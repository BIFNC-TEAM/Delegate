import { createHash, randomBytes } from "node:crypto";

import {
  IdentityAssuranceLevel,
  IdentityLinkProvider,
  Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import {
  normalizeMatrixServerName,
  normalizeMatrixUserId,
} from "./matrix-identifiers";
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
  verifiedAt: Date | null;
  assuranceLevel: IdentityAssuranceLevel;
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
  $queryRaw?<T = unknown>(query: Prisma.Sql): Promise<T>;
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
        id: string;
        audienceIdentityId: string;
        provider: IdentityLinkProvider;
        providerSubject: string;
        issuer: string;
        connectionId: string | null;
        verifiedAt: Date | null;
        assuranceLevel: IdentityAssuranceLevel;
        revokedAt: Date | null;
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
  challengeId: string;
  token: string;
  expiresAt: string;
  provider: IdentityLinkProvider;
  issuer: string;
  connectionId: string;
};

export type IdentityBindingChallengeStatus =
  | "PENDING"
  | "CONSUMED"
  | "EXPIRED"
  | "REVOKED";

export type IdentityBindingChallengeSnapshot = {
  challengeId: string;
  status: IdentityBindingChallengeStatus;
  expiresAt: string;
  providerSubject?: string;
};

export type GetIdentityBindingChallengeStatusInput = {
  audienceIdentityId: string;
  challengeId: string;
  now?: Date;
};

type ConsumeIdentityBindingChallengeScope = {
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer?: string;
  connectionId: string;
  proofMetadata?: Record<string, unknown>;
};

export type ConsumeIdentityBindingChallengeInput =
  ConsumeIdentityBindingChallengeScope
  & (
    | { token: string; tokenHash?: never }
    | { token?: never; tokenHash: string }
  );

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

/**
 * Serializes every Matrix proof mutation and final outbound proof check for one
 * Delegate audience identity on one Application Service connection.
 *
 * Callers that also hold representative/room locks must acquire this lock
 * last: representative -> room -> audience connection.
 */
export async function lockMatrixAudienceConnectionScope(
  client: Pick<Prisma.TransactionClient, "$executeRaw">,
  input: {
    audienceIdentityId: string;
    connectionId: string;
  },
) {
  const audienceIdentityId = requireNonEmpty(
    input.audienceIdentityId,
    "Audience identity id",
  );
  const connectionId = normalizeConnectionId(input.connectionId);
  await client.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`matrix-audience-connection:${audienceIdentityId}:${connectionId}`})
    )
  `;
}

export async function hasActiveMatrixAudienceConnectionProof(
  input: {
    audienceIdentityId: string | null;
    providerSubject: string;
    issuer: string;
    connectionId: string;
  },
  client: Pick<
    Prisma.TransactionClient,
    "identityLink" | "identityLinkConnectionProof"
  > = prisma,
): Promise<boolean> {
  const audienceIdentityId = input.audienceIdentityId?.trim();
  const providerSubject = normalizeMatrixUserId(input.providerSubject);
  const issuer = normalizeMatrixServerName(input.issuer);
  const connectionId = normalizeConnectionId(input.connectionId);
  if (!audienceIdentityId || !issuer || !connectionId) return false;

  const identityLink = await client.identityLink.findUnique({
    where: {
      provider_providerSubject: {
        provider: IdentityLinkProvider.MATRIX,
        providerSubject,
      },
    },
    select: {
      id: true,
      audienceIdentityId: true,
      issuer: true,
      verifiedAt: true,
      assuranceLevel: true,
      revokedAt: true,
    },
  });
  if (
    !identityLink
    || identityLink.audienceIdentityId !== audienceIdentityId
    || identityLink.issuer.trim() !== issuer
    || identityLink.revokedAt
    || !identityLink.verifiedAt
    || (
      identityLink.assuranceLevel
        !== IdentityAssuranceLevel.PLATFORM_VERIFIED
      && identityLink.assuranceLevel
        !== IdentityAssuranceLevel.STEP_UP_VERIFIED
    )
  ) {
    return false;
  }

  const proof = await client.identityLinkConnectionProof.findUnique({
    where: {
      identityLinkId_issuer_connectionId: {
        identityLinkId: identityLink.id,
        issuer,
        connectionId,
      },
    },
    select: {
      verifiedAt: true,
      assuranceLevel: true,
      revokedAt: true,
    },
  });
  return Boolean(
    proof
    && !proof.revokedAt
    && proof.verifiedAt
    && (
      proof.assuranceLevel === IdentityAssuranceLevel.PLATFORM_VERIFIED
      || proof.assuranceLevel === IdentityAssuranceLevel.STEP_UP_VERIFIED
    ),
  );
}

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
    && isVerifiedAssuranceLevel(binding.assuranceLevel)
  );
}

function isVerifiedAssuranceLevel(
  assuranceLevel: IdentityAssuranceLevel,
): boolean {
  return assuranceLevel === IdentityAssuranceLevel.PLATFORM_VERIFIED
    || assuranceLevel === IdentityAssuranceLevel.STEP_UP_VERIFIED;
}

/**
 * Reads the lifecycle of one challenge without exposing the challenge secret
 * or allowing another authenticated audience identity to probe its state.
 */
export async function getIdentityBindingChallengeStatus(
  input: GetIdentityBindingChallengeStatusInput,
  client: AudienceBindingClient = prisma as unknown as AudienceBindingClient,
): Promise<IdentityBindingChallengeSnapshot | null> {
  const audienceIdentityId = requireNonEmpty(
    input.audienceIdentityId,
    "Audience identity id",
  );
  const challengeId = requireNonEmpty(input.challengeId, "Binding challenge id");
  const challenge = await client.identityBindingChallenge.findUnique({
    where: { id: challengeId },
    select: {
      id: true,
      audienceIdentityId: true,
      expiresAt: true,
      consumedAt: true,
      revokedAt: true,
      expectedProviderSubject: true,
      metadata: true,
    },
  });
  if (!challenge || challenge.audienceIdentityId !== audienceIdentityId) {
    return null;
  }

  const now = input.now ?? new Date();
  const status: IdentityBindingChallengeStatus = challenge.consumedAt
    ? "CONSUMED"
    : challenge.revokedAt
      ? "REVOKED"
      : challenge.expiresAt.getTime() <= now.getTime()
        ? "EXPIRED"
        : "PENDING";
  const consumedProviderSubject =
    status === "CONSUMED"
      ? readConsumedProviderSubject(challenge.metadata)
        ?? challenge.expectedProviderSubject
      : null;
  return {
    challengeId: challenge.id,
    status,
    expiresAt: challenge.expiresAt.toISOString(),
    ...(consumedProviderSubject
      ? { providerSubject: consumedProviderSubject }
      : {}),
  };
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
  const issuer = normalizeIssuer(input.provider, input.issuer);
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
        // A Matrix connection can accept federated MXIDs from many issuers.
        // The newest command for that representative connection replaces any
        // older command, including one minted for another homeserver.
        ...(input.provider === IdentityLinkProvider.MATRIX ? {} : { issuer }),
        connectionId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
    return tx.identityBindingChallenge.create({
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

  const challenge = client.$transaction
    ? await runWithPrismaWriteConflictRetry(() =>
      client.$transaction!(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
    )
    : await run(client);

  return {
    challengeId: challenge.id,
    token,
    expiresAt: expiresAt.toISOString(),
    provider: input.provider,
    issuer,
    connectionId,
  };
}

/**
 * Consumes a challenge exactly once and binds the verified provider subject to
 * the canonical Delegate identity. An exact replay may recover the committed
 * result while its connection proof remains active, so channel post-actions can
 * be retried without allowing another account or adapter scope to reuse it.
 */
export async function consumeIdentityBindingChallenge(
  input: ConsumeIdentityBindingChallengeInput,
  client: AudienceBindingClient = prisma as unknown as AudienceBindingClient,
): Promise<IdentityBindingResult> {
  const tokenHash = input.tokenHash === undefined
    ? hashBindingToken(requireNonEmpty(input.token, "Binding token"))
    : normalizeBindingTokenHash(input.tokenHash);
  const issuer = normalizeIssuer(input.provider, input.issuer);
  const connectionId = normalizeConnectionId(input.connectionId);
  const providerSubject = normalizeProviderSubject(input.provider, input.providerSubject);
  assertBindableProvider(input.provider);

  const run = async (tx: AudienceBindingClient): Promise<IdentityBindingResult> => {
    const now = new Date();
    const challenge = await tx.identityBindingChallenge.findUnique({
      where: { tokenHash },
    });
    if (!challenge) throw new Error("Binding challenge is invalid.");
    if (
      challenge.provider !== input.provider ||
      challenge.issuer !== issuer ||
      challenge.connectionId !== connectionId
    ) {
      throw new Error("Binding challenge does not match this provider.");
    }
    if (input.provider === IdentityLinkProvider.MATRIX) {
      await lockMatrixAudienceConnectionScopeIfAvailable(tx, {
        audienceIdentityId: challenge.audienceIdentityId,
        connectionId,
      });
    }
    if (challenge.consumedAt) {
      return replayConsumedIdentityBindingChallenge({
        tx,
        challenge,
        providerSubject,
        issuer,
        connectionId,
      });
    }
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
      data: {
        consumedAt: now,
        metadata: {
          ...(isRecord(challenge.metadata) ? challenge.metadata : {}),
          consumedProviderSubject: providerSubject,
        },
      },
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
      if (input.provider === IdentityLinkProvider.MATRIX) {
        await replaceMatrixBindingWithinConnection({
          tx,
          audienceIdentityId: identity.id,
          activeIdentityLinkId: identityLink.id,
          connectionId,
          now,
        });
      }
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

async function replayConsumedIdentityBindingChallenge(input: {
  tx: AudienceBindingClient;
  challenge: BindingChallengeRecord;
  providerSubject: string;
  issuer: string;
  connectionId: string;
}): Promise<IdentityBindingResult> {
  const alreadyUsed = () =>
    new Error("Binding challenge has already been used.");
  if (
    readConsumedProviderSubject(input.challenge.metadata)
      !== input.providerSubject
  ) {
    throw alreadyUsed();
  }

  const [identity, link] = await Promise.all([
    input.tx.audienceIdentity.findUnique({
      where: { id: input.challenge.audienceIdentityId },
      select: { id: true, status: true },
    }),
    input.tx.identityLink.findUnique({
      where: {
        provider_providerSubject: {
          provider: input.challenge.provider,
          providerSubject: input.providerSubject,
        },
      },
      select: {
        id: true,
        audienceIdentityId: true,
        issuer: true,
        connectionId: true,
        verifiedAt: true,
        assuranceLevel: true,
        revokedAt: true,
      },
    }),
  ]);
  if (
    !identity
    || identity.status !== "REGISTERED"
    || !link
    || link.audienceIdentityId !== identity.id
    || link.issuer !== input.issuer
    || link.revokedAt !== null
    || link.verifiedAt === null
    || !isVerifiedAssuranceLevel(link.assuranceLevel)
  ) {
    throw alreadyUsed();
  }

  let verifiedAt = link.verifiedAt;
  if (input.tx.identityLinkConnectionProof) {
    const proof = await input.tx.identityLinkConnectionProof.findUnique({
      where: {
        identityLinkId_issuer_connectionId: {
          identityLinkId: link.id,
          issuer: input.issuer,
          connectionId: input.connectionId,
        },
      },
    });
    if (
      !proof
      || proof.revokedAt !== null
      || proof.verifiedAt === null
      || !isVerifiedAssuranceLevel(proof.assuranceLevel)
    ) {
      throw alreadyUsed();
    }
    verifiedAt = proof.verifiedAt;
  } else if (
    link.connectionId?.trim().toLowerCase() !== input.connectionId
  ) {
    throw alreadyUsed();
  }

  return {
    audienceIdentityId: identity.id,
    provider: input.challenge.provider,
    providerSubject: input.providerSubject,
    issuer: input.issuer,
    verifiedAt: verifiedAt.toISOString(),
    ...(isRecord(input.challenge.metadata)
      ? { metadata: input.challenge.metadata }
      : {}),
  };
}

async function replaceMatrixBindingWithinConnection(input: {
  tx: AudienceBindingClient;
  audienceIdentityId: string;
  activeIdentityLinkId: string;
  connectionId: string;
  now: Date;
}) {
  const { tx } = input;
  if (!tx.identityLink.findMany || !tx.identityLinkConnectionProof) {
    throw new Error(
      "Matrix connection replacement is unavailable for this persistence client.",
    );
  }

  const links = await tx.identityLink.findMany({
    where: {
      audienceIdentityId: input.audienceIdentityId,
      provider: IdentityLinkProvider.MATRIX,
      revokedAt: null,
    },
    select: {
      id: true,
      audienceIdentityId: true,
      provider: true,
      providerSubject: true,
      issuer: true,
      connectionId: true,
      verifiedAt: true,
      assuranceLevel: true,
      revokedAt: true,
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
      },
    },
  });

  for (const link of links) {
    if (
      link.id === input.activeIdentityLinkId
      || link.audienceIdentityId !== input.audienceIdentityId
      || link.provider !== IdentityLinkProvider.MATRIX
      || link.revokedAt !== null
    ) {
      continue;
    }

    const proofs = link.connectionProofs ?? [];
    const matchingProofs = proofs.filter(
      (proof) =>
        proof.connectionId === input.connectionId
        && proof.revokedAt === null
        && proof.verifiedAt !== null
        && (
          proof.assuranceLevel === IdentityAssuranceLevel.PLATFORM_VERIFIED
          || proof.assuranceLevel === IdentityAssuranceLevel.STEP_UP_VERIFIED
        ),
    );
    const isLegacyConnection =
      proofs.length === 0
      && link.connectionId?.trim().toLowerCase() === input.connectionId;
    if (matchingProofs.length === 0 && !isLegacyConnection) {
      continue;
    }

    // Exact-evidence readers always lock the parent link before its proof.
    // Mutations must use the same order or a reader holding LINK SHARE while
    // waiting for PROOF SHARE can deadlock with a writer holding PROOF UPDATE
    // while waiting to revoke the parent link.
    if (!await lockIdentityLinkForMutationIfAvailable(tx, link.id)) {
      continue;
    }
    for (const proof of matchingProofs) {
      if (!await lockIdentityConnectionProofForMutationIfAvailable(tx, {
        identityLinkId: link.id,
        issuer: proof.issuer,
        connectionId: proof.connectionId,
      })) {
        continue;
      }
      await tx.identityLinkConnectionProof.updateMany({
        where: {
          identityLinkId: link.id,
          issuer: proof.issuer,
          connectionId: proof.connectionId,
          revokedAt: null,
        },
        data: { revokedAt: input.now },
      });
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
    if (activeProofCount === 0) {
      await tx.identityLink.update({
        where: { id: link.id },
        data: { revokedAt: input.now },
      });
    }
  }
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
  const issuer = normalizeIssuer(input.provider, input.issuer);
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
    if (input.provider === IdentityLinkProvider.MATRIX) {
      await lockMatrixAudienceConnectionScopeIfAvailable(tx, {
        audienceIdentityId,
        connectionId,
      });
    }

    // A retrying DELETE must also invalidate a challenge created after an
    // earlier unlink. Challenge revocation is therefore independent from
    // whether the connection proof itself changes in this transaction.
    await tx.identityBindingChallenge.updateMany({
      where: {
        audienceIdentityId,
        provider: input.provider,
        // Matrix adapters accept federated MXIDs, so unlinking one proof must
        // invalidate every pending command for this representative connection,
        // including a replacement minted for another homeserver.
        ...(input.provider === IdentityLinkProvider.MATRIX ? {} : { issuer }),
        connectionId,
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    let link = await tx.identityLink.findUnique({
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
      || normalizeIssuer(input.provider, link.issuer) !== issuer
    ) {
      return { binding, changed: false };
    }
    if (!await lockIdentityLinkForMutationIfAvailable(tx, link.id)) {
      return { binding, changed: false };
    }
    // Re-read after acquiring LINK UPDATE so a concurrent rebind cannot make
    // the pre-lock snapshot authoritative for this unlink attempt.
    link = await tx.identityLink.findUnique({
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
      || normalizeIssuer(input.provider, link.issuer) !== issuer
    ) {
      return { binding, changed: false };
    }

    let changed = false;
    if (tx.identityLinkConnectionProof) {
      const proofLocked =
        await lockIdentityConnectionProofForMutationIfAvailable(tx, {
          identityLinkId: link.id,
          issuer,
          connectionId,
        });
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
      if ((!proof || !proofLocked) && !isLegacyConnection) {
        return { binding, changed: false };
      }

      if (proof && proofLocked) {
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

async function lockIdentityLinkForMutationIfAvailable(
  client: AudienceBindingClient,
  identityLinkId: string,
): Promise<boolean> {
  if (typeof client.$queryRaw !== "function") return true;
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "IdentityLink"
    WHERE "id" = ${identityLinkId}
    FOR UPDATE
  `);
  return rows.length === 1;
}

async function lockIdentityConnectionProofForMutationIfAvailable(
  client: AudienceBindingClient,
  input: {
    identityLinkId: string;
    issuer: string;
    connectionId: string;
  },
): Promise<boolean> {
  if (typeof client.$queryRaw !== "function") return true;
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "IdentityLinkConnectionProof"
    WHERE "identityLinkId" = ${input.identityLinkId}
      AND "issuer" = ${input.issuer}
      AND "connectionId" = ${input.connectionId}
    FOR UPDATE
  `);
  return rows.length === 1;
}

async function lockMatrixAudienceConnectionScopeIfAvailable(
  client: AudienceBindingClient,
  input: {
    audienceIdentityId: string;
    connectionId: string;
  },
) {
  const lockClient = client as AudienceBindingClient
    & Partial<Pick<Prisma.TransactionClient, "$executeRaw">>;
  if (typeof lockClient.$executeRaw !== "function") return;
  await lockMatrixAudienceConnectionScope(
    lockClient as AudienceBindingClient
      & Pick<Prisma.TransactionClient, "$executeRaw">,
    input,
  );
}

function normalizeBindingTokenHash(value: string): string {
  const tokenHash = requireNonEmpty(value, "Binding token hash").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new Error("Binding token hash is invalid.");
  }
  return tokenHash;
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
    return normalizeMatrixUserId(subject);
  }
  return subject;
}

function normalizeIssuer(
  provider: IdentityLinkProvider,
  value?: string,
): string {
  const issuer = value?.trim() || "delegate";
  return provider === IdentityLinkProvider.MATRIX
    ? normalizeMatrixServerName(issuer)
    : issuer.toLowerCase().slice(0, 255);
}

function readConsumedProviderSubject(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const value = metadata.consumedProviderSubject;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
