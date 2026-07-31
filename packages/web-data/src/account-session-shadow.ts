import { Prisma } from "@prisma/client";

import {
  resolveAccountShadowForVerifiedPrincipal,
  type AccountShadowClient,
  type ResolvedAccountShadow,
  type VerifiedAccountPrincipal,
} from "./account-shadow";
import {
  createAppSession,
  revokeAppSession,
  type AppSessionApplicationValue,
  type AppSessionClient,
  type CreatedAppSession,
} from "./app-sessions";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

export const DELEGATE_DASHBOARD_APP_SESSION_COOKIE =
  "delegate_dashboard_session_v2";
export const DELEGATE_REPRESENTATIVES_APP_SESSION_COOKIE =
  "delegate_reps_session_v2";

export type AccountSessionPersona =
  | {
      kind: "owner";
      ownerId: string;
    }
  | {
      kind: "audience";
      audienceIdentityId: string;
    };

type OwnerPersonaRecord = {
  id: string;
  accountId: string | null;
};

type AudiencePersonaRecord = {
  id: string;
  accountId: string | null;
  status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
  mergedIntoId: string | null;
};

type AccountSessionPersonaClient = {
  owner: {
    findUnique(args: {
      where: { id: string } | { accountId: string };
      select: { id: true; accountId: true };
    }): Promise<OwnerPersonaRecord | null>;
    updateMany(args: {
      where: {
        id: string;
        OR: Array<{ accountId: null } | { accountId: string }>;
      };
      data: { accountId: string };
    }): Promise<{ count: number }>;
  };
  audienceIdentity: {
    findUnique(args: {
      where: { id: string } | { accountId: string };
      select: {
        id: true;
        accountId: true;
        status: true;
        mergedIntoId: true;
      };
    }): Promise<AudiencePersonaRecord | null>;
    updateMany(args: {
      where: {
        id: string;
        status: "REGISTERED";
        mergedIntoId: null;
        OR: Array<{ accountId: null } | { accountId: string }>;
      };
      data: { accountId: string };
    }): Promise<{ count: number }>;
  };
};

export type AccountSessionShadowClient = AccountSessionPersonaClient & {
  $transaction<T>(
    operation: (tx: unknown) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

export type IssueAccountSessionShadowInput = {
  principal: VerifiedAccountPrincipal;
  persona: AccountSessionPersona;
  application: AppSessionApplicationValue;
  /**
   * When present, possession of this application-scoped token authorizes its
   * revocation in the same transaction before the replacement is created.
   * Invalid tokens are ignored without a database lookup.
   */
  previousToken?: string | null | undefined;
  logtoSessionId?: string | null | undefined;
  deviceLabel?: string | null | undefined;
  userAgent?: string | null | undefined;
  now?: Date | undefined;
};

export type IssuedAccountSessionShadow = {
  account: ResolvedAccountShadow["account"];
  authIdentity: ResolvedAccountShadow["authIdentity"];
  accountCreated: boolean;
  previousSessionRevoked: boolean;
  token: CreatedAppSession["token"];
  session: CreatedAppSession["session"];
};

export type AccountSessionPersonaErrorReason =
  | "MISSING"
  | "NOT_REGISTERED"
  | "ACCOUNT_CONFLICT"
  | "ACCOUNT_ALREADY_CLAIMED"
  | "CROSS_PERSONA_REVIEW_REQUIRED"
  | "APPLICATION_MISMATCH"
  | "CAS_CONFLICT";

export class AccountSessionPersonaConflictError extends Error {
  readonly code = "ACCOUNT_SESSION_PERSONA_CONFLICT";

  constructor(
    readonly persona: AccountSessionPersona,
    readonly reason: AccountSessionPersonaErrorReason,
  ) {
    super(`Cannot attach ${persona.kind} persona to Account (${reason}).`);
    this.name = "AccountSessionPersonaConflictError";
  }
}

/**
 * Atomically resolves the exact verified external principal, CAS-attaches the
 * already-authorized legacy persona, rotates any browser-held v2 session, and
 * creates its replacement. No email, phone, or subject-only lookup participates
 * in account resolution.
 */
export async function issueAccountSessionShadow(
  input: IssueAccountSessionShadowInput,
  client: AccountSessionShadowClient =
    prisma as unknown as AccountSessionShadowClient,
): Promise<IssuedAccountSessionShadow> {
  assertPersonaApplication(input.persona, input.application);
  try {
    return await runWithPrismaWriteConflictRetry(
      () =>
        client.$transaction(
          async (rawTx) => {
            const tx = rawTx as AccountShadowClient
              & AppSessionClient
              & AccountSessionPersonaClient;
            // Explicit facades guarantee the lower-level helpers stay inside
            // this transaction even if a future Prisma transaction proxy
            // happens to expose a nested `$transaction` property.
            const accountClient = {
              authIdentity: tx.authIdentity,
              account: tx.account,
            } as AccountShadowClient;
            const appSessionClient = {
              authIdentity: tx.authIdentity,
              appSession: tx.appSession,
            } as AppSessionClient;
            const personaClient: AccountSessionPersonaClient = {
              owner: tx.owner,
              audienceIdentity: tx.audienceIdentity,
            };

            const resolved =
              await resolveAccountShadowForVerifiedPrincipal(
                input.principal,
                accountClient,
              );
            await attachPersonaWithCompareAndSet(
              personaClient,
              input.persona,
              resolved.account.id,
            );

            const previousSessionRevoked =
              typeof input.previousToken === "string"
              && input.previousToken.length > 0
                ? await revokeAppSession(
                    {
                      token: input.previousToken,
                      application: input.application,
                      reason: "REPLACED_BY_LOGIN",
                      now: input.now,
                    },
                    appSessionClient,
                  )
                : false;

            const created = await createAppSession(
              {
                accountId: resolved.account.id,
                authIdentityId: resolved.authIdentity.id,
                application: input.application,
                // No Account-based Workspace membership authority exists yet.
                // Shadow issuance must not infer this from legacy Owner fields.
                activeOrganizationId: null,
                logtoSessionId: input.logtoSessionId,
                deviceLabel: input.deviceLabel,
                userAgent: input.userAgent,
                now: input.now,
              },
              appSessionClient,
            );

            return {
              account: resolved.account,
              authIdentity: resolved.authIdentity,
              accountCreated: resolved.created,
              previousSessionRevoked,
              token: created.token,
              session: created.session,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      {
        // P2034 is included by the shared retry helper. P2002 covers an exact
        // AuthIdentity first-login race and a concurrent persona claim; a retry
        // observes the winner and either returns it or reports a safe conflict.
        additionalRetryableCodes: ["P2002"],
      },
    );
  } catch (error) {
    if (isPrismaKnownErrorCode(error, "P2002")) {
      throw new AccountSessionPersonaConflictError(
        input.persona,
        "CAS_CONFLICT",
      );
    }
    throw error;
  }
}

function assertPersonaApplication(
  persona: AccountSessionPersona,
  application: AppSessionApplicationValue,
): void {
  if (
    (persona.kind === "owner" && application !== "DASHBOARD")
    || (
      persona.kind === "audience"
      && application !== "PUBLIC_REPRESENTATIVES"
    )
  ) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "APPLICATION_MISMATCH",
    );
  }
}

function attachPersonaWithCompareAndSet(
  client: AccountSessionPersonaClient,
  persona: AccountSessionPersona,
  accountId: string,
): Promise<void> {
  return persona.kind === "owner"
    ? attachOwnerPersona(client, persona, accountId)
    : attachAudiencePersona(client, persona, accountId);
}

async function attachOwnerPersona(
  client: AccountSessionPersonaClient,
  persona: Extract<AccountSessionPersona, { kind: "owner" }>,
  accountId: string,
): Promise<void> {
  const ownerId = normalizePersonaId(persona.ownerId, "ownerId");
  const owner = await client.owner.findUnique({
    where: { id: ownerId },
    select: { id: true, accountId: true },
  });
  if (!owner) {
    throw new AccountSessionPersonaConflictError(persona, "MISSING");
  }
  if (owner.accountId && owner.accountId !== accountId) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "ACCOUNT_CONFLICT",
    );
  }
  const audienceClaim = await client.audienceIdentity.findUnique({
    where: { accountId },
    select: {
      id: true,
      accountId: true,
      status: true,
      mergedIntoId: true,
    },
  });
  if (audienceClaim && owner.accountId !== accountId) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "CROSS_PERSONA_REVIEW_REQUIRED",
    );
  }
  const currentClaim = await client.owner.findUnique({
    where: { accountId },
    select: { id: true, accountId: true },
  });
  if (currentClaim && currentClaim.id !== ownerId) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "ACCOUNT_ALREADY_CLAIMED",
    );
  }
  const updated = await client.owner.updateMany({
    where: {
      id: ownerId,
      OR: [{ accountId: null }, { accountId }],
    },
    data: { accountId },
  });
  if (updated.count !== 1) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "CAS_CONFLICT",
    );
  }
}

async function attachAudiencePersona(
  client: AccountSessionPersonaClient,
  persona: Extract<AccountSessionPersona, { kind: "audience" }>,
  accountId: string,
): Promise<void> {
  const audienceIdentityId = normalizePersonaId(
    persona.audienceIdentityId,
    "audienceIdentityId",
  );
  const audience = await client.audienceIdentity.findUnique({
    where: { id: audienceIdentityId },
    select: {
      id: true,
      accountId: true,
      status: true,
      mergedIntoId: true,
    },
  });
  if (!audience) {
    throw new AccountSessionPersonaConflictError(persona, "MISSING");
  }
  if (audience.status !== "REGISTERED" || audience.mergedIntoId) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "NOT_REGISTERED",
    );
  }
  if (audience.accountId && audience.accountId !== accountId) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "ACCOUNT_CONFLICT",
    );
  }
  const ownerClaim = await client.owner.findUnique({
    where: { accountId },
    select: { id: true, accountId: true },
  });
  if (ownerClaim && audience.accountId !== accountId) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "CROSS_PERSONA_REVIEW_REQUIRED",
    );
  }
  const currentClaim = await client.audienceIdentity.findUnique({
    where: { accountId },
    select: {
      id: true,
      accountId: true,
      status: true,
      mergedIntoId: true,
    },
  });
  if (currentClaim && currentClaim.id !== audienceIdentityId) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "ACCOUNT_ALREADY_CLAIMED",
    );
  }
  const updated = await client.audienceIdentity.updateMany({
    where: {
      id: audienceIdentityId,
      status: "REGISTERED",
      mergedIntoId: null,
      OR: [{ accountId: null }, { accountId }],
    },
    data: { accountId },
  });
  if (updated.count !== 1) {
    throw new AccountSessionPersonaConflictError(
      persona,
      "CAS_CONFLICT",
    );
  }
}

function normalizePersonaId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function isPrismaKnownErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === code
  );
}
