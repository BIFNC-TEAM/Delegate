import {
  PaymentProvider,
  RechargeOrderStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  WeChatPayReconciliationLeaseLostError,
  claimNextWeChatPayOrderReconciliation,
  enqueueWeChatPayOrderReconciliation,
  reconcileClaimedWeChatPayOrder,
  reconcileWeChatPayOrderIfDue,
  runWeChatPayOrderReconciliationTick,
} from "../src/agent-wallet-payment-reconciliation";
import type { NormalizedPaymentProviderEvent } from "../src/agent-wallet-payment-providers";

const databaseNow = new Date("2026-07-27T10:00:00.000Z");

describe("WeChat Pay order reconciliation", () => {
  it("enqueues one durable job and claims it with SKIP LOCKED and a 30-second lease", async () => {
    const client = new FakeReconciliationClient();
    client.addPendingOrder("order-1");

    await enqueueWeChatPayOrderReconciliation(
      "order-1",
      client,
      { initialDelayMs: 0, now: () => databaseNow },
    );
    await enqueueWeChatPayOrderReconciliation(
      "order-1",
      client,
      { initialDelayMs: 0, now: () => databaseNow },
    );

    const claim = await claimNextWeChatPayOrderReconciliation({
      client,
      rechargeOrderId: "order-1",
    });
    const duplicateClaim =
      await claimNextWeChatPayOrderReconciliation({
        client,
        rechargeOrderId: "order-1",
      });

    expect(client.outboxRows).toHaveLength(1);
    expect(client.lastRawQuery).toContain(
      "FOR UPDATE SKIP LOCKED",
    );
    expect(claim).toEqual({
      outboxId: "outbox-1",
      rechargeOrderId: "order-1",
      attempt: 1,
      leaseUntil: new Date("2026-07-27T10:00:30.000Z"),
    });
    expect(duplicateClaim).toBeNull();
    expect(client.outboxRows[0]).toMatchObject({
      status: "PROCESSING",
      attemptCount: 1,
    });
  });

  it("queries outside the claim transaction and backs off an unexpired pending order", async () => {
    const client = await clientWithClaimableOrder();
    const queryOrder = vi.fn(async () => {
      expect(client.transactionDepth).toBe(0);
      return pendingQueryResult();
    });

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder,
        completePaidEvent: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );
    const immediateRetry = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder,
        completePaidEvent: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({ status: "pending", queried: true });
    expect(immediateRetry).toEqual({
      status: "pending",
      queried: false,
    });
    expect(queryOrder).toHaveBeenCalledOnce();
    expect(client.outboxRows[0]).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      availableAt: new Date("2026-07-27T10:00:10.000Z"),
      lastError: null,
    });
    expect(client.orders[0]).toMatchObject({
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
      checkoutUrl: "weixin://wxpay/test",
    });
    expect(client.orderUpdateTransactionDepths).toHaveLength(0);
  });

  it.each(["NOTPAY", "USERPAYING"] as const)(
    "queries once, then closes an expired Native checkout reported as %s",
    async (tradeState) => {
      const client = await clientWithClaimableOrder(
        nativeCheckoutPayload("2026-07-27T09:59:59.000Z"),
      );
      const queryOrder = vi.fn(async () => ({
        status: "pending" as const,
        tradeState,
        event: null,
      }));

      const result = await reconcileWeChatPayOrderIfDue(
        "order-1",
        {
          client,
          queryOrder,
          completePaidEvent: vi.fn(),
          initialDelayMs: 0,
          now: () => databaseNow,
        },
      );

      expect(queryOrder).toHaveBeenCalledOnce();
      expect(result).toEqual({
        status: "closed",
        queried: true,
      });
      expect(client.orders[0]).toMatchObject({
        status: RechargeOrderStatus.CANCELED,
        checkoutUrl: null,
      });
      expect(client.outboxRows[0]).toMatchObject({
        status: "PROCESSED",
        attemptCount: 1,
        lastError: null,
      });
      expect(client.orderUpdateTransactionDepths).toEqual([1]);
    },
  );

  it.each([
    null,
    {},
    { mode: "native" },
    nativeCheckoutPayload("not-a-time"),
    nativeCheckoutPayload("2026-07-27T09:59:59Z"),
    {
      provider: "wechat_pay",
      rawPayload: {
        mode: "jsapi",
        expiresAt: "2026-07-27T09:59:59.000Z",
      },
    },
  ])(
    "keeps polling fail-safe when checkout expiration is absent or invalid",
    async (providerPayload) => {
      const client =
        await clientWithClaimableOrder(providerPayload);

      const result = await reconcileWeChatPayOrderIfDue(
        "order-1",
        {
          client,
          queryOrder: vi.fn(async () => pendingQueryResult()),
          completePaidEvent: vi.fn(),
          initialDelayMs: 0,
          now: () => databaseNow,
        },
      );

      expect(result).toEqual({
        status: "pending",
        queried: true,
      });
      expect(client.orders[0]).toMatchObject({
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        checkoutUrl: "weixin://wxpay/test",
      });
      expect(client.outboxRows[0]!.status).toBe("PENDING");
      expect(client.orderUpdateTransactionDepths).toHaveLength(0);
    },
  );

  it("completes a signed paid result and terminalizes its durable job", async () => {
    const client = await clientWithClaimableOrder();
    const event = paidEvent("order-1");
    const completePaidEvent = vi.fn(async () => {
      client.orders[0]!.status = RechargeOrderStatus.PAID;
    });

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => ({
          status: "paid" as const,
          tradeState: "SUCCESS" as const,
          event,
        })),
        completePaidEvent,
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({ status: "paid", queried: true });
    expect(completePaidEvent).toHaveBeenCalledWith(event);
    expect(client.outboxRows[0]).toMatchObject({
      status: "PROCESSED",
      attemptCount: 1,
      lastError: null,
    });
  });

  it("does not regress a callback-confirmed payment when an in-flight query returns pending", async () => {
    const client = await clientWithClaimableOrder(
      nativeCheckoutPayload("2026-07-27T09:59:59.000Z"),
    );
    client.beforeRechargeOrderUpdate = () => {
      client.orders[0]!.status = RechargeOrderStatus.PAID;
      client.beforeRechargeOrderUpdate = null;
    };

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => pendingQueryResult()),
        completePaidEvent: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({ status: "paid", queried: true });
    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.PAID,
    );
    expect(client.outboxRows[0]!.status).toBe("PROCESSED");
    expect(client.orderUpdateTransactionDepths).toEqual([1]);
  });

  it.each([
    {
      providerStatus: "closed" as const,
      tradeState: "CLOSED" as const,
      localStatus: RechargeOrderStatus.CANCELED,
    },
    {
      providerStatus: "refunded" as const,
      tradeState: "REFUND" as const,
      localStatus: RechargeOrderStatus.REFUNDED,
    },
    {
      providerStatus: "failed" as const,
      tradeState: "PAYERROR" as const,
      localStatus: RechargeOrderStatus.FAILED,
    },
  ])(
    "atomically persists provider terminal state $providerStatus",
    async ({ providerStatus, tradeState, localStatus }) => {
      const client = await clientWithClaimableOrder();

      const result = await reconcileWeChatPayOrderIfDue(
        "order-1",
        {
          client,
          queryOrder: vi.fn(async () => ({
            status: providerStatus,
            tradeState,
            event: null,
          })),
          completePaidEvent: vi.fn(),
          initialDelayMs: 0,
          now: () => databaseNow,
        },
      );

      expect(result).toEqual({
        status: providerStatus,
        queried: true,
      });
      expect(client.orders[0]).toMatchObject({
        status: localStatus,
        checkoutUrl: null,
      });
      expect(client.outboxRows[0]!.status).toBe("PROCESSED");
    },
  );

  it("persists only a safe error code before rethrowing a provider error", async () => {
    const client = await clientWithClaimableOrder();
    const providerError = Object.assign(
      new Error("merchant-secret must not be stored"),
      { code: "WECHAT_PAY_PROTOCOL_ERROR" },
    );

    await expect(
      reconcileWeChatPayOrderIfDue("order-1", {
        client,
        queryOrder: vi.fn(async () => {
          throw providerError;
        }),
        completePaidEvent: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      }),
    ).rejects.toBe(providerError);

    expect(client.outboxRows[0]).toMatchObject({
      status: "FAILED",
      attemptCount: 1,
      availableAt: new Date("2026-07-27T10:00:05.000Z"),
      lastError: "WECHAT_PAY_PROTOCOL_ERROR",
    });
    expect(JSON.stringify(client.outboxRows)).not.toContain(
      "merchant-secret",
    );
  });

  it("persists a wallet conflict as dead-lettered manual review state", async () => {
    const client = await clientWithClaimableOrder();
    const queryOrder = vi.fn(async () => ({
      status: "paid" as const,
      tradeState: "SUCCESS" as const,
      event: paidEvent("order-1"),
    }));
    const conflict = Object.assign(
      new Error("private reconciliation detail"),
      { code: "RECHARGE_PAYMENT_CONFLICT" },
    );

    await expect(
      reconcileWeChatPayOrderIfDue("order-1", {
        client,
        queryOrder,
        completePaidEvent: vi.fn(async () => {
          throw conflict;
        }),
        initialDelayMs: 0,
        now: () => databaseNow,
      }),
    ).rejects.toBe(conflict);
    expect(client.outboxRows[0]).toMatchObject({
      status: "DEAD_LETTER",
      lastError: "RECHARGE_PAYMENT_CONFLICT",
    });

    await expect(
      reconcileWeChatPayOrderIfDue("order-1", {
        client,
        queryOrder,
        completePaidEvent: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      }),
    ).rejects.toThrow("manual review");
    expect(queryOrder).toHaveBeenCalledOnce();
  });

  it("fences a stale attempt after an expired lease is reclaimed", async () => {
    const client = await clientWithClaimableOrder();
    const first =
      await claimNextWeChatPayOrderReconciliation({ client });
    expect(first).not.toBeNull();

    client.outboxRows[0]!.availableAt = new Date(
      databaseNow.getTime() - 1,
    );
    const second =
      await claimNextWeChatPayOrderReconciliation({ client });
    expect(second?.attempt).toBe(2);

    await expect(
      reconcileClaimedWeChatPayOrder(first!, {
        client,
        queryOrder: vi.fn(async () => pendingQueryResult()),
        completePaidEvent: vi.fn(),
        now: () => databaseNow,
      }),
    ).rejects.toBeInstanceOf(
      WeChatPayReconciliationLeaseLostError,
    );
    expect(client.outboxRows[0]).toMatchObject({
      status: "PROCESSING",
      attemptCount: 2,
    });
  });

  it("does not claim work or load provider dependencies while disabled", async () => {
    const client = await clientWithClaimableOrder();
    const queryOrder = vi.fn();
    const completePaidEvent = vi.fn();

    const summary =
      await runWeChatPayOrderReconciliationTick({
        client,
        env: { DELEGATE_WECHAT_PAY_ENABLED: "false" },
        queryOrder,
        completePaidEvent,
      });

    expect(summary).toEqual({
      enabled: false,
      claimed: 0,
      paid: 0,
      terminal: 0,
      pending: 0,
      failed: 0,
    });
    expect(queryOrder).not.toHaveBeenCalled();
    expect(completePaidEvent).not.toHaveBeenCalled();
    expect(client.outboxRows[0]!.status).toBe("PENDING");
  });
});

async function clientWithClaimableOrder(
  providerPayload?: unknown,
) {
  const client = new FakeReconciliationClient();
  if (providerPayload === undefined) {
    client.addPendingOrder("order-1");
  } else {
    client.addPendingOrder("order-1", providerPayload);
  }
  await enqueueWeChatPayOrderReconciliation(
    "order-1",
    client,
    { initialDelayMs: 0, now: () => databaseNow },
  );
  return client;
}

function pendingQueryResult() {
  return {
    status: "pending" as const,
    tradeState: "NOTPAY" as const,
    event: null,
  };
}

function nativeCheckoutPayload(expiresAt: string) {
  return {
    provider: "wechat_pay",
    rawPayload: {
      mode: "native",
      outTradeNo: "order-1",
      expiresAt,
    },
  };
}

function paidEvent(
  orderId: string,
): NormalizedPaymentProviderEvent {
  return {
    provider: PaymentProvider.WECHAT_PAY,
    providerEventId: "query:transaction-1",
    providerTransactionId: "transaction-1",
    eventType: "RECHARGE_PAID",
    rechargeOrderId: orderId,
    providerOrderId: orderId,
    amountCents: 2_000,
    currency: "CNY",
    rawPayload: { source: "order_query" },
    normalizedPayload: {
      providerTransactionId: "transaction-1",
    },
    idempotencyKey: "wechat_pay:query:transaction-1",
    verifiedAt: databaseNow,
  };
}

type FakeOutboxRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  status:
    | "PENDING"
    | "PROCESSING"
    | "PROCESSED"
    | "FAILED"
    | "DEAD_LETTER";
  idempotencyKey: string;
  attemptCount: number;
  availableAt: Date;
  processedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
};

type FakeOrder = {
  id: string;
  provider: PaymentProvider;
  status: RechargeOrderStatus;
  checkoutUrl: string | null;
  providerPayload: unknown;
  refundedAt: Date | null;
};

class FakeReconciliationClient {
  outboxRows: FakeOutboxRow[] = [];
  orders: FakeOrder[] = [];
  transactionDepth = 0;
  orderUpdateTransactionDepths: number[] = [];
  beforeRechargeOrderUpdate: (() => void) | null = null;
  lastRawQuery = "";

  addPendingOrder(
    id: string,
    providerPayload: unknown = nativeCheckoutPayload(
      "2026-07-27T11:00:00.000Z",
    ),
  ) {
    this.orders.push({
      id,
      provider: PaymentProvider.WECHAT_PAY,
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
      checkoutUrl: "weixin://wxpay/test",
      providerPayload,
      refundedAt: null,
    });
  }

  outboxEvent = {
    findUnique: async (args: any) =>
      this.outboxRows.find(
        (row) =>
          row.idempotencyKey === args.where.idempotencyKey,
      ) ?? null,
    upsert: async (args: any) => {
      const existing = this.outboxRows.find(
        (row) =>
          row.idempotencyKey === args.where.idempotencyKey,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: FakeOutboxRow = {
        id: `outbox-${this.outboxRows.length + 1}`,
        aggregateType: args.create.aggregateType,
        aggregateId: args.create.aggregateId,
        eventType: args.create.eventType,
        payload: args.create.payload,
        status: args.create.status,
        idempotencyKey: args.create.idempotencyKey,
        attemptCount: 0,
        availableAt: args.create.availableAt,
        processedAt: null,
        lastError: null,
        createdAt: databaseNow,
      };
      this.outboxRows.push(row);
      return row;
    },
    update: async (args: any) => {
      const row = this.requireOutbox(args.where.id);
      applyOutboxData(row, args.data);
      return row;
    },
    updateMany: async (args: any) => {
      const row = this.outboxRows.find(
        (candidate) => matchesOutbox(candidate, args.where),
      );
      if (!row) return { count: 0 };
      applyOutboxData(row, args.data);
      return { count: 1 };
    },
  };

  rechargeOrder = {
    findUnique: async (args: any) =>
      this.orders.find((row) => row.id === args.where.id)
      ?? null,
    updateMany: async (args: any) => {
      this.orderUpdateTransactionDepths.push(
        this.transactionDepth,
      );
      this.beforeRechargeOrderUpdate?.();
      const row = this.orders.find(
        (candidate) =>
          candidate.id === args.where.id
          && candidate.provider === args.where.provider
          && candidate.status === args.where.status,
      );
      if (!row) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
  };

  async $queryRaw<T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    this.lastRawQuery = strings.join("?");
    const requestedOrderId =
      values.length >= 3 && typeof values[2] === "string"
        ? values[2]
        : undefined;
    const row = this.outboxRows
      .filter(
        (candidate) =>
          candidate.aggregateType === values[0]
          && candidate.eventType === values[1]
          && (
            requestedOrderId === undefined
            || candidate.aggregateId === requestedOrderId
          )
          && ["PENDING", "FAILED", "PROCESSING"].includes(
            candidate.status,
          )
          && candidate.availableAt.getTime()
            <= databaseNow.getTime(),
      )
      .sort(
        (left, right) =>
          left.availableAt.getTime() - right.availableAt.getTime(),
      )[0];
    return (row
      ? [{
          id: row.id,
          aggregateId: row.aggregateId,
          attemptCount: row.attemptCount,
          claimedAt: databaseNow,
        }]
      : []) as T;
  }

  async $transaction<T>(
    operation: (tx: FakeReconciliationClient) => Promise<T>,
  ): Promise<T> {
    this.transactionDepth += 1;
    try {
      return await operation(this);
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private requireOutbox(id: string): FakeOutboxRow {
    const row = this.outboxRows.find(
      (candidate) => candidate.id === id,
    );
    if (!row) throw new Error("outbox not found");
    return row;
  }
}

function matchesOutbox(
  row: FakeOutboxRow,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "id") return row.id === expected;
    if (key === "aggregateType") {
      return row.aggregateType === expected;
    }
    if (key === "aggregateId") return row.aggregateId === expected;
    if (key === "eventType") return row.eventType === expected;
    if (key === "status") return row.status === expected;
    if (key === "attemptCount") {
      return row.attemptCount === expected;
    }
    return true;
  });
}

function applyOutboxData(
  row: FakeOutboxRow,
  data: Record<string, any>,
) {
  if (data.attemptCount?.increment) {
    row.attemptCount += data.attemptCount.increment;
  }
  for (const key of [
    "status",
    "availableAt",
    "processedAt",
    "lastError",
  ] as const) {
    if (key in data) {
      (row as any)[key] = data[key];
    }
  }
}
