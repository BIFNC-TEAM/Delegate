import { randomUUID } from "node:crypto";

import {
  AgentTokenPurchaseStatus,
  CreatorEarningStatus,
  PaymentProvider,
  Prisma,
  RechargeOrderStatus,
  RechargeRefundProviderStatus,
  RechargeRefundReversalStatus,
  RechargeRefundSubmissionStatus,
  ServiceEntitlementStatus,
} from "@prisma/client";

import {
  persistVerifiedWeChatPayRefundApiResult,
} from "./agent-wallet-wechat-refunds";
import {
  runWalletWriteTransaction,
  WalletIdempotencyConflictError,
} from "./agent-wallet-write";
import { prisma } from "./prisma";
import {
  queryWeChatPayRefundByOutRefundNo,
  submitWeChatPayRefund,
  WeChatPayRefundApiError,
  type SubmitWeChatPayRefundInput,
  type WeChatPayRefundApiResult,
} from "./wechat-pay-api-v3";
import {
  loadWeChatPayProcessingConfigFromEnv,
} from "./wechat-pay-release-flags";

export const WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE =
  "wechat_pay.refund.reconcile";
const WECHAT_REFUND_LIFECYCLE_AGGREGATE_TYPE =
  "recharge_refund";
const MINIMUM_LIFECYCLE_LEASE_MS = 75_000;
const DEFAULT_LIFECYCLE_LEASE_MS = 75_000;
const DEFAULT_INITIAL_QUERY_DELAY_MS = 60_000;
const DEFAULT_MAX_RECOVERY_AGE_MS = 8 * 24 * 60 * 60_000;
const MINIMUM_MAX_RECOVERY_AGE_MS = 8 * 24 * 60 * 60_000;
const MAXIMUM_MAX_RECOVERY_AGE_MS = 30 * 24 * 60 * 60_000;
const DEFINITIVE_REFUND_SUBMISSION_REJECTION_CODES =
  new Set([
    "PARAM_ERROR",
    "INVALID_REQUEST",
    "SIGN_ERROR",
    "NOT_ENOUGH",
    "USER_ACCOUNT_ABNORMAL",
    "MCH_NOT_EXISTS",
    "RESOURCE_NOT_EXISTS",
  ]);

export type CreateWeChatRefundIntentInput = {
  rechargeOrderId: string;
  requestedByOwnerId: string;
  requestIdempotencyKey: string;
  refundNotifyUrl: string;
  reason?: string;
};

export type WeChatRefundIntentSnapshot = {
  id: string;
  rechargeOrderId: string;
  providerRefundOrderId: string;
  submissionStatus:
    | "queued"
    | "accepted"
    | "unknown"
    | "rejected";
  providerStatus:
    | "processing"
    | "succeeded"
    | "closed"
    | "abnormal"
    | null;
  reversalStatus:
    | "pending"
    | "applied"
    | "not_required"
    | "reconciliation_required";
  processingError: string | null;
};

export type WeChatRefundLifecycleClaim = {
  outboxId: string;
  rechargeRefundId: string;
  attempt: number;
  leaseUntil: Date;
};

export type WeChatRefundLifecycleTickSummary = {
  claimed: number;
  submitted: number;
  queried: number;
  terminal: number;
  pending: number;
  rejected: number;
  failed: number;
  reconciliationRequired: number;
};

export type WeChatRefundLifecycleDependencies = {
  submitRefund?: (
    input: SubmitWeChatPayRefundInput,
  ) => Promise<WeChatPayRefundApiResult>;
  queryRefund?: (
    outRefundNo: string,
  ) => Promise<WeChatPayRefundApiResult>;
};

export type RunWeChatRefundLifecycleTickOptions =
  WeChatRefundLifecycleDependencies & {
    client?: typeof prisma;
    limit?: number;
    leaseMs?: number;
    maxRecoveryAgeMs?: number;
    now?: () => Date;
  };

export class WeChatRefundIntentConflictError extends Error {
  readonly code = "WECHAT_REFUND_INTENT_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WeChatRefundIntentConflictError";
  }
}

export class WeChatRefundLifecycleLeaseLostError extends Error {
  readonly code = "WECHAT_REFUND_LIFECYCLE_LEASE_LOST";

  constructor() {
    super("WeChat refund lifecycle lease was lost.");
    this.name = "WeChatRefundLifecycleLeaseLostError";
  }
}

export async function createWeChatRefundIntent(
  input: CreateWeChatRefundIntentInput,
  options: {
    client?: typeof prisma;
    now?: () => Date;
    providerRefundOrderId?: string;
  } = {},
): Promise<WeChatRefundIntentSnapshot> {
  const rechargeOrderId = requiredText(
    input.rechargeOrderId,
    "rechargeOrderId",
    64,
  );
  const requestedByOwnerId = requiredText(
    input.requestedByOwnerId,
    "requestedByOwnerId",
    128,
  );
  const requestIdempotencyKey = requiredText(
    input.requestIdempotencyKey,
    "requestIdempotencyKey",
    200,
  );
  const reason = optionalBoundedText(input.reason, "reason", 80);
  const refundNotifyUrl = validatedRefundNotifyUrl(
    input.refundNotifyUrl,
  );
  const providerRefundOrderId =
    options.providerRefundOrderId
      ? validatedProviderRefundOrderId(
          options.providerRefundOrderId,
        )
      : `delegate_${randomUUID().replaceAll("-", "")}`;
  const client = options.client ?? prisma;
  const now = options.now?.() ?? new Date();

  return runWalletWriteTransaction(client, async (tx) => {
    const replay = await tx.rechargeRefund.findUnique({
      where: { requestIdempotencyKey },
    });
    if (replay) {
      assertIntentReplayMatches(replay, {
        rechargeOrderId,
        requestedByOwnerId,
        requestIdempotencyKey,
        reason,
        refundNotifyUrl,
      });
      return serializeIntent(replay);
    }

    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "RechargeOrder"
      WHERE "id" = ${rechargeOrderId}
      FOR UPDATE
    `;
    if (!locked[0]) {
      throw new WeChatRefundIntentConflictError(
        "Recharge order not found.",
      );
    }
    // The first lookup is only a fast path. A concurrent creator can commit
    // while this transaction waits for the order lock, so repeat the exact
    // idempotency check under the serialized order boundary.
    const replayAfterLock = await tx.rechargeRefund.findUnique({
      where: { requestIdempotencyKey },
    });
    if (replayAfterLock) {
      assertIntentReplayMatches(replayAfterLock, {
        rechargeOrderId,
        requestedByOwnerId,
        requestIdempotencyKey,
        reason,
        refundNotifyUrl,
      });
      return serializeIntent(replayAfterLock);
    }
    const order = await tx.rechargeOrder.findUnique({
      where: { id: rechargeOrderId },
      include: {
        representative: {
          select: { ownerId: true },
        },
        tokenPurchases: {
          include: {
            userAgentWallet: true,
            creatorEarnings: true,
            entitlementAccount: true,
          },
          orderBy: { createdAt: "asc" },
        },
        refunds: {
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!order) {
      throw new WeChatRefundIntentConflictError(
        "Recharge order not found.",
      );
    }
    if (
      order.representative?.ownerId !== requestedByOwnerId
    ) {
      throw new WeChatRefundIntentConflictError(
        "Recharge order is not owned by the requester.",
      );
    }
    assertRefundableOrder(order);
    if (
      order.refunds.some((refund) =>
        isUnresolvedOrSuccessfulRefund(refund),
      )
    ) {
      throw new WeChatRefundIntentConflictError(
        "Recharge order already has an unresolved or successful refund.",
      );
    }

    const purchase = order.tokenPurchases[0]!;
    const refund = await tx.rechargeRefund.create({
      data: {
        rechargeOrderId: order.id,
        tokenPurchaseId: purchase.id,
        requestedByOwnerId,
        provider: PaymentProvider.WECHAT_PAY,
        providerRefundOrderId,
        paymentTransactionId: order.providerTransactionId!,
        originalAmountCents: order.amountCents,
        refundAmountCents: order.amountCents,
        currency: order.currency,
        submissionStatus:
          RechargeRefundSubmissionStatus.QUEUED,
        reversalStatus: RechargeRefundReversalStatus.PENDING,
        requestIdempotencyKey,
        requestReason: reason,
        refundNotifyUrl,
      },
    });
    await tx.serviceEntitlementAccount.update({
      where: { id: purchase.entitlementAccountId! },
      data: { status: ServiceEntitlementStatus.FROZEN },
    });
    await tx.outboxEvent.create({
      data: {
        aggregateType:
          WECHAT_REFUND_LIFECYCLE_AGGREGATE_TYPE,
        aggregateId: refund.id,
        eventType: WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE,
        payload: { version: 1 },
        status: "PENDING",
        idempotencyKey:
          `wechat_pay:refund:${refund.id}:lifecycle`,
        availableAt: now,
      },
    });
    return serializeIntent(refund);
  });
}

export async function claimNextWeChatRefundLifecycle(
  options: {
    client?: typeof prisma;
    leaseMs?: number;
  } = {},
): Promise<WeChatRefundLifecycleClaim | null> {
  const client = options.client ?? prisma;
  const leaseMs = normalizedLeaseMs(options.leaseMs);
  return client.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{
      id: string;
      aggregateId: string;
      attemptCount: number;
      claimedAt: Date;
    }>>`
      SELECT
        "id",
        "aggregateId",
        "attemptCount",
        NOW() AS "claimedAt"
      FROM "OutboxEvent"
      WHERE "aggregateType" =
          ${WECHAT_REFUND_LIFECYCLE_AGGREGATE_TYPE}
        AND "eventType" =
          ${WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE}
        AND "status" IN ('PENDING', 'FAILED', 'PROCESSING')
        AND "availableAt" <= NOW()
      ORDER BY "availableAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;
    const claimedAt =
      candidate.claimedAt instanceof Date
        && Number.isFinite(candidate.claimedAt.getTime())
        ? candidate.claimedAt
        : new Date();
    const attempt = candidate.attemptCount + 1;
    const leaseUntil = new Date(
      claimedAt.getTime() + leaseMs,
    );
    await tx.outboxEvent.update({
      where: { id: candidate.id },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: leaseUntil,
        processedAt: null,
        lastError: null,
      },
    });
    return {
      outboxId: candidate.id,
      rechargeRefundId: candidate.aggregateId,
      attempt,
      leaseUntil,
    };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}

export async function runWeChatRefundLifecycleTick(
  options: RunWeChatRefundLifecycleTickOptions = {},
): Promise<WeChatRefundLifecycleTickSummary> {
  const limit = normalizedLimit(options.limit);
  const summary: WeChatRefundLifecycleTickSummary = {
    claimed: 0,
    submitted: 0,
    queried: 0,
    terminal: 0,
    pending: 0,
    rejected: 0,
    failed: 0,
    reconciliationRequired: 0,
  };
  for (let index = 0; index < limit; index += 1) {
    const claim = await claimNextWeChatRefundLifecycle({
      ...(options.client ? { client: options.client } : {}),
      ...(options.leaseMs !== undefined
        ? { leaseMs: options.leaseMs }
        : {}),
    });
    if (!claim) break;
    summary.claimed += 1;
    try {
      const result = await reconcileClaimedWeChatRefund(
        claim,
        options,
      );
      summary.submitted += result.submitted ? 1 : 0;
      summary.queried += result.queried ? 1 : 0;
      summary.terminal += result.terminal ? 1 : 0;
      summary.pending += result.pending ? 1 : 0;
      summary.rejected += result.rejected ? 1 : 0;
      summary.reconciliationRequired +=
        result.reconciliationRequired ? 1 : 0;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

async function reconcileClaimedWeChatRefund(
  claim: WeChatRefundLifecycleClaim,
  options: RunWeChatRefundLifecycleTickOptions,
): Promise<{
  submitted: boolean;
  queried: boolean;
  terminal: boolean;
  pending: boolean;
  rejected: boolean;
  reconciliationRequired: boolean;
}> {
  const client = options.client ?? prisma;
  const now = options.now?.() ?? new Date();
  const maxRecoveryAgeMs = normalizedMaxRecoveryAge(
    options.maxRecoveryAgeMs,
  );
  const refund = await client.rechargeRefund.findUnique({
    where: { id: claim.rechargeRefundId },
    include: {
      rechargeOrder: true,
      tokenPurchase: {
        include: { entitlementAccount: true },
      },
    },
  });
  if (!refund || refund.provider !== PaymentProvider.WECHAT_PAY) {
    await deadLetterOwnedClaim(
      claim,
      "wechat_refund_intent_missing_or_provider_mismatch",
      client,
    );
    throw new WeChatRefundIntentConflictError(
      "WeChat refund intent is missing or has another provider.",
    );
  }
  if (
    refund.submissionStatus
      === RechargeRefundSubmissionStatus.REJECTED
    || refund.providerStatus
      === RechargeRefundProviderStatus.CLOSED
    || refund.providerStatus
      === RechargeRefundProviderStatus.SUCCEEDED
  ) {
    if (
      refund.providerStatus
      === RechargeRefundProviderStatus.CLOSED
      && refund.reversalStatus
        === RechargeRefundReversalStatus.NOT_REQUIRED
    ) {
      await restoreRefundEntitlementIfResolved(
        refund.id,
        client,
        now,
      );
    }
    await completeOwnedClaim(claim, client);
    return {
      submitted: false,
      queried: false,
      terminal: true,
      pending: false,
      rejected:
        refund.submissionStatus
        === RechargeRefundSubmissionStatus.REJECTED,
      reconciliationRequired: false,
    };
  }
  if (
    now.getTime() - refund.createdAt.getTime()
      >= maxRecoveryAgeMs
  ) {
    await quarantineExpiredRecovery(
      claim,
      "wechat_refund_recovery_window_exhausted",
      client,
    );
    return {
      submitted: false,
      queried: false,
      terminal: false,
      pending: false,
      rejected: false,
      reconciliationRequired: true,
    };
  }

  const dependencies = resolveLifecycleDependencies(options);
  let submitted = false;
  let queried = false;
  let providerResult: WeChatPayRefundApiResult;
  const initialSubmission =
    refund.submissionStatus
      === RechargeRefundSubmissionStatus.QUEUED
      ? await markRefundSubmissionStarted(
          claim,
          client,
          options.now?.() ?? new Date(),
          options.leaseMs,
        )
      : false;
  try {
    if (initialSubmission) {
      submitted = true;
      providerResult = await dependencies.submitRefund(
        refundRequestInput(refund),
      );
    } else {
      queried = true;
      try {
        await renewRefundClaimForProviderEffect(
          claim,
          client,
          options.now?.() ?? new Date(),
          options.leaseMs,
        );
        providerResult = await dependencies.queryRefund(
          refund.providerRefundOrderId,
        );
      } catch (error) {
        if (
          error instanceof WeChatPayRefundApiError
          && error.failureKind === "not_found"
          && refund.submissionStatus
            === RechargeRefundSubmissionStatus.UNKNOWN
        ) {
          if (
            isStoredDefinitiveRefundSubmissionRejection(
              refund.processingError,
            )
          ) {
            const rejected = await recordRejectedAndComplete(
              claim,
              refund.processingError!,
              client,
              now,
              refund.createdAt,
            );
            return {
              submitted: false,
              queried: true,
              terminal: rejected,
              pending: !rejected,
              rejected,
              reconciliationRequired: false,
            };
          }
          submitted = true;
          await renewRefundClaimForProviderEffect(
            claim,
            client,
            options.now?.() ?? new Date(),
            options.leaseMs,
          );
          providerResult = await dependencies.submitRefund(
            refundRequestInput(refund),
          );
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    // The refund is durably UNKNOWN before the first POST. A crash, timeout,
    // or any non-2xx response can race with provider-side acceptance, so none
    // of them unfreeze directly. Persist only a stable error code; the next
    // attempt must query this exact out_refund_no first. A documented
    // definitive rejection is applied only after that signed query confirms
    // the refund does not exist.
    await recordUnknownAndReschedule(
      claim,
      safeLifecycleErrorCode(error),
      client,
      now,
      refund.createdAt,
    );
    return {
      submitted,
      queried,
      terminal: false,
      pending: true,
      rejected: false,
      reconciliationRequired: false,
    };
  }

  const persisted =
    await persistVerifiedWeChatPayRefundApiResult(
      providerResult,
      client,
    );
  if (
    persisted.providerStatus === "succeeded"
    || persisted.providerStatus === "closed"
  ) {
    await completeOwnedClaim(claim, client);
    return {
      submitted,
      queried,
      terminal: true,
      pending: false,
      rejected: false,
      reconciliationRequired:
        persisted.reversalStatus
        === "reconciliation_required",
    };
  }
  await rescheduleOwnedClaim(
    claim,
    client,
    nextLifecycleAttemptAt(
      now,
      refund.createdAt,
    ),
    persisted.providerStatus === "abnormal"
      ? "wechat_refund_provider_abnormal"
      : null,
  );
  return {
    submitted,
    queried,
    terminal: false,
    pending: true,
    rejected: false,
    reconciliationRequired: false,
  };
}

async function markRefundSubmissionStarted(
  claim: WeChatRefundLifecycleClaim,
  client: typeof prisma,
  now: Date,
  leaseMsInput: number | undefined,
): Promise<boolean> {
  const leaseMs = normalizedLeaseMs(leaseMsInput);
  return runWalletWriteTransaction(client, async (tx) => {
    const fenced = await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: {
        status: "PROCESSING",
        availableAt: new Date(now.getTime() + leaseMs),
      },
    });
    if (fenced.count !== 1) {
      throw new WeChatRefundLifecycleLeaseLostError();
    }
    const marked = await tx.rechargeRefund.updateMany({
      where: {
        id: claim.rechargeRefundId,
        provider: PaymentProvider.WECHAT_PAY,
        providerStatus: null,
        submissionStatus:
          RechargeRefundSubmissionStatus.QUEUED,
      },
      data: {
        submissionStatus:
          RechargeRefundSubmissionStatus.UNKNOWN,
        processingError: "wechat_refund_submission_started",
      },
    });
    if (marked.count !== 1) {
      throw new WeChatRefundIntentConflictError(
        "WeChat refund submission state changed before the provider request.",
      );
    }
    return true;
  });
}

async function renewRefundClaimForProviderEffect(
  claim: WeChatRefundLifecycleClaim,
  client: typeof prisma,
  now: Date,
  leaseMsInput: number | undefined,
): Promise<void> {
  const leaseMs = normalizedLeaseMs(leaseMsInput);
  const renewed = await client.outboxEvent.updateMany({
    where: ownedClaimWhere(claim),
    data: {
      status: "PROCESSING",
      availableAt: new Date(now.getTime() + leaseMs),
    },
  });
  if (renewed.count !== 1) {
    throw new WeChatRefundLifecycleLeaseLostError();
  }
}

function resolveLifecycleDependencies(
  options: WeChatRefundLifecycleDependencies,
): Required<WeChatRefundLifecycleDependencies> {
  let config:
    | ReturnType<typeof loadWeChatPayProcessingConfigFromEnv>
    | undefined;
  return {
    submitRefund:
      options.submitRefund
      ?? ((input) => {
        config ??= loadWeChatPayProcessingConfigFromEnv();
        return submitWeChatPayRefund(input, config);
      }),
    queryRefund:
      options.queryRefund
      ?? ((outRefundNo) => {
        config ??= loadWeChatPayProcessingConfigFromEnv();
        return queryWeChatPayRefundByOutRefundNo(
          outRefundNo,
          config,
        );
      }),
  };
}

function refundRequestInput(refund: {
  paymentTransactionId: string;
  rechargeOrderId: string;
  providerRefundOrderId: string;
  originalAmountCents: number;
  refundAmountCents: number;
  currency: string;
  requestReason: string | null;
  refundNotifyUrl: string | null;
}): SubmitWeChatPayRefundInput {
  if (refund.currency !== "CNY" || !refund.refundNotifyUrl) {
    throw new WeChatRefundIntentConflictError(
      "WeChat refund intent is missing canonical request data.",
    );
  }
  return {
    transactionId: refund.paymentTransactionId,
    outTradeNo: refund.rechargeOrderId,
    outRefundNo: refund.providerRefundOrderId,
    originalAmountCents: refund.originalAmountCents,
    refundAmountCents: refund.refundAmountCents,
    currency: "CNY",
    ...(refund.requestReason
      ? { reason: refund.requestReason }
      : {}),
    notifyUrl: refund.refundNotifyUrl,
  };
}

async function completeOwnedClaim(
  claim: WeChatRefundLifecycleClaim,
  client: typeof prisma,
): Promise<void> {
  const updated = await client.outboxEvent.updateMany({
    where: ownedClaimWhere(claim),
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      lastError: null,
    },
  });
  if (updated.count !== 1) {
    throw new WeChatRefundLifecycleLeaseLostError();
  }
}

async function rescheduleOwnedClaim(
  claim: WeChatRefundLifecycleClaim,
  client: typeof prisma,
  availableAt: Date,
  lastError: string | null,
): Promise<void> {
  const updated = await client.outboxEvent.updateMany({
    where: ownedClaimWhere(claim),
    data: {
      status: lastError ? "FAILED" : "PENDING",
      availableAt,
      processedAt: null,
      lastError,
    },
  });
  if (updated.count !== 1) {
    throw new WeChatRefundLifecycleLeaseLostError();
  }
}

async function recordUnknownAndReschedule(
  claim: WeChatRefundLifecycleClaim,
  errorCode: string,
  client: typeof prisma,
  now: Date,
  createdAt: Date,
): Promise<void> {
  await client.$transaction(async (tx) => {
    const fenced = await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: { status: "PROCESSING" },
    });
    if (fenced.count !== 1) {
      throw new WeChatRefundLifecycleLeaseLostError();
    }
    await tx.rechargeRefund.updateMany({
      where: {
        id: claim.rechargeRefundId,
        providerStatus: null,
        submissionStatus: {
          in: [
            RechargeRefundSubmissionStatus.QUEUED,
            RechargeRefundSubmissionStatus.UNKNOWN,
          ],
        },
      },
      data: {
        submissionStatus:
          RechargeRefundSubmissionStatus.UNKNOWN,
        processingError: errorCode,
      },
    });
    await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: {
        status: "FAILED",
        availableAt: nextLifecycleAttemptAt(now, createdAt),
        processedAt: null,
        lastError: errorCode,
      },
    });
  });
}

async function recordRejectedAndComplete(
  claim: WeChatRefundLifecycleClaim,
  errorCode: string,
  client: typeof prisma,
  now: Date,
  createdAt: Date,
): Promise<boolean> {
  return runWalletWriteTransaction(client, async (tx) => {
    const fenced = await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: { status: "PROCESSING" },
    });
    if (fenced.count !== 1) {
      throw new WeChatRefundLifecycleLeaseLostError();
    }

    const rejected = await tx.rechargeRefund.updateMany({
      where: {
        id: claim.rechargeRefundId,
        provider: PaymentProvider.WECHAT_PAY,
        providerStatus: null,
        reversalStatus: RechargeRefundReversalStatus.PENDING,
        submissionStatus: {
          in: [
            RechargeRefundSubmissionStatus.QUEUED,
            RechargeRefundSubmissionStatus.UNKNOWN,
          ],
        },
      },
      data: {
        submissionStatus:
          RechargeRefundSubmissionStatus.REJECTED,
        reversalStatus:
          RechargeRefundReversalStatus.NOT_REQUIRED,
        processingError: errorCode,
      },
    });
    if (rejected.count !== 1) {
      const current = await tx.rechargeRefund.findUnique({
        where: { id: claim.rechargeRefundId },
        select: {
          submissionStatus: true,
          providerStatus: true,
          reversalStatus: true,
        },
      });
      if (
        current?.submissionStatus
          !== RechargeRefundSubmissionStatus.REJECTED
        || current.providerStatus !== null
        || current.reversalStatus
          !== RechargeRefundReversalStatus.NOT_REQUIRED
      ) {
        const rescheduled = await tx.outboxEvent.updateMany({
          where: ownedClaimWhere(claim),
          data: {
            status: "FAILED",
            availableAt: nextLifecycleAttemptAt(now, createdAt),
            processedAt: null,
            lastError: "wechat_refund_rejection_state_raced",
          },
        });
        if (rescheduled.count !== 1) {
          throw new WeChatRefundLifecycleLeaseLostError();
        }
        return false;
      }
    }

    await restoreRefundEntitlementWithinTransaction(
      tx,
      claim.rechargeRefundId,
      now,
    );
    const completed = await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: {
        status: "PROCESSED",
        processedAt: now,
        lastError: null,
      },
    });
    if (completed.count !== 1) {
      throw new WeChatRefundLifecycleLeaseLostError();
    }
    return true;
  });
}

async function quarantineExpiredRecovery(
  claim: WeChatRefundLifecycleClaim,
  errorCode: string,
  client: typeof prisma,
): Promise<void> {
  await client.$transaction(async (tx) => {
    const fenced = await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: { status: "PROCESSING" },
    });
    if (fenced.count !== 1) {
      throw new WeChatRefundLifecycleLeaseLostError();
    }
    await tx.rechargeRefund.updateMany({
      where: {
        id: claim.rechargeRefundId,
        reversalStatus: RechargeRefundReversalStatus.PENDING,
      },
      data: {
        reversalStatus:
          RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
        processingError: errorCode,
      },
    });
    await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: {
        status: "DEAD_LETTER",
        processedAt: null,
        lastError: errorCode,
      },
    });
  });
}

async function deadLetterOwnedClaim(
  claim: WeChatRefundLifecycleClaim,
  errorCode: string,
  client: typeof prisma,
): Promise<void> {
  const updated = await client.outboxEvent.updateMany({
    where: ownedClaimWhere(claim),
    data: {
      status: "DEAD_LETTER",
      processedAt: null,
      lastError: errorCode,
    },
  });
  if (updated.count !== 1) {
    throw new WeChatRefundLifecycleLeaseLostError();
  }
}

function ownedClaimWhere(
  claim: WeChatRefundLifecycleClaim,
): Prisma.OutboxEventWhereInput {
  return {
    id: claim.outboxId,
    aggregateType: WECHAT_REFUND_LIFECYCLE_AGGREGATE_TYPE,
    aggregateId: claim.rechargeRefundId,
    eventType: WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE,
    status: "PROCESSING",
    attemptCount: claim.attempt,
  };
}

async function restoreRefundEntitlementIfResolved(
  rechargeRefundId: string,
  client: typeof prisma,
  now: Date,
): Promise<void> {
  await client.$transaction((tx) =>
    restoreRefundEntitlementWithinTransaction(
      tx,
      rechargeRefundId,
      now,
    ),
  );
}

async function restoreRefundEntitlementWithinTransaction(
  tx: Prisma.TransactionClient,
  rechargeRefundId: string,
  now: Date,
): Promise<void> {
  const refund = await tx.rechargeRefund.findUnique({
    where: { id: rechargeRefundId },
    include: {
      tokenPurchase: {
        include: { entitlementAccount: true },
      },
    },
  });
  const account = refund?.tokenPurchase?.entitlementAccount;
  if (!account) return;
  const unresolved = await tx.rechargeRefund.count({
    where: {
      id: { not: rechargeRefundId },
      tokenPurchase: {
        entitlementAccountId: account.id,
      },
      OR: [
        {
          submissionStatus: {
            in: [
              RechargeRefundSubmissionStatus.QUEUED,
              RechargeRefundSubmissionStatus.UNKNOWN,
            ],
          },
        },
        {
          providerStatus: {
            in: [
              RechargeRefundProviderStatus.PROCESSING,
              RechargeRefundProviderStatus.ABNORMAL,
              RechargeRefundProviderStatus.SUCCEEDED,
            ],
          },
          reversalStatus: {
            in: [
              RechargeRefundReversalStatus.PENDING,
              RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
            ],
          },
        },
      ],
    },
  });
  if (unresolved !== 0) return;
  const expired =
    account.expiresAt !== null
    && account.expiresAt.getTime() <= now.getTime();
  await tx.serviceEntitlementAccount.update({
    where: { id: account.id },
    data: {
      status: expired
        ? ServiceEntitlementStatus.EXPIRED
        : account.remainingUnits === 0
            && account.reservedUnits === 0
          ? ServiceEntitlementStatus.EXHAUSTED
          : ServiceEntitlementStatus.ACTIVE,
    },
  });
}

function assertRefundableOrder(order: {
  id: string;
  provider: PaymentProvider;
  providerTransactionId: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  tokenPurchases: Array<{
    rechargeOrderId: string | null;
    amountCents: number;
    currency: string;
    tokenAmount: number;
    remainingTokenAmount: number | null;
    creatorPendingCents: number;
    status: AgentTokenPurchaseStatus;
    entitlementAccountId: string | null;
    userAgentWallet: {
      reservedTokenAmount: number;
    } | null;
    entitlementAccount: {
      status: ServiceEntitlementStatus;
    } | null;
    creatorEarnings: Array<{
      status: CreatorEarningStatus;
      pendingCents: number;
      withdrawableCents: number;
    }>;
  }>;
}): void {
  if (
    order.provider !== PaymentProvider.WECHAT_PAY
    || order.status !== RechargeOrderStatus.PAID
    || !order.providerTransactionId
    || order.currency !== "CNY"
    || order.amountCents <= 0
  ) {
    throw new WeChatRefundIntentConflictError(
      "Recharge order is not an eligible paid WeChat order.",
    );
  }
  if (order.tokenPurchases.length !== 1) {
    throw new WeChatRefundIntentConflictError(
      "Recharge order must have exactly one token purchase.",
    );
  }
  const purchase = order.tokenPurchases[0]!;
  const pendingCreatorCents = purchase.creatorEarnings.reduce(
    (sum, earning) => sum + earning.pendingCents,
    0,
  );
  if (
    purchase.rechargeOrderId !== order.id
    || purchase.amountCents !== order.amountCents
    || purchase.currency !== order.currency
    || purchase.status !== AgentTokenPurchaseStatus.COMPLETED
    || purchase.remainingTokenAmount !== purchase.tokenAmount
    || !purchase.userAgentWallet
    || purchase.userAgentWallet.reservedTokenAmount !== 0
    || !purchase.entitlementAccountId
    || !purchase.entitlementAccount
    || purchase.entitlementAccount.status
      !== ServiceEntitlementStatus.ACTIVE
    || purchase.creatorEarnings.some(
      (earning) =>
        earning.status !== CreatorEarningStatus.PENDING
        || earning.withdrawableCents !== 0,
    )
    || pendingCreatorCents !== purchase.creatorPendingCents
  ) {
    throw new WeChatRefundIntentConflictError(
      "Recharge credits are consumed, reserved, ambiguous, or no longer safely refundable.",
    );
  }
}

function isUnresolvedOrSuccessfulRefund(refund: {
  submissionStatus: RechargeRefundSubmissionStatus;
  providerStatus: RechargeRefundProviderStatus | null;
  reversalStatus: RechargeRefundReversalStatus;
}): boolean {
  return refund.submissionStatus
      === RechargeRefundSubmissionStatus.QUEUED
    || refund.submissionStatus
      === RechargeRefundSubmissionStatus.UNKNOWN
    || refund.providerStatus
      === RechargeRefundProviderStatus.PROCESSING
    || refund.providerStatus
      === RechargeRefundProviderStatus.ABNORMAL
    || refund.providerStatus
      === RechargeRefundProviderStatus.SUCCEEDED
    || refund.reversalStatus
      === RechargeRefundReversalStatus.RECONCILIATION_REQUIRED;
}

function assertIntentReplayMatches(
  refund: {
    rechargeOrderId: string;
    requestedByOwnerId: string | null;
    requestIdempotencyKey: string | null;
    requestReason: string | null;
    refundNotifyUrl: string | null;
  },
  expected: {
    rechargeOrderId: string;
    requestedByOwnerId: string;
    requestIdempotencyKey: string;
    reason: string | null;
    refundNotifyUrl: string;
  },
): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["rechargeOrderId", refund.rechargeOrderId, expected.rechargeOrderId],
    ["requestedByOwnerId", refund.requestedByOwnerId, expected.requestedByOwnerId],
    ["requestIdempotencyKey", refund.requestIdempotencyKey, expected.requestIdempotencyKey],
    ["requestReason", refund.requestReason, expected.reason],
    ["refundNotifyUrl", refund.refundNotifyUrl, expected.refundNotifyUrl],
  ];
  for (const [field, actual, wanted] of fields) {
    if (!Object.is(actual, wanted)) {
      throw new WalletIdempotencyConflictError(
        "WeChat refund intent",
        field,
      );
    }
  }
}

function serializeIntent(refund: {
  id: string;
  rechargeOrderId: string;
  providerRefundOrderId: string;
  submissionStatus: RechargeRefundSubmissionStatus;
  providerStatus: RechargeRefundProviderStatus | null;
  reversalStatus: RechargeRefundReversalStatus;
  processingError: string | null;
}): WeChatRefundIntentSnapshot {
  if (
    refund.submissionStatus
    === RechargeRefundSubmissionStatus.EXTERNAL
  ) {
    throw new Error("External refund is not a Delegate refund intent.");
  }
  return {
    id: refund.id,
    rechargeOrderId: refund.rechargeOrderId,
    providerRefundOrderId: refund.providerRefundOrderId,
    submissionStatus:
      refund.submissionStatus.toLowerCase() as
        WeChatRefundIntentSnapshot["submissionStatus"],
    providerStatus:
      refund.providerStatus
        ? refund.providerStatus.toLowerCase() as
          NonNullable<
            WeChatRefundIntentSnapshot["providerStatus"]
          >
        : null,
    reversalStatus:
      refund.reversalStatus.toLowerCase() as
        WeChatRefundIntentSnapshot["reversalStatus"],
    processingError: refund.processingError,
  };
}

function nextLifecycleAttemptAt(
  now: Date,
  createdAt: Date,
): Date {
  const ageMs = Math.max(
    0,
    now.getTime() - createdAt.getTime(),
  );
  const delayMs =
    ageMs < 5 * 60_000
      ? DEFAULT_INITIAL_QUERY_DELAY_MS
      : ageMs < 30 * 60_000
        ? 5 * 60_000
        : ageMs < 2 * 60 * 60_000
          ? 10 * 60_000
          : ageMs < 8 * 60 * 60_000
            ? 20 * 60_000
            : 30 * 60_000;
  return new Date(now.getTime() + delayMs);
}

function normalizedLeaseMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_LIFECYCLE_LEASE_MS;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < MINIMUM_LIFECYCLE_LEASE_MS
    || resolved > 10 * 60_000
  ) {
    throw new Error(
      "WeChat refund lifecycle leaseMs must be between 75000 and 600000.",
    );
  }
  return resolved;
}

function normalizedLimit(value: number | undefined): number {
  const resolved = value ?? 10;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > 100
  ) {
    throw new Error(
      "WeChat refund lifecycle limit must be between 1 and 100.",
    );
  }
  return resolved;
}

function normalizedMaxRecoveryAge(
  value: number | undefined,
): number {
  const resolved = value ?? DEFAULT_MAX_RECOVERY_AGE_MS;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < MINIMUM_MAX_RECOVERY_AGE_MS
    || resolved > MAXIMUM_MAX_RECOVERY_AGE_MS
  ) {
    throw new Error(
      "WeChat refund maxRecoveryAgeMs must cover between 8 and 30 days.",
    );
  }
  return resolved;
}

function safeLifecycleErrorCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z0-9_]{1,120}$/.test(error.code)
  ) {
    if (
      error instanceof WeChatPayRefundApiError
      && /^[A-Z0-9_]{1,80}$/.test(error.providerCode)
    ) {
      return `wechat_refund_${error.providerCode.toLowerCase()}`;
    }
    return error.code.toLowerCase();
  }
  return "wechat_refund_provider_outcome_unknown";
}

function isStoredDefinitiveRefundSubmissionRejection(
  errorCode: string | null,
): boolean {
  if (!errorCode?.startsWith("wechat_refund_")) {
    return false;
  }
  const providerCode = errorCode
    .slice("wechat_refund_".length)
    .toUpperCase();
  return DEFINITIVE_REFUND_SUBMISSION_REJECTION_CODES.has(
    providerCode,
  );
}

function validatedProviderRefundOrderId(value: string): string {
  const normalized = requiredText(
    value,
    "providerRefundOrderId",
    64,
  );
  if (!/^[0-9A-Za-z_\-|*@]+$/.test(normalized)) {
    throw new Error(
      "providerRefundOrderId contains unsupported characters.",
    );
  }
  return normalized;
}

function validatedRefundNotifyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("refundNotifyUrl must be a valid URL.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname
      !== "/api/payments/wechat/refund-notify"
    || Buffer.byteLength(url.toString(), "utf8") > 256
  ) {
    throw new Error(
      "refundNotifyUrl must be the public HTTPS WeChat refund callback without credentials, query, or fragment.",
    );
  }
  return url.toString();
}

function requiredText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(
      `${field} is required and must not exceed ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximumBytes: number,
): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new Error(
      `${field} must not exceed ${maximumBytes} UTF-8 bytes.`,
    );
  }
  return normalized;
}
