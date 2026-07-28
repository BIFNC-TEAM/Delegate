import {
  recordWeChatPayOperationalWorkerFailed,
  recordWeChatPayOperationalWorkerStarted,
  recordWeChatPayOperationalWorkerSucceeded,
  runWeChatPayOrderReconciliationTick,
  runWeChatRefundLifecycleTick,
  runWeChatRefundReversalTick,
  syncWeChatPayWalletExceptionCases,
  WECHAT_PAY_OPERATIONAL_FAILURE_CODES,
  WECHAT_PAY_OPERATIONAL_WORKERS,
  type WeChatPayOperationalSummary,
  type WeChatPayOperationalWorkerKey,
  type WeChatPayReconciliationTickSummary,
  type WeChatRefundLifecycleTickSummary,
  type WeChatRefundReversalTickSummary,
} from "@delegate/web-data";

export type WeChatPayOperationsTickConfig = {
  batchSize: number;
  leaseMs: number;
  pendingBackoffMs: number;
  errorBackoffMs: number;
  maxBackoffMs: number;
};

export type WeChatPayOperationsTickDependencies = {
  runOrderReconciliation(
    options: {
      limit: number;
      leaseMs: number;
      pendingBackoffMs: number;
      errorBackoffMs: number;
      maxBackoffMs: number;
    },
  ): Promise<WeChatPayReconciliationTickSummary>;
  runRefundLifecycle(
    options: {
      limit: number;
      leaseMs: number;
    },
  ): Promise<WeChatRefundLifecycleTickSummary>;
  runRefundReversal(
    options: {
      limit: number;
      leaseMs: number;
      maxBackoffMs: number;
    },
  ): Promise<WeChatRefundReversalTickSummary>;
  recordStarted(
    workerKey: WeChatPayOperationalWorkerKey,
  ): Promise<void>;
  recordSucceeded(
    workerKey: WeChatPayOperationalWorkerKey,
    summary: WeChatPayOperationalSummary,
  ): Promise<void>;
  recordFailed(
    workerKey: WeChatPayOperationalWorkerKey,
  ): Promise<void>;
  syncExceptionCases(): Promise<{
    detected: number;
    resolved: number;
  }>;
};

export type WeChatPayOperationsTickResult = {
  orders: WeChatPayReconciliationTickSummary | null;
  refundLifecycle: WeChatRefundLifecycleTickSummary | null;
  refunds: WeChatRefundReversalTickSummary | null;
  failedWorkerCodes: string[];
  recoveredWorkerCodes: string[];
  exceptionCases: {
    detected: number;
    resolved: number;
  } | null;
  exceptionSyncFailed: boolean;
};

const defaultDependencies: WeChatPayOperationsTickDependencies = {
  runOrderReconciliation:
    runWeChatPayOrderReconciliationTick,
  runRefundLifecycle: runWeChatRefundLifecycleTick,
  runRefundReversal: runWeChatRefundReversalTick,
  recordStarted: (workerKey) =>
    recordWeChatPayOperationalWorkerStarted(workerKey),
  recordSucceeded: (workerKey, summary) =>
    recordWeChatPayOperationalWorkerSucceeded(
      workerKey,
      summary,
    ),
  recordFailed: (workerKey) =>
    recordWeChatPayOperationalWorkerFailed(workerKey),
  syncExceptionCases: () =>
    syncWeChatPayWalletExceptionCases(),
};

export async function runWeChatPayOperationsTick(
  config: WeChatPayOperationsTickConfig,
  dependencies: WeChatPayOperationsTickDependencies =
    defaultDependencies,
): Promise<WeChatPayOperationsTickResult> {
  const lanes = [
    trackedLane(
      WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation,
      () =>
        dependencies.runOrderReconciliation({
          limit: config.batchSize,
          leaseMs: config.leaseMs,
          pendingBackoffMs: config.pendingBackoffMs,
          errorBackoffMs: config.errorBackoffMs,
          maxBackoffMs: config.maxBackoffMs,
        }),
      dependencies,
    ),
    trackedLane(
      WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle,
      () =>
        dependencies.runRefundLifecycle({
          limit: config.batchSize,
          leaseMs: config.leaseMs,
        }),
      dependencies,
    ),
    trackedLane(
      WECHAT_PAY_OPERATIONAL_WORKERS.refundReversal,
      () =>
        dependencies.runRefundReversal({
          limit: config.batchSize,
          leaseMs: config.leaseMs,
          maxBackoffMs: config.maxBackoffMs,
        }),
      dependencies,
    ),
  ] as const;
  const [orders, refundLifecycle, refunds] =
    await Promise.allSettled(lanes);

  let exceptionCases: {
    detected: number;
    resolved: number;
  } | null = null;
  let exceptionSyncFailed = false;
  try {
    exceptionCases = await dependencies.syncExceptionCases();
  } catch {
    exceptionSyncFailed = true;
  }

  const results = [orders, refundLifecycle, refunds] as const;
  const workerKeys = [
    WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation,
    WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle,
    WECHAT_PAY_OPERATIONAL_WORKERS.refundReversal,
  ] as const;
  const failedWorkerCodes = results.flatMap(
    (result, index) =>
      result.status === "rejected"
        ? [
            WECHAT_PAY_OPERATIONAL_FAILURE_CODES[
              workerKeys[index]!
            ],
          ]
        : [],
  );
  const recoveredWorkerCodes = results.flatMap(
    (result, index) =>
      result.status === "fulfilled"
      && operationalSummaryDidWork(result.value)
        ? [
            WECHAT_PAY_OPERATIONAL_FAILURE_CODES[
              workerKeys[index]!
            ],
          ]
        : [],
  );

  return {
    orders: fulfilledValue(orders),
    refundLifecycle: fulfilledValue(refundLifecycle),
    refunds: fulfilledValue(refunds),
    failedWorkerCodes,
    recoveredWorkerCodes,
    exceptionCases,
    exceptionSyncFailed,
  };
}

export function weChatPayOperationsTickFailureCode(
  result: WeChatPayOperationsTickResult,
): string | null {
  return result.failedWorkerCodes[0]
    ?? (
      result.exceptionSyncFailed
        ? "wechat_exception_queue_sync_failed"
        : null
    );
}

/**
 * A lane failure remains active while its Outbox work is in backoff. An idle
 * tick is only a heartbeat; it is not evidence that the failed item recovered.
 */
export function updateWeChatPayOperationsFailureCodes(
  previousCodes: readonly string[],
  result: WeChatPayOperationsTickResult,
): string[] {
  const orderedLaneCodes = Object.values(
    WECHAT_PAY_OPERATIONAL_FAILURE_CODES,
  );
  const activeCodes = new Set(
    previousCodes.filter((code) =>
      orderedLaneCodes.includes(code),
    ),
  );
  for (const code of result.recoveredWorkerCodes) {
    activeCodes.delete(code);
  }
  for (const code of result.failedWorkerCodes) {
    activeCodes.add(code);
  }

  const exceptionSyncCode =
    "wechat_exception_queue_sync_failed";
  if (result.exceptionSyncFailed) {
    activeCodes.add(exceptionSyncCode);
  } else {
    activeCodes.delete(exceptionSyncCode);
  }

  return [
    ...orderedLaneCodes.filter((code) =>
      activeCodes.has(code),
    ),
    ...(activeCodes.has(exceptionSyncCode)
      ? [exceptionSyncCode]
      : []),
  ];
}

async function trackedLane<T extends object>(
  workerKey: WeChatPayOperationalWorkerKey,
  operation: () => Promise<T>,
  dependencies: WeChatPayOperationsTickDependencies,
): Promise<T> {
  await dependencies.recordStarted(workerKey);
  let summary: T;
  try {
    summary = await operation();
  } catch (error) {
    await dependencies.recordFailed(workerKey);
    throw error;
  }
  if (operationalSummaryFailed(workerKey, summary)) {
    await dependencies.recordFailed(workerKey);
    throw new Error(
      WECHAT_PAY_OPERATIONAL_FAILURE_CODES[workerKey],
    );
  }
  if (!operationalSummaryDidWork(summary)) {
    return summary;
  }
  try {
    await dependencies.recordSucceeded(workerKey, summary);
    return summary;
  } catch (error) {
    await dependencies.recordFailed(workerKey);
    throw error;
  }
}

function operationalSummaryDidWork(summary: object): boolean {
  return positiveCounter(
    (summary as Record<string, unknown>).claimed,
  );
}

function operationalSummaryFailed(
  workerKey: WeChatPayOperationalWorkerKey,
  summary: object,
): boolean {
  const counters = summary as Record<string, unknown>;
  switch (workerKey) {
    case WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation:
    case WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle:
      return positiveCounter(counters.failed);
    case WECHAT_PAY_OPERATIONAL_WORKERS.refundReversal:
      return positiveCounter(counters.retryScheduled);
  }
}

function positiveCounter(value: unknown): boolean {
  return (
    typeof value === "number"
    && Number.isFinite(value)
    && value > 0
  );
}

function fulfilledValue<T>(
  result: PromiseSettledResult<T>,
): T | null {
  return result.status === "fulfilled"
    ? result.value
    : null;
}
