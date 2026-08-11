import {
  BillingHandoffAllowance,
  BillingHandoffServiceLevel,
  HandoffEntitlementGrantStatus,
  HandoffEntitlementLedgerKind,
  HandoffEntitlementReservationState,
  HandoffStatus,
  RechargeOrderStatus,
  RepresentativeHandoffAccessMode,
  type HandoffRequest,
  type Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";

type HandoffEntitlementClient = {
  rechargeOrder: {
    findUnique(args: unknown): Promise<{
      id: string;
      representativeId: string | null;
      billingPriceVersionId: string | null;
      productKindSnapshot: string | null;
      handoffAllowanceSnapshot: string | null;
      handoffUnitsSnapshot: number | null;
      handoffServiceLevelSnapshot: string | null;
      handoffValidityDaysSnapshot: number | null;
      status: RechargeOrderStatus;
      paidAt: Date | null;
      userWallet: { audienceIdentityId: string | null };
    } | null>;
  };
  handoffEntitlementGrant: {
    findUnique(args: unknown): Promise<HandoffGrantRecord | null>;
    findMany(args: unknown): Promise<HandoffGrantRecord[]>;
    create(args: unknown): Promise<HandoffGrantRecord>;
  };
  handoffEntitlementLedgerEntry: {
    create(args: unknown): Promise<{ id: string }>;
  };
};

type HandoffGrantRecord = {
  id: string;
  rechargeOrderId: string;
  audienceIdentityId: string;
  representativeId: string;
  billingPriceVersionId: string;
  allowance: BillingHandoffAllowance;
  serviceLevel: BillingHandoffServiceLevel;
  grantedUses: number | null;
  remainingUses: number | null;
  reservedUses: number;
  consumedUses: number;
  status: HandoffEntitlementGrantStatus;
  startsAt: Date;
  expiresAt: Date | null;
};

export type PurchasedHandoffEntitlementSnapshot = {
  id: string;
  rechargeOrderId: string;
  audienceIdentityId: string;
  representativeId: string;
  billingPriceVersionId: string;
  allowance: "LIMITED" | "UNLIMITED";
  serviceLevel: "STANDARD" | "PRIORITY";
  grantedUses: number | null;
  remainingUses: number | null;
  reservedUses: number;
  consumedUses: number;
  status: "ACTIVE" | "FROZEN" | "EXHAUSTED" | "EXPIRED" | "REFUNDED";
  startsAt: string;
  expiresAt: string;
};

export type PurchasedHandoffEntitlementSummary = {
  audienceIdentityId: string;
  representativeId: string;
  hasUnlimited: boolean;
  limitedRemainingUses: number;
  highestServiceLevel: "STANDARD" | "PRIORITY" | null;
  activeGrants: PurchasedHandoffEntitlementSnapshot[];
};

const activeHandoffStatuses = [
  HandoffStatus.OPEN,
  HandoffStatus.REVIEWING,
  HandoffStatus.ACCEPTED,
] as const;

export type HandoffRequestDraft = {
  representativeId: string;
  contactId: string;
  conversationId?: string | null;
  episodeId?: string | null;
  intakeSubmissionId?: string | null;
  reason: string;
  summary: string;
  recommendedPriority: number;
  recommendedOwnerAction: string;
};

export type EnsureHandoffRequestResult =
  | {
      outcome: "created" | "reused";
      request: HandoffRequest;
      access: "free" | "package";
    }
  | {
      outcome:
        | "handoff_disabled"
        | "entitlement_required"
        | "active_request_exists";
      request: null;
      activeRequestId?: string;
    };

export class HandoffEntitlementRequiredError extends Error {
  readonly code = "HANDOFF_ENTITLEMENT_REQUIRED";

  constructor() {
    super("A paid handoff entitlement is required before an operator can take over.");
    this.name = "HandoffEntitlementRequiredError";
  }
}

export class HandoffDisabledError extends Error {
  readonly code = "HANDOFF_DISABLED";

  constructor() {
    super("Human handoff is disabled for this representative.");
    this.name = "HandoffDisabledError";
  }
}

export class HandoffStateConflictError extends Error {
  readonly code = "HANDOFF_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "HandoffStateConflictError";
  }
}

export async function grantPurchasedHandoffEntitlement(
  input: { rechargeOrderId: string },
  client: HandoffEntitlementClient,
): Promise<PurchasedHandoffEntitlementSnapshot | null> {
  const rechargeOrderId = input.rechargeOrderId.trim();
  if (!rechargeOrderId) throw new Error("rechargeOrderId is required.");
  const order = await client.rechargeOrder.findUnique({
    where: { id: rechargeOrderId },
    select: {
      id: true,
      representativeId: true,
      billingPriceVersionId: true,
      productKindSnapshot: true,
      handoffAllowanceSnapshot: true,
      handoffUnitsSnapshot: true,
      handoffServiceLevelSnapshot: true,
      handoffValidityDaysSnapshot: true,
      status: true,
      paidAt: true,
      userWallet: { select: { audienceIdentityId: true } },
    },
  });
  if (!order) throw new Error("Recharge order not found.");
  if (order.productKindSnapshot !== "SERVICE_PACKAGE") {
    throw new Error("Only service packages can grant handoff access.");
  }
  if (order.handoffAllowanceSnapshot === "NONE") return null;
  if (
    order.status !== RechargeOrderStatus.PAID
    || !order.paidAt
    || !order.representativeId
    || !order.billingPriceVersionId
    || !order.userWallet.audienceIdentityId
    || (order.handoffAllowanceSnapshot !== "LIMITED"
      && order.handoffAllowanceSnapshot !== "UNLIMITED")
    || (order.handoffServiceLevelSnapshot !== "STANDARD"
      && order.handoffServiceLevelSnapshot !== "PRIORITY")
    || !Number.isSafeInteger(order.handoffValidityDaysSnapshot)
    || (order.handoffValidityDaysSnapshot ?? 0) <= 0
    || (order.handoffAllowanceSnapshot === "LIMITED"
      && (!Number.isSafeInteger(order.handoffUnitsSnapshot)
        || (order.handoffUnitsSnapshot ?? 0) <= 0))
    || (order.handoffAllowanceSnapshot === "UNLIMITED"
      && order.handoffUnitsSnapshot !== null)
  ) {
    throw new Error("Paid recharge order has invalid handoff terms.");
  }
  const existing = await client.handoffEntitlementGrant.findUnique({
    where: { rechargeOrderId },
  });
  if (existing) return serializeGrant(existing);

  const startsAt = order.paidAt;
  const expiresAt = new Date(
    startsAt.getTime() + order.handoffValidityDaysSnapshot! * 86_400_000,
  );
  const limitedUses = order.handoffAllowanceSnapshot === "LIMITED"
    ? order.handoffUnitsSnapshot!
    : null;
  const grant = await client.handoffEntitlementGrant.create({
    data: {
      rechargeOrderId,
      audienceIdentityId: order.userWallet.audienceIdentityId,
      representativeId: order.representativeId,
      billingPriceVersionId: order.billingPriceVersionId,
      allowance: order.handoffAllowanceSnapshot,
      serviceLevel: order.handoffServiceLevelSnapshot,
      grantedUses: limitedUses,
      remainingUses: limitedUses,
      reservedUses: 0,
      consumedUses: 0,
      status: HandoffEntitlementGrantStatus.ACTIVE,
      startsAt,
      expiresAt,
    },
  });
  await client.handoffEntitlementLedgerEntry.create({
    data: {
      grantId: grant.id,
      kind: HandoffEntitlementLedgerKind.GRANT,
      // The ledger schema requires a positive unit even for unlimited grants;
      // metadata marks this as an unlimited grant rather than a counted use.
      uses: limitedUses ?? 1,
      remainingAfter: limitedUses,
      reservedAfter: 0,
      consumedAfter: 0,
      idempotencyKey: `handoff-grant:${rechargeOrderId}`,
      metadata: {
        rechargeOrderId,
        allowance: order.handoffAllowanceSnapshot,
        unlimited: limitedUses === null,
      } satisfies Prisma.InputJsonValue,
    },
  });
  return serializeGrant(grant);
}

export async function getPurchasedHandoffEntitlementSummary(
  input: { audienceIdentityId: string; representativeId: string },
  client: HandoffEntitlementClient =
    prisma as unknown as HandoffEntitlementClient,
): Promise<PurchasedHandoffEntitlementSummary> {
  const audienceIdentityId = input.audienceIdentityId.trim();
  const representativeId = input.representativeId.trim();
  if (!audienceIdentityId || !representativeId) {
    throw new Error("audienceIdentityId and representativeId are required.");
  }
  const now = new Date();
  const grants = await client.handoffEntitlementGrant.findMany({
    where: {
      audienceIdentityId,
      representativeId,
      status: HandoffEntitlementGrantStatus.ACTIVE,
      startsAt: { lte: now },
      expiresAt: { gt: now },
    },
    orderBy: [{ serviceLevel: "desc" }, { expiresAt: "asc" }, { id: "asc" }],
  });
  const activeGrants = grants.map(serializeGrant);
  return {
    audienceIdentityId,
    representativeId,
    hasUnlimited: grants.some(
      (grant) => grant.allowance === BillingHandoffAllowance.UNLIMITED,
    ),
    limitedRemainingUses: grants.reduce(
      (total, grant) => total + (grant.remainingUses ?? 0),
      0,
    ),
    highestServiceLevel: grants.some(
      (grant) => grant.serviceLevel === BillingHandoffServiceLevel.PRIORITY,
    )
      ? "PRIORITY"
      : grants.length > 0
        ? "STANDARD"
        : null,
    activeGrants,
  };
}

/**
 * Create the single active handoff for an audience/representative pair.
 *
 * The identity-scoped advisory lock closes the read/select/update gap for both
 * the partial unique index on active requests and grant counters. The database
 * constraints remain the final authority; this lock makes retries uncommon
 * for callers that do not run at SERIALIZABLE isolation (notably the bot).
 */
export async function createOrReuseHandoffRequestInTransaction(
  input: HandoffRequestDraft,
  tx: Prisma.TransactionClient,
): Promise<EnsureHandoffRequestResult> {
  const contact = await tx.contact.findUnique({
    where: { id: input.contactId },
    select: {
      representativeId: true,
      audienceIdentityId: true,
    },
  });
  if (!contact || contact.representativeId !== input.representativeId) {
    throw new Error("Handoff contact does not match the representative.");
  }
  const representative = await tx.representative.findUnique({
    where: { id: input.representativeId },
    select: {
      humanInLoop: true,
      handoffAccessMode: true,
    },
  });
  if (!representative) throw new Error("Representative not found.");

  const audienceIdentityId = contact.audienceIdentityId;
  await lockHandoffIdentity(tx, {
    representativeId: input.representativeId,
    audienceIdentityId,
    contactId: input.contactId,
  });

  const existing = await tx.handoffRequest.findFirst({
    where: {
      representativeId: input.representativeId,
      ...(audienceIdentityId
        ? { audienceIdentityId }
        : { audienceIdentityId: null, contactId: input.contactId }),
      status: { in: [...activeHandoffStatuses] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (existing) {
    if (!existing.handoffEntitlementGrantId && !representative.humanInLoop) {
      return { outcome: "handoff_disabled", request: null };
    }
    const sameConversation = existing.conversationId
      === (input.conversationId ?? null);
    if (!sameConversation) {
      return {
        outcome: "active_request_exists",
        request: null,
        activeRequestId: existing.id,
      };
    }
    const refreshed = existing.status === HandoffStatus.OPEN
      || existing.status === HandoffStatus.REVIEWING
      ? await tx.handoffRequest.update({
          where: { id: existing.id },
          data: {
            reason: input.reason,
            summary: input.summary,
            recommendedPriority: clampPriority(input.recommendedPriority),
            recommendedOwnerAction: input.recommendedOwnerAction,
            ...(input.episodeId ? { episodeId: input.episodeId } : {}),
            ...(input.intakeSubmissionId
              ? { intakeSubmissionId: input.intakeSubmissionId }
              : {}),
          },
        })
      : existing;
    return {
      outcome: "reused",
      request: refreshed,
      access: refreshed.handoffEntitlementGrantId ? "package" : "free",
    };
  }

  const baseData = {
    representativeId: input.representativeId,
    contactId: input.contactId,
    audienceIdentityId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.episodeId ? { episodeId: input.episodeId } : {}),
    ...(input.intakeSubmissionId
      ? { intakeSubmissionId: input.intakeSubmissionId }
      : {}),
    reason: input.reason,
    summary: input.summary,
    recommendedPriority: clampPriority(input.recommendedPriority),
    recommendedOwnerAction: input.recommendedOwnerAction,
    status: HandoffStatus.OPEN,
  };

  const now = new Date();
  if (audienceIdentityId) {
    const candidates = await tx.handoffEntitlementGrant.findMany({
      where: {
        audienceIdentityId,
        representativeId: input.representativeId,
        status: HandoffEntitlementGrantStatus.ACTIVE,
        startsAt: { lte: now },
        expiresAt: { gt: now },
        OR: [
          { allowance: BillingHandoffAllowance.UNLIMITED },
          {
            allowance: BillingHandoffAllowance.LIMITED,
            remainingUses: { gt: 0 },
          },
        ],
      },
      orderBy: [
        { serviceLevel: "desc" },
        { expiresAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: 32,
    });

    // A paid grant is an immutable fulfillment obligation. It takes priority
    // over mutable representative settings so an already-issued QR payment
    // that settles late can still redeem the purchased handoff.
    for (const candidate of candidates) {
      const reserved = await tx.handoffEntitlementGrant.updateMany({
        where: {
          id: candidate.id,
          status: HandoffEntitlementGrantStatus.ACTIVE,
          startsAt: { lte: now },
          expiresAt: { gt: now },
          ...(candidate.allowance === BillingHandoffAllowance.LIMITED
            ? {
                allowance: BillingHandoffAllowance.LIMITED,
                remainingUses: { gt: 0 },
              }
            : { allowance: BillingHandoffAllowance.UNLIMITED }),
        },
        data: {
          reservedUses: { increment: 1 },
          ...(candidate.allowance === BillingHandoffAllowance.LIMITED
            ? { remainingUses: { decrement: 1 } }
            : {}),
        },
      });
      if (reserved.count !== 1) continue;

      const grant = await tx.handoffEntitlementGrant.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      const request = await tx.handoffRequest.create({
        data: {
          ...baseData,
          handoffEntitlementGrantId: grant.id,
          entitlementReservationState:
            HandoffEntitlementReservationState.RESERVED,
          serviceLevelSnapshot: grant.serviceLevel,
          entitlementReservedAt: now,
        },
      });
      await tx.handoffEntitlementLedgerEntry.create({
        data: {
          grantId: grant.id,
          handoffRequestId: request.id,
          kind: HandoffEntitlementLedgerKind.RESERVE,
          uses: 1,
          remainingAfter: grant.remainingUses,
          reservedAfter: grant.reservedUses,
          consumedAfter: grant.consumedUses,
          idempotencyKey: `handoff:${request.id}:reserve`,
          metadata: {
            representativeId: input.representativeId,
            audienceIdentityId,
            serviceLevel: grant.serviceLevel,
          } satisfies Prisma.InputJsonValue,
        },
      });
      return { outcome: "created", request, access: "package" };
    }
  }

  if (!representative.humanInLoop) {
    return { outcome: "handoff_disabled", request: null };
  }
  if (
    representative.handoffAccessMode
    === RepresentativeHandoffAccessMode.FREE
  ) {
    const request = await tx.handoffRequest.create({ data: baseData });
    return { outcome: "created", request, access: "free" };
  }
  if (!audienceIdentityId) {
    return { outcome: "entitlement_required", request: null };
  }

  return { outcome: "entitlement_required", request: null };
}

/** Accept the active request (if any) through the canonical consume path. */
export async function acceptConversationHandoffInTransaction(
  input: { conversationId: string; representativeId: string },
  tx: Prisma.TransactionClient,
): Promise<HandoffRequest | null> {
  const conversation = await tx.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      id: true,
      representativeId: true,
      contactId: true,
      audienceIdentityId: true,
      representative: {
        select: { humanInLoop: true, handoffAccessMode: true },
      },
    },
  });
  if (!conversation || conversation.representativeId !== input.representativeId) {
    throw new Error("Conversation not found for handoff acceptance.");
  }
  await lockHandoffIdentity(tx, conversation);
  const request = await tx.handoffRequest.findFirst({
    where: {
      conversationId: conversation.id,
      representativeId: input.representativeId,
      status: { in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!request) {
    if (!conversation.representative.humanInLoop) {
      throw new HandoffDisabledError();
    }
    if (
      conversation.representative.handoffAccessMode
      === RepresentativeHandoffAccessMode.PACKAGE_REQUIRED
    ) {
      throw new HandoffEntitlementRequiredError();
    }
    return null;
  }
  if (
    !request.handoffEntitlementGrantId
    && !conversation.representative.humanInLoop
  ) {
    throw new HandoffDisabledError();
  }
  return acceptHandoffRequestInTransaction({ handoffRequestId: request.id }, tx);
}

export async function acceptHandoffRequestInTransaction(
  input: { handoffRequestId: string },
  tx: Prisma.TransactionClient,
): Promise<HandoffRequest> {
  let request = await tx.handoffRequest.findUnique({
    where: { id: input.handoffRequestId },
  });
  if (!request) throw new Error("Handoff request not found.");
  await lockHandoffIdentity(tx, request);
  request = await tx.handoffRequest.findUnique({
    where: { id: request.id },
  });
  if (!request) throw new Error("Handoff request not found.");

  if (!request.handoffEntitlementGrantId) {
    if (request.status === HandoffStatus.ACCEPTED) return request;
    if (
      request.status !== HandoffStatus.OPEN
      && request.status !== HandoffStatus.REVIEWING
    ) {
      throw new HandoffStateConflictError(
        "Only an open or reviewing handoff can be accepted.",
      );
    }
    return tx.handoffRequest.update({
      where: { id: request.id },
      data: { status: HandoffStatus.ACCEPTED },
    });
  }

  if (
    request.entitlementReservationState
    === HandoffEntitlementReservationState.CONSUMED
  ) {
    if (
      request.status === HandoffStatus.ACCEPTED
      || request.status === HandoffStatus.CLOSED
    ) {
      return request;
    }
    throw new HandoffStateConflictError(
      "The paid handoff was consumed in an invalid request state.",
    );
  }
  if (
    request.entitlementReservationState
    !== HandoffEntitlementReservationState.RESERVED
    || (
      request.status !== HandoffStatus.OPEN
      && request.status !== HandoffStatus.REVIEWING
    )
  ) {
    throw new HandoffStateConflictError(
      "The handoff entitlement is not reserved for acceptance.",
    );
  }

  const grant = await tx.handoffEntitlementGrant.findUniqueOrThrow({
    where: { id: request.handoffEntitlementGrantId },
  });
  const exhausted =
    grant.allowance === BillingHandoffAllowance.LIMITED
    && grant.remainingUses === 0
    && grant.reservedUses === 1
    && grant.grantedUses === grant.consumedUses + 1;
  const moved = await tx.handoffEntitlementGrant.updateMany({
    where: {
      id: grant.id,
      status: HandoffEntitlementGrantStatus.ACTIVE,
      reservedUses: { gt: 0 },
    },
    data: {
      reservedUses: { decrement: 1 },
      consumedUses: { increment: 1 },
      ...(exhausted
        ? { status: HandoffEntitlementGrantStatus.EXHAUSTED }
        : {}),
    },
  });
  if (moved.count !== 1) {
    throw new HandoffStateConflictError(
      "The handoff grant changed before it could be consumed.",
    );
  }
  const consumedAt = new Date();
  const updatedRequest = await tx.handoffRequest.update({
    where: { id: request.id },
    data: {
      status: HandoffStatus.ACCEPTED,
      entitlementReservationState:
        HandoffEntitlementReservationState.CONSUMED,
      entitlementConsumedAt: consumedAt,
    },
  });
  const updatedGrant = await tx.handoffEntitlementGrant.findUniqueOrThrow({
    where: { id: grant.id },
  });
  await tx.handoffEntitlementLedgerEntry.create({
    data: {
      grantId: updatedGrant.id,
      handoffRequestId: request.id,
      kind: HandoffEntitlementLedgerKind.CONSUME,
      uses: 1,
      remainingAfter: updatedGrant.remainingUses,
      reservedAfter: updatedGrant.reservedUses,
      consumedAfter: updatedGrant.consumedUses,
      idempotencyKey: `handoff:${request.id}:consume`,
      metadata: { acceptedAt: consumedAt.toISOString() },
    },
  });
  return updatedRequest;
}

/**
 * Resolve an unaccepted request and release its reservation. A consumed request
 * can only move ACCEPTED -> CLOSED; its paid use is never restored.
 */
export async function resolveHandoffRequestInTransaction(
  input: {
    handoffRequestId: string;
    status: "DECLINED" | "CLOSED";
    reason: string;
  },
  tx: Prisma.TransactionClient,
): Promise<HandoffRequest> {
  let request = await tx.handoffRequest.findUnique({
    where: { id: input.handoffRequestId },
  });
  if (!request) throw new Error("Handoff request not found.");
  await lockHandoffIdentity(tx, request);
  request = await tx.handoffRequest.findUnique({
    where: { id: request.id },
  });
  if (!request) throw new Error("Handoff request not found.");

  if (!request.handoffEntitlementGrantId) {
    if (request.status === input.status) return request;
    if (
      request.status === HandoffStatus.ACCEPTED
      && input.status === HandoffStatus.CLOSED
    ) {
      return tx.handoffRequest.update({
        where: { id: request.id },
        data: { status: HandoffStatus.CLOSED },
      });
    }
    if (
      request.status !== HandoffStatus.OPEN
      && request.status !== HandoffStatus.REVIEWING
    ) {
      throw new HandoffStateConflictError(
        "Only an unaccepted handoff can be declined or closed.",
      );
    }
    return tx.handoffRequest.update({
      where: { id: request.id },
      data: { status: input.status },
    });
  }

  if (
    request.entitlementReservationState
    === HandoffEntitlementReservationState.CONSUMED
  ) {
    if (input.status !== HandoffStatus.CLOSED) {
      throw new HandoffStateConflictError(
        "A consumed handoff can be closed but cannot be declined.",
      );
    }
    if (request.status === HandoffStatus.CLOSED) return request;
    if (request.status !== HandoffStatus.ACCEPTED) {
      throw new HandoffStateConflictError(
        "Only an accepted consumed handoff can be closed.",
      );
    }
    return tx.handoffRequest.update({
      where: { id: request.id },
      data: { status: HandoffStatus.CLOSED },
    });
  }
  if (
    request.entitlementReservationState
    === HandoffEntitlementReservationState.RELEASED
  ) {
    if (request.status === input.status) return request;
    throw new HandoffStateConflictError(
      "The handoff reservation was already released to another terminal state.",
    );
  }
  if (
    request.entitlementReservationState
    !== HandoffEntitlementReservationState.RESERVED
    || (
      request.status !== HandoffStatus.OPEN
      && request.status !== HandoffStatus.REVIEWING
    )
  ) {
    throw new HandoffStateConflictError(
      "The handoff entitlement is not releasable.",
    );
  }

  const grant = await tx.handoffEntitlementGrant.findUniqueOrThrow({
    where: { id: request.handoffEntitlementGrantId },
  });
  const moved = await tx.handoffEntitlementGrant.updateMany({
    where: {
      id: grant.id,
      status: HandoffEntitlementGrantStatus.ACTIVE,
      reservedUses: { gt: 0 },
    },
    data: {
      reservedUses: { decrement: 1 },
      ...(grant.allowance === BillingHandoffAllowance.LIMITED
        ? { remainingUses: { increment: 1 } }
        : {}),
    },
  });
  if (moved.count !== 1) {
    throw new HandoffStateConflictError(
      "The handoff grant changed before it could be released.",
    );
  }
  const releasedAt = new Date();
  const updatedRequest = await tx.handoffRequest.update({
    where: { id: request.id },
    data: {
      status: input.status,
      entitlementReservationState:
        HandoffEntitlementReservationState.RELEASED,
      entitlementReleasedAt: releasedAt,
    },
  });
  const updatedGrant = await tx.handoffEntitlementGrant.findUniqueOrThrow({
    where: { id: grant.id },
  });
  await tx.handoffEntitlementLedgerEntry.create({
    data: {
      grantId: updatedGrant.id,
      handoffRequestId: request.id,
      kind: HandoffEntitlementLedgerKind.RELEASE,
      uses: 1,
      remainingAfter: updatedGrant.remainingUses,
      reservedAfter: updatedGrant.reservedUses,
      consumedAfter: updatedGrant.consumedUses,
      idempotencyKey: `handoff:${request.id}:release`,
      metadata: {
        releasedAt: releasedAt.toISOString(),
        reason: input.reason,
      },
    },
  });
  return updatedRequest;
}

async function lockHandoffIdentity(
  tx: Prisma.TransactionClient,
  input: {
    representativeId: string;
    audienceIdentityId?: string | null;
    contactId: string;
  },
): Promise<void> {
  const identityKey = input.audienceIdentityId
    ? `audience:${input.audienceIdentityId}`
    : `contact:${input.contactId}`;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`handoff:${input.representativeId}:${identityKey}`})
    )
  `;
}

function clampPriority(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value || 0)));
}

function serializeGrant(
  grant: HandoffGrantRecord,
): PurchasedHandoffEntitlementSnapshot {
  if (!grant.expiresAt) throw new Error("Handoff grant is missing its expiry.");
  return {
    id: grant.id,
    rechargeOrderId: grant.rechargeOrderId,
    audienceIdentityId: grant.audienceIdentityId,
    representativeId: grant.representativeId,
    billingPriceVersionId: grant.billingPriceVersionId,
    allowance: grant.allowance as "LIMITED" | "UNLIMITED",
    serviceLevel: grant.serviceLevel,
    grantedUses: grant.grantedUses,
    remainingUses: grant.remainingUses,
    reservedUses: grant.reservedUses,
    consumedUses: grant.consumedUses,
    status: grant.status,
    startsAt: grant.startsAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
  };
}
