import { createHash, randomUUID } from "node:crypto";

import {
  CreatorPayoutProfileStatus,
  EventType,
  PayoutDestinationKind,
  PayoutDestinationStatus,
  PayoutSubjectType,
} from "@prisma/client";

import {
  encryptPayoutDestinationToken,
  fingerprintPayoutDestinationToken,
  type PayoutDestinationProvider,
} from "./payout-destination-credentials";
import { prisma } from "./prisma";

type OrganizationMemberRole = "OWNER" | "ADMIN" | "APPROVER" | "ANALYST";

type OwnerPermissionRecord = {
  id: string;
  organizationId: string | null;
  organizationMember: {
    organizationId: string;
    role: OrganizationMemberRole;
    canManageBilling: boolean;
  } | null;
};

type PayoutDestinationRecord = {
  id: string;
  profileId: string;
  kind: PayoutDestinationKind;
  status: PayoutDestinationStatus;
  currency: string;
  maskedLabel: string;
  credentialCiphertext?: Uint8Array | null;
  credentialIv?: Uint8Array | null;
  credentialAuthTag?: Uint8Array | null;
  credentialKeyVersion?: string;
  credentialAlgorithm?: string;
  credentialFingerprint?: string;
  credentialVersion: number;
  coolingOffUntil: Date | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  activatedAt: Date | null;
  disabledAt: Date | null;
  replacedAt: Date | null;
  createdByOwnerId: string;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

type CreatorPayoutProfileRecord = {
  id: string;
  subjectType: PayoutSubjectType;
  ownerId: string | null;
  organizationId: string | null;
  status: CreatorPayoutProfileStatus;
  version: number;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  rejectionReasonCode: string | null;
  suspendedAt: Date | null;
  createdByOwnerId: string;
  createdAt: Date;
  updatedAt: Date;
  destinations?: PayoutDestinationRecord[];
};

type AuditRecord = {
  type: EventType;
  requestHash: string | null;
  payload: unknown;
};

export type CreatorPayoutProfileClient = {
  owner: {
    findUnique(args: unknown): Promise<OwnerPermissionRecord | null>;
  };
  creatorPayoutProfile: {
    findUnique(args: unknown): Promise<CreatorPayoutProfileRecord | null>;
    create(args: unknown): Promise<CreatorPayoutProfileRecord>;
    update(args: unknown): Promise<CreatorPayoutProfileRecord>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  payoutDestination: {
    findUnique(args: unknown): Promise<PayoutDestinationRecord | null>;
    findMany(args: unknown): Promise<PayoutDestinationRecord[]>;
    create(args: unknown): Promise<PayoutDestinationRecord>;
    update(args: unknown): Promise<PayoutDestinationRecord>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  withdrawRequest?: {
    count(args: unknown): Promise<number>;
  };
  eventAudit: {
    findUnique(args: unknown): Promise<AuditRecord | null>;
    create(args: unknown): Promise<unknown>;
  };
  $transaction?<T>(
    operation: (tx: CreatorPayoutProfileClient) => Promise<T>,
    options?: unknown,
  ): Promise<T>;
};

export type CreatorPayoutProfileSnapshot = {
  id: string;
  subjectType: "owner" | "organization";
  status: "pending_verification" | "verified" | "rejected" | "suspended";
  version: number;
  verifiedAt: string | null;
  rejectionReasonCode: string | null;
  suspendedAt: string | null;
  destinations: PayoutDestinationSnapshot[];
};

export type PayoutDestinationSnapshot = {
  id: string;
  kind: "wechat_pay";
  status:
    | "pending_verification"
    | "verified"
    | "active"
    | "rejected"
    | "disabled"
    | "replaced";
  currency: "CNY";
  maskedLabel: string;
  coolingOffUntil: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  disabledAt: string | null;
  replacedAt: string | null;
};

export class CreatorPayoutProfileError extends Error {
  constructor(
    readonly code:
      | "payout_profile_invalid"
      | "payout_profile_not_found"
      | "payout_profile_forbidden"
      | "payout_profile_version_conflict"
      | "payout_profile_idempotency_conflict"
      | "payout_profile_state_conflict"
      | "payout_profile_local_only",
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "CreatorPayoutProfileError";
  }
}

export type CreatorPayoutProfileMutationOptions = {
  client?: CreatorPayoutProfileClient;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
};

type ResolvedPayoutSubject = {
  subjectType: PayoutSubjectType;
  ownerId: string | null;
  organizationId: string | null;
};

const destinationPublicSelect = {
  id: true,
  kind: true,
  status: true,
  currency: true,
  maskedLabel: true,
  coolingOffUntil: true,
  verifiedAt: true,
  activatedAt: true,
  disabledAt: true,
  replacedAt: true,
} as const;

const destinationProfileMutationSelect = {
  ...destinationPublicSelect,
  profileId: true,
  credentialVersion: true,
  credentialFingerprint: true,
} as const;

const profileReadSelect = {
  id: true,
  subjectType: true,
  ownerId: true,
  organizationId: true,
  status: true,
  version: true,
  verifiedAt: true,
  rejectionReasonCode: true,
  suspendedAt: true,
  destinations: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: destinationPublicSelect,
  },
} as const;

const profileMutationSelect = {
  ...profileReadSelect,
  ownerId: true,
  organizationId: true,
  verifiedBy: true,
  destinations: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: destinationProfileMutationSelect,
  },
} as const;

const destinationSelect = {
  id: true,
  profileId: true,
  kind: true,
  status: true,
  currency: true,
  maskedLabel: true,
  credentialCiphertext: true,
  credentialIv: true,
  credentialAuthTag: true,
  credentialKeyVersion: true,
  credentialAlgorithm: true,
  credentialFingerprint: true,
  credentialVersion: true,
  coolingOffUntil: true,
  verifiedAt: true,
  verifiedBy: true,
  activatedAt: true,
  disabledAt: true,
  replacedAt: true,
  createdByOwnerId: true,
  idempotencyKey: true,
  createdAt: true,
  updatedAt: true,
} as const;

const destinationMutationRoles = new Set<OrganizationMemberRole>([
  "OWNER",
  "ADMIN",
]);
const maximumIdempotencyKeyLength = 128;
const replacementCoolingOffMs = 24 * 60 * 60 * 1_000;
const maximumSerializableAttempts = 3;

export async function getCreatorPayoutProfile(
  input: { ownerId: string },
  client: CreatorPayoutProfileClient =
    prisma as unknown as CreatorPayoutProfileClient,
): Promise<CreatorPayoutProfileSnapshot | null> {
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const subject = await resolvePayoutSubject(client, ownerId, "read");
  const profile = await findProfileForSubject(
    client,
    subject,
    profileReadSelect,
  );
  return profile ? serializeCreatorPayoutProfile(profile) : null;
}

export async function submitCreatorPayoutProfile(
  input: {
    ownerId: string;
    expectedVersion?: number;
    idempotencyKey: string;
  },
  options: CreatorPayoutProfileMutationOptions = {},
): Promise<CreatorPayoutProfileSnapshot> {
  const client =
    options.client ??
    (prisma as unknown as CreatorPayoutProfileClient);
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const expectedVersion = optionalVersion(input.expectedVersion);
  const callerKey = requiredIdempotencyKey(input.idempotencyKey);
  const operationKey = buildOperationKey(
    "payout_profile_submit",
    ownerId,
    callerKey,
  );

  return runProfileTransaction(client, async (tx) => {
    const subject = await resolvePayoutSubject(tx, ownerId, "mutate");
    const requestHash = hashRequest([
      "payout_profile_submit",
      subject.subjectType,
      subject.ownerId,
      subject.organizationId,
      expectedVersion,
    ]);
    const replay = await findAuditReplay(tx, ownerId, operationKey);
    if (replay) {
      assertMatchingReplay(
        replay,
        EventType.WALLET_PAYOUT_PROFILE_SUBMITTED,
        requestHash,
      );
      return requireProfileSnapshotByAudit(tx, replay);
    }

    const existing = await findProfileForSubject(
      tx,
      subject,
      profileMutationSelect,
    );
    if (
      expectedVersion !== null
      && (existing?.version ?? 0) !== expectedVersion
    ) {
      throw versionConflict();
    }

    let profile: CreatorPayoutProfileRecord;
    if (!existing) {
      profile = await tx.creatorPayoutProfile.create({
        data: {
          subjectType: subject.subjectType,
          ownerId: subject.ownerId,
          organizationId: subject.organizationId,
          status: CreatorPayoutProfileStatus.PENDING_VERIFICATION,
          version: 0,
          createdByOwnerId: ownerId,
        },
        select: profileMutationSelect,
      });
    } else if (
      existing.status === CreatorPayoutProfileStatus.REJECTED
      || existing.status === CreatorPayoutProfileStatus.SUSPENDED
    ) {
      profile = await updateProfileVersioned(tx, existing, {
        status: CreatorPayoutProfileStatus.PENDING_VERIFICATION,
        verifiedAt: null,
        verifiedBy: null,
        rejectionReasonCode: null,
        suspendedAt: null,
        version: { increment: 1 },
      });
    } else {
      profile = existing;
    }

    await createAudit(tx, {
      ownerId,
      type: EventType.WALLET_PAYOUT_PROFILE_SUBMITTED,
      idempotencyKey: operationKey,
      requestHash,
      payload: {
        actorId: ownerId,
        resourceId: profile.id,
        subjectType: profile.subjectType,
        status: profile.status,
        resultingVersion: profile.version,
      },
    });
    return serializeCreatorPayoutProfile(profile);
  });
}

/**
 * Accepts only a provider/vault-issued recipient token and a provider-derived
 * masked label. Raw bank-card, account-number, payment-password, and identity
 * document fields are intentionally absent from this contract.
 */
export async function createTokenizedPayoutDestination(
  input: {
    ownerId: string;
    profileId: string;
    recipientToken: string;
    providerMaskedLabel: string;
    expectedProfileVersion: number;
    idempotencyKey: string;
  },
  options: CreatorPayoutProfileMutationOptions = {},
): Promise<CreatorPayoutProfileSnapshot> {
  const client =
    options.client ??
    (prisma as unknown as CreatorPayoutProfileClient);
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const profileId = requiredText(input.profileId, "profileId", 191);
  const expectedProfileVersion = requiredVersion(
    input.expectedProfileVersion,
    "expectedProfileVersion",
  );
  const providerMaskedLabel = normalizeProviderMaskedLabel(
    input.providerMaskedLabel,
    input.recipientToken,
  );
  const callerKey = requiredIdempotencyKey(input.idempotencyKey);
  const operationKey = buildOperationKey(
    "payout_destination_create",
    ownerId,
    callerKey,
  );
  const provider: PayoutDestinationProvider = "WECHAT_PAY";

  return runProfileTransaction(client, async (tx) => {
    const subject = await resolvePayoutSubject(tx, ownerId, "mutate");
    const profile = await requireOwnedProfile(tx, profileId, subject);
    const fingerprint = fingerprintPayoutDestinationToken(
      input.recipientToken,
      env,
    );
    const requestHash = hashRequest([
      "payout_destination_create",
      profile.id,
      provider,
      "CNY",
      providerMaskedLabel,
      fingerprint,
      expectedProfileVersion,
    ]);
    const replay = await findAuditReplay(tx, ownerId, operationKey);
    if (replay) {
      assertMatchingReplay(
        replay,
        EventType.WALLET_PAYOUT_DESTINATION_CHANGED,
        requestHash,
      );
      return requireProfileSnapshotByAudit(tx, replay);
    }
    if (profile.version !== expectedProfileVersion) {
      throw versionConflict();
    }

    const destinations = await tx.payoutDestination.findMany({
      where: { profileId: profile.id },
      orderBy: [{ credentialVersion: "desc" }, { id: "desc" }],
      select: destinationSelect,
    });
    if (
      destinations.some(
        (destination) =>
          destination.status ===
            PayoutDestinationStatus.PENDING_VERIFICATION,
      )
    ) {
      throw stateConflict(
        "A payout destination is already pending verification.",
      );
    }
    if (
      destinations.some(
        (destination) =>
          destination.credentialFingerprint === fingerprint
          && destination.status !== PayoutDestinationStatus.DISABLED
          && destination.status !== PayoutDestinationStatus.REPLACED,
      )
    ) {
      throw stateConflict("This payout destination is already configured.");
    }

    const destinationId = randomUUID();
    const credentialVersion =
      (destinations[0]?.credentialVersion ?? 0) + 1;
    const encrypted = encryptPayoutDestinationToken(
      {
        recipientToken: input.recipientToken,
        payoutProfileId: profile.id,
        payoutDestinationId: destinationId,
        credentialVersion,
        provider,
      },
      env,
    );
    const hasActiveDestination = destinations.some(
      (destination) =>
        destination.status === PayoutDestinationStatus.ACTIVE,
    );
    await tx.payoutDestination.create({
      data: {
        id: destinationId,
        profileId: profile.id,
        kind: PayoutDestinationKind.WECHAT_PAY,
        status: PayoutDestinationStatus.PENDING_VERIFICATION,
        currency: "CNY",
        maskedLabel: providerMaskedLabel,
        credentialCiphertext: Uint8Array.from(encrypted.ciphertext),
        credentialIv: Uint8Array.from(encrypted.iv),
        credentialAuthTag: Uint8Array.from(encrypted.authTag),
        credentialKeyVersion: encrypted.keyVersion,
        credentialAlgorithm: encrypted.algorithm,
        credentialFingerprint: encrypted.fingerprint,
        credentialVersion,
        coolingOffUntil: hasActiveDestination
          ? new Date(now.getTime() + replacementCoolingOffMs)
          : null,
        createdByOwnerId: ownerId,
        idempotencyKey: operationKey,
      },
      select: destinationSelect,
    });
    const updated = await updateProfileVersioned(
      tx,
      profile,
      hasActiveDestination
        ? {
            version: { increment: 1 },
          }
        : {
            status: CreatorPayoutProfileStatus.PENDING_VERIFICATION,
            verifiedAt: null,
            verifiedBy: null,
            rejectionReasonCode: null,
            suspendedAt: null,
            version: { increment: 1 },
          },
    );

    await createAudit(tx, {
      ownerId,
      type: EventType.WALLET_PAYOUT_DESTINATION_CHANGED,
      idempotencyKey: operationKey,
      requestHash,
      payload: {
        actorId: ownerId,
        resourceId: updated.id,
        destinationId,
        operation: hasActiveDestination ? "replace" : "create",
        status: PayoutDestinationStatus.PENDING_VERIFICATION,
        resultingVersion: updated.version,
      },
    });
    return requireProfileSnapshot(tx, updated.id);
  });
}

export async function reviewCreatorPayoutProfileLocally(
  input: {
    ownerId: string;
    profileId: string;
    destinationId: string;
    decision: "approve" | "reject";
    reasonCode?: string;
    actorId: string;
    expectedProfileVersion: number;
    idempotencyKey: string;
  },
  options: CreatorPayoutProfileMutationOptions = {},
): Promise<CreatorPayoutProfileSnapshot> {
  assertLocalOnly(options.env);
  const client =
    options.client ??
    (prisma as unknown as CreatorPayoutProfileClient);
  const now = options.now ?? new Date();
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const profileId = requiredText(input.profileId, "profileId", 191);
  const destinationId = requiredText(
    input.destinationId,
    "destinationId",
    191,
  );
  const actorId = requiredText(input.actorId, "actorId", 191);
  const reasonCode =
    input.decision === "reject"
      ? requiredReasonCode(input.reasonCode)
      : null;
  const expectedProfileVersion = requiredVersion(
    input.expectedProfileVersion,
    "expectedProfileVersion",
  );
  const operationKey = buildOperationKey(
    "payout_destination_review",
    ownerId,
    requiredIdempotencyKey(input.idempotencyKey),
  );

  return runProfileTransaction(client, async (tx) => {
    const subject = await resolvePayoutSubject(tx, ownerId, "mutate");
    const profile = await requireOwnedProfile(tx, profileId, subject);
    const requestHash = hashRequest([
      "payout_destination_review",
      profileId,
      destinationId,
      input.decision,
      reasonCode,
      actorId,
      expectedProfileVersion,
    ]);
    const replay = await findAuditReplay(tx, ownerId, operationKey);
    if (replay) {
      assertMatchingReplay(
        replay,
        EventType.WALLET_PAYOUT_DESTINATION_VERIFIED,
        requestHash,
      );
      return requireProfileSnapshotByAudit(tx, replay);
    }
    if (profile.version !== expectedProfileVersion) {
      throw versionConflict();
    }
    const destination = await requireProfileDestination(
      tx,
      profile.id,
      destinationId,
    );
    if (
      destination.status !==
      PayoutDestinationStatus.PENDING_VERIFICATION
    ) {
      throw stateConflict(
        "Only a pending payout destination can be reviewed.",
      );
    }
    const hasActiveDestination = (
      await tx.payoutDestination.findMany({
        where: { profileId: profile.id },
        orderBy: [{ credentialVersion: "desc" }, { id: "desc" }],
        select: destinationSelect,
      })
    ).some(
      (candidate) =>
        candidate.id !== destination.id
        && candidate.status === PayoutDestinationStatus.ACTIVE,
    );

    await tx.payoutDestination.update({
      where: { id: destination.id },
      data:
        input.decision === "approve"
          ? {
              status: PayoutDestinationStatus.VERIFIED,
              verifiedAt: now,
              verifiedBy: actorId,
            }
          : {
              status: PayoutDestinationStatus.REJECTED,
              verifiedAt: null,
              verifiedBy: actorId,
            },
      select: destinationSelect,
    });
    const updated = await updateProfileVersioned(
      tx,
      profile,
      hasActiveDestination
        ? {
            version: { increment: 1 },
          }
        : input.decision === "approve"
        ? {
            status: CreatorPayoutProfileStatus.VERIFIED,
            verifiedAt: now,
            verifiedBy: actorId,
            rejectionReasonCode: null,
            suspendedAt: null,
            version: { increment: 1 },
          }
        : {
            status: CreatorPayoutProfileStatus.REJECTED,
            verifiedAt: null,
            verifiedBy: actorId,
            rejectionReasonCode: reasonCode,
            suspendedAt: null,
            version: { increment: 1 },
          },
    );
    await createAudit(tx, {
      ownerId,
      type: EventType.WALLET_PAYOUT_DESTINATION_VERIFIED,
      idempotencyKey: operationKey,
      requestHash,
      payload: {
        actorId,
        resourceId: profile.id,
        destinationId,
        decision: input.decision,
        reasonCode,
        status: updated.status,
        resultingVersion: updated.version,
      },
    });
    return requireProfileSnapshot(tx, profile.id);
  });
}

export async function activatePayoutDestinationLocally(
  input: {
    ownerId: string;
    profileId: string;
    destinationId: string;
    actorId: string;
    expectedProfileVersion: number;
    idempotencyKey: string;
  },
  options: CreatorPayoutProfileMutationOptions = {},
): Promise<CreatorPayoutProfileSnapshot> {
  assertLocalOnly(options.env);
  const client =
    options.client ??
    (prisma as unknown as CreatorPayoutProfileClient);
  const now = options.now ?? new Date();
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const profileId = requiredText(input.profileId, "profileId", 191);
  const destinationId = requiredText(
    input.destinationId,
    "destinationId",
    191,
  );
  const actorId = requiredText(input.actorId, "actorId", 191);
  const expectedProfileVersion = requiredVersion(
    input.expectedProfileVersion,
    "expectedProfileVersion",
  );
  const operationKey = buildOperationKey(
    "payout_destination_activate",
    ownerId,
    requiredIdempotencyKey(input.idempotencyKey),
  );

  return runProfileTransaction(client, async (tx) => {
    const subject = await resolvePayoutSubject(tx, ownerId, "mutate");
    const profile = await requireOwnedProfile(tx, profileId, subject);
    const requestHash = hashRequest([
      "payout_destination_activate",
      profileId,
      destinationId,
      actorId,
      expectedProfileVersion,
    ]);
    const replay = await findAuditReplay(tx, ownerId, operationKey);
    if (replay) {
      assertMatchingReplay(
        replay,
        EventType.WALLET_PAYOUT_DESTINATION_CHANGED,
        requestHash,
      );
      return requireProfileSnapshotByAudit(tx, replay);
    }
    if (profile.version !== expectedProfileVersion) {
      throw versionConflict();
    }
    if (profile.status !== CreatorPayoutProfileStatus.VERIFIED) {
      throw stateConflict(
        "The payout profile must be verified before activation.",
      );
    }
    const destination = await requireProfileDestination(
      tx,
      profile.id,
      destinationId,
    );
    if (
      destination.status !==
        PayoutDestinationStatus.VERIFIED
      || !destination.verifiedAt
    ) {
      throw stateConflict(
        "The payout destination must be verified before activation.",
      );
    }
    if (
      destination.coolingOffUntil
      && destination.coolingOffUntil.getTime() > now.getTime()
    ) {
      throw stateConflict(
        "The payout destination cooling-off period is still active.",
      );
    }

    await tx.payoutDestination.updateMany({
      where: {
        profileId: profile.id,
        id: { not: destination.id },
        status: PayoutDestinationStatus.ACTIVE,
      },
      data: {
        status: PayoutDestinationStatus.REPLACED,
        replacedAt: now,
      },
    });
    await tx.payoutDestination.update({
      where: { id: destination.id },
      data: {
        status: PayoutDestinationStatus.ACTIVE,
        activatedAt: now,
        disabledAt: null,
        replacedAt: null,
      },
      select: destinationSelect,
    });
    const updated = await updateProfileVersioned(tx, profile, {
      version: { increment: 1 },
    });
    await createAudit(tx, {
      ownerId,
      type: EventType.WALLET_PAYOUT_DESTINATION_CHANGED,
      idempotencyKey: operationKey,
      requestHash,
      payload: {
        actorId,
        resourceId: profile.id,
        destinationId,
        operation: "activate",
        status: PayoutDestinationStatus.ACTIVE,
        resultingVersion: updated.version,
      },
    });
    return requireProfileSnapshot(tx, profile.id);
  });
}

export async function disablePayoutDestinationLocally(
  input: {
    ownerId: string;
    profileId: string;
    destinationId: string;
    actorId: string;
    expectedProfileVersion: number;
    idempotencyKey: string;
  },
  options: CreatorPayoutProfileMutationOptions = {},
): Promise<CreatorPayoutProfileSnapshot> {
  assertLocalOnly(options.env);
  const client =
    options.client ??
    (prisma as unknown as CreatorPayoutProfileClient);
  const now = options.now ?? new Date();
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const profileId = requiredText(input.profileId, "profileId", 191);
  const destinationId = requiredText(
    input.destinationId,
    "destinationId",
    191,
  );
  const actorId = requiredText(input.actorId, "actorId", 191);
  const expectedProfileVersion = requiredVersion(
    input.expectedProfileVersion,
    "expectedProfileVersion",
  );
  const operationKey = buildOperationKey(
    "payout_destination_disable",
    ownerId,
    requiredIdempotencyKey(input.idempotencyKey),
  );

  return runProfileTransaction(client, async (tx) => {
    const subject = await resolvePayoutSubject(tx, ownerId, "mutate");
    const profile = await requireOwnedProfile(tx, profileId, subject);
    const requestHash = hashRequest([
      "payout_destination_disable",
      profileId,
      destinationId,
      actorId,
      expectedProfileVersion,
    ]);
    const replay = await findAuditReplay(tx, ownerId, operationKey);
    if (replay) {
      assertMatchingReplay(
        replay,
        EventType.WALLET_PAYOUT_DESTINATION_CHANGED,
        requestHash,
      );
      return requireProfileSnapshotByAudit(tx, replay);
    }
    if (profile.version !== expectedProfileVersion) {
      throw versionConflict();
    }
    const destination = await requireProfileDestination(
      tx,
      profile.id,
      destinationId,
    );
    if (destination.status !== PayoutDestinationStatus.ACTIVE) {
      throw stateConflict(
        "Only an active payout destination can be disabled.",
      );
    }
    if (tx.withdrawRequest) {
      const activeWithdrawals = await tx.withdrawRequest.count({
        where: {
          payoutDestinationId: destination.id,
          status: { in: ["PENDING_REVIEW", "APPROVED", "FAILED"] },
          allocations: {
            some: {
              releasedAt: null,
              paidAt: null,
            },
          },
        },
      });
      if (activeWithdrawals > 0) {
        throw stateConflict(
          "The payout destination is locked by an active withdrawal.",
        );
      }
    }

    await tx.payoutDestination.update({
      where: { id: destination.id },
      data: {
        status: PayoutDestinationStatus.DISABLED,
        disabledAt: now,
        credentialCiphertext: null,
        credentialIv: null,
        credentialAuthTag: null,
      },
      select: destinationSelect,
    });
    const otherActiveDestinations = (
      await tx.payoutDestination.findMany({
        where: {
          profileId: profile.id,
          id: { not: destination.id },
          status: PayoutDestinationStatus.ACTIVE,
        },
        select: destinationSelect,
      })
    ).length;
    const updated = await updateProfileVersioned(
      tx,
      profile,
      otherActiveDestinations > 0
        || profile.status !== CreatorPayoutProfileStatus.VERIFIED
        ? { version: { increment: 1 } }
        : {
            status: CreatorPayoutProfileStatus.SUSPENDED,
            suspendedAt: now,
            version: { increment: 1 },
          },
    );
    await createAudit(tx, {
      ownerId,
      type: EventType.WALLET_PAYOUT_DESTINATION_CHANGED,
      idempotencyKey: operationKey,
      requestHash,
      payload: {
        actorId,
        resourceId: profile.id,
        destinationId,
        operation: "disable",
        status: PayoutDestinationStatus.DISABLED,
        resultingVersion: updated.version,
      },
    });
    return requireProfileSnapshot(tx, profile.id);
  });
}

async function resolvePayoutSubject(
  client: CreatorPayoutProfileClient,
  ownerId: string,
  access: "read" | "mutate",
): Promise<ResolvedPayoutSubject> {
  const owner = await client.owner.findUnique({
    where: { id: ownerId },
    select: {
      id: true,
      organizationId: true,
      organizationMember: {
        select: {
          organizationId: true,
          role: true,
          canManageBilling: true,
        },
      },
    },
  });
  if (!owner) {
    throw new CreatorPayoutProfileError(
      "payout_profile_not_found",
      "Owner was not found.",
      404,
    );
  }
  if (!owner.organizationId) {
    return {
      subjectType: PayoutSubjectType.OWNER,
      ownerId: owner.id,
      organizationId: null,
    };
  }
  const membership = owner.organizationMember;
  if (
    !membership
    || membership.organizationId !== owner.organizationId
    || !membership.canManageBilling
    || (
      access === "mutate"
      && !destinationMutationRoles.has(membership.role)
    )
  ) {
    throw new CreatorPayoutProfileError(
      "payout_profile_forbidden",
      "You do not have permission to manage this payout profile.",
      403,
    );
  }
  return {
    subjectType: PayoutSubjectType.ORGANIZATION,
    ownerId: null,
    organizationId: owner.organizationId,
  };
}

async function findProfileForSubject(
  client: CreatorPayoutProfileClient,
  subject: ResolvedPayoutSubject,
  select: unknown = profileMutationSelect,
) {
  return client.creatorPayoutProfile.findUnique({
    where:
      subject.subjectType === PayoutSubjectType.OWNER
        ? { ownerId: subject.ownerId! }
        : { organizationId: subject.organizationId! },
    select,
  });
}

async function requireOwnedProfile(
  client: CreatorPayoutProfileClient,
  profileId: string,
  subject: ResolvedPayoutSubject,
) {
  const profile = await client.creatorPayoutProfile.findUnique({
    where: { id: profileId },
    select: profileMutationSelect,
  });
  if (
    !profile
    || profile.subjectType !== subject.subjectType
    || profile.ownerId !== subject.ownerId
    || profile.organizationId !== subject.organizationId
  ) {
    throw new CreatorPayoutProfileError(
      "payout_profile_not_found",
      "Payout profile was not found.",
      404,
    );
  }
  return profile;
}

async function requireProfileDestination(
  client: CreatorPayoutProfileClient,
  profileId: string,
  destinationId: string,
) {
  const destination = await client.payoutDestination.findUnique({
    where: { id: destinationId },
    select: destinationSelect,
  });
  if (!destination || destination.profileId !== profileId) {
    throw new CreatorPayoutProfileError(
      "payout_profile_not_found",
      "Payout destination was not found.",
      404,
    );
  }
  return destination;
}

async function updateProfileVersioned(
  client: CreatorPayoutProfileClient,
  profile: CreatorPayoutProfileRecord,
  data: Record<string, unknown>,
) {
  const result = await client.creatorPayoutProfile.updateMany({
    where: {
      id: profile.id,
      version: profile.version,
    },
    data,
  });
  if (result.count !== 1) throw versionConflict();
  const updated = await client.creatorPayoutProfile.findUnique({
    where: { id: profile.id },
    select: profileMutationSelect,
  });
  if (!updated) {
    throw new CreatorPayoutProfileError(
      "payout_profile_not_found",
      "Payout profile was not found.",
      404,
    );
  }
  return updated;
}

async function requireProfileSnapshot(
  client: CreatorPayoutProfileClient,
  profileId: string,
) {
  const profile = await client.creatorPayoutProfile.findUnique({
    where: { id: profileId },
    select: profileReadSelect,
  });
  if (!profile) {
    throw new CreatorPayoutProfileError(
      "payout_profile_not_found",
      "Payout profile was not found.",
      404,
    );
  }
  return serializeCreatorPayoutProfile(profile);
}

async function requireProfileSnapshotByAudit(
  client: CreatorPayoutProfileClient,
  audit: AuditRecord,
) {
  const payload = asRecord(audit.payload);
  const profileId =
    typeof payload?.resourceId === "string"
      ? payload.resourceId
      : null;
  if (!profileId) {
    throw stateConflict(
      "The payout profile idempotency record requires reconciliation.",
    );
  }
  return requireProfileSnapshot(client, profileId);
}

async function findAuditReplay(
  client: CreatorPayoutProfileClient,
  ownerId: string,
  idempotencyKey: string,
) {
  return client.eventAudit.findUnique({
    where: {
      ownerId_idempotencyKey: {
        ownerId,
        idempotencyKey,
      },
    },
    select: {
      type: true,
      requestHash: true,
      payload: true,
    },
  });
}

function assertMatchingReplay(
  audit: AuditRecord,
  type: EventType,
  requestHash: string,
) {
  if (audit.type === type && audit.requestHash === requestHash) return;
  throw new CreatorPayoutProfileError(
    "payout_profile_idempotency_conflict",
    "This idempotency key belongs to a different payout request.",
    409,
  );
}

async function createAudit(
  client: CreatorPayoutProfileClient,
  input: {
    ownerId: string;
    type: EventType;
    idempotencyKey: string;
    requestHash: string;
    payload: Record<string, unknown>;
  },
) {
  await client.eventAudit.create({
    data: {
      ownerId: input.ownerId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      payload: input.payload,
    },
  });
}

function serializeCreatorPayoutProfile(
  profile: CreatorPayoutProfileRecord,
): CreatorPayoutProfileSnapshot {
  return {
    id: profile.id,
    subjectType: profile.subjectType.toLowerCase() as
      CreatorPayoutProfileSnapshot["subjectType"],
    status: profile.status.toLowerCase() as
      CreatorPayoutProfileSnapshot["status"],
    version: profile.version,
    verifiedAt: profile.verifiedAt?.toISOString() ?? null,
    rejectionReasonCode: profile.rejectionReasonCode,
    suspendedAt: profile.suspendedAt?.toISOString() ?? null,
    destinations: (profile.destinations ?? []).map(
      serializePayoutDestination,
    ),
  };
}

function serializePayoutDestination(
  destination: PayoutDestinationRecord,
): PayoutDestinationSnapshot {
  return {
    id: destination.id,
    kind: destination.kind.toLowerCase() as "wechat_pay",
    status: destination.status.toLowerCase() as
      PayoutDestinationSnapshot["status"],
    currency: "CNY",
    maskedLabel: destination.maskedLabel,
    coolingOffUntil:
      destination.coolingOffUntil?.toISOString() ?? null,
    verifiedAt: destination.verifiedAt?.toISOString() ?? null,
    activatedAt: destination.activatedAt?.toISOString() ?? null,
    disabledAt: destination.disabledAt?.toISOString() ?? null,
    replacedAt: destination.replacedAt?.toISOString() ?? null,
  };
}

async function runProfileTransaction<T>(
  client: CreatorPayoutProfileClient,
  operation: (tx: CreatorPayoutProfileClient) => Promise<T>,
): Promise<T> {
  if (!client.$transaction) return operation(client);
  for (
    let attempt = 1;
    attempt <= maximumSerializableAttempts;
    attempt += 1
  ) {
    try {
      return await client.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      const code = prismaErrorCode(error);
      if (
        (code !== "P2002" && code !== "P2034")
        || attempt === maximumSerializableAttempts
      ) {
        throw error;
      }
    }
  }
  throw versionConflict();
}

function buildOperationKey(
  operation: string,
  ownerId: string,
  callerKey: string,
) {
  const digest = createHash("sha256")
    .update(operation, "utf8")
    .update("\0", "utf8")
    .update(ownerId, "utf8")
    .update("\0", "utf8")
    .update(callerKey, "utf8")
    .digest("hex");
  return `${operation}:${digest}`;
}

function hashRequest(parts: unknown[]) {
  return createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
}

function requiredIdempotencyKey(value: string) {
  return requiredText(
    value,
    "idempotencyKey",
    maximumIdempotencyKeyLength,
  );
}

function normalizeProviderMaskedLabel(
  value: string,
  recipientToken: string,
) {
  const normalized = requiredText(value, "providerMaskedLabel", 120);
  if (
    /[\u0000-\u001f\u007f]/u.test(normalized)
    || /\d{7,}/u.test(normalized)
    || /[A-Za-z0-9_-]{24,}/u.test(normalized)
    || normalized === recipientToken.trim()
    || normalized.includes(recipientToken.trim())
  ) {
    throw new CreatorPayoutProfileError(
      "payout_profile_invalid",
      "The provider payout label must contain only masked display data.",
      400,
    );
  }
  return normalized;
}

function requiredReasonCode(value: string | undefined) {
  const normalized = requiredText(
    value ?? "",
    "reasonCode",
    64,
  ).toUpperCase();
  if (!/^[A-Z0-9_:-]+$/.test(normalized)) {
    throw new CreatorPayoutProfileError(
      "payout_profile_invalid",
      "reasonCode is invalid.",
      400,
    );
  }
  return normalized;
}

function requiredVersion(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CreatorPayoutProfileError(
      "payout_profile_invalid",
      `${label} must be a non-negative integer.`,
      400,
    );
  }
  return value;
}

function optionalVersion(value: number | undefined) {
  return value === undefined
    ? null
    : requiredVersion(value, "expectedVersion");
}

function requiredText(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || normalized.includes("\0")
  ) {
    throw new CreatorPayoutProfileError(
      "payout_profile_invalid",
      `${label} is invalid.`,
      400,
    );
  }
  return normalized;
}

function versionConflict() {
  return new CreatorPayoutProfileError(
    "payout_profile_version_conflict",
    "The payout profile changed since it was loaded.",
    409,
  );
}

function stateConflict(message: string) {
  return new CreatorPayoutProfileError(
    "payout_profile_state_conflict",
    message,
    409,
  );
}

function assertLocalOnly(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.NODE_ENV !== "production") return;
  throw new CreatorPayoutProfileError(
    "payout_profile_local_only",
    "Local payout operations are unavailable in production.",
    404,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function prismaErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}
