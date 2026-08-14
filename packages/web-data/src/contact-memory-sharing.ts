import { createHash, randomBytes } from "node:crypto";

import {
  AudienceIdentityStatus,
  ContactMemorySharingConsentStatus,
  ContactMemorySharingSourceEventRole,
  IdentityAssuranceLevel,
  IdentityLinkProvider,
  Prisma,
  RepresentativeChannelKind,
  type PrismaClient,
} from "@prisma/client";

import { contactMemorySharingConsentContractVersion } from "./memory-disclosure";
import { resolveAndLockIngressIdentityProvenance } from "./contact-memory-source-evidence";
import {
  lockContactSharedMemoryCoordinate,
  requestAutomaticContactSharedMemoryDeletionInTransaction,
} from "./memory-governance";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

const maximumIdentityMergeDepth = 32;
const sharingRevocationReasonCode = "contact_cross_channel_sharing_revoked";
const contactMemorySharingChallengeTtlMs = 10 * 60_000;
const contactMemorySharingChallengeTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export type ContactMemorySharingSourceEvidence =
  | {
      sourceChannel: "WEB";
      providerSubject: string;
      issuer: string;
      connectionId: string;
      sourceIdentityLinkId: string;
    }
  | {
      sourceChannel: "MATRIX" | "TELEGRAM";
      providerSubject: string;
      issuer: string;
      connectionId: string;
    };

export type ContactMemorySharingBlockedReason =
  | "policy_disabled"
  | "identity_ineligible"
  | "consent_missing"
  | "consent_stale"
  | "user_disabled";

export type DeterministicContactMemorySharingCommand =
  | "DISCLOSE"
  | "GRANT"
  | "INVALID_CONFIRM"
  | "REVOKE";

export function resolveDeterministicContactMemorySharingCommand(
  text: string,
): DeterministicContactMemorySharingCommand | null {
  const normalized = text.trim().replace(/\s+/gu, " ");
  const lower = normalized.toLowerCase();
  if (lower === "!memory_share") return "DISCLOSE";
  if (lower === "!memory_unshare") return "REVOKE";
  if (lower.startsWith("!memory_share confirm")) {
    return readContactMemorySharingChallengeToken(
      normalized.slice("!memory_share ".length),
    )
      ? "GRANT"
      : "INVALID_CONFIRM";
  }
  return null;
}

export function readContactMemorySharingChallengeToken(value: string) {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const match = normalized.match(/^confirm ([A-Za-z0-9_-]{43})$/u);
  return match?.[1] ?? null;
}

export type ContactMemorySharingState = {
  supported: true;
  policyEnabled: boolean;
  active: boolean;
  contractVersion: typeof contactMemorySharingConsentContractVersion;
  grantedAt: string | null;
  sourceChannel: RepresentativeChannelKind | null;
  blockedReason: ContactMemorySharingBlockedReason | null;
};

export type ContactMemorySharingErrorCode =
  | "contact_memory_sharing_invalid_input"
  | "contact_memory_sharing_representative_not_found"
  | "contact_memory_sharing_policy_disabled"
  | "contact_memory_sharing_identity_ineligible"
  | "contact_memory_sharing_source_unverified"
  | "contact_memory_sharing_contract_mismatch"
  | "contact_memory_sharing_challenge_invalid"
  | "contact_memory_sharing_challenge_expired"
  | "contact_memory_sharing_challenge_consumed"
  | "contact_memory_sharing_conflict";

export class ContactMemorySharingError extends Error {
  constructor(
    readonly code: ContactMemorySharingErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ContactMemorySharingError";
  }
}

type SharingCoordinates = {
  representativeId: string;
  representativeSlug: string;
  audienceIdentityId: string;
};

export async function getContactMemorySharingState(
  input: {
    representativeSlug: string;
    audienceIdentityId: string;
  },
  options: { client?: PrismaClient } = {},
): Promise<ContactMemorySharingState> {
  const client = options.client ?? prisma;
  const coordinates = await resolveSharingCoordinates(client, input);
  const [policy, identity] = await Promise.all([
    client.representativeMemoryPolicy.findUnique({
      where: { representativeId: coordinates.representativeId },
      select: {
        revision: true,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
      },
    }),
    client.audienceIdentity.findUnique({
      where: { id: coordinates.audienceIdentityId },
      select: { status: true },
    }),
  ]);
  const policyEnabled = Boolean(
    policy?.longTermMemoryEnabled
    && policy.contactMemoryEnabled,
  );
  if (identity?.status !== AudienceIdentityStatus.REGISTERED) {
    return sharingState({
      policyEnabled,
      blockedReason: "identity_ineligible",
    });
  }
  if (!policyEnabled || !policy) {
    return sharingState({
      policyEnabled: false,
      blockedReason: "policy_disabled",
    });
  }
  const [consent, latestPreference] = await Promise.all([
    client.contactMemorySharingConsent.findFirst({
      where: {
        representativeId: coordinates.representativeId,
        audienceIdentityId: coordinates.audienceIdentityId,
        policyRevision: policy.revision,
      },
      orderBy: [{ consentVersion: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        status: true,
        grantedAt: true,
        revokedAt: true,
        consentVersion: true,
        disclosureContractVersion: true,
        sourceChannel: true,
        challengeId: true,
        sourceEvidenceHash: true,
        confirmationEventHash: true,
        proofHash: true,
        sourceEventClaim: {
          select: {
            eventHash: true,
            role: true,
            representativeId: true,
            audienceIdentityId: true,
            sourceChannel: true,
            challengeId: true,
            consentId: true,
          },
        },
        challenge: {
          select: {
            id: true,
            representativeId: true,
            audienceIdentityId: true,
            sourceChannel: true,
            policyRevision: true,
            disclosureContractVersion: true,
            sourceEvidenceHash: true,
            disclosureEventHash: true,
            createdAt: true,
            expiresAt: true,
            consumedAt: true,
            revokedAt: true,
            sourceEventClaims: {
              where: {
                role: ContactMemorySharingSourceEventRole.DISCLOSURE,
              },
              select: {
                eventHash: true,
                role: true,
                representativeId: true,
                audienceIdentityId: true,
                sourceChannel: true,
                challengeId: true,
                consentId: true,
              },
            },
          },
        },
      },
    }),
    client.contactMemorySharingConsent.findFirst({
      where: {
        representativeId: coordinates.representativeId,
        audienceIdentityId: coordinates.audienceIdentityId,
      },
      orderBy: [
        { updatedAt: "desc" },
        { createdAt: "desc" },
        { consentVersion: "desc" },
      ],
      select: { status: true, revokedAt: true },
    }),
  ]);
  if (
    latestPreference?.status === ContactMemorySharingConsentStatus.REVOKED
    || latestPreference?.revokedAt
  ) {
    return sharingState({
      policyEnabled: true,
      blockedReason: "user_disabled",
    });
  }
  if (!consent) {
    return sharingState({ policyEnabled: true, blockedReason: "consent_missing" });
  }
  const active = consent.status === ContactMemorySharingConsentStatus.GRANTED
    && consent.revokedAt === null
    && consent.consentVersion >= 1
    && consent.disclosureContractVersion
      === contactMemorySharingConsentContractVersion
    && Boolean(consent.challengeId)
    && /^[0-9a-f]{64}$/u.test(consent.sourceEvidenceHash ?? "")
    && /^[0-9a-f]{64}$/u.test(consent.confirmationEventHash ?? "")
    && /^[0-9a-f]{64}$/u.test(consent.proofHash)
    && consent.challenge?.representativeId === coordinates.representativeId
    && consent.challenge.audienceIdentityId
      === coordinates.audienceIdentityId
    && consent.challenge.sourceChannel === consent.sourceChannel
    && consent.challenge.policyRevision === policy.revision
    && consent.challenge.disclosureContractVersion
      === contactMemorySharingConsentContractVersion
    && consent.challenge.sourceEvidenceHash === consent.sourceEvidenceHash
    && Boolean(consent.challenge.consumedAt)
    && consent.challenge.consumedAt! >= consent.challenge.createdAt
    && consent.challenge.consumedAt! <= consent.challenge.expiresAt
    && consent.grantedAt >= consent.challenge.consumedAt!
    && consent.challenge.revokedAt === null
    && consent.challenge.sourceEventClaims.some((claim) =>
      claim.eventHash === consent.challenge?.disclosureEventHash
      && claim.role === ContactMemorySharingSourceEventRole.DISCLOSURE
      && claim.representativeId === coordinates.representativeId
      && claim.audienceIdentityId === coordinates.audienceIdentityId
      && claim.sourceChannel === consent.sourceChannel
      && claim.challengeId === consent.challengeId
      && claim.consentId === null
    )
    && consent.sourceEventClaim?.eventHash === consent.confirmationEventHash
    && consent.sourceEventClaim.role
      === ContactMemorySharingSourceEventRole.CONFIRMATION
    && consent.sourceEventClaim.representativeId
      === coordinates.representativeId
    && consent.sourceEventClaim.audienceIdentityId
      === coordinates.audienceIdentityId
    && consent.sourceEventClaim.sourceChannel === consent.sourceChannel
    && consent.sourceEventClaim.challengeId === consent.challengeId
    && consent.sourceEventClaim.consentId === consent.id;
  return {
    ...sharingState({
      policyEnabled: true,
      blockedReason: active ? null : "consent_stale",
    }),
    active,
    grantedAt: active ? consent.grantedAt.toISOString() : null,
    sourceChannel: active ? consent.sourceChannel : null,
  };
}

export async function createContactMemorySharingChallenge(
  input: {
    representativeSlug: string;
    audienceIdentityId: string;
    disclosureContractVersion: string;
    sourceEventKey: string;
  } & ContactMemorySharingSourceEvidence,
  options: {
    client?: PrismaClient;
    now?: () => Date;
    generateToken?: () => string;
  } = {},
) {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(
    () => client.$transaction(
      (tx) => createContactMemorySharingChallengeInTransaction(tx, input, {
        ...(options.now ? { now: options.now } : {}),
        ...(options.generateToken
          ? { generateToken: options.generateToken }
          : {}),
      }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
    { additionalRetryableCodes: ["P2002"] },
  ).catch(normalizeSharingWriteError);
}

export async function createContactMemorySharingChallengeInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    representativeSlug: string;
    audienceIdentityId: string;
    disclosureContractVersion: string;
    sourceEventKey: string;
  } & ContactMemorySharingSourceEvidence,
  options: { now?: () => Date; generateToken?: () => string } = {},
) {
  if (
    input.disclosureContractVersion
      !== contactMemorySharingConsentContractVersion
  ) {
    throw new ContactMemorySharingError(
      "contact_memory_sharing_contract_mismatch",
      "The cross-channel memory disclosure changed. Review the current disclosure before granting consent.",
      422,
    );
  }
  const occurredAt = options.now?.() ?? new Date();
  if (!Number.isFinite(occurredAt.getTime())) {
    throw invalidInput("now must produce a valid date.");
  }
  const sourceEventHash = hashSourceEventKey(input.sourceEventKey);
  const coordinates = await resolveSharingCoordinates(tx, input);
  const lockedSource = await lockVerifiedSharingSourceBeforeSharedCoordinate(
    tx,
    coordinates,
    input,
  );
  await lockContactSharedMemoryCoordinate(tx, coordinates);
  const [policy, identity] = await Promise.all([
    tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: coordinates.representativeId },
      select: {
        revision: true,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
      },
    }),
    tx.audienceIdentity.findUnique({
      where: { id: coordinates.audienceIdentityId },
      select: { status: true },
    }),
  ]);
  assertSharingPolicyAndIdentity(policy, identity);
  const verifiedSource = await resolveVerifiedSharingSource(
    tx,
    coordinates,
    input,
  );
  assertLockedSourceMatches(lockedSource, verifiedSource);
  const token = options.generateToken?.()
    ?? randomBytes(32).toString("base64url");
  if (!contactMemorySharingChallengeTokenPattern.test(token)) {
    throw invalidInput("Challenge token generator returned an invalid token.");
  }
  const expiresAt = new Date(
    occurredAt.getTime() + contactMemorySharingChallengeTtlMs,
  );
  const sourceChannel = toRepresentativeChannel(input.sourceChannel);
  await tx.contactMemorySharingChallenge.updateMany({
    where: {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      sourceChannel,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: occurredAt },
    },
    data: { revokedAt: occurredAt },
  });
  const challenge = await tx.contactMemorySharingChallenge.create({
    data: {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      sourceChannel,
      policyRevision: policy!.revision,
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      tokenHash: sha256(token),
      sourceEvidenceHash: verifiedSource.sourceEvidenceHash,
      disclosureEventHash: sourceEventHash,
      expiresAt,
      createdAt: occurredAt,
    },
    select: { id: true, expiresAt: true },
  });
  await tx.contactMemorySharingSourceEventClaim.create({
    data: {
      eventHash: sourceEventHash,
      role: ContactMemorySharingSourceEventRole.DISCLOSURE,
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      sourceChannel,
      challengeId: challenge.id,
      consentId: null,
      createdAt: occurredAt,
    },
  });
  return {
    challengeToken: token,
    challengeExpiresAt: challenge.expiresAt.toISOString(),
    contractVersion: contactMemorySharingConsentContractVersion,
  };
}

export async function grantContactMemorySharingConsent(
  input: {
    representativeSlug: string;
    audienceIdentityId: string;
    challengeToken: string;
    sourceEventKey: string;
  } & ContactMemorySharingSourceEvidence,
  options: { client?: PrismaClient; now?: () => Date } = {},
) {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(
    () => client.$transaction(
      (tx) => grantContactMemorySharingConsentInTransaction(tx, input, {
        ...(options.now ? { now: options.now } : {}),
      }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
    { additionalRetryableCodes: ["P2002"] },
  ).catch(normalizeSharingWriteError);
}

export async function grantContactMemorySharingConsentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    representativeSlug: string;
    audienceIdentityId: string;
    challengeToken: string;
    sourceEventKey: string;
  } & ContactMemorySharingSourceEvidence,
  options: { now?: () => Date } = {},
) {
  const challengeToken = requiredChallengeToken(input.challengeToken);
  const confirmationEventHash = hashSourceEventKey(input.sourceEventKey);
  const occurredAt = options.now?.() ?? new Date();
  if (!Number.isFinite(occurredAt.getTime())) {
    throw invalidInput("now must produce a valid date.");
  }
  const coordinates = await resolveSharingCoordinates(tx, input);
  const lockedSource = await lockVerifiedSharingSourceBeforeSharedCoordinate(
    tx,
    coordinates,
    input,
  );
  await lockContactSharedMemoryCoordinate(tx, coordinates);
  const [policy, identity] = await Promise.all([
    tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: coordinates.representativeId },
      select: {
        revision: true,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
      },
    }),
    tx.audienceIdentity.findUnique({
      where: { id: coordinates.audienceIdentityId },
      select: { status: true },
    }),
  ]);
  assertSharingPolicyAndIdentity(policy, identity);
  const verifiedSource = await resolveVerifiedSharingSource(
    tx,
    coordinates,
    input,
  );
  assertLockedSourceMatches(lockedSource, verifiedSource);
  const tokenHash = sha256(challengeToken);
  const lockedChallenge = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "ContactMemorySharingChallenge"
    WHERE "tokenHash" = ${tokenHash}
    FOR UPDATE
  `);
  if (lockedChallenge.length !== 1) {
    throw invalidChallenge();
  }
  const challenge = await tx.contactMemorySharingChallenge.findUnique({
    where: { id: lockedChallenge[0]!.id },
    select: {
      id: true,
      representativeId: true,
      audienceIdentityId: true,
      sourceChannel: true,
      policyRevision: true,
      disclosureContractVersion: true,
      sourceEvidenceHash: true,
      disclosureEventHash: true,
      expiresAt: true,
      consumedAt: true,
      revokedAt: true,
    },
  });
  if (!challenge || challenge.revokedAt) throw invalidChallenge();
  if (challenge.consumedAt) {
    throw new ContactMemorySharingError(
      "contact_memory_sharing_challenge_consumed",
      "This memory-sharing confirmation was already used. Review the disclosure again.",
      409,
    );
  }
  if (challenge.expiresAt <= occurredAt) {
    throw new ContactMemorySharingError(
      "contact_memory_sharing_challenge_expired",
      "This memory-sharing confirmation expired. Review the disclosure again.",
      410,
    );
  }
  const sourceChannel = toRepresentativeChannel(input.sourceChannel);
  if (
    challenge.representativeId !== coordinates.representativeId
    || challenge.audienceIdentityId !== coordinates.audienceIdentityId
    || challenge.sourceChannel !== sourceChannel
    || challenge.policyRevision !== policy!.revision
    || challenge.disclosureContractVersion
      !== contactMemorySharingConsentContractVersion
    || challenge.sourceEvidenceHash !== verifiedSource.sourceEvidenceHash
    || challenge.disclosureEventHash === confirmationEventHash
  ) {
    throw invalidChallenge();
  }
  const consumed = await tx.contactMemorySharingChallenge.updateMany({
    where: {
      id: challenge.id,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: occurredAt },
    },
    data: { consumedAt: occurredAt },
  });
  if (consumed.count !== 1) throw invalidChallenge();
  const current = await tx.contactMemorySharingConsent.findFirst({
    where: {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      policyRevision: policy.revision,
      status: ContactMemorySharingConsentStatus.GRANTED,
      revokedAt: null,
    },
    orderBy: [{ consentVersion: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      consentVersion: true,
      disclosureContractVersion: true,
      grantedAt: true,
      sourceChannel: true,
      proofHash: true,
    },
  });
  if (current) {
    await tx.contactMemorySharingConsent.update({
      where: { id: current.id },
      data: {
        status: ContactMemorySharingConsentStatus.REVOKED,
        revokedAt: occurredAt,
      },
    });
  }
  const latest = await tx.contactMemorySharingConsent.findFirst({
    where: {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      policyRevision: policy.revision,
    },
    orderBy: [{ consentVersion: "desc" }, { createdAt: "desc" }],
    select: { consentVersion: true },
  });
  const consentVersion = (latest?.consentVersion ?? 0) + 1;
  const proofHash = sha256(JSON.stringify([
    "contact-memory-sharing-consent-v2",
    coordinates.representativeId,
    coordinates.audienceIdentityId,
    policy.revision,
    consentVersion,
    contactMemorySharingConsentContractVersion,
    sourceChannel,
    challenge.id,
    verifiedSource.sourceEvidenceHash,
    challenge.disclosureEventHash,
    confirmationEventHash,
    occurredAt.toISOString(),
  ]));
  const consent = await tx.contactMemorySharingConsent.create({
    data: {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      status: ContactMemorySharingConsentStatus.GRANTED,
      grantedAt: occurredAt,
      policyRevision: policy.revision,
      consentVersion,
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceChannel,
      challengeId: challenge.id,
      sourceEvidenceHash: verifiedSource.sourceEvidenceHash,
      confirmationEventHash,
      proofHash,
    },
    select: { id: true, grantedAt: true, sourceChannel: true },
  });
  await tx.contactMemorySharingSourceEventClaim.create({
    data: {
      eventHash: confirmationEventHash,
      role: ContactMemorySharingSourceEventRole.CONFIRMATION,
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      sourceChannel,
      challengeId: challenge.id,
      consentId: consent.id,
      createdAt: occurredAt,
    },
  });
  return {
    active: true as const,
    replayed: false,
    contractVersion: contactMemorySharingConsentContractVersion,
    grantedAt: consent.grantedAt.toISOString(),
    sourceChannel: consent.sourceChannel,
  };
}

export async function revokeContactMemorySharingConsent(
  input: {
    representativeSlug: string;
    audienceIdentityId: string;
    sourceChannel: "WEB" | "MATRIX" | "TELEGRAM";
  },
  options: { client?: PrismaClient; now?: () => Date } = {},
) {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(
    () => client.$transaction(
      (tx) => revokeContactMemorySharingConsentInTransaction(tx, input, {
        ...(options.now ? { now: options.now } : {}),
      }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
    { additionalRetryableCodes: ["P2002"] },
  ).catch(normalizeSharingWriteError);
}

export async function revokeContactMemorySharingConsentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    representativeSlug: string;
    audienceIdentityId: string;
    sourceChannel: "WEB" | "MATRIX" | "TELEGRAM";
  },
  options: { now?: () => Date } = {},
) {
  const coordinates = await resolveSharingCoordinates(tx, input);
  await lockContactSharedMemoryCoordinate(tx, coordinates);
  const occurredAt = options.now?.() ?? new Date();
  if (!Number.isFinite(occurredAt.getTime())) {
    throw invalidInput("now must produce a valid date.");
  }
  const revokedChallenges = await tx.contactMemorySharingChallenge.updateMany({
    where: {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      consumedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: occurredAt },
  });
  const active = await tx.contactMemorySharingConsent.findMany({
    where: {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      status: ContactMemorySharingConsentStatus.GRANTED,
      revokedAt: null,
    },
    orderBy: [{ policyRevision: "asc" }, { consentVersion: "asc" }],
    select: { id: true },
  });
  for (const consent of active) {
    await tx.contactMemorySharingConsent.update({
      where: { id: consent.id },
      data: {
        status: ContactMemorySharingConsentStatus.REVOKED,
        revokedAt: occurredAt,
      },
    });
  }
  const identityDigest = sha256(coordinates.audienceIdentityId);
  const deletion = await requestAutomaticContactSharedMemoryDeletionInTransaction(
    tx,
    {
      representativeId: coordinates.representativeId,
      audienceIdentityId: coordinates.audienceIdentityId,
      requestId: `sharing-revoke:${identityDigest.slice(0, 32)}`,
      requestedByActorId: `contact:${identityDigest.slice(0, 32)}`,
      reasonCode: sharingRevocationReasonCode,
      occurredAt,
    },
  );
  return {
    active: false as const,
    changed:
      revokedChallenges.count > 0
      || active.length > 0
      || deletion.queuedCount > 0,
    matchedMemoryCount: deletion.matchedCount,
    queuedDeletionCount: deletion.queuedCount,
    replayedDeletionCount: deletion.replayedCount,
  };
}

async function resolveSharingCoordinates(
  client: Pick<Prisma.TransactionClient, "representative" | "audienceIdentity">,
  input: { representativeSlug: string; audienceIdentityId: string },
): Promise<SharingCoordinates> {
  const representativeSlug = requiredText(
    input.representativeSlug,
    "representativeSlug",
  );
  const requestedIdentityId = requiredText(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const representative = await client.representative.findUnique({
    where: { slug: representativeSlug },
    select: { id: true, slug: true },
  });
  if (!representative) {
    throw new ContactMemorySharingError(
      "contact_memory_sharing_representative_not_found",
      "Representative was not found.",
      404,
    );
  }
  const audienceIdentityId = await resolveCanonicalIdentityId(
    client,
    requestedIdentityId,
  );
  return {
    representativeId: representative.id,
    representativeSlug: representative.slug,
    audienceIdentityId,
  };
}

async function resolveCanonicalIdentityId(
  client: Pick<Prisma.TransactionClient, "audienceIdentity">,
  initialId: string,
) {
  const visited = new Set<string>();
  let id = initialId;
  for (let depth = 0; depth < maximumIdentityMergeDepth; depth += 1) {
    if (visited.has(id)) {
      throw new ContactMemorySharingError(
        "contact_memory_sharing_identity_ineligible",
        "Audience identity merge cycle detected.",
        409,
      );
    }
    visited.add(id);
    const identity = await client.audienceIdentity.findUnique({
      where: { id },
      select: { id: true, status: true, mergedIntoId: true },
    });
    if (!identity || identity.status === AudienceIdentityStatus.DISABLED) {
      throw new ContactMemorySharingError(
        "contact_memory_sharing_identity_ineligible",
        "Audience identity is not eligible for cross-channel memory.",
        403,
      );
    }
    if (
      identity.status !== AudienceIdentityStatus.MERGED
      || !identity.mergedIntoId
    ) return identity.id;
    id = identity.mergedIntoId;
  }
  throw new ContactMemorySharingError(
    "contact_memory_sharing_identity_ineligible",
    "Audience identity merge chain is too deep.",
    409,
  );
}

async function resolveVerifiedSharingSource(
  tx: Prisma.TransactionClient,
  coordinates: SharingCoordinates,
  evidence: ContactMemorySharingSourceEvidence,
) {
  const providerSubject = requiredText(
    evidence.providerSubject,
    "providerSubject",
  );
  const issuer = requiredText(evidence.issuer, "issuer").toLowerCase();
  const connectionId = requiredText(
    evidence.connectionId,
    "connectionId",
  ).toLowerCase();
  if (evidence.sourceChannel === "WEB") {
    const sourceIdentityLinkId = requiredText(
      evidence.sourceIdentityLinkId,
      "sourceIdentityLinkId",
    );
    const link = await tx.identityLink.findUnique({
      where: {
        id: sourceIdentityLinkId,
      },
      select: {
        id: true,
        audienceIdentityId: true,
        provider: true,
        providerSubject: true,
        issuer: true,
        connectionId: true,
        assuranceLevel: true,
        verifiedAt: true,
        revokedAt: true,
      },
    });
    if (
      !link
      || link.audienceIdentityId !== coordinates.audienceIdentityId
      || link.provider !== IdentityLinkProvider.LOGTO
      || link.providerSubject !== providerSubject
      || link.issuer.trim().toLowerCase() !== issuer
      || (
        link.connectionId?.trim().toLowerCase()
          ?? `logto-identity-link:${link.id}`
      ) !== connectionId
      || !link.verifiedAt
      || link.revokedAt
      || !isVerifiedAssurance(link.assuranceLevel)
    ) throw sourceUnverified();
    return {
      sourceIdentityLinkId: link.id,
      sourceIdentityConnectionProofId: null,
      sourceEvidenceHash: hashSharingSourceEvidence({
        sourceChannel: evidence.sourceChannel,
        provider: IdentityLinkProvider.LOGTO,
        providerSubject,
        issuer,
        connectionId,
        identityLinkId: link.id,
        connectionProofId: null,
      }),
    };
  }
  const provider = evidence.sourceChannel === "MATRIX"
    ? IdentityLinkProvider.MATRIX
    : IdentityLinkProvider.TELEGRAM;
  const link = await tx.identityLink.findUnique({
    where: { provider_providerSubject: { provider, providerSubject } },
    select: {
      id: true,
      audienceIdentityId: true,
      issuer: true,
      verifiedAt: true,
      revokedAt: true,
      assuranceLevel: true,
    },
  });
  if (
    !link
    || link.audienceIdentityId !== coordinates.audienceIdentityId
    || link.issuer.trim().toLowerCase() !== issuer
    || link.revokedAt
    || !link.verifiedAt
    || !isVerifiedAssurance(link.assuranceLevel)
  ) throw sourceUnverified();
  const proof = await tx.identityLinkConnectionProof.findUnique({
    where: {
      identityLinkId_issuer_connectionId: {
        identityLinkId: link.id,
        issuer,
        connectionId,
      },
    },
    select: {
      id: true,
      verifiedAt: true,
      revokedAt: true,
      assuranceLevel: true,
    },
  });
  if (
    !proof?.verifiedAt
    || proof.revokedAt
    || !isVerifiedAssurance(proof.assuranceLevel)
  ) throw sourceUnverified();
  return {
    sourceIdentityLinkId: link.id,
    sourceIdentityConnectionProofId: proof.id,
    sourceEvidenceHash: hashSharingSourceEvidence({
      sourceChannel: evidence.sourceChannel,
      provider,
      providerSubject,
      issuer,
      connectionId,
      identityLinkId: link.id,
      connectionProofId: proof.id,
    }),
  };
}

async function lockVerifiedSharingSourceBeforeSharedCoordinate(
  tx: Prisma.TransactionClient,
  coordinates: SharingCoordinates,
  evidence: ContactMemorySharingSourceEvidence,
) {
  const locked = await resolveAndLockIngressIdentityProvenance(tx, {
    sourceChannel: toRepresentativeChannel(evidence.sourceChannel),
    audienceIdentityId: coordinates.audienceIdentityId,
    senderId: evidence.providerSubject,
    connectionId: evidence.connectionId,
    ...(evidence.sourceChannel === "WEB"
      ? { webIdentityLinkId: evidence.sourceIdentityLinkId }
      : {}),
  });
  if (!locked) throw sourceUnverified();
  return locked;
}

function assertLockedSourceMatches(
  locked: {
    sourceIdentityLinkId: string;
    sourceIdentityConnectionProofId: string | null;
  },
  verified: {
    sourceIdentityLinkId: string;
    sourceIdentityConnectionProofId: string | null;
  },
) {
  if (
    locked.sourceIdentityLinkId !== verified.sourceIdentityLinkId
    || locked.sourceIdentityConnectionProofId
      !== verified.sourceIdentityConnectionProofId
  ) throw sourceUnverified();
}

function hashSharingSourceEvidence(input: {
  sourceChannel: ContactMemorySharingSourceEvidence["sourceChannel"];
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer: string;
  connectionId: string;
  identityLinkId: string;
  connectionProofId: string | null;
}) {
  return sha256(JSON.stringify([
    "contact-memory-sharing-source-v1",
    input.sourceChannel,
    input.provider,
    input.providerSubject,
    input.issuer,
    input.connectionId,
    input.identityLinkId,
    input.connectionProofId,
  ]));
}

function isVerifiedAssurance(value: IdentityAssuranceLevel) {
  return value === IdentityAssuranceLevel.PLATFORM_VERIFIED
    || value === IdentityAssuranceLevel.STEP_UP_VERIFIED;
}

function assertSharingPolicyAndIdentity(
  policy: {
    revision: number;
    longTermMemoryEnabled: boolean;
    contactMemoryEnabled: boolean;
  } | null,
  identity: { status: AudienceIdentityStatus } | null,
): asserts policy is NonNullable<typeof policy> {
  if (
    !policy?.longTermMemoryEnabled
    || !policy.contactMemoryEnabled
  ) {
    throw new ContactMemorySharingError(
      "contact_memory_sharing_policy_disabled",
      "Cross-channel Contact Memory is not enabled for this representative.",
      409,
    );
  }
  if (identity?.status !== AudienceIdentityStatus.REGISTERED) {
    throw new ContactMemorySharingError(
      "contact_memory_sharing_identity_ineligible",
      "A registered Delegate identity is required for cross-channel memory.",
      403,
    );
  }
}

function sourceUnverified() {
  return new ContactMemorySharingError(
    "contact_memory_sharing_source_unverified",
    "The current channel is not verified for this Delegate identity.",
    403,
  );
}

function requiredChallengeToken(value: string) {
  const normalized = requiredText(value, "challengeToken");
  if (!contactMemorySharingChallengeTokenPattern.test(normalized)) {
    throw invalidChallenge();
  }
  return normalized;
}

function hashSourceEventKey(value: string) {
  const normalized = requiredText(value, "sourceEventKey");
  if (normalized.length > 2_048) {
    throw invalidInput("sourceEventKey is too long.");
  }
  return sha256(JSON.stringify([
    "contact-memory-sharing-source-event-v1",
    normalized,
  ]));
}

function invalidChallenge() {
  return new ContactMemorySharingError(
    "contact_memory_sharing_challenge_invalid",
    "This memory-sharing confirmation is invalid. Review the disclosure again.",
    409,
  );
}

function sharingState(input: {
  policyEnabled: boolean;
  blockedReason: ContactMemorySharingBlockedReason | null;
}): ContactMemorySharingState {
  return {
    supported: true,
    policyEnabled: input.policyEnabled,
    active: false,
    contractVersion: contactMemorySharingConsentContractVersion,
    grantedAt: null,
    sourceChannel: null,
    blockedReason: input.blockedReason,
  };
}

function toRepresentativeChannel(
  value: ContactMemorySharingSourceEvidence["sourceChannel"],
) {
  return value === "WEB"
    ? RepresentativeChannelKind.WEB
    : value === "MATRIX"
      ? RepresentativeChannelKind.MATRIX
      : RepresentativeChannelKind.TELEGRAM;
}

function requiredText(value: string, field: string) {
  const normalized = value?.trim();
  if (!normalized) throw invalidInput(`${field} is required.`);
  return normalized;
}

function invalidInput(message: string) {
  return new ContactMemorySharingError(
    "contact_memory_sharing_invalid_input",
    message,
    400,
  );
}

function normalizeSharingWriteError(error: unknown): never {
  if (error instanceof ContactMemorySharingError) throw error;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034")
  ) {
    throw new ContactMemorySharingError(
      "contact_memory_sharing_conflict",
      "Cross-channel memory consent changed concurrently. Retry the request.",
      409,
    );
  }
  throw error;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
