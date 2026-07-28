import { describe, expect, it, vi } from "vitest";

import {
  getWeChatPayOperationsHealthSnapshot,
  recordWeChatPayOperationalWorkerFailed,
  recordWeChatPayOperationalWorkerSucceeded,
  WECHAT_PAY_OPERATIONAL_WORKERS,
} from "../src/wechat-pay-operations";
import type { prisma } from "../src/prisma";

describe("WeChat Pay operational checkpoints", () => {
  it("stores a stable failure code instead of an exception message", async () => {
    const upsert = vi.fn(async () => undefined);
    const client = {
      operationalWorkerCheckpoint: { upsert },
    };

    await recordWeChatPayOperationalWorkerFailed(
      WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle,
      {
        client,
        now: new Date("2026-07-28T09:00:00.000Z"),
      },
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          lastErrorCode:
            "wechat_refund_lifecycle_tick_failed",
        }),
        update: expect.objectContaining({
          lastErrorCode:
            "wechat_refund_lifecycle_tick_failed",
          consecutiveFailures: { increment: 1 },
        }),
      }),
    );
    expect(JSON.stringify(upsert.mock.calls)).not.toContain(
      "merchant",
    );
  });

  it("persists only scalar counters and booleans in summaries", async () => {
    const upsert = vi.fn(async () => undefined);

    await recordWeChatPayOperationalWorkerSucceeded(
      WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation,
      {
        enabled: true,
        claimed: 2,
        negative: -1,
        rawError: "secret provider response",
        nested: { id: "order-secret" },
      },
      {
        client: {
          operationalWorkerCheckpoint: { upsert },
        },
      },
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          lastSummary: {
            enabled: true,
            claimed: 2,
          },
        }),
        update: expect.objectContaining({
          lastSummary: {
            enabled: true,
            claimed: 2,
          },
        }),
      }),
    );
    expect(JSON.stringify(upsert.mock.calls)).not.toContain(
      "order-secret",
    );
    expect(JSON.stringify(upsert.mock.calls)).not.toContain(
      "provider response",
    );
  });
});

describe("WeChat Pay operations health", () => {
  it("returns only redacted counts and worker states", async () => {
    const now = new Date("2026-07-28T09:00:00.000Z");
    const fakeClient = {
      operationalWorkerCheckpoint: {
        findMany: vi.fn(async () => [
          {
            workerKey:
              WECHAT_PAY_OPERATIONAL_WORKERS.orderReconciliation,
            lastHeartbeatAt: new Date(
              "2026-07-28T08:59:55.000Z",
            ),
            consecutiveFailures: 0,
            lastSummary: {
              orderId: "must-not-return",
            },
          },
          {
            workerKey:
              WECHAT_PAY_OPERATIONAL_WORKERS.refundLifecycle,
            lastHeartbeatAt: new Date(
              "2026-07-28T08:59:55.000Z",
            ),
            consecutiveFailures: 1,
            lastErrorCode: "secret-raw-error",
          },
        ]),
      },
      outboxEvent: {
        count: vi.fn(async (args: {
          where: { eventType: string };
        }) =>
          args.where.eventType ===
          "wechat_pay.refund.reconcile"
            ? 2
            : 0,
        ),
      },
      rechargeRefund: {
        count: vi.fn(async (args: {
          where: Record<string, unknown>;
        }) =>
          "providerStatus" in args.where ? 1 : 3,
        ),
      },
      paymentProviderEvent: {
        count: vi.fn(async () => 4),
      },
    };

    const snapshot =
      await getWeChatPayOperationsHealthSnapshot({
        client: fakeClient as unknown as typeof prisma,
        now,
        staleAfterMs: 60_000,
        processingEnabled: true,
      });

    expect(snapshot).toMatchObject({
      status: "critical",
      workers: [
        {
          worker: "order_reconciliation",
          status: "healthy",
          count: 0,
        },
        {
          worker: "refund_lifecycle",
          status: "failing",
          severity: "warning",
          count: 2,
        },
        {
          worker: "refund_reversal",
          status: "missing",
          severity: "critical",
          count: 1,
        },
      ],
    });
    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "wechat_refund_lifecycle_failed_backlog",
          count: 2,
        }),
        expect.objectContaining({
          code: "wechat_refund_lifecycle_dead_letter",
          count: 2,
        }),
        expect.objectContaining({
          code: "wechat_refund_reconciliation_required",
          count: 3,
        }),
        expect.objectContaining({
          code: "wechat_refund_abnormal",
          count: 1,
        }),
        expect.objectContaining({
          code: "wechat_refund_unmatched_verified",
          count: 4,
        }),
      ]),
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("must-not-return");
    expect(serialized).not.toContain("secret-raw-error");
    expect(serialized).not.toContain("orderId");
    expect(serialized).not.toContain("refundId");
    expect(serialized).not.toContain("merchant");
  });

  it("keeps a worker failing while any failed Outbox item remains in backoff", async () => {
    const workerKeys = Object.values(
      WECHAT_PAY_OPERATIONAL_WORKERS,
    );
    const fakeClient = {
      operationalWorkerCheckpoint: {
        findMany: vi.fn(async () =>
          workerKeys.map((workerKey) => ({
            workerKey,
            lastHeartbeatAt: new Date(
              "2026-07-28T08:59:55.000Z",
            ),
            consecutiveFailures: 0,
          })),
        ),
      },
      outboxEvent: {
        count: vi.fn(async (args: {
          where: {
            eventType: string;
            status: string;
          };
        }) =>
          args.where.eventType
            === "wechat_pay.order.reconcile"
          && args.where.status === "FAILED"
            ? 1
            : 0,
        ),
      },
      rechargeRefund: {
        count: vi.fn(async () => 0),
      },
      paymentProviderEvent: {
        count: vi.fn(async () => 0),
      },
    };

    const snapshot =
      await getWeChatPayOperationsHealthSnapshot({
        client: fakeClient as unknown as typeof prisma,
        now: new Date("2026-07-28T09:00:00.000Z"),
        staleAfterMs: 60_000,
        processingEnabled: true,
      });

    expect(snapshot.status).toBe("degraded");
    expect(snapshot.workers[0]).toMatchObject({
      worker: "order_reconciliation",
      status: "failing",
      severity: "warning",
      count: 1,
    });
    expect(snapshot.alerts).toContainEqual({
      code: "wechat_order_reconciliation_failed_backlog",
      severity: "warning",
      count: 1,
    });
  });
});
