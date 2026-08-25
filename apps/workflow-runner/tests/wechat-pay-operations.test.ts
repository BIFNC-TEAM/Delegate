import { describe, expect, it, vi } from "vitest";

import {
  WECHAT_PAY_OPERATIONAL_WORKERS,
  type WeChatPayOperationalWorkerKey,
} from "@delegate/web-data";

import {
  runWeChatPayOperationsTick,
  type WeChatPayOperationsTickDependencies,
  updateWeChatPayOperationsFailureCodes,
  weChatPayOperationsTickFailureCode,
} from "../src/wechat-pay-operations";

describe("WeChat Pay operations runner", () => {
  it("settles all three lanes and checkpoints each lane when one rejects", async () => {
    const completed: string[] = [];
    const started: WeChatPayOperationalWorkerKey[] = [];
    const succeeded: WeChatPayOperationalWorkerKey[] = [];
    const failed: WeChatPayOperationalWorkerKey[] = [];
    const dependencies: WeChatPayOperationsTickDependencies = {
      runOrderReconciliation: vi.fn(async () => {
        completed.push("orders");
        throw new Error("provider detail must not escape");
      }),
      runRefundLifecycle: vi.fn(async () => {
        completed.push("lifecycle");
        return lifecycleSummary();
      }),
      runRefundReversal: vi.fn(async () => {
        completed.push("reversal");
        return reversalSummary();
      }),
      recordStarted: vi.fn(async (workerKey) => {
        started.push(workerKey);
      }),
      recordSucceeded: vi.fn(async (workerKey) => {
        succeeded.push(workerKey);
      }),
      recordFailed: vi.fn(async (workerKey) => {
        failed.push(workerKey);
      }),
      syncExceptionCases: vi.fn(async () => ({
        detected: 2,
        resolved: 1,
      })),
    };

    const result = await runWeChatPayOperationsTick(
      {
        batchSize: 10,
        leaseMs: 75_000,
        pendingBackoffMs: 10_000,
        errorBackoffMs: 5_000,
        maxBackoffMs: 600_000,
      },
      dependencies,
    );

    expect(completed.sort()).toEqual([
      "lifecycle",
      "orders",
      "reversal",
    ]);
    expect(started).toHaveLength(3);
    expect(succeeded.sort()).toEqual([
      WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle,
      WECHAT_PAY_OPERATIONAL_WORKERS.refundReversal,
    ].sort());
    expect(failed).toEqual([
      WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation,
    ]);
    expect(result).toMatchObject({
      orders: null,
      refundLifecycle: lifecycleSummary(),
      refunds: reversalSummary(),
      failedWorkerCodes: [
        "wechat_order_reconciliation_tick_failed",
      ],
      exceptionCases: {
        detected: 2,
        resolved: 1,
      },
      exceptionSyncFailed: false,
    });
    expect(JSON.stringify(result)).not.toContain("provider detail");
    expect(weChatPayOperationsTickFailureCode(result)).toBe(
      "wechat_order_reconciliation_tick_failed",
    );
  });

  it("does not turn exception-queue synchronization into a lane failure", async () => {
    const dependencies: WeChatPayOperationsTickDependencies = {
      runOrderReconciliation: vi.fn(async () => orderSummary()),
      runRefundLifecycle: vi.fn(async () => lifecycleSummary()),
      runRefundReversal: vi.fn(async () => reversalSummary()),
      recordStarted: vi.fn(async () => undefined),
      recordSucceeded: vi.fn(async () => undefined),
      recordFailed: vi.fn(async () => undefined),
      syncExceptionCases: vi.fn(async () => {
        throw new Error("database row detail");
      }),
    };

    const result = await runWeChatPayOperationsTick(
      {
        batchSize: 1,
        leaseMs: 75_000,
        pendingBackoffMs: 10_000,
        errorBackoffMs: 5_000,
        maxBackoffMs: 600_000,
      },
      dependencies,
    );

    expect(result.failedWorkerCodes).toEqual([]);
    expect(result.exceptionCases).toBeNull();
    expect(result.exceptionSyncFailed).toBe(true);
    expect(result.orders).toEqual(orderSummary());
    expect(weChatPayOperationsTickFailureCode(result)).toBe(
      "wechat_exception_queue_sync_failed",
    );
  });

  it("marks fulfilled summaries with item failures as failed lanes", async () => {
    const failed: WeChatPayOperationalWorkerKey[] = [];
    const succeeded: WeChatPayOperationalWorkerKey[] = [];
    const dependencies: WeChatPayOperationsTickDependencies = {
      runOrderReconciliation: vi.fn(async () => ({
        ...orderSummary(),
        failed: 1,
      })),
      runRefundLifecycle: vi.fn(async () => ({
        ...lifecycleSummary(),
        failed: 2,
      })),
      runRefundReversal: vi.fn(async () => ({
        ...reversalSummary(),
        retryScheduled: 3,
      })),
      recordStarted: vi.fn(async () => undefined),
      recordSucceeded: vi.fn(async (workerKey) => {
        succeeded.push(workerKey);
      }),
      recordFailed: vi.fn(async (workerKey) => {
        failed.push(workerKey);
      }),
      syncExceptionCases: vi.fn(async () => ({
        detected: 0,
        resolved: 0,
      })),
    };

    const result = await runWeChatPayOperationsTick(
      {
        batchSize: 10,
        leaseMs: 75_000,
        pendingBackoffMs: 10_000,
        errorBackoffMs: 5_000,
        maxBackoffMs: 600_000,
      },
      dependencies,
    );

    expect(failed.sort()).toEqual([
      WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation,
      WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle,
      WECHAT_PAY_OPERATIONAL_WORKERS.refundReversal,
    ].sort());
    expect(succeeded).toEqual([]);
    expect(result).toMatchObject({
      orders: null,
      refundLifecycle: null,
      refunds: null,
      failedWorkerCodes: [
        "wechat_order_reconciliation_tick_failed",
        "wechat_refund_lifecycle_tick_failed",
        "wechat_refund_reversal_tick_failed",
      ],
    });
    expect(weChatPayOperationsTickFailureCode(result)).toBe(
      "wechat_order_reconciliation_tick_failed",
    );
  });

  it("clears a transient lane failure on the next successful idle heartbeat", async () => {
    let orderTick = 0;
    const succeeded: WeChatPayOperationalWorkerKey[] = [];
    const dependencies: WeChatPayOperationsTickDependencies = {
      runOrderReconciliation: vi.fn(async () => {
        orderTick += 1;
        if (orderTick === 1) {
          return {
            ...orderSummary(),
            paid: 0,
            failed: 1,
          };
        }
        if (orderTick === 2) {
          return {
            ...orderSummary(),
            claimed: 0,
            paid: 0,
          };
        }
        return orderSummary();
      }),
      runRefundLifecycle: vi.fn(async () => ({
        ...lifecycleSummary(),
        claimed: 0,
        submitted: 0,
        pending: 0,
      })),
      runRefundReversal: vi.fn(async () => ({
        ...reversalSummary(),
        claimed: 0,
        applied: 0,
      })),
      recordStarted: vi.fn(async () => undefined),
      recordSucceeded: vi.fn(async (workerKey) => {
        succeeded.push(workerKey);
      }),
      recordFailed: vi.fn(async () => undefined),
      syncExceptionCases: vi.fn(async () => ({
        detected: 0,
        resolved: 0,
      })),
    };
    const config = {
      batchSize: 10,
      leaseMs: 75_000,
      pendingBackoffMs: 10_000,
      errorBackoffMs: 5_000,
      maxBackoffMs: 600_000,
    };

    const failedTick = await runWeChatPayOperationsTick(
      config,
      dependencies,
    );
    let activeCodes =
      updateWeChatPayOperationsFailureCodes(
        [],
        failedTick,
      );
    expect(activeCodes).toEqual([
      "wechat_order_reconciliation_tick_failed",
    ]);
    succeeded.length = 0;

    const idleTick = await runWeChatPayOperationsTick(
      config,
      dependencies,
    );
    activeCodes = updateWeChatPayOperationsFailureCodes(
      activeCodes,
      idleTick,
    );
    expect(idleTick.recoveredWorkerCodes).toEqual([
      "wechat_order_reconciliation_tick_failed",
      "wechat_refund_lifecycle_tick_failed",
      "wechat_refund_reversal_tick_failed",
    ]);
    expect(activeCodes).toEqual([]);
    expect(succeeded).toEqual([
      WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation,
      WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle,
      WECHAT_PAY_OPERATIONAL_WORKERS.refundReversal,
    ]);

    const recoveredTick = await runWeChatPayOperationsTick(
      config,
      dependencies,
    );
    activeCodes = updateWeChatPayOperationsFailureCodes(
      activeCodes,
      recoveredTick,
    );
    expect(recoveredTick.recoveredWorkerCodes).toEqual([
      "wechat_order_reconciliation_tick_failed",
      "wechat_refund_lifecycle_tick_failed",
      "wechat_refund_reversal_tick_failed",
    ]);
    expect(activeCodes).toEqual([]);
    expect(succeeded).toHaveLength(6);
  });
});

function orderSummary() {
  return {
    enabled: true,
    claimed: 1,
    paid: 1,
    terminal: 0,
    pending: 0,
    failed: 0,
  };
}

function lifecycleSummary() {
  return {
    claimed: 1,
    submitted: 1,
    queried: 0,
    terminal: 0,
    pending: 1,
    rejected: 0,
    failed: 0,
    reconciliationRequired: 0,
  };
}

function reversalSummary() {
  return {
    claimed: 1,
    applied: 1,
    reconciliationRequired: 0,
    retryScheduled: 0,
    unresolved: 0,
  };
}
