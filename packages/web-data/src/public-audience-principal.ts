import {
  IdentityAssuranceLevel,
  IdentityLinkProvider,
} from "@prisma/client";

import type { DelegateAuthSession } from "./auth-session";
import { prisma } from "./prisma";
import {
  buildWebAudienceExternalUserId,
  buildWebAudienceKey,
  normalizeWebAudienceId,
} from "./web-audience";

const MAX_AUDIENCE_IDENTITY_MERGE_DEPTH = 64;

type AudienceIdentityRecord = {
  id: string;
  audienceKey: string;
  status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
  mergedIntoId: string | null;
};

export type PublicAudiencePrincipalClient = {
  audienceIdentity: {
    upsert(args: unknown): Promise<AudienceIdentityRecord>;
    findUnique(args: unknown): Promise<AudienceIdentityRecord | null>;
  };
  identityLink: {
    findUnique(args: unknown): Promise<{
      audienceIdentityId: string;
      verifiedAt: Date | null;
      assuranceLevel: IdentityAssuranceLevel;
      revokedAt: Date | null;
    } | null>;
  };
};

export type PublicAudienceWalletClient = {
  userWallet: {
    findMany(args: unknown): Promise<Array<{ externalUserId: string }>>;
  };
};

export type PublicAudiencePrincipal = {
  mode: "anonymous" | "authenticated";
  audienceId: string;
  audienceIdentityId: string;
  /**
   * Stable server-side business key. API responses must not expose this value or
   * the canonical identity id to the browser.
   */
  businessKey: string;
};

export type PublicAudiencePrincipalErrorCode =
  | "AUTHENTICATED_PRINCIPAL_INVALID"
  | "ANONYMOUS_SESSION_ROTATION_REQUIRED"
  | "WALLET_IDENTITY_CONFLICT";

export class PublicAudiencePrincipalError extends Error {
  constructor(
    readonly code: PublicAudiencePrincipalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PublicAudiencePrincipalError";
  }
}

/**
 * Resolves the server-authoritative principal for public representative
 * requests. The caller must verify the auth-session signature before passing a
 * session here. A valid audience session is then revalidated against current
 * identity-link state on every business request.
 */
export async function resolvePublicAudiencePrincipal(
  input: {
    audienceId: string;
    verifiedAuthSession?: DelegateAuthSession | null;
    now?: Date;
  },
  client: PublicAudiencePrincipalClient =
    prisma as unknown as PublicAudiencePrincipalClient,
): Promise<PublicAudiencePrincipal> {
  const audienceId = normalizeWebAudienceId(input.audienceId);
  const now = input.now ?? new Date();
  const webIdentity = await client.audienceIdentity.upsert({
    where: { audienceKey: buildWebAudienceKey(audienceId) },
    update: { lastSeenAt: now },
    create: {
      audienceKey: buildWebAudienceKey(audienceId),
      status: "ANONYMOUS",
      lastSeenAt: now,
    },
    select: {
      id: true,
      audienceKey: true,
      status: true,
      mergedIntoId: true,
    },
  });

  const authSession = input.verifiedAuthSession ?? null;
  if (!authSession) {
    if (webIdentity.status !== "ANONYMOUS" || webIdentity.mergedIntoId) {
      throw new PublicAudiencePrincipalError(
        "ANONYMOUS_SESSION_ROTATION_REQUIRED",
        "The anonymous browser session is attached to a registered identity and must be rotated.",
      );
    }
    const canonicalIdentity = await resolveCanonicalIdentity(
      webIdentity.id,
      client,
    );
    if (canonicalIdentity.status !== "ANONYMOUS") {
      throw new PublicAudiencePrincipalError(
        "ANONYMOUS_SESSION_ROTATION_REQUIRED",
        "The anonymous browser session no longer represents an anonymous identity.",
      );
    }
    return serializePrincipal("anonymous", audienceId, canonicalIdentity.id);
  }

  const sessionAudienceId = authSession.audienceId?.trim().toLowerCase();
  const sessionAudienceIdentityId = authSession.audienceIdentityId?.trim();
  const subject = authSession.subject?.trim();
  if (
    authSession.actor !== "audience"
    || authSession.provider !== "logto"
    || !sessionAudienceId
    || sessionAudienceId !== audienceId
    || !sessionAudienceIdentityId
    || !subject
  ) {
    throw invalidAuthenticatedPrincipal();
  }

  const link = await client.identityLink.findUnique({
    where: {
      provider_providerSubject: {
        provider: IdentityLinkProvider.LOGTO,
        providerSubject: subject,
      },
    },
    select: {
      audienceIdentityId: true,
      verifiedAt: true,
      assuranceLevel: true,
      revokedAt: true,
    },
  });
  if (
    !link
    || link.revokedAt
    || !link.verifiedAt
    || (
      link.assuranceLevel !== IdentityAssuranceLevel.PLATFORM_VERIFIED
      && link.assuranceLevel !== IdentityAssuranceLevel.STEP_UP_VERIFIED
    )
  ) {
    throw invalidAuthenticatedPrincipal();
  }

  const [
    canonicalWebIdentity,
    canonicalSessionIdentity,
    canonicalLinkedIdentity,
  ] = await Promise.all([
    resolveCanonicalIdentity(webIdentity.id, client),
    resolveCanonicalIdentity(sessionAudienceIdentityId, client),
    resolveCanonicalIdentity(link.audienceIdentityId, client),
  ]);
  if (
    canonicalSessionIdentity.status !== "REGISTERED"
    || canonicalWebIdentity.id !== canonicalSessionIdentity.id
    || canonicalLinkedIdentity.id !== canonicalSessionIdentity.id
  ) {
    throw invalidAuthenticatedPrincipal();
  }

  return serializePrincipal(
    "authenticated",
    audienceId,
    canonicalSessionIdentity.id,
  );
}

/**
 * Resolves the legacy wallet selector without trusting a browser-provided
 * external id. Existing wallets follow the canonical identity. A missing
 * wallet falls back to the current signed anonymous browser id until wallet
 * creation is moved fully onto the canonical key.
 */
export async function resolvePublicAudienceWalletExternalUserId(
  input: {
    audienceIdentityId: string;
    representativeSlug: string;
    audienceId: string;
    currency?: string;
  },
  client: PublicAudienceWalletClient =
    prisma as unknown as PublicAudienceWalletClient,
): Promise<string> {
  const audienceIdentityId = requireValue(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const currency = (input.currency?.trim().toUpperCase() || "CNY").slice(0, 12);
  const wallets = await client.userWallet.findMany({
    where: {
      audienceIdentityId,
      currency,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: { externalUserId: true },
  });
  if (wallets.length > 1) {
    throw new PublicAudiencePrincipalError(
      "WALLET_IDENTITY_CONFLICT",
      "Multiple wallets exist for this audience identity and currency.",
    );
  }
  return wallets[0]?.externalUserId
    ?? buildWebAudienceExternalUserId(
      requireValue(input.representativeSlug, "representativeSlug"),
      input.audienceId,
    );
}

async function resolveCanonicalIdentity(
  audienceIdentityId: string,
  client: PublicAudiencePrincipalClient,
): Promise<AudienceIdentityRecord> {
  const initialId = requireValue(audienceIdentityId, "audienceIdentityId");
  const visited = new Set<string>();
  let currentId = initialId;
  for (let depth = 0; depth < MAX_AUDIENCE_IDENTITY_MERGE_DEPTH; depth += 1) {
    if (visited.has(currentId)) throw invalidAuthenticatedPrincipal();
    visited.add(currentId);
    const identity = await client.audienceIdentity.findUnique({
      where: { id: currentId },
      select: {
        id: true,
        audienceKey: true,
        status: true,
        mergedIntoId: true,
      },
    });
    if (!identity || identity.status === "DISABLED") {
      throw invalidAuthenticatedPrincipal();
    }
    if (identity.status !== "MERGED") return identity;
    if (!identity.mergedIntoId?.trim()) throw invalidAuthenticatedPrincipal();
    currentId = identity.mergedIntoId;
  }
  throw invalidAuthenticatedPrincipal();
}

function serializePrincipal(
  mode: PublicAudiencePrincipal["mode"],
  audienceId: string,
  audienceIdentityId: string,
): PublicAudiencePrincipal {
  return {
    mode,
    audienceId,
    audienceIdentityId,
    businessKey: `audience:${audienceIdentityId}`,
  };
}

function invalidAuthenticatedPrincipal() {
  return new PublicAudiencePrincipalError(
    "AUTHENTICATED_PRINCIPAL_INVALID",
    "The authenticated audience session is no longer valid.",
  );
}

function requireValue(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
