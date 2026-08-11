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
import { WeChatPayProtocolError } from "../src/wechat-pay-api-v3";

const databaseNow = new Date("2026-07-27T10:00:00.000Z");

describe("WeChat Pay order reconciliation", () => {
  it("enqueues one durable job and claims it with SKIP LOCKED and a provider-safe 75-second lease", async () => {
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
      leaseUntil: new Date("2026-07-27T10:01:15.000Z"),
    });
    expect(duplicateClaim).toBeNull();
    expect(client.outboxRows[0]).toMatchObject({
      status: "PROCESSING",
      attemptCount: 1,
    });
  });

  it("rejects a reconciliation lease that cannot cover the maximum provider timeout plus persistence", async () => {
    await expect(
      claimNextWeChatPayOrderReconciliation({
        client: new FakeReconciliationClient(),
        leaseMs: 60_000,
      }),
    ).rejects.toThrow("at least 75000");
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

  it("does not query a CREATED order until the original provider request timeout and propagation window have passed", async () => {
    const client = new FakeReconciliationClient();
    client.addCreatedOrder("order-1", {
      createdAt: new Date("2026-07-27T09:59:30.000Z"),
    });
    await enqueueWeChatPayOrderReconciliation(
      "order-1",
      client,
      { initialDelayMs: 0, now: () => databaseNow },
    );
    const queryOrder = vi.fn();

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder,
        completePaidEvent: vi.fn(),
        createCheckout: vi.fn(),
        closeOrder: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({
      status: "pending",
      queried: false,
    });
    expect(queryOrder).not.toHaveBeenCalled();
    expect(client.outboxRows[0]).toMatchObject({
      status: "PENDING",
      availableAt:
        new Date("2026-07-27T10:00:45.000Z"),
      lastError: null,
    });
  });

  it("retries a CREATED Native order only after a signed not_found query and persists the recovered QR", async () => {
    const client = await clientWithCreatedOrder(
      new Date("2026-07-27T09:58:00.000Z"),
    );
    const callOrder: string[] = [];
    let createdRecoveryInput:
      | Record<string, unknown>
      | undefined;
    const createCheckout = vi.fn(async (order) => {
      expect(client.transactionDepth).toBe(0);
      callOrder.push("create");
      createdRecoveryInput = {
        id: order.id,
        status: order.status,
        amountCents: order.amountCents,
        currency: order.currency,
        idempotencyKey: order.idempotencyKey,
      };
      return {
        provider: PaymentProvider.WECHAT_PAY,
        providerOrderId: "order-1",
        checkoutUrl: "weixin://wxpay/recovered",
        providerPayload: nativeCheckoutPayload(
          "2026-07-27T12:00:00.000Z",
        ),
      };
    });

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => {
          expect(client.transactionDepth).toBe(0);
          callOrder.push("query");
          return missingQueryResult();
        }),
        completePaidEvent: vi.fn(),
        createCheckout,
        closeOrder: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(callOrder).toEqual(["query", "create"]);
    expect(createdRecoveryInput).toEqual({
      id: "order-1",
      status: RechargeOrderStatus.CREATED,
      amountCents: 2_000,
      currency: "CNY",
      idempotencyKey: "idempotency-order-1",
    });
    expect(result).toEqual({
      status: "pending",
      queried: true,
    });
    expect(client.orders[0]).toMatchObject({
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
      providerOrderId: "order-1",
      checkoutUrl: "weixin://wxpay/recovered",
    });
    expect(client.outboxRows[0]).toMatchObject({
      status: "PENDING",
      lastError: null,
    });
  });

  it("cancels a missing CREATED order instead of replaying a frozen request after time_expire", async () => {
    const client = new FakeReconciliationClient();
    client.addCreatedOrder("order-1", {
      createdAt: new Date("2026-07-27T07:00:00.000Z"),
      providerPayload: nativePreparedCheckoutPayload(
        "order-1",
        "2026-07-27T09:00:00.000Z",
      ),
    });
    await enqueueWeChatPayOrderReconciliation(
      "order-1",
      client,
      { initialDelayMs: 0, now: () => databaseNow },
    );
    const createCheckout = vi.fn();
    const closeOrder = vi.fn();

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => missingQueryResult()),
        completePaidEvent: vi.fn(),
        createCheckout,
        closeOrder,
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({ status: "closed", queried: true });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(closeOrder).not.toHaveBeenCalled();
    expect(client.orders[0]).toMatchObject({
      status: RechargeOrderStatus.CANCELED,
      checkoutUrl: null,
    });
    expect(client.outboxRows[0]).toMatchObject({
      status: "PROCESSED",
      lastError: null,
    });
  });

  it("credits a signed SUCCESS query directly from CREATED through the shared paid-event path", async () => {
    const client = await clientWithCreatedOrder(
      new Date("2026-07-27T09:58:00.000Z"),
    );
    const event = paidEvent("order-1");
    const completePaidEvent = vi.fn(async () => {
      client.orders[0]!.status = RechargeOrderStatus.PAID;
      client.orders[0]!.providerOrderId = "order-1";
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
        createCheckout: vi.fn(),
        closeOrder: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({ status: "paid", queried: true });
    expect(completePaidEvent).toHaveBeenCalledWith(event);
    expect(client.outboxRows[0]!.status).toBe("PROCESSED");
  });

  it("waits at least five minutes before closing a CREATED provider order whose code_url was lost", async () => {
    const client = await clientWithCreatedOrder(
      new Date("2026-07-27T09:58:00.000Z"),
    );
    const closeOrder = vi.fn();

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => pendingQueryResult()),
        completePaidEvent: vi.fn(),
        createCheckout: vi.fn(),
        closeOrder,
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({
      status: "pending",
      queried: true,
    });
    expect(closeOrder).not.toHaveBeenCalled();
    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.CREATED,
    );
    expect(client.outboxRows[0]!.status).toBe("PENDING");
  });

  it("cancels a CREATED order only after NOTPAY and a verified successful close", async () => {
    const client = await clientWithCreatedOrder(
      new Date("2026-07-27T09:54:00.000Z"),
    );
    const closeOrder = vi.fn(async () => {
      expect(client.transactionDepth).toBe(0);
    });

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => pendingQueryResult()),
        completePaidEvent: vi.fn(),
        createCheckout: vi.fn(),
        closeOrder,
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(closeOrder).toHaveBeenCalledWith("order-1");
    expect(result).toEqual({
      status: "closed",
      queried: true,
    });
    expect(client.orders[0]).toMatchObject({
      status: RechargeOrderStatus.CANCELED,
      checkoutUrl: null,
    });
    expect(client.outboxRows[0]!.status).toBe("PROCESSED");
  });

  it("keeps an expired REQUIRES_PAYMENT order pending through the five-minute close margin", async () => {
    const client = await clientWithClaimableOrder(
      nativeCheckoutPayload("2026-07-27T09:56:00.000Z"),
    );
    const closeOrder = vi.fn();

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => pendingQueryResult()),
        completePaidEvent: vi.fn(),
        createCheckout: vi.fn(),
        closeOrder,
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(result).toEqual({ status: "pending", queried: true });
    expect(closeOrder).not.toHaveBeenCalled();
    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.REQUIRES_PAYMENT,
    );
    expect(client.outboxRows[0]!.status).toBe("PENDING");
  });

  it("closes an expired REQUIRES_PAYMENT order only after signed NOTPAY and the safety margin", async () => {
    const client = await clientWithClaimableOrder(
      nativeCheckoutPayload("2026-07-27T09:54:00.000Z"),
    );
    const closeOrder = vi.fn();

    const result = await reconcileWeChatPayOrderIfDue(
      "order-1",
      {
        client,
        queryOrder: vi.fn(async () => pendingQueryResult()),
        completePaidEvent: vi.fn(),
        createCheckout: vi.fn(),
        closeOrder,
        initialDelayMs: 0,
        now: () => databaseNow,
      },
    );

    expect(closeOrder).toHaveBeenCalledWith("order-1");
    expect(result).toEqual({ status: "closed", queried: true });
    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.CANCELED,
    );
    expect(client.outboxRows[0]!.status).toBe("PROCESSED");
  });

  it("keeps a failed close retryable so the next attempt queries first again", async () => {
    const client = await clientWithCreatedOrder(
      new Date("2026-07-27T09:54:00.000Z"),
    );
    const providerError = Object.assign(
      new Error("upstream private message"),
      { code: "WECHAT_PAY_PROTOCOL_ERROR" },
    );

    await expect(
      reconcileWeChatPayOrderIfDue("order-1", {
        client,
        queryOrder: vi.fn(async () => pendingQueryResult()),
        completePaidEvent: vi.fn(),
        createCheckout: vi.fn(),
        closeOrder: vi.fn(async () => {
          throw providerError;
        }),
        initialDelayMs: 0,
        now: () => databaseNow,
      }),
    ).rejects.toBe(providerError);

    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.CREATED,
    );
    expect(client.outboxRows[0]).toMatchObject({
      status: "FAILED",
      lastError: "WECHAT_PAY_PROTOCOL_ERROR",
    });
    expect(JSON.stringify(client.outboxRows)).not.toContain(
      "upstream private message",
    );
  });

  it("prevents an expired owner from closing after a newer worker reclaims the lease", async () => {
    const client = await clientWithCreatedOrder(
      new Date("2026-07-27T09:54:00.000Z"),
    );
    const stale =
      await claimNextWeChatPayOrderReconciliation({ client });
    if (!stale) throw new Error("expected stale claim");
    let current:
      | Awaited<ReturnType<
          typeof claimNextWeChatPayOrderReconciliation
        >>
      | undefined;
    const closeOrder = vi.fn();

    await expect(
      reconcileClaimedWeChatPayOrder(stale, {
        client,
        queryOrder: vi.fn(async () => {
          client.outboxRows[0]!.availableAt =
            new Date(databaseNow.getTime() - 1);
          current =
            await claimNextWeChatPayOrderReconciliation({
              client,
            });
          return pendingQueryResult();
        }),
        completePaidEvent: vi.fn(),
        createCheckout: vi.fn(),
        closeOrder,
        now: () => databaseNow,
      }),
    ).rejects.toBeInstanceOf(
      WeChatPayReconciliationLeaseLostError,
    );

    expect(current?.attempt).toBe(2);
    expect(closeOrder).not.toHaveBeenCalled();
    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.CREATED,
    );
  });

  it("allows only the current lease owner to resubmit after not_found", async () => {
    const client = await clientWithCreatedOrder(
      new Date("2026-07-27T09:54:00.000Z"),
    );
    const stale =
      await claimNextWeChatPayOrderReconciliation({ client });
    if (!stale) throw new Error("expected stale claim");
    let current:
      | Awaited<ReturnType<
          typeof claimNextWeChatPayOrderReconciliation
        >>
      | undefined;
    const createCheckout = vi.fn(async () => ({
      provider: PaymentProvider.WECHAT_PAY,
      providerOrderId: "order-1",
      checkoutUrl: "weixin://wxpay/current-owner",
      providerPayload: nativeCheckoutPayload(
        "2026-07-27T12:00:00.000Z",
      ),
    }));

    await expect(
      reconcileClaimedWeChatPayOrder(stale, {
        client,
        queryOrder: vi.fn(async () => {
          client.outboxRows[0]!.availableAt =
            new Date(databaseNow.getTime() - 1);
          current =
            await claimNextWeChatPayOrderReconciliation({
              client,
            });
          return missingQueryResult();
        }),
        completePaidEvent: vi.fn(),
        createCheckout,
        closeOrder: vi.fn(),
        now: () => databaseNow,
      }),
    ).rejects.toBeInstanceOf(
      WeChatPayReconciliationLeaseLostError,
    );
    expect(createCheckout).not.toHaveBeenCalled();
    if (!current) throw new Error("expected current claim");

    await reconcileClaimedWeChatPayOrder(current, {
      client,
      queryOrder: vi.fn(async () => missingQueryResult()),
      completePaidEvent: vi.fn(),
      createCheckout,
      closeOrder: vi.fn(),
      now: () => databaseNow,
    });

    expect(createCheckout).toHaveBeenCalledOnce();
    expect(client.orders[0]).toMatchObject({
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
      checkoutUrl: "weixin://wxpay/current-owner",
    });
  });

  it("dead-letters a not_found query for an already persisted REQUIRES_PAYMENT checkout", async () => {
    const client = await clientWithClaimableOrder();
    const createCheckout = vi.fn();

    await expect(
      reconcileWeChatPayOrderIfDue("order-1", {
        client,
        queryOrder: vi.fn(async () => missingQueryResult()),
        completePaidEvent: vi.fn(),
        createCheckout,
        closeOrder: vi.fn(),
        initialDelayMs: 0,
        now: () => databaseNow,
      }),
    ).rejects.toThrow("missing at the provider");

    expect(createCheckout).not.toHaveBeenCalled();
    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.REQUIRES_PAYMENT,
    );
    expect(client.outboxRows[0]).toMatchObject({
      status: "DEAD_LETTER",
      lastError:
        "wechat_existing_checkout_missing_at_provider",
    });
  });

  it.each(["NOTPAY", "USERPAYING"] as const)(
    "keeps an expired local QR pending until WeChat reports a terminal state (%s)",
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
        status: "pending",
        queried: true,
      });
      expect(client.orders[0]).toMatchObject({
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        checkoutUrl: "weixin://wxpay/test",
      });
      expect(client.outboxRows[0]).toMatchObject({
        status: "PENDING",
        attemptCount: 1,
        availableAt: new Date("2026-07-27T10:00:10.000Z"),
        lastError: null,
      });
      expect(client.orderUpdateTransactionDepths).toHaveLength(0);
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
    const queryOrder = vi.fn(async () => {
      client.orders[0]!.status = RechargeOrderStatus.PAID;
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

    expect(result).toEqual({ status: "paid", queried: true });
    expect(client.orders[0]!.status).toBe(
      RechargeOrderStatus.PAID,
    );
    expect(client.outboxRows[0]!.status).toBe("PROCESSED");
    expect(client.orderUpdateTransactionDepths).toHaveLength(0);
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

  it("persists provider code and Request-ID without persisting its message", async () => {
    const client = await clientWithClaimableOrder();
    const providerError = new WeChatPayProtocolError(
      "private provider detail must not be stored",
      {
        providerErrorCode: "NO_AUTH",
        providerHttpStatus: 403,
        providerRequestId: "wechat-request-123",
      },
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
      lastError:
        "WECHAT_PAY_PROTOCOL_ERROR|provider=NO_AUTH|request_id=wechat-request-123",
    });
    expect(JSON.stringify(client.outboxRows)).not.toContain(
      "private provider detail",
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

  it("continues processing existing orders while collection is paused", async () => {
    const client = await clientWithClaimableOrder();
    const queryOrder = vi.fn(async () => pendingQueryResult());

    const summary =
      await runWeChatPayOrderReconciliationTick({
        client,
        env: {
          DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "false",
          DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "true",
        },
        queryOrder,
        completePaidEvent: vi.fn(),
        limit: 1,
        now: () => databaseNow,
      });

    expect(summary).toMatchObject({
      enabled: true,
      claimed: 1,
      pending: 1,
      failed: 0,
    });
    expect(queryOrder).toHaveBeenCalledOnce();
    expect(client.outboxRows[0]).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
    });
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

async function clientWithCreatedOrder(createdAt: Date) {
  const client = new FakeReconciliationClient();
  client.addCreatedOrder("order-1", { createdAt });
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

function missingQueryResult() {
  return {
    status: "not_found" as const,
    tradeState: null,
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

function nativePreparedCheckoutPayload(
  orderId: string,
  expiresAt = "2026-07-27T12:00:00.000Z",
) {
  return {
    provider: "wechat_pay",
    appId: "wx-test",
    merchantId: "1900000109",
    rawPayload: {
      version: 1,
      mode: "native",
      appId: "wx-test",
      merchantId: "1900000109",
      description: "Delegate recharge",
      outTradeNo: orderId,
      expiresAt,
      notifyUrl:
        "https://delegate.example/api/payments/wechat/notify",
      amountCents: 2_000,
      currency: "CNY",
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
  providerOrderId: string | null;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  checkoutUrl: string | null;
  providerPayload: unknown;
  refundedAt: Date | null;
  createdAt: Date;
  userWallet: {
    externalUserId: string;
  };
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
      providerOrderId: id,
      amountCents: 2_000,
      currency: "CNY",
      idempotencyKey: `idempotency-${id}`,
      checkoutUrl: "weixin://wxpay/test",
      providerPayload,
      refundedAt: null,
      createdAt: new Date("2026-07-27T09:00:00.000Z"),
      userWallet: {
        externalUserId: `external-${id}`,
      },
    });
  }

  addCreatedOrder(
    id: string,
    input: {
      createdAt?: Date;
      providerPayload?: unknown;
    } = {},
  ) {
    this.orders.push({
      id,
      provider: PaymentProvider.WECHAT_PAY,
      status: RechargeOrderStatus.CREATED,
      providerOrderId: null,
      amountCents: 2_000,
      currency: "CNY",
      idempotencyKey: `idempotency-${id}`,
      checkoutUrl: null,
      providerPayload:
        input.providerPayload
        ?? nativePreparedCheckoutPayload(id),
      refundedAt: null,
      createdAt:
        input.createdAt
        ?? new Date("2026-07-27T09:59:00.000Z"),
      userWallet: {
        externalUserId: `external-${id}`,
      },
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
          && (
            typeof args.where.status === "object"
              ? args.where.status.in.includes(candidate.status)
              : candidate.status === args.where.status
          ),
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
