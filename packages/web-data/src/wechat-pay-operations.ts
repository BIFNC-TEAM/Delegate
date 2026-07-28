import {
  PaymentProvider,
  PaymentProviderEventType,
  Prisma,
  RechargeRefundProviderStatus,
  RechargeRefundReversalStatus,
} from "@prisma/client";

import { WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE } from "./agent-wallet-wechat-refund-submission";
import { WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE } from "./agent-wallet-wechat-refunds";
import { prisma } from "./prisma";

export const WECHAT_PAY_OPERATIONAL_WORKERS = {
  orderReconciliation: "wechat_pay.order_reconciliation",
  refundLifecycle: "wechat_pay.refund_lifecycle",
  refundReversal: "wechat_pay.refund_reversal",
} as const;

export type WeChatPayOperationalWorkerKey =
  (typeof WECHAT_PAY_OPERATIONAL_WORKERS)[keyof typeof WECHAT_PAY_OPERATIONAL_WORKERS];

export const WECHAT_PAY_OPERATIONAL_FAILURE_CODES: Record<
  WeChatPayOperationalWorkerKey,
  string
> = {
  [WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation]:
    "wechat_order_reconciliation_tick_failed",
  [WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle]:
    "wechat_refund_lifecycle_tick_failed",
  [WECHAT_PAY_OPERATIONAL_WORKERS.refundReversal]:
    "wechat_refund_reversal_tick_failed",
};

export type WeChatPayOperationalSummary = object;

type OperationalCheckpointClient = {
  operationalWorkerCheckpoint: {
    upsert(args: unknown): Promise<unknown>;
  };
};

export async function recordWeChatPayOperationalWorkerStarted(
  workerKey: WeChatPayOperationalWorkerKey,
  options: {
    client?: OperationalCheckpointClient;
    now?: Date;
  } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const client = options.client ?? prisma;
  await client.operationalWorkerCheckpoint.upsert({
    where: { workerKey },
    create: {
      workerKey,
      lastStartedAt: now,
      lastHeartbeatAt: now,
      consecutiveFailures: 0,
    },
    update: {
      lastStartedAt: now,
      lastHeartbeatAt: now,
    },
  });
}

export async function recordWeChatPayOperationalWorkerSucceeded(
  workerKey: WeChatPayOperationalWorkerKey,
  summary: WeChatPayOperationalSummary,
  options: {
    client?: OperationalCheckpointClient;
    now?: Date;
  } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const client = options.client ?? prisma;
  const safeSummary = sanitizeOperationalSummary(summary);
  await client.operationalWorkerCheckpoint.upsert({
    where: { workerKey },
    create: {
      workerKey,
      lastStartedAt: now,
      lastHeartbeatAt: now,
      lastSuccessAt: now,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastSummary: safeSummary as Prisma.InputJsonValue,
    },
    update: {
      lastHeartbeatAt: now,
      lastSuccessAt: now,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastSummary: safeSummary as Prisma.InputJsonValue,
    },
  });
}

export async function recordWeChatPayOperationalWorkerFailed(
  workerKey: WeChatPayOperationalWorkerKey,
  options: {
    client?: OperationalCheckpointClient;
    now?: Date;
  } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const client = options.client ?? prisma;
  const errorCode = WECHAT_PAY_OPERATIONAL_FAILURE_CODES[workerKey];
  await client.operationalWorkerCheckpoint.upsert({
    where: { workerKey },
    create: {
      workerKey,
      lastStartedAt: now,
      lastHeartbeatAt: now,
      consecutiveFailures: 1,
      lastErrorCode: errorCode,
    },
    update: {
      lastHeartbeatAt: now,
      consecutiveFailures: { increment: 1 },
      lastErrorCode: errorCode,
    },
  });
}

export type WeChatPayOperationsHealthSeverity =
  | "info"
  | "warning"
  | "critical";

export type WeChatPayOperationsHealthAlert = {
  code: string;
  severity: WeChatPayOperationsHealthSeverity;
  count: number;
};

export type WeChatPayOperationsWorkerHealth = {
  worker:
    | "order_reconciliation"
    | "refund_lifecycle"
    | "refund_reversal";
  status:
    | "disabled"
    | "healthy"
    | "missing"
    | "stale"
    | "failing";
  code: string;
  severity: WeChatPayOperationsHealthSeverity;
  count: number;
};

export type WeChatPayOperationsHealthSnapshot = {
  status: "healthy" | "degraded" | "critical";
  workers: WeChatPayOperationsWorkerHealth[];
  alerts: WeChatPayOperationsHealthAlert[];
};

export async function getWeChatPayOperationsHealthSnapshot(
  options: {
    client?: typeof prisma;
    now?: Date;
    staleAfterMs?: number;
    processingEnabled?: boolean;
  } = {},
): Promise<WeChatPayOperationsHealthSnapshot> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const staleAfterMs = boundedStaleAfterMs(options.staleAfterMs);
  const processingEnabled = options.processingEnabled ?? true;
  const workerEntries = Object.entries(
    WECHAT_PAY_OPERATIONAL_WORKERS,
  ) as Array<[
    keyof typeof WECHAT_PAY_OPERATIONAL_WORKERS,
    WeChatPayOperationalWorkerKey,
  ]>;

  const [
    checkpoints,
    orderFailedBacklog,
    refundLifecycleFailedBacklog,
    refundReversalFailedBacklog,
    orderDeadLetters,
    refundLifecycleDeadLetters,
    refundReversalDeadLetters,
    reconciliationRequired,
    abnormalRefunds,
    unmatchedVerifiedRefunds,
  ] = await Promise.all([
    processingEnabled
      ? client.operationalWorkerCheckpoint.findMany({
          where: {
            workerKey: {
              in: workerEntries.map(([, workerKey]) => workerKey),
            },
          },
          select: {
            workerKey: true,
            lastHeartbeatAt: true,
            consecutiveFailures: true,
          },
        })
      : Promise.resolve([]),
    client.outboxEvent.count({
      where: {
        aggregateType: "recharge_order",
        eventType: "wechat_pay.order.reconcile",
        status: "FAILED",
      },
    }),
    client.outboxEvent.count({
      where: {
        aggregateType: "recharge_refund",
        eventType: WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE,
        status: "FAILED",
      },
    }),
    client.outboxEvent.count({
      where: {
        aggregateType: "recharge_refund",
        eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
        status: "FAILED",
      },
    }),
    client.outboxEvent.count({
      where: {
        aggregateType: "recharge_order",
        eventType: "wechat_pay.order.reconcile",
        status: "DEAD_LETTER",
      },
    }),
    client.outboxEvent.count({
      where: {
        aggregateType: "recharge_refund",
        eventType: WECHAT_REFUND_LIFECYCLE_OUTBOX_EVENT_TYPE,
        status: "DEAD_LETTER",
      },
    }),
    client.outboxEvent.count({
      where: {
        aggregateType: "recharge_refund",
        eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
        status: "DEAD_LETTER",
      },
    }),
    client.rechargeRefund.count({
      where: {
        provider: PaymentProvider.WECHAT_PAY,
        reversalStatus:
          RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
      },
    }),
    client.rechargeRefund.count({
      where: {
        provider: PaymentProvider.WECHAT_PAY,
        providerStatus: RechargeRefundProviderStatus.ABNORMAL,
      },
    }),
    client.paymentProviderEvent.count({
      where: {
        provider: PaymentProvider.WECHAT_PAY,
        eventType: {
          in: [
            PaymentProviderEventType.REFUND_PROCESSING,
            PaymentProviderEventType.REFUND_SUCCEEDED,
            PaymentProviderEventType.REFUND_CLOSED,
            PaymentProviderEventType.REFUND_ABNORMAL,
          ],
        },
        verifiedAt: { not: null },
        rechargeRefundId: null,
      },
    }),
  ]);

  const checkpointByKey = new Map(
    checkpoints.map((checkpoint) => [
      checkpoint.workerKey,
      checkpoint,
    ]),
  );
  const failedBacklogByWorker = {
    orderReconciliation: orderFailedBacklog,
    refundLifecycle: refundLifecycleFailedBacklog,
    refundReversal: refundReversalFailedBacklog,
  } satisfies Record<
    keyof typeof WECHAT_PAY_OPERATIONAL_WORKERS,
    number
  >;
  const workers = workerEntries.map(([name, workerKey]) =>
    buildWorkerHealth({
      name,
      workerKey,
      checkpoint: checkpointByKey.get(workerKey),
      now,
      staleAfterMs,
      processingEnabled,
      outstandingFailures: failedBacklogByWorker[name],
    }),
  );
  const alerts: WeChatPayOperationsHealthAlert[] = [
    {
      code: "wechat_order_reconciliation_failed_backlog",
      severity: "warning",
      count: orderFailedBacklog,
    },
    {
      code: "wechat_refund_lifecycle_failed_backlog",
      severity: "warning",
      count: refundLifecycleFailedBacklog,
    },
    {
      code: "wechat_refund_reversal_failed_backlog",
      severity: "warning",
      count: refundReversalFailedBacklog,
    },
    {
      code: "wechat_order_reconciliation_dead_letter",
      severity: "critical",
      count: orderDeadLetters,
    },
    {
      code: "wechat_refund_lifecycle_dead_letter",
      severity: "critical",
      count: refundLifecycleDeadLetters,
    },
    {
      code: "wechat_refund_reversal_dead_letter",
      severity: "critical",
      count: refundReversalDeadLetters,
    },
    {
      code: "wechat_refund_reconciliation_required",
      severity: "critical",
      count: reconciliationRequired,
    },
    {
      code: "wechat_refund_abnormal",
      severity: "critical",
      count: abnormalRefunds,
    },
    {
      code: "wechat_refund_unmatched_verified",
      severity: "critical",
      count: unmatchedVerifiedRefunds,
    },
  ];
  const observations = [...workers, ...alerts];
  const status = observations.some(
    (item) => item.count > 0 && item.severity === "critical",
  )
    ? "critical"
    : observations.some(
          (item) =>
            item.count > 0 && item.severity === "warning",
        )
      ? "degraded"
      : "healthy";

  return { status, workers, alerts };
}

function sanitizeOperationalSummary(
  summary: WeChatPayOperationalSummary,
): Record<string, number | boolean> {
  const safe: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (
      /^[a-z][a-zA-Z0-9]{0,63}$/.test(key)
      && (
        typeof value === "boolean"
        || (
          typeof value === "number"
          && Number.isSafeInteger(value)
          && value >= 0
        )
      )
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

function boundedStaleAfterMs(value: number | undefined): number {
  if (value === undefined) return 180_000;
  if (
    !Number.isSafeInteger(value)
    || value < 30_000
    || value > 60 * 60_000
  ) {
    throw new Error("Invalid operations health stale interval.");
  }
  return value;
}

function buildWorkerHealth(input: {
  name: keyof typeof WECHAT_PAY_OPERATIONAL_WORKERS;
  workerKey: WeChatPayOperationalWorkerKey;
  checkpoint:
    | {
        lastHeartbeatAt: Date;
        consecutiveFailures: number;
      }
    | undefined;
  now: Date;
  staleAfterMs: number;
  processingEnabled: boolean;
  outstandingFailures: number;
}): WeChatPayOperationsWorkerHealth {
  const worker = camelCaseWorkerName(input.name);
  if (!input.processingEnabled) {
    return {
      worker,
      status: "disabled",
      code: `wechat_${worker}_worker_disabled`,
      severity: "info",
      count: 0,
    };
  }
  if (!input.checkpoint) {
    return {
      worker,
      status: "missing",
      code: `wechat_${worker}_worker_missing`,
      severity: "critical",
      count: 1,
    };
  }
  const heartbeatMs = input.checkpoint.lastHeartbeatAt.getTime();
  const ageMs = input.now.getTime() - heartbeatMs;
  if (
    !Number.isFinite(heartbeatMs)
    || ageMs < -5_000
    || ageMs > input.staleAfterMs
  ) {
    return {
      worker,
      status: "stale",
      code: `wechat_${worker}_worker_stale`,
      severity: "critical",
      count: 1,
    };
  }
  if (
    input.checkpoint.consecutiveFailures > 0
    || input.outstandingFailures > 0
  ) {
    return {
      worker,
      status: "failing",
      code: `wechat_${worker}_worker_failing`,
      severity:
        input.checkpoint.consecutiveFailures >= 3
          ? "critical"
          : "warning",
      count: Math.max(
        input.checkpoint.consecutiveFailures,
        input.outstandingFailures,
      ),
    };
  }
  return {
    worker,
    status: "healthy",
    code: `wechat_${worker}_worker_healthy`,
    severity: "info",
    count: 0,
  };
}

function camelCaseWorkerName(
  name: keyof typeof WECHAT_PAY_OPERATIONAL_WORKERS,
): WeChatPayOperationsWorkerHealth["worker"] {
  switch (name) {
    case "orderReconciliation":
      return "order_reconciliation";
    case "refundLifecycle":
      return "refund_lifecycle";
    case "refundReversal":
      return "refund_reversal";
  }
}
