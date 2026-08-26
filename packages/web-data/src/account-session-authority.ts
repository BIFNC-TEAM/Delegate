import { prisma } from "./prisma";
import {
  touchAppSession,
  type AppSessionRecord,
} from "./app-sessions";

export type DashboardAccountSessionPrincipal = {
  version: 2;
  actor: "owner";
  provider: "logto";
  accountId: string;
  authIdentityId: string;
  ownerId: string;
  issuer: string;
  subject: string;
  email: string | null;
  issuedAt: number;
  expiresAt: number;
};

export type PublicAudienceAccountSessionPrincipal = {
  version: 2;
  actor: "audience";
  provider: "logto";
  accountId: string;
  authIdentityId: string;
  audienceIdentityId: string;
  audienceId: string;
  issuer: string;
  subject: string;
  email: string | null;
  issuedAt: number;
  expiresAt: number;
};

export type AccountSessionAuthorityPrincipal =
  | DashboardAccountSessionPrincipal
  | PublicAudienceAccountSessionPrincipal;

type IdentityAuthorityRecord = {
  id: string;
  accountId: string;
  issuer: string;
  subject: string;
  email: string | null;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  account: {
    id: string;
    status: "ACTIVE" | "SUSPENDED" | "DELETION_PENDING" | "DELETED";
  };
};

type DashboardPersonaRecord = {
  id: string;
  accountId: string | null;
};

type AudiencePersonaRecord = {
  id: string;
  accountId: string | null;
  status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
  mergedIntoId: string | null;
};

type AccountSessionAuthorityDependencies = {
  touchSession(input: {
    token: string;
    application: "DASHBOARD" | "PUBLIC_REPRESENTATIVES";
    now?: Date | undefined;
  }): Promise<AppSessionRecord | null>;
  loadIdentity(authIdentityId: string): Promise<IdentityAuthorityRecord | null>;
  loadOwner(accountId: string): Promise<DashboardPersonaRecord | null>;
  loadAudience(accountId: string): Promise<AudiencePersonaRecord | null>;
};

const defaultDependencies: AccountSessionAuthorityDependencies = {
  touchSession: (input) => touchAppSession(input),
  loadIdentity: (authIdentityId) =>
    prisma.authIdentity.findUnique({
      where: { id: authIdentityId },
      include: { account: true },
    }),
  loadOwner: (accountId) =>
    prisma.owner.findUnique({
      where: { accountId },
      select: { id: true, accountId: true },
    }),
  loadAudience: (accountId) =>
    prisma.audienceIdentity.findUnique({
      where: { accountId },
      select: {
        id: true,
        accountId: true,
        status: true,
        mergedIntoId: true,
      },
    }),
};

/**
 * Resolves the opaque application cookie into one current product persona.
 * AppSession validation, Account/AuthIdentity status, application isolation,
 * and persona ownership all fail closed independently.
 */
export async function resolveAccountSessionAuthority(
  input: {
    token: string;
    application: "DASHBOARD" | "PUBLIC_REPRESENTATIVES";
    now?: Date | undefined;
  },
  dependencies: AccountSessionAuthorityDependencies = defaultDependencies,
): Promise<AccountSessionAuthorityPrincipal | null> {
  const session = await dependencies.touchSession(input);
  if (!session) return null;

  const identity = await dependencies.loadIdentity(session.authIdentityId);
  if (!isCurrentIdentity(identity, session)) return null;

  const common = {
    version: 2 as const,
    provider: "logto" as const,
    accountId: session.accountId,
    authIdentityId: session.authIdentityId,
    issuer: identity.issuer,
    subject: identity.subject,
    email: identity.email,
    issuedAt: Math.floor(session.issuedAt.getTime() / 1_000),
    expiresAt: Math.floor(session.absoluteExpiresAt.getTime() / 1_000),
  };

  if (input.application === "DASHBOARD") {
    if (session.publicAudienceId !== null) return null;
    const owner = await dependencies.loadOwner(session.accountId);
    if (!owner || owner.accountId !== session.accountId) return null;
    return {
      ...common,
      actor: "owner",
      ownerId: owner.id,
    };
  }

  const audienceId = session.publicAudienceId?.trim().toLowerCase();
  if (!audienceId) return null;
  const audience = await dependencies.loadAudience(session.accountId);
  if (
    !audience
    || audience.accountId !== session.accountId
    || audience.status !== "REGISTERED"
    || audience.mergedIntoId !== null
  ) {
    return null;
  }
  return {
    ...common,
    actor: "audience",
    audienceIdentityId: audience.id,
    audienceId,
  };
}

function isCurrentIdentity(
  identity: IdentityAuthorityRecord | null,
  session: AppSessionRecord,
): identity is IdentityAuthorityRecord {
  return Boolean(
    identity
    && identity.id === session.authIdentityId
    && identity.accountId === session.accountId
    && identity.account.id === session.accountId
    && identity.status === "ACTIVE"
    && identity.account.status === "ACTIVE"
    && identity.issuer.trim()
    && identity.subject.trim(),
  );
}
