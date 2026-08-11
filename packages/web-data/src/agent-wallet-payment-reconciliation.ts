import {
  PaymentProvider,
  RechargeOrderStatus,
} from "@prisma/client";

import type {
  NormalizedPaymentProviderEvent,
  RechargeCheckoutSession,
} from "./agent-wallet-payment-providers";
import { prisma } from "./prisma";
import {
  isWeChatPayProcessingEnabled,
  loadWeChatPayProcessingConfigFromEnv,
} from "./wechat-pay-release-flags";
import {
  closeWeChatPayOrderByOutTradeNo,
  createWeChatPayApiV3PaymentProviderAdapter,
  queryWeChatPayOrderByOutTradeNo,
  WeChatPayProtocolError,
  type WeChatPayEnvironment,
  type WeChatPayOrderQueryResult,
} from "./wechat-pay-api-v3";

const WECHAT_RECONCILIATION_AGGREGATE_TYPE = "recharge_order";
const WECHAT_RECONCILIATION_EVENT_TYPE =
  "wechat_pay.order.reconcile";
const WECHAT_RECONCILIATION_KEY_PREFIX =
  "wechat_pay:reconcile:";

const MINIMUM_LEASE_MS = 75_000;
const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_PENDING_BACKOFF_MS = 10_000;
const DEFAULT_ERROR_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 10 * 60_000;
const DEFAULT_CREATED_ORDER_CLOSE_DELAY_MS = 5 * 60_000;
export const WECHAT_CREATED_ORDER_RECOVERY_DELAY_MS = 75_000;

type ReconciliationOutboxRecord = {
  id: string;
  aggregateId: string;
  attemptCount: number;
  claimedAt: Date;
};

type RechargeOrderState = {
  id: string;
  provider: PaymentProvider;
  status: RechargeOrderStatus;
  providerOrderId: string | null;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  checkoutUrl: string | null;
  providerPayload: unknown;
  createdAt: Date;
  userWallet: {
    externalUserId: string;
  };
};

type ReconciliationTransactionClient = {
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  outboxEvent: {
    findUnique(args: unknown): Promise<{
      status: string;
      lastError: string | null;
    } | null>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
    upsert(args: unknown): Promise<unknown>;
  };
  rechargeOrder: {
    findUnique(args: unknown): Promise<RechargeOrderState | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
};

type ReconciliationClient = ReconciliationTransactionClient & {
  $transaction<T>(
    operation: (
      tx: ReconciliationTransactionClient,
    ) => Promise<T>,
  ): Promise<T>;
};

export type WeChatPayOrderReconciliationClaim = {
  outboxId: string;
  rechargeOrderId: string;
  attempt: number;
  leaseUntil: Date;
};

export type WeChatPayReconciliationPublicStatus =
  | "pending"
  | "paid"
  | "closed"
  | "refunded"
  | "failed";

export type WeChatPayOrderReconciliationResult = {
  status: WeChatPayReconciliationPublicStatus;
  queried: boolean;
};

export type WeChatPayReconciliationTickSummary = {
  enabled: boolean;
  claimed: number;
  paid: number;
  terminal: number;
  pending: number;
  failed: number;
};

type ReconciliationTimingOptions = {
  leaseMs?: number;
  initialDelayMs?: number;
  pendingBackoffMs?: number;
  errorBackoffMs?: number;
  maxBackoffMs?: number;
  createdOrderCloseDelayMs?: number;
  createdRecoverySafetyDelayMs?: number;
  now?: () => Date;
};

type ReconciliationDependencies = {
  queryOrder?: (
    rechargeOrderId: string,
  ) => Promise<WeChatPayOrderQueryResult>;
  completePaidEvent?: (
    event: NormalizedPaymentProviderEvent,
  ) => Promise<unknown>;
  createCheckout?: (
    order: RechargeOrderState,
  ) => Promise<RechargeCheckoutSession>;
  closeOrder?: (
    rechargeOrderId: string,
  ) => Promise<void>;
};

export type ReconcileWeChatPayOrderOptions =
  ReconciliationTimingOptions &
  ReconciliationDependencies & {
    client?: ReconciliationClient;
  };

export type RunWeChatPayReconciliationTickOptions =
  ReconcileWeChatPayOrderOptions & {
    env?: WeChatPayEnvironment;
    limit?: number;
  };

export class WeChatPayReconciliationLeaseLostError extends Error {
  readonly code = "WECHAT_PAY_RECONCILIATION_LEASE_LOST";

  constructor() {
    super("WeChat Pay reconciliation lease was lost.");
    this.name = "WeChatPayReconciliationLeaseLostError";
  }
}

export class WeChatPayReconciliationConflictError extends Error {
  readonly code = "WECHAT_PAY_RECONCILIATION_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WeChatPayReconciliationConflictError";
  }
}

/**
 * The local order transition and this durable work item are written by the
 * same database transaction. The globally unique key also heals an old or
 * replayed CREATED/REQUIRES_PAYMENT order without creating parallel jobs.
 */
export async function enqueueWeChatPayOrderReconciliation(
  rechargeOrderIdInput: string,
  client: Pick<
    ReconciliationTransactionClient,
    "outboxEvent"
  > = prisma as unknown as ReconciliationTransactionClient,
  options: Pick<
    ReconciliationTimingOptions,
    "initialDelayMs" | "now"
  > = {},
): Promise<void> {
  const rechargeOrderId =
    requireRechargeOrderId(rechargeOrderIdInput);
  const now = options.now?.() ?? new Date();
  const initialDelayMs = normalizeNonNegativeDuration(
    options.initialDelayMs,
    DEFAULT_INITIAL_DELAY_MS,
  );

  await client.outboxEvent.upsert({
    where: {
      idempotencyKey:
        `${WECHAT_RECONCILIATION_KEY_PREFIX}${rechargeOrderId}`,
    },
    create: {
      aggregateType: WECHAT_RECONCILIATION_AGGREGATE_TYPE,
      aggregateId: rechargeOrderId,
      eventType: WECHAT_RECONCILIATION_EVENT_TYPE,
      payload: { version: 1 },
      status: "PENDING",
      idempotencyKey:
        `${WECHAT_RECONCILIATION_KEY_PREFIX}${rechargeOrderId}`,
      availableAt: new Date(now.getTime() + initialDelayMs),
    },
    // Never reopen a terminal event. This no-op update makes enqueue
    // idempotent while preserving its current lease/backoff state.
    update: {},
  });
}

export async function claimNextWeChatPayOrderReconciliation(
  options: {
    client?: ReconciliationClient;
    rechargeOrderId?: string;
    leaseMs?: number;
  } = {},
): Promise<WeChatPayOrderReconciliationClaim | null> {
  const client = options.client
    ?? prisma as unknown as ReconciliationClient;
  const leaseMs = normalizeLeaseMs(options.leaseMs);
  const rechargeOrderId = options.rechargeOrderId === undefined
    ? undefined
    : requireRechargeOrderId(options.rechargeOrderId);

  return client.$transaction(async (tx) => {
    const rows = rechargeOrderId === undefined
      ? await tx.$queryRaw<ReconciliationOutboxRecord[]>`
          SELECT
            "id",
            "aggregateId",
            "attemptCount",
            NOW() AS "claimedAt"
          FROM "OutboxEvent"
          WHERE "aggregateType" = ${WECHAT_RECONCILIATION_AGGREGATE_TYPE}
            AND "eventType" = ${WECHAT_RECONCILIATION_EVENT_TYPE}
            AND "status" IN ('PENDING', 'FAILED', 'PROCESSING')
            AND "availableAt" <= NOW()
          ORDER BY "availableAt" ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
      : await tx.$queryRaw<ReconciliationOutboxRecord[]>`
          SELECT
            "id",
            "aggregateId",
            "attemptCount",
            NOW() AS "claimedAt"
          FROM "OutboxEvent"
          WHERE "aggregateType" = ${WECHAT_RECONCILIATION_AGGREGATE_TYPE}
            AND "eventType" = ${WECHAT_RECONCILIATION_EVENT_TYPE}
            AND "aggregateId" = ${rechargeOrderId}
            AND "status" IN ('PENDING', 'FAILED', 'PROCESSING')
            AND "availableAt" <= NOW()
          ORDER BY "availableAt" ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
    const candidate = rows[0];
    if (!candidate) {
      return null;
    }

    const claimedAt = validDateOrNow(candidate.claimedAt);
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
      rechargeOrderId: candidate.aggregateId,
      attempt,
      leaseUntil,
    };
  });
}

/**
 * Performs one provider query outside every database transaction. All writes
 * after the query are fenced by the exact outbox attempt that performed it.
 */
export async function reconcileClaimedWeChatPayOrder(
  claim: WeChatPayOrderReconciliationClaim,
  options: ReconcileWeChatPayOrderOptions = {},
): Promise<WeChatPayOrderReconciliationResult> {
  const client = options.client
    ?? prisma as unknown as ReconciliationClient;
  const order = await client.rechargeOrder.findUnique({
    where: { id: claim.rechargeOrderId },
    select: {
      id: true,
      provider: true,
      status: true,
      providerOrderId: true,
      amountCents: true,
      currency: true,
      idempotencyKey: true,
      checkoutUrl: true,
      providerPayload: true,
      createdAt: true,
      userWallet: {
        select: {
          externalUserId: true,
        },
      },
    },
  });
  if (!order || order.provider !== PaymentProvider.WECHAT_PAY) {
    await deadLetterClaim(
      claim,
      "wechat_recharge_order_missing_or_provider_mismatch",
      client,
    );
    throw new WeChatPayReconciliationConflictError(
      "WeChat Pay recharge order is missing or has a different provider.",
    );
  }

  const localStatus = publicStatusForLocalOrder(order.status);
  if (localStatus && localStatus !== "pending") {
    await completeClaimAsTerminal(claim, client);
    return { status: localStatus, queried: false };
  }
  if (
    order.status !== RechargeOrderStatus.CREATED
    && order.status !== RechargeOrderStatus.REQUIRES_PAYMENT
  ) {
    await deadLetterClaim(
      claim,
      "wechat_recharge_order_not_queryable",
      client,
    );
    throw new WeChatPayReconciliationConflictError(
      `WeChat Pay recharge order cannot be queried from ${order.status}.`,
    );
  }

  if (
    order.status === RechargeOrderStatus.CREATED
    && !isCreatedRecoveryQueryDue(order, options)
  ) {
    return rescheduleCreatedRecoverySafetyWindow(
      claim,
      order,
      client,
      options,
    );
  }

  const dependencies = resolveDependencies(options);
  let queryResult: WeChatPayOrderQueryResult;
  try {
    // Deliberately outside a database transaction and row lock.
    queryResult = await dependencies.queryOrder(
      claim.rechargeOrderId,
    );
  } catch (error) {
    await retryClaimAfterError(
      claim,
      error,
      client,
      options,
    );
    throw error;
  }

  if (queryResult.status === "paid") {
    try {
      await dependencies.completePaidEvent(queryResult.event);
    } catch (error) {
      if (isReconciliationConflict(error)) {
        await deadLetterClaim(
          claim,
          safeErrorCode(error),
          client,
        );
      } else {
        await retryClaimAfterError(
          claim,
          error,
          client,
          options,
        );
      }
      throw error;
    }
    await completeClaimAsTerminal(claim, client);
    return { status: "paid", queried: true };
  }

  if (queryResult.status === "not_found") {
    if (order.status !== RechargeOrderStatus.CREATED) {
      await deadLetterClaim(
        claim,
        "wechat_existing_checkout_missing_at_provider",
        client,
      );
      throw new WeChatPayReconciliationConflictError(
        "A persisted WeChat Pay checkout is missing at the provider.",
      );
    }
    return recoverProviderMissingCreatedOrder(
      claim,
      order,
      dependencies,
      client,
      options,
    );
  }

  if (queryResult.status === "pending") {
    if (
      queryResult.tradeState === "NOTPAY"
      && isUnpaidOrderCloseDue(order, options)
    ) {
      return closeUnpayableOrder(
        claim,
        dependencies,
        client,
        options,
      );
    }
    return reschedulePendingClaim(
      claim,
      client,
      options,
    );
  }

  return applyProviderTerminalResult(
    claim,
    queryResult.status,
    client,
    options,
  );
}

/**
 * Used by the authenticated browser route. It shares the same durable row and
 * lease as background workers, so repeated clicks and multiple web replicas
 * cannot multiply upstream order queries.
 */
export async function reconcileWeChatPayOrderIfDue(
  rechargeOrderIdInput: string,
  options: ReconcileWeChatPayOrderOptions = {},
): Promise<WeChatPayOrderReconciliationResult> {
  const rechargeOrderId =
    requireRechargeOrderId(rechargeOrderIdInput);
  const client = options.client
    ?? prisma as unknown as ReconciliationClient;
  await enqueueWeChatPayOrderReconciliation(
    rechargeOrderId,
    client,
    {
      ...(options.initialDelayMs === undefined
        ? {}
        : { initialDelayMs: options.initialDelayMs }),
      ...(options.now ? { now: options.now } : {}),
    },
  );
  const claim = await claimNextWeChatPayOrderReconciliation({
    client,
    rechargeOrderId,
    ...(options.leaseMs === undefined
      ? {}
      : { leaseMs: options.leaseMs }),
  });
  if (claim) {
    try {
      return await reconcileClaimedWeChatPayOrder(claim, {
        ...options,
        client,
      });
    } catch (error) {
      if (
        !(error instanceof WeChatPayReconciliationLeaseLostError)
      ) {
        throw error;
      }
      // A newer worker owns the provider query. Return current local truth
      // instead of exposing a transient internal lease race to the browser.
    }
  }

  const order = await client.rechargeOrder.findUnique({
    where: { id: rechargeOrderId },
    select: { id: true, provider: true, status: true },
  });
  if (!order || order.provider !== PaymentProvider.WECHAT_PAY) {
    throw new WeChatPayReconciliationConflictError(
      "WeChat Pay recharge order is missing or has a different provider.",
    );
  }
  const durableJob = await client.outboxEvent.findUnique({
    where: {
      idempotencyKey:
        `${WECHAT_RECONCILIATION_KEY_PREFIX}${rechargeOrderId}`,
    },
    select: { status: true, lastError: true },
  });
  if (durableJob?.status === "DEAD_LETTER") {
    throw new WeChatPayReconciliationConflictError(
      "WeChat Pay reconciliation requires manual review.",
    );
  }
  return {
    status:
      publicStatusForLocalOrder(order.status) ?? "pending",
    queried: false,
  };
}

export async function runWeChatPayOrderReconciliationTick(
  options: RunWeChatPayReconciliationTickOptions = {},
): Promise<WeChatPayReconciliationTickSummary> {
  const env = options.env ?? process.env;
  const summary: WeChatPayReconciliationTickSummary = {
    enabled: isWeChatPayProcessingEnabled(env),
    claimed: 0,
    paid: 0,
    terminal: 0,
    pending: 0,
    failed: 0,
  };
  if (!summary.enabled) {
    return summary;
  }

  const client = options.client
    ?? prisma as unknown as ReconciliationClient;
  const limit = normalizeLimit(options.limit);
  for (let index = 0; index < limit; index += 1) {
    const claim = await claimNextWeChatPayOrderReconciliation({
      client,
      ...(options.leaseMs === undefined
        ? {}
        : { leaseMs: options.leaseMs }),
    });
    if (!claim) {
      break;
    }
    summary.claimed += 1;

    try {
      const result = await reconcileClaimedWeChatPayOrder(
        claim,
        {
          ...options,
          client,
        },
      );
      if (result.status === "pending") {
        summary.pending += 1;
      } else if (result.status === "paid") {
        summary.paid += 1;
      } else {
        summary.terminal += 1;
      }
    } catch {
      // The item has already been durably retried or dead-lettered. Continue
      // the bounded batch so one bad order cannot starve unrelated payments.
      summary.failed += 1;
    }
  }

  return summary;
}

async function recoverProviderMissingCreatedOrder(
  claim: WeChatPayOrderReconciliationClaim,
  order: RechargeOrderState,
  dependencies: Required<ReconciliationDependencies>,
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<WeChatPayOrderReconciliationResult> {
  if (isPreparedCreatedCheckoutExpired(order, options)) {
    // The signed query proved that WeChat has no order for this out_trade_no.
    // Replaying the exact frozen request after time_expire can never succeed
    // and would otherwise leave the outbox retrying forever. Close only local
    // state so the user can deliberately create a fresh out_trade_no.
    return applyProviderTerminalResult(
      claim,
      "closed",
      client,
      options,
    );
  }
  await renewClaimForProviderEffect(
    claim,
    client,
    options,
  );
  let checkout: RechargeCheckoutSession;
  try {
    // This is the only recovery path allowed to resubmit a Native order. The
    // signed query immediately above proved that this out_trade_no does not
    // exist, and the adapter reuses the request facts frozen before attempt 1.
    checkout = await dependencies.createCheckout(order);
  } catch (error) {
    await retryClaimAfterError(
      claim,
      error,
      client,
      options,
    );
    throw error;
  }

  try {
    return await persistRecoveredCreatedCheckout(
      claim,
      checkout,
      client,
      options,
    );
  } catch (error) {
    if (
      error instanceof WeChatPayReconciliationLeaseLostError
    ) {
      throw error;
    }
    if (isReconciliationConflict(error)) {
      await deadLetterClaim(
        claim,
        safeErrorCode(error),
        client,
      );
    } else {
      await retryClaimAfterError(
        claim,
        error,
        client,
        options,
      );
    }
    throw error;
  }
}

async function persistRecoveredCreatedCheckout(
  claim: WeChatPayOrderReconciliationClaim,
  checkout: RechargeCheckoutSession,
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<WeChatPayOrderReconciliationResult> {
  assertRecoveredCheckout(checkout, claim.rechargeOrderId);
  return client.$transaction(async (tx) => {
    await assertClaimOwned(claim, tx);
    const transitioned = await tx.rechargeOrder.updateMany({
      where: {
        id: claim.rechargeOrderId,
        provider: PaymentProvider.WECHAT_PAY,
        status: RechargeOrderStatus.CREATED,
      },
      data: {
        providerOrderId: checkout.providerOrderId,
        checkoutUrl: checkout.checkoutUrl,
        providerPayload: checkout.providerPayload,
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
      },
    });
    if (transitioned.count === 0) {
      const current = await tx.rechargeOrder.findUnique({
        where: { id: claim.rechargeOrderId },
        select: {
          id: true,
          provider: true,
          status: true,
          providerOrderId: true,
        },
      });
      const currentStatus = current
        ? publicStatusForLocalOrder(current.status)
        : null;
      if (
        !current
        || current.provider !== PaymentProvider.WECHAT_PAY
        || !currentStatus
      ) {
        await markClaimDeadLettered(
          claim,
          "wechat_created_checkout_transition_conflict",
          tx,
        );
        throw new WeChatPayReconciliationConflictError(
          "WeChat Pay recharge order changed during checkout recovery.",
        );
      }
      if (
        current.status === RechargeOrderStatus.REQUIRES_PAYMENT
        && current.providerOrderId !== checkout.providerOrderId
      ) {
        await markClaimDeadLettered(
          claim,
          "wechat_created_checkout_provider_order_conflict",
          tx,
        );
        throw new WeChatPayReconciliationConflictError(
          "Recovered WeChat Pay checkout identity conflicts with local state.",
        );
      }
      if (currentStatus !== "pending") {
        await markClaimProcessed(claim, tx);
        return { status: currentStatus, queried: true };
      }
    }
    await rescheduleOwnedClaim(claim, tx, options);
    return { status: "pending", queried: true };
  });
}

async function closeUnpayableOrder(
  claim: WeChatPayOrderReconciliationClaim,
  dependencies: Required<ReconciliationDependencies>,
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<WeChatPayOrderReconciliationResult> {
  await renewClaimForProviderEffect(
    claim,
    client,
    options,
  );
  try {
    // A signed NOTPAY query proves the provider order exists. A CREATED order
    // has lost its one-time code_url; a REQUIRES_PAYMENT order has passed its
    // provider-authored expiry and safety margin. Only a verified close lets
    // the user create a fresh out_trade_no without two payable orders.
    await dependencies.closeOrder(claim.rechargeOrderId);
  } catch (error) {
    await retryClaimAfterError(
      claim,
      error,
      client,
      options,
    );
    throw error;
  }

  return client.$transaction(async (tx) => {
    await assertClaimOwned(claim, tx);
    const transitioned = await tx.rechargeOrder.updateMany({
      where: {
        id: claim.rechargeOrderId,
        provider: PaymentProvider.WECHAT_PAY,
        status: {
          in: [
            RechargeOrderStatus.CREATED,
            RechargeOrderStatus.REQUIRES_PAYMENT,
          ],
        },
      },
      data: {
        status: RechargeOrderStatus.CANCELED,
        checkoutUrl: null,
      },
    });
    if (transitioned.count === 0) {
      const current = await tx.rechargeOrder.findUnique({
        where: { id: claim.rechargeOrderId },
        select: { id: true, provider: true, status: true },
      });
      const currentStatus = current
        ? publicStatusForLocalOrder(current.status)
        : null;
      if (
        !current
        || current.provider !== PaymentProvider.WECHAT_PAY
        || !currentStatus
      ) {
        await markClaimDeadLettered(
          claim,
          "wechat_close_transition_conflict",
          tx,
        );
        throw new WeChatPayReconciliationConflictError(
          "WeChat Pay recharge order changed during confirmed close.",
        );
      }
      await markClaimProcessed(claim, tx);
      return { status: currentStatus, queried: true };
    }
    await markClaimProcessed(claim, tx);
    return { status: "closed", queried: true };
  });
}

async function renewClaimForProviderEffect(
  claim: WeChatPayOrderReconciliationClaim,
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<void> {
  const leaseMs = normalizeLeaseMs(options.leaseMs);
  const now = options.now?.() ?? new Date();
  await client.$transaction(async (tx) => {
    const renewed = await tx.outboxEvent.updateMany({
      where: ownedClaimWhere(claim),
      data: {
        status: "PROCESSING",
        availableAt: new Date(now.getTime() + leaseMs),
      },
    });
    if (renewed.count !== 1) {
      throw new WeChatPayReconciliationLeaseLostError();
    }
  });
}

function isUnpaidOrderCloseDue(
  order: RechargeOrderState,
  options: ReconciliationTimingOptions,
): boolean {
  const closeDelayMs = normalizeCreatedOrderCloseDelayMs(
    options.createdOrderCloseDelayMs,
  );
  const now = options.now?.() ?? new Date();
  if (order.status === RechargeOrderStatus.CREATED) {
    const createdAt = order.createdAt;
    return createdAt instanceof Date
      && Number.isFinite(createdAt.getTime())
      && now.getTime() - createdAt.getTime() >= closeDelayMs;
  }
  const checkoutExpiresAt =
    readNativeCheckoutExpiresAt(order.providerPayload);
  return order.status === RechargeOrderStatus.REQUIRES_PAYMENT
    && checkoutExpiresAt !== null
    && now.getTime() - checkoutExpiresAt.getTime() >= closeDelayMs;
}

function isCreatedRecoveryQueryDue(
  order: RechargeOrderState,
  options: ReconciliationTimingOptions,
): boolean {
  if (
    !(order.createdAt instanceof Date)
    || !Number.isFinite(order.createdAt.getTime())
  ) {
    return false;
  }
  const delayMs = normalizeCreatedRecoverySafetyDelayMs(
    options.createdRecoverySafetyDelayMs,
  );
  const now = options.now?.() ?? new Date();
  return now.getTime() - order.createdAt.getTime() >= delayMs;
}

function isPreparedCreatedCheckoutExpired(
  order: RechargeOrderState,
  options: ReconciliationTimingOptions,
): boolean {
  const outer = readUnknownObject(order.providerPayload);
  const prepared = outer
    ? readUnknownObject(outer.rawPayload)
    : null;
  if (
    !prepared
    || prepared.version !== 1
    || prepared.mode !== "native"
    || prepared.outTradeNo !== order.id
  ) {
    return false;
  }
  const expiresAt =
    readNativeCheckoutExpiresAt(order.providerPayload);
  if (!expiresAt) {
    return false;
  }
  const now = options.now?.() ?? new Date();
  return expiresAt.getTime() <= now.getTime();
}

function readNativeCheckoutExpiresAt(
  providerPayload: unknown,
): Date | null {
  const outer = readUnknownObject(providerPayload);
  if (!outer) {
    return null;
  }
  const nativePayload = Object.prototype.hasOwnProperty.call(
    outer,
    "rawPayload",
  )
    ? readUnknownObject(outer.rawPayload)
    : outer;
  if (
    !nativePayload
    || nativePayload.mode !== "native"
    || typeof nativePayload.expiresAt !== "string"
  ) {
    return null;
  }
  const expiresAt = new Date(nativePayload.expiresAt);
  return Number.isFinite(expiresAt.getTime())
    && expiresAt.toISOString() === nativePayload.expiresAt
    ? expiresAt
    : null;
}

async function rescheduleCreatedRecoverySafetyWindow(
  claim: WeChatPayOrderReconciliationClaim,
  order: RechargeOrderState,
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<WeChatPayOrderReconciliationResult> {
  return client.$transaction(async (tx) => {
    await assertClaimOwned(claim, tx);
    const safetyDelayMs = normalizeCreatedRecoverySafetyDelayMs(
      options.createdRecoverySafetyDelayMs,
    );
    const availableAt = new Date(
      order.createdAt.getTime() + safetyDelayMs,
    );
    await updateOwnedClaim(
      claim,
      {
        status: "PENDING",
        availableAt,
        processedAt: null,
        lastError: null,
      },
      tx,
    );
    return { status: "pending", queried: false };
  });
}

function assertRecoveredCheckout(
  checkout: RechargeCheckoutSession,
  expectedOrderId: string,
): void {
  if (
    checkout.provider !== PaymentProvider.WECHAT_PAY
    || checkout.providerOrderId !== expectedOrderId
    || typeof checkout.checkoutUrl !== "string"
    || !checkout.checkoutUrl.startsWith("weixin://wxpay/")
    || checkout.providerPayload === null
    || typeof checkout.providerPayload !== "object"
    || Array.isArray(checkout.providerPayload)
  ) {
    throw new WeChatPayReconciliationConflictError(
      "Recovered WeChat Pay checkout did not match the frozen local order.",
    );
  }
}

async function reschedulePendingClaim(
  claim: WeChatPayOrderReconciliationClaim,
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<WeChatPayOrderReconciliationResult> {
  return client.$transaction(async (tx) => {
    await assertClaimOwned(claim, tx);
    const order = await tx.rechargeOrder.findUnique({
      where: { id: claim.rechargeOrderId },
      select: {
        id: true,
        provider: true,
        status: true,
      },
    });
    const currentStatus = order
      ? publicStatusForLocalOrder(order.status)
      : null;
    if (
      !order
      || order.provider !== PaymentProvider.WECHAT_PAY
    ) {
      await markClaimDeadLettered(
        claim,
        "wechat_recharge_order_missing_or_provider_mismatch",
        tx,
      );
      throw new WeChatPayReconciliationConflictError(
        "WeChat Pay recharge order disappeared during reconciliation.",
      );
    }
    if (currentStatus && currentStatus !== "pending") {
      await markClaimProcessed(claim, tx);
      return { status: currentStatus, queried: true };
    }
    if (
      order.status !== RechargeOrderStatus.CREATED
      && order.status !== RechargeOrderStatus.REQUIRES_PAYMENT
    ) {
      await markClaimDeadLettered(
        claim,
        "wechat_recharge_order_not_queryable",
        tx,
      );
      throw new WeChatPayReconciliationConflictError(
        "WeChat Pay recharge order changed to a non-queryable state.",
      );
    }

    // A local QR expiration is only a presentation boundary. It is not
    // provider-authoritative proof that WeChat closed the order, and using it
    // here creates a paid-but-not-credited race when clocks differ or payment
    // completes between the signed query and the local transition. Keep
    // polling until a signed provider terminal state is observed.
    await rescheduleOwnedClaim(claim, tx, options);
    return { status: "pending", queried: true };
  });
}

async function rescheduleOwnedClaim(
  claim: WeChatPayOrderReconciliationClaim,
  tx: ReconciliationTransactionClient,
  options: ReconciliationTimingOptions,
): Promise<void> {
  const now = options.now?.() ?? new Date();
  const retryAt = new Date(
    now.getTime()
    + calculateBackoff(
      claim.attempt,
      options.pendingBackoffMs,
      DEFAULT_PENDING_BACKOFF_MS,
      options.maxBackoffMs,
    ),
  );
  await updateOwnedClaim(
    claim,
    {
      status: "PENDING",
      availableAt: retryAt,
      processedAt: null,
      lastError: null,
    },
    tx,
  );
}

async function applyProviderTerminalResult(
  claim: WeChatPayOrderReconciliationClaim,
  providerStatus: "closed" | "refunded" | "failed",
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<WeChatPayOrderReconciliationResult> {
  return client.$transaction(async (tx) => {
    await assertClaimOwned(claim, tx);
    const terminalStatus =
      providerStatus === "closed"
        ? RechargeOrderStatus.CANCELED
        : providerStatus === "refunded"
          ? RechargeOrderStatus.REFUNDED
          : RechargeOrderStatus.FAILED;
    const transitioned = await tx.rechargeOrder.updateMany({
      where: {
        id: claim.rechargeOrderId,
        provider: PaymentProvider.WECHAT_PAY,
        status: {
          in: [
            RechargeOrderStatus.CREATED,
            RechargeOrderStatus.REQUIRES_PAYMENT,
          ],
        },
      },
      data: {
        status: terminalStatus,
        checkoutUrl: null,
        ...(terminalStatus === RechargeOrderStatus.REFUNDED
          ? { refundedAt: options.now?.() ?? new Date() }
          : {}),
      },
    });
    if (transitioned.count === 0) {
      const current = await tx.rechargeOrder.findUnique({
        where: { id: claim.rechargeOrderId },
        select: { id: true, provider: true, status: true },
      });
      const racedStatus = current
        ? publicStatusForLocalOrder(current.status)
        : null;
      if (
        !current
        || current.provider !== PaymentProvider.WECHAT_PAY
        || !racedStatus
      ) {
        await markClaimDeadLettered(
          claim,
          "wechat_terminal_transition_conflict",
          tx,
        );
        throw new WeChatPayReconciliationConflictError(
          "WeChat Pay recharge order changed during terminal transition.",
        );
      }
      await markClaimProcessed(claim, tx);
      return { status: racedStatus, queried: true };
    }
    await markClaimProcessed(claim, tx);
    return { status: providerStatus, queried: true };
  });
}

async function completeClaimAsTerminal(
  claim: WeChatPayOrderReconciliationClaim,
  client: ReconciliationClient,
): Promise<void> {
  await client.$transaction(async (tx) => {
    await assertClaimOwned(claim, tx);
    await markClaimProcessed(claim, tx);
  });
}

async function retryClaimAfterError(
  claim: WeChatPayOrderReconciliationClaim,
  error: unknown,
  client: ReconciliationClient,
  options: ReconciliationTimingOptions,
): Promise<void> {
  const now = options.now?.() ?? new Date();
  const retryAt = new Date(
    now.getTime()
    + calculateBackoff(
      claim.attempt,
      options.errorBackoffMs,
      DEFAULT_ERROR_BACKOFF_MS,
      options.maxBackoffMs,
    ),
  );
  await client.$transaction(async (tx) => {
    const owned = await fenceClaim(claim, tx);
    if (!owned) {
      return;
    }
    await updateOwnedClaim(
      claim,
      {
        status: "FAILED",
        availableAt: retryAt,
        processedAt: null,
        lastError: safeErrorCode(error),
      },
      tx,
    );
  });
}

async function deadLetterClaim(
  claim: WeChatPayOrderReconciliationClaim,
  reason: string,
  client: ReconciliationClient,
): Promise<void> {
  await client.$transaction(async (tx) => {
    const owned = await fenceClaim(claim, tx);
    if (!owned) {
      return;
    }
    await markClaimDeadLettered(claim, reason, tx);
  });
}

async function assertClaimOwned(
  claim: WeChatPayOrderReconciliationClaim,
  tx: ReconciliationTransactionClient,
): Promise<void> {
  if (!await fenceClaim(claim, tx)) {
    throw new WeChatPayReconciliationLeaseLostError();
  }
}

async function fenceClaim(
  claim: WeChatPayOrderReconciliationClaim,
  tx: ReconciliationTransactionClient,
): Promise<boolean> {
  const fenced = await tx.outboxEvent.updateMany({
    where: ownedClaimWhere(claim),
    // A no-op update takes the row lock before related business writes.
    data: { status: "PROCESSING" },
  });
  return fenced.count === 1;
}

async function markClaimProcessed(
  claim: WeChatPayOrderReconciliationClaim,
  tx: ReconciliationTransactionClient,
): Promise<void> {
  await updateOwnedClaim(
    claim,
    {
      status: "PROCESSED",
      processedAt: new Date(),
      lastError: null,
    },
    tx,
  );
}

async function markClaimDeadLettered(
  claim: WeChatPayOrderReconciliationClaim,
  reason: string,
  tx: ReconciliationTransactionClient,
): Promise<void> {
  await updateOwnedClaim(
    claim,
    {
      status: "DEAD_LETTER",
      processedAt: null,
      lastError: reason.slice(0, 200),
    },
    tx,
  );
}

async function updateOwnedClaim(
  claim: WeChatPayOrderReconciliationClaim,
  data: unknown,
  tx: ReconciliationTransactionClient,
): Promise<void> {
  const updated = await tx.outboxEvent.updateMany({
    where: ownedClaimWhere(claim),
    data,
  });
  if (updated.count !== 1) {
    throw new WeChatPayReconciliationLeaseLostError();
  }
}

function ownedClaimWhere(
  claim: WeChatPayOrderReconciliationClaim,
) {
  return {
    id: claim.outboxId,
    aggregateType: WECHAT_RECONCILIATION_AGGREGATE_TYPE,
    aggregateId: claim.rechargeOrderId,
    eventType: WECHAT_RECONCILIATION_EVENT_TYPE,
    status: "PROCESSING",
    attemptCount: claim.attempt,
  };
}

function readUnknownObject(
  value: unknown,
): Record<string, unknown> | null {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolveDependencies(
  options: ReconciliationDependencies,
): Required<ReconciliationDependencies> {
  let config:
    | ReturnType<typeof loadWeChatPayProcessingConfigFromEnv>
    | undefined;
  return {
    queryOrder:
      options.queryOrder
      ?? ((rechargeOrderId) => {
        config ??= loadWeChatPayProcessingConfigFromEnv();
        return queryWeChatPayOrderByOutTradeNo(
          rechargeOrderId,
          config,
        );
      }),
    completePaidEvent:
      options.completePaidEvent
      ?? (async (event) => {
        const {
          completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent,
        } = await import("./agent-wallet-recharge");
        await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          event,
        );
      }),
    createCheckout:
      options.createCheckout
      ?? (async (order) => {
        config ??= loadWeChatPayProcessingConfigFromEnv();
        return createWeChatPayApiV3PaymentProviderAdapter(
          config,
        ).createRechargeCheckout({
          rechargeOrderId: order.id,
          externalUserId: order.userWallet.externalUserId,
          amountCents: order.amountCents,
          currency: order.currency,
          idempotencyKey: order.idempotencyKey,
          preparedProviderPayload: order.providerPayload,
        });
      }),
    closeOrder:
      options.closeOrder
      ?? (async (rechargeOrderId) => {
        config ??= loadWeChatPayProcessingConfigFromEnv();
        await closeWeChatPayOrderByOutTradeNo(
          rechargeOrderId,
          config,
        );
      }),
  };
}

function publicStatusForLocalOrder(
  status: RechargeOrderStatus,
): WeChatPayReconciliationPublicStatus | null {
  switch (status) {
    case RechargeOrderStatus.CREATED:
    case RechargeOrderStatus.REQUIRES_PAYMENT:
      return "pending";
    case RechargeOrderStatus.PAID:
      return "paid";
    case RechargeOrderStatus.CANCELED:
      return "closed";
    case RechargeOrderStatus.REFUNDED:
      return "refunded";
    case RechargeOrderStatus.FAILED:
      return "failed";
    default:
      return null;
  }
}

function calculateBackoff(
  attempt: number,
  configuredBaseMs: number | undefined,
  defaultBaseMs: number,
  configuredMaxMs: number | undefined,
): number {
  const baseMs = normalizePositiveDuration(
    configuredBaseMs,
    defaultBaseMs,
  );
  const maxMs = Math.max(
    baseMs,
    normalizePositiveDuration(
      configuredMaxMs,
      DEFAULT_MAX_BACKOFF_MS,
    ),
  );
  const exponent = Math.min(
    16,
    Math.max(0, Math.trunc(attempt) - 1),
  );
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function normalizeLeaseMs(value: number | undefined): number {
  if (value === undefined) {
    return MINIMUM_LEASE_MS;
  }
  if (!Number.isSafeInteger(value) || value < MINIMUM_LEASE_MS) {
    throw new Error(
      `WeChat Pay reconciliation leaseMs must be at least ${MINIMUM_LEASE_MS}.`,
    );
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(
      "WeChat Pay reconciliation limit must be between 1 and 100.",
    );
  }
  return value;
}

function normalizeNonNegativeDuration(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "WeChat Pay reconciliation duration must be a non-negative integer.",
    );
  }
  return value;
}

function normalizePositiveDuration(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      "WeChat Pay reconciliation duration must be a positive integer.",
    );
  }
  return value;
}

function normalizeCreatedOrderCloseDelayMs(
  value: number | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_CREATED_ORDER_CLOSE_DELAY_MS;
  }
  if (
    !Number.isSafeInteger(value)
    || value < DEFAULT_CREATED_ORDER_CLOSE_DELAY_MS
  ) {
    throw new Error(
      `WeChat Pay createdOrderCloseDelayMs must be at least ${DEFAULT_CREATED_ORDER_CLOSE_DELAY_MS}.`,
    );
  }
  return value;
}

function normalizeCreatedRecoverySafetyDelayMs(
  value: number | undefined,
): number {
  if (value === undefined) {
    return WECHAT_CREATED_ORDER_RECOVERY_DELAY_MS;
  }
  if (
    !Number.isSafeInteger(value)
    || value <= 60_000
  ) {
    throw new Error(
      "WeChat Pay createdRecoverySafetyDelayMs must be greater than the maximum provider request timeout of 60000.",
    );
  }
  return value;
}

function requireRechargeOrderId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Recharge order id is required.");
  }
  return normalized;
}

function validDateOrNow(value: Date): Date {
  return value instanceof Date
    && Number.isFinite(value.getTime())
    ? value
    : new Date();
}

function safeErrorCode(error: unknown): string {
  if (error instanceof WeChatPayProtocolError) {
    return [
      error.code,
      error.providerErrorCode
        ? `provider=${error.providerErrorCode}`
        : null,
      error.providerRequestId
        ? `request_id=${error.providerRequestId}`
        : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join("|")
      .slice(0, 200);
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code.slice(0, 200);
  }
  if (error instanceof Error) {
    return error.name.slice(0, 200);
  }
  return "wechat_payment_reconciliation_failed";
}

function isReconciliationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "RECHARGE_PAYMENT_CONFLICT"
    || error.code === "WALLET_IDEMPOTENCY_CONFLICT"
    || error.code === "AGENT_WALLET_RECONCILIATION_REQUIRED";
}
