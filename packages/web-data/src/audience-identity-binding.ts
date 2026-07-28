import { createHash, randomBytes } from "node:crypto";

import {
  IdentityAssuranceLevel,
  IdentityLinkProvider,
  Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";
import { mergeAudienceIdentity } from "./web-audience";

const DEFAULT_CHALLENGE_TTL_SECONDS = 10 * 60;
const MAX_CHALLENGE_TTL_SECONDS = 30 * 60;

type IdentityStatus = "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";

type BindingChallengeRecord = {
  id: string;
  audienceIdentityId: string;
  provider: IdentityLinkProvider;
  issuer: string;
  connectionId: string;
  expectedProviderSubject: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  metadata?: unknown;
};

type IdentityLinkRecord = {
  id: string;
  audienceIdentityId: string;
  issuer: string;
  connectionId: string | null;
  revokedAt: Date | null;
};

type IdentityLinkConnectionProofRecord = {
  identityLinkId: string;
  issuer: string;
  connectionId: string;
  verifiedAt: Date | null;
  assuranceLevel: IdentityAssuranceLevel;
  revokedAt: Date | null;
  proofMetadata?: unknown;
};

type AudienceBindingClient = {
  $transaction?<T>(
    callback: (client: AudienceBindingClient) => Promise<T>,
    options?: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
  audienceIdentity: {
    findUnique(args: unknown): Promise<{ id: string; status: IdentityStatus } | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  identityBindingChallenge: {
    create(args: unknown): Promise<BindingChallengeRecord>;
    findUnique(args: unknown): Promise<BindingChallengeRecord | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  identityLink: {
    findUnique(args: unknown): Promise<IdentityLinkRecord | null>;
    findFirst(args: unknown): Promise<IdentityLinkRecord | null>;
    create(args: unknown): Promise<IdentityLinkRecord>;
    update(args: unknown): Promise<IdentityLinkRecord>;
    findMany?(args: unknown): Promise<
      Array<{
        id?: string;
        provider: IdentityLinkProvider;
        providerSubject: string;
        issuer: string;
        connectionId: string | null;
        verifiedAt: Date | null;
        assuranceLevel: IdentityAssuranceLevel;
        connectionProofs?: IdentityLinkConnectionProofRecord[];
      }>
    >;
  };
  identityLinkConnectionProof?: {
    findUnique(args: unknown): Promise<IdentityLinkConnectionProofRecord | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
    count(args: unknown): Promise<number>;
    upsert(args: unknown): Promise<IdentityLinkConnectionProofRecord>;
  };
};

export type CreateIdentityBindingChallengeInput = {
  audienceIdentityId: string;
  provider: IdentityLinkProvider;
  connectionId: string;
  issuer?: string;
  expectedProviderSubject?: string;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
};

export type IdentityBindingChallengeGrant = {
  token: string;
  expiresAt: string;
  provider: IdentityLinkProvider;
  issuer: string;
  connectionId: string;
};

export type ConsumeIdentityBindingChallengeInput = {
  token: string;
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer?: string;
  connectionId: string;
  proofMetadata?: Record<string, unknown>;
};

export type IdentityBindingResult = {
  audienceIdentityId: string;
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer: string;
  verifiedAt: string;
  metadata?: Record<string, unknown>;
};

export type RevokePrivateChannelIdentityBindingInput = {
  audienceIdentityId: string;
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer: string;
  connectionId: string;
};

export type RevokePrivateChannelIdentityBindingResult = {
  binding: {
    provider: IdentityLinkProvider;
    providerSubject: string;
    issuer: string;
    connectionId: string;
  };
  changed: boolean;
};

export type ActivePrivateChannelIdentityBinding = {
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer: string;
  connectionId: string | null;
  verifiedAt: string | null;
  assuranceLevel: IdentityAssuranceLevel;
};

export const privateChannelIdentityProviders = {
  telegram: IdentityLinkProvider.TELEGRAM,
  matrix: IdentityLinkProvider.MATRIX,
} as const;

export async function listActivePrivateChannelIdentityBindings(
  audienceIdentityId: string,
  client: AudienceBindingClient = prisma as unknown as AudienceBindingClient,
): Promise<ActivePrivateChannelIdentityBinding[]> {
  const id = requireNonEmpty(audienceIdentityId, "Audience identity id");
  const identity = await client.audienceIdentity.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!identity) throw new Error("Audience identity was not found.");
  assertActiveIdentity(identity);
  if (!client.identityLink.findMany) {
    throw new Error("Identity binding listing is unavailable for this persistence client.");
  }

  const bindings = await client.identityLink.findMany({
    where: {
      audienceIdentityId: id,
      provider: {
        in: [IdentityLinkProvider.TELEGRAM, IdentityLinkProvider.MATRIX],
      },
      revokedAt: null,
      verifiedAt: { not: null },
      assuranceLevel: {
        in: [
          IdentityAssuranceLevel.PLATFORM_VERIFIED,
          IdentityAssuranceLevel.STEP_UP_VERIFIED,
        ],
      },
    },
    select: {
      provider: true,
      providerSubject: true,
      issuer: true,
      connectionId: true,
      verifiedAt: true,
      assuranceLevel: true,
      connectionProofs: {
        select: {
          identityLinkId: true,
          issuer: true,
          connectionId: true,
          verifiedAt: true,
          assuranceLevel: true,
          revokedAt: true,
          proofMetadata: true,
        },
        orderBy: [{ createdAt: "asc" }],
      },
    },
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });

  return bindings.flatMap((binding) => {
    if (binding.connectionProofs?.length) {
      return binding.connectionProofs.flatMap((proof) =>
        proof.revokedAt === null
        && proof.verifiedAt !== null
        && (
          proof.assuranceLevel === IdentityAssuranceLevel.PLATFORM_VERIFIED
          || proof.assuranceLevel === IdentityAssuranceLevel.STEP_UP_VERIFIED
        )
          ? [{
              provider: binding.provider,
              providerSubject: binding.providerSubject,
              issuer: proof.issuer,
              connectionId: proof.connectionId,
              verifiedAt: proof.verifiedAt.toISOString(),
              assuranceLevel: proof.assuranceLevel,
            }]
          : [],
      );
    }
    return [{
      provider: binding.provider,
      providerSubject: binding.providerSubject,
      issuer: binding.issuer,
      connectionId: binding.connectionId,
      verifiedAt: binding.verifiedAt?.toISOString() ?? null,
      assuranceLevel: binding.assuranceLevel,
    }];
  });
}

export function isVerifiedPrivateChannelIdentityBinding(
  binding: ActivePrivateChannelIdentityBinding,
  expected: {
    provider: IdentityLinkProvider;
    issuer: string;
    connectionId: string;
  },
): boolean {
  return (
    binding.provider === expected.provider
    && binding.issuer === expected.issuer
    && binding.connectionId === expected.connectionId
    && binding.verifiedAt !== null
    && (
      binding.assuranceLevel === IdentityAssuranceLevel.PLATFORM_VERIFIED
      || binding.assuranceLevel === IdentityAssuranceLevel.STEP_UP_VERIFIED
    )
  );
}

/**
 * Creates a short-lived capability that must be delivered through an already
 * authenticated private channel. Only the hash is persisted.
 */
export async function createIdentityBindingChallenge(
  input: CreateIdentityBindingChallengeInput,
  client: AudienceBindingClient = prisma as unknown as AudienceBindingClient,
): Promise<IdentityBindingChallengeGrant> {
  const audienceIdentityId = requireNonEmpty(input.audienceIdentityId, "Audience identity id");
  const issuer = normalizeIssuer(input.issuer);
  const connectionId = normalizeConnectionId(input.connectionId);
  assertBindableProvider(input.provider);
  const ttlSeconds = normalizeTtlSeconds(input.ttlSeconds);
  const expectedProviderSubject = input.expectedProviderSubject
    ? normalizeProviderSubject(input.provider, input.expectedProviderSubject)
    : undefined;
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const run = async (tx: AudienceBindingClient) => {
    const identity = await tx.audienceIdentity.findUnique({
      where: { id: audienceIdentityId },
      select: { id: true, status: true },
    });
    if (!identity) throw new Error("Audience identity was not found.");
    if (identity.status !== "REGISTERED") {
      throw new Error(
        "Private-channel binding must target a registered Web identity.",
      );
    }
    const verifiedWebLink = await tx.identityLink.findFirst({
      where: {
        audienceIdentityId,
        provider: IdentityLinkProvider.LOGTO,
        revokedAt: null,
        verifiedAt: { not: null },
        assuranceLevel: {
          in: [
            IdentityAssuranceLevel.PLATFORM_VERIFIED,
            IdentityAssuranceLevel.STEP_UP_VERIFIED,
          ],
        },
      },
      select: {
        id: true,
        audienceIdentityId: true,
        issuer: true,
        connectionId: true,
        revokedAt: true,
      },
    });
    if (!verifiedWebLink) {
      throw new Error(
        "Private-channel binding requires a verified Web login.",
      );
    }

    // A Web identity can have only one live challenge for an exact adapter
    // scope. This keeps the most recently displayed command authoritative and
    // prevents an older copied command from restoring a revoked proof later.
    await tx.identityBindingChallenge.updateMany({
      where: {
        audienceIdentityId,
        provider: input.provider,
        issuer,
        connectionId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
    await tx.identityBindingChallenge.create({
      data: {
        audienceIdentityId,
        provider: input.provider,
        issuer,
        connectionId,
        ...(expectedProviderSubject ? { expectedProviderSubject } : {}),
        tokenHash: hashBindingToken(token),
        expiresAt,
        metadata: input.metadata ?? {},
      },
    });
  };

  if (client.$transaction) {
    await runWithPrismaWriteConflictRetry(() =>
      client.$transaction!(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
    );
  } else {
    await run(client);
  }

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    provider: input.provider,
    issuer,
    connectionId,
  };
}

/**
 * Consumes a challenge exactly once and binds the verified provider subject to
 * the canonical Delegate identity. Existing links are never silently moved.
 */
export async function consumeIdentityBindingChallenge(
  input: ConsumeIdentityBindingChallengeInput,
  client: AudienceBindingClient = prisma as unknown as AudienceBindingClient,
): Promise<IdentityBindingResult> {
  const token = requireNonEmpty(input.token, "Binding token");
  const issuer = normalizeIssuer(input.issuer);
  const connectionId = normalizeConnectionId(input.connectionId);
  const providerSubject = normalizeProviderSubject(input.provider, input.providerSubject);
  assertBindableProvider(input.provider);

  const run = async (tx: AudienceBindingClient): Promise<IdentityBindingResult> => {
    const now = new Date();
    const challenge = await tx.identityBindingChallenge.findUnique({
      where: { tokenHash: hashBindingToken(token) },
    });
    if (!challenge) throw new Error("Binding challenge is invalid.");
    if (
      challenge.provider !== input.provider ||
      challenge.issuer !== issuer ||
      challenge.connectionId !== connectionId
    ) {
      throw new Error("Binding challenge does not match this provider.");
    }
    if (challenge.consumedAt) throw new Error("Binding challenge has already been used.");
    if (challenge.revokedAt) throw new Error("Binding challenge has been revoked.");
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw new Error("Binding challenge has expired.");
    }
    if (
      challenge.expectedProviderSubject &&
      challenge.expectedProviderSubject !== providerSubject
    ) {
      throw new Error("Binding challenge belongs to a different provider account.");
    }

    const identity = await tx.audienceIdentity.findUnique({
      where: { id: challenge.audienceIdentityId },
      select: { id: true, status: true },
    });
    if (!identity) throw new Error("Audience identity was not found.");
    assertActiveIdentity(identity);

    const existing = await tx.identityLink.findUnique({
      where: {
        provider_providerSubject: {
          provider: input.provider,
          providerSubject,
        },
      },
      select: {
        id: true,
        audienceIdentityId: true,
        issuer: true,
        connectionId: true,
        revokedAt: true,
      },
    });
    if (existing && existing.issuer !== issuer) {
      throw new Error("Provider account belongs to a different issuer realm.");
    }
    if (
      !tx.identityLinkConnectionProof
      && existing?.connectionId
      && existing.connectionId.toLowerCase() !== connectionId
    ) {
      throw new Error("Provider account belongs to a different provider connection.");
    }
    if (existing && existing.audienceIdentityId !== identity.id) {
      const providerIdentity = await tx.audienceIdentity.findUnique({
        where: { id: existing.audienceIdentityId },
        select: { id: true, status: true },
      });
      if (
        !providerIdentity
        || providerIdentity.status !== "ANONYMOUS"
        || identity.status !== "REGISTERED"
      ) {
        throw new Error("Provider account is already bound to another audience identity.");
      }
      await mergeAudienceIdentity(
        {
          sourceAudienceIdentityId: providerIdentity.id,
          targetAudienceIdentityId: identity.id,
          transferVerifiedProvisionalAssets: true,
          now,
        },
        tx as never,
      );
    }

    const consumed = await tx.identityBindingChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new Error("Binding challenge was consumed concurrently.");
    }

    const proofMetadata = {
      ...(input.proofMetadata ?? {}),
      method: "private_channel_challenge",
      challengeId: challenge.id,
      issuer,
      connectionId,
    };
    const identityLink = existing
      ? await tx.identityLink.update({
        where: { id: existing.id },
        data: {
          issuer,
          ...(!tx.identityLinkConnectionProof ? { connectionId } : {}),
          verifiedAt: now,
          assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
          revokedAt: null,
          proofMetadata,
        },
      })
      : await tx.identityLink.create({
        data: {
          audienceIdentityId: identity.id,
          provider: input.provider,
          providerSubject,
          issuer,
          connectionId,
          verifiedAt: now,
          assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
          proofMetadata,
        },
      });
    if (tx.identityLinkConnectionProof) {
      await tx.identityLinkConnectionProof.upsert({
        where: {
          identityLinkId_issuer_connectionId: {
            identityLinkId: identityLink.id,
            issuer,
            connectionId,
          },
        },
        create: {
          identityLinkId: identityLink.id,
          issuer,
          connectionId,
          verifiedAt: now,
          assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
          revokedAt: null,
          proofMetadata,
        },
        update: {
          verifiedAt: now,
          assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
          revokedAt: null,
          proofMetadata,
        },
      });
    }

    return {
      audienceIdentityId: identity.id,
      provider: input.provider,
      providerSubject,
      issuer,
      verifiedAt: now.toISOString(),
      ...(isRecord(challenge.metadata)
        ? { metadata: challenge.metadata }
        : {}),
    };
  };

  return client.$transaction
    ? runWithPrismaWriteConflictRetry(() =>
        client.$transaction!(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      )
    : run(client);
}

/**
 * Revokes one provider connection without disturbing verified proofs for other
 * Bots or Matrix adapters. A revoked proof is a tombstone: normal channel
 * traffic cannot silently reactivate it, while a new Web-issued challenge can.
 */
export async function revokePrivateChannelIdentityBinding(
  input: RevokePrivateChannelIdentityBindingInput,
  client: AudienceBindingClient = prisma as unknown as AudienceBindingClient,
): Promise<RevokePrivateChannelIdentityBindingResult> {
  const audienceIdentityId = requireNonEmpty(
    input.audienceIdentityId,
    "Audience identity id",
  );
  const providerSubject = normalizeProviderSubject(
    input.provider,
    input.providerSubject,
  );
  const issuer = normalizeIssuer(input.issuer);
  const connectionId = normalizeConnectionId(input.connectionId);
  assertBindableProvider(input.provider);
  const now = new Date();
  const binding = {
    provider: input.provider,
    providerSubject,
    issuer,
    connectionId,
  };

  const run = async (
    tx: AudienceBindingClient,
  ): Promise<RevokePrivateChannelIdentityBindingResult> => {
    const identity = await tx.audienceIdentity.findUnique({
      where: { id: audienceIdentityId },
      select: { id: true, status: true },
    });
    if (!identity) throw new Error("Audience identity was not found.");
    assertActiveIdentity(identity);
    if (identity.status !== "REGISTERED") {
      throw new Error(
        "Private-channel unlink must target a registered Web identity.",
      );
    }

    // A retrying DELETE must also invalidate a challenge created after an
    // earlier unlink. Challenge revocation is therefore independent from
    // whether the connection proof itself changes in this transaction.
    await tx.identityBindingChallenge.updateMany({
      where: {
        audienceIdentityId,
        provider: input.provider,
        issuer,
        connectionId,
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    const link = await tx.identityLink.findUnique({
      where: {
        provider_providerSubject: {
          provider: input.provider,
          providerSubject,
        },
      },
      select: {
        id: true,
        audienceIdentityId: true,
        issuer: true,
        connectionId: true,
        revokedAt: true,
      },
    });
    if (
      !link
      || link.audienceIdentityId !== audienceIdentityId
      || normalizeIssuer(link.issuer) !== issuer
    ) {
      return { binding, changed: false };
    }

    let changed = false;
    if (tx.identityLinkConnectionProof) {
      const proof = await tx.identityLinkConnectionProof.findUnique({
        where: {
          identityLinkId_issuer_connectionId: {
            identityLinkId: link.id,
            issuer,
            connectionId,
          },
        },
      });
      const isLegacyConnection =
        !proof
        && link.connectionId?.trim().toLowerCase() === connectionId;
      if (!proof && !isLegacyConnection) {
        return { binding, changed: false };
      }

      if (proof) {
        const revoked = await tx.identityLinkConnectionProof.updateMany({
          where: {
            identityLinkId: link.id,
            issuer,
            connectionId,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        changed = revoked.count === 1;
      }

      const activeProofCount = await tx.identityLinkConnectionProof.count({
        where: {
          identityLinkId: link.id,
          revokedAt: null,
          verifiedAt: { not: null },
          assuranceLevel: {
            in: [
              IdentityAssuranceLevel.PLATFORM_VERIFIED,
              IdentityAssuranceLevel.STEP_UP_VERIFIED,
            ],
          },
        },
      });
      if (activeProofCount === 0 && link.revokedAt === null) {
        await tx.identityLink.update({
          where: { id: link.id },
          data: { revokedAt: now },
        });
        changed = true;
      }
    } else {
      const matchesLegacyConnection =
        link.connectionId?.trim().toLowerCase() === connectionId;
      if (!matchesLegacyConnection) {
        return { binding, changed: false };
      }
      if (link.revokedAt === null) {
        await tx.identityLink.update({
          where: { id: link.id },
          data: { revokedAt: now },
        });
        changed = true;
      }
    }

    return { binding, changed };
  };

  return client.$transaction
    ? runWithPrismaWriteConflictRetry(() =>
        client.$transaction!(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      )
    : run(client);
}

export function hashBindingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function assertBindableProvider(provider: IdentityLinkProvider) {
  if (provider !== IdentityLinkProvider.TELEGRAM && provider !== IdentityLinkProvider.MATRIX) {
    throw new Error("Private-channel binding only supports Telegram or Matrix.");
  }
}

function assertActiveIdentity(identity: { status: IdentityStatus }) {
  if (identity.status === "DISABLED") throw new Error("Audience identity is disabled.");
  if (identity.status === "MERGED") {
    throw new Error("Binding must target the canonical audience identity.");
  }
}

function normalizeProviderSubject(provider: IdentityLinkProvider, value: string): string {
  const subject = requireNonEmpty(value, "Provider subject");
  if (provider === IdentityLinkProvider.TELEGRAM) {
    if (!/^[1-9]\d{0,19}$/.test(subject)) {
      throw new Error("Telegram provider subject must be a numeric user id.");
    }
    return subject;
  }
  if (provider === IdentityLinkProvider.MATRIX) {
    if (!/^@[^\s:]+:[^\s:]+$/.test(subject)) {
      throw new Error("Matrix provider subject must be a full MXID.");
    }
    const separator = subject.lastIndexOf(":");
    return `${subject.slice(0, separator)}:${subject.slice(separator + 1).toLowerCase()}`;
  }
  return subject;
}

function normalizeIssuer(value?: string): string {
  return (value?.trim().toLowerCase() || "delegate").slice(0, 255);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeConnectionId(value: string): string {
  return requireNonEmpty(value, "Connection id").toLowerCase().slice(0, 255);
}

function normalizeTtlSeconds(value?: number): number {
  const ttl = value ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_CHALLENGE_TTL_SECONDS) {
    throw new Error("Binding challenge TTL must be between 60 and 1800 seconds.");
  }
  return ttl;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
