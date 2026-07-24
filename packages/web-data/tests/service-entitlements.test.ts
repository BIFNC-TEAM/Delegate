import {
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  createServicePaymentOrder,
  consumeServiceEntitlement,
  consumeConversationEntitlement,
  fulfillServicePaymentOrder,
  grantServiceEntitlement,
  releaseConversationEntitlement,
  releaseConversationEntitlementByGenerationRunId,
  refundServiceEntitlement,
  releaseServiceEntitlement,
  reserveConversationEntitlement,
  reserveServiceEntitlement,
  serviceEntitlementOperationKey,
  servicePaymentProviderOrderKey,
  type ServicePaymentEvidenceInput,
} from "../src/service-entitlements";

const coordinates = {
  audienceIdentityId: "audience_1",
  representativeId: "representative_1",
  productCode: "delegate_chat_credit",
};

describe("service entitlements", () => {
  it("grants once with a deterministic idempotency key", async () => {
    const client = new FakeServiceEntitlementClient();
    const input = {
      ...coordinates,
      units: 10,
      operationKey: "admin-grant-1",
    };

    const first = await grantServiceEntitlement(input, client);
    const second = await grantServiceEntitlement(input, client);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      grantedUnits: 10,
      remainingUnits: 10,
      reservedUnits: 0,
      ledgerKind: "GRANT",
      idempotencyKey: serviceEntitlementOperationKey(
        "GRANT",
        coordinates,
        "admin-grant-1",
      ),
    });
    expect(client.accounts).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(1);
  });

  it("rejects an idempotency key reused with different units", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      { ...coordinates, units: 10, operationKey: "same-operation" },
      client,
    );

    await expect(
      grantServiceEntitlement(
        { ...coordinates, units: 11, operationKey: "same-operation" },
        client,
      ),
    ).rejects.toThrow("reused with different immutable input");
    expect(client.accounts[0]?.remainingUnits).toBe(10);
    expect(client.ledgerEntries).toHaveLength(1);
  });

  it("atomically reserves, consumes, and releases units", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      { ...coordinates, units: 10, operationKey: "grant-10" },
      client,
    );

    const reserved = await reserveServiceEntitlement(
      { ...coordinates, units: 6, operationKey: "run-1-reserve" },
      client,
    );
    const consumed = await consumeServiceEntitlement(
      { ...coordinates, units: 4, operationKey: "run-1-consume" },
      client,
    );
    const released = await releaseServiceEntitlement(
      { ...coordinates, units: 2, operationKey: "run-1-release" },
      client,
    );

    expect(reserved).toMatchObject({ remainingUnits: 4, reservedUnits: 6 });
    expect(consumed).toMatchObject({ remainingUnits: 4, reservedUnits: 2 });
    expect(released).toMatchObject({
      status: "ACTIVE",
      remainingUnits: 6,
      reservedUnits: 0,
    });
    expect(client.ledgerEntries.map((entry) => entry.kind)).toEqual([
      "GRANT",
      "RESERVE",
      "CONSUME",
      "RELEASE",
    ]);
  });

  it("never allows available or reserved units to become negative", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      { ...coordinates, units: 5, operationKey: "grant-5" },
      client,
    );

    await expect(
      reserveServiceEntitlement(
        { ...coordinates, units: 6, operationKey: "reserve-too-much" },
        client,
      ),
    ).rejects.toThrow("Insufficient available");
    await reserveServiceEntitlement(
      { ...coordinates, units: 3, operationKey: "reserve-3" },
      client,
    );
    await expect(
      consumeServiceEntitlement(
        { ...coordinates, units: 4, operationKey: "consume-too-much" },
        client,
      ),
    ).rejects.toThrow("Insufficient reserved");
    await expect(
      releaseServiceEntitlement(
        { ...coordinates, units: 4, operationKey: "release-too-much" },
        client,
      ),
    ).rejects.toThrow("Insufficient reserved");

    expect(client.accounts[0]).toMatchObject({
      remainingUnits: 2,
      reservedUnits: 3,
    });
  });

  it("exhausts the account after the final reservation is consumed", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      { ...coordinates, units: 3, operationKey: "grant-3" },
      client,
    );
    await reserveServiceEntitlement(
      { ...coordinates, units: 3, operationKey: "reserve-3" },
      client,
    );

    const consumed = await consumeServiceEntitlement(
      { ...coordinates, units: 3, operationKey: "consume-3" },
      client,
    );

    expect(consumed).toMatchObject({
      status: "EXHAUSTED",
      remainingUnits: 0,
      reservedUnits: 0,
    });
  });

  it("shares one preferred paid reply across channel conversations", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      {
        ...coordinates,
        productCode: "plan:pass",
        units: 2,
        operationKey: "grant-pass",
      },
      client,
    );
    await grantServiceEntitlement(
      {
        ...coordinates,
        productCode: "plan:deep_help",
        units: 1,
        operationKey: "grant-deep",
      },
      client,
    );

    const first = await reserveConversationEntitlement(
      {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        generationRunId: "matrix-run-1",
      },
      client,
    );
    expect(first?.productCode).toBe("plan:deep_help");
    await consumeConversationEntitlement(first!, client);

    const second = await reserveConversationEntitlement(
      {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        generationRunId: "telegram-run-1",
      },
      client,
    );
    expect(second?.productCode).toBe("plan:pass");
    await releaseConversationEntitlement(second!, client);

    expect(
      client.accounts.find((account) => account.productCode === "plan:deep_help"),
    ).toMatchObject({
      remainingUnits: 0,
      reservedUnits: 0,
      status: "EXHAUSTED",
    });
    expect(
      client.accounts.find((account) => account.productCode === "plan:pass"),
    ).toMatchObject({
      remainingUnits: 2,
      reservedUnits: 0,
      status: "ACTIVE",
    });
  });

  it("can safely reserve again for the same run after a release", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      {
        ...coordinates,
        productCode: "plan:pass",
        units: 1,
        operationKey: "grant-pass",
      },
      client,
    );

    const first = await reserveConversationEntitlement(
      {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        generationRunId: "retry-run",
      },
      client,
    );
    await releaseConversationEntitlement(first!, client);
    const second = await reserveConversationEntitlement(
      {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        generationRunId: "retry-run",
      },
      client,
    );
    const consumed = await consumeConversationEntitlement(second!, client);

    expect(first).toMatchObject({ attempt: 1 });
    expect(second).toMatchObject({
      attempt: 2,
      accountId: first?.accountId,
    });
    expect(consumed).toMatchObject({
      remainingUnits: 0,
      reservedUnits: 0,
      status: "EXHAUSTED",
    });
    expect(client.ledgerEntries.map((entry) => entry.kind)).toEqual([
      "GRANT",
      "RESERVE",
      "RELEASE",
      "RESERVE",
      "CONSUME",
    ]);
  });

  it("recovers and releases a durable reservation after the worker loses its handle", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      {
        ...coordinates,
        productCode: "plan:pass",
        units: 1,
        operationKey: "grant-crash-recovery",
      },
      client,
    );
    await reserveConversationEntitlement(
      {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        generationRunId: "crashed-run",
      },
      client,
    );

    const released = await releaseConversationEntitlementByGenerationRunId(
      {
        generationRunId: "crashed-run",
        reason: "generation_canceled",
      },
      client,
    );
    const replay = await releaseConversationEntitlementByGenerationRunId(
      { generationRunId: "crashed-run" },
      client,
    );

    expect(released).toMatchObject({
      ledgerKind: "RELEASE",
      remainingUnits: 1,
      reservedUnits: 0,
    });
    expect(replay).toBeNull();
    expect(client.ledgerEntries.map((entry) => entry.kind)).toEqual([
      "GRANT",
      "RESERVE",
      "RELEASE",
    ]);
  });

  it("never releases a reservation that was already consumed", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      {
        ...coordinates,
        productCode: "plan:pass",
        units: 1,
        operationKey: "grant-consumed-recovery",
      },
      client,
    );
    const reservation = await reserveConversationEntitlement(
      {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        generationRunId: "consumed-run",
      },
      client,
    );
    await consumeConversationEntitlement(reservation!, client);

    await expect(
      releaseConversationEntitlementByGenerationRunId(
        { generationRunId: "consumed-run" },
        client,
      ),
    ).resolves.toBeNull();
    expect(client.accounts[0]).toMatchObject({
      remainingUnits: 0,
      reservedUnits: 0,
      status: "EXHAUSTED",
    });
    expect(client.ledgerEntries.map((entry) => entry.kind)).toEqual([
      "GRANT",
      "RESERVE",
      "CONSUME",
    ]);
  });

  it("keeps an active reservation valid when its account identity is transferred", async () => {
    const client = new FakeServiceEntitlementClient();
    await grantServiceEntitlement(
      {
        ...coordinates,
        productCode: "plan:pass",
        units: 1,
        operationKey: "grant-pass",
      },
      client,
    );
    const reservation = await reserveConversationEntitlement(
      {
        audienceIdentityId: coordinates.audienceIdentityId,
        representativeId: coordinates.representativeId,
        generationRunId: "merge-run",
      },
      client,
    );
    const account = client.accounts.find((row) => row.id === reservation?.accountId);
    account!.audienceIdentityId = "registered_audience";

    const consumed = await consumeConversationEntitlement(reservation!, client);

    expect(consumed).toMatchObject({
      accountId: reservation?.accountId,
      audienceIdentityId: "registered_audience",
      ledgerKind: "CONSUME",
    });
    await expect(
      releaseConversationEntitlement(reservation!, client),
    ).rejects.toThrow("already consumed");
  });
});

describe("service payment entitlement fulfillment", () => {
  it("creates an immutable provider order fact idempotently", async () => {
    const client = new FakeServiceEntitlementClient();
    const input = {
      id: "payment_order_new",
      payerAudienceIdentityId: coordinates.audienceIdentityId,
      representativeId: coordinates.representativeId,
      provider: PaymentProvider.TELEGRAM_STARS,
      providerAccountId: "123456789",
      providerOrderId: "invoice_1",
      productCode: "plan:pass",
      amountMinor: 50,
      currency: "XTR",
      entitlementUnits: 50,
      priceSnapshot: { stars: 50 },
    };

    const first = await createServicePaymentOrder(input, client);
    const second = await createServicePaymentOrder(input, client);

    expect(second).toEqual(first);
    expect(client.paymentOrders).toHaveLength(1);
    await expect(
      createServicePaymentOrder(
        {
          ...input,
          entitlementUnits: 51,
        },
        client,
      ),
    ).rejects.toThrow("reused with different immutable input");
  });

  it("validates a paid event and grants the order exactly once", async () => {
    const client = new FakeServiceEntitlementClient({
      paymentOrder: paymentOrder(),
    });
    const paidEvidence = paymentEvidence();

    const first = await fulfillServicePaymentOrder(paidEvidence, client);
    const second = await fulfillServicePaymentOrder(paidEvidence, client);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      paymentOrderId: "payment_order_1",
      paymentStatus: "PAID",
      amountMinor: 1200,
      currency: "CNY",
      entitlement: {
        grantedUnits: 12,
        remainingUnits: 12,
        ledgerKind: "GRANT",
      },
    });
    expect(client.paymentOrders[0]).toMatchObject({
      status: RechargeOrderStatus.PAID,
      fulfillmentKey: "service-payment:payment_order_1:fulfill",
    });
    expect(client.paymentEvents).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(1);
  });

  it.each([
    ["provider account", { providerAccountId: "wrong_account" }],
    ["provider order", { providerOrderId: "wrong_order" }],
    ["amount", { amountMinor: 1199 }],
    ["currency", { currency: "USD" }],
    ["payer", { payerAudienceIdentityId: "audience_2" }],
  ])("rejects mismatched %s evidence without granting", async (_label, overrides) => {
    const client = new FakeServiceEntitlementClient({
      paymentOrder: paymentOrder(),
    });

    await expect(
      fulfillServicePaymentOrder(
        { ...paymentEvidence(), ...overrides },
        client,
      ),
    ).rejects.toThrow("does not match order");
    expect(client.accounts).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
    expect(client.paymentOrders[0]?.status).toBe(
      RechargeOrderStatus.REQUIRES_PAYMENT,
    );
  });

  it("keeps Telegram Stars XTR separate from fiat rails", async () => {
    const starsClient = new FakeServiceEntitlementClient({
      paymentOrder: paymentOrder({
        provider: PaymentProvider.TELEGRAM_STARS,
        providerAccountId: "telegram_bot_1",
        providerOrderId: "stars_charge_1",
        providerOrderKey: servicePaymentProviderOrderKey({
          provider: PaymentProvider.TELEGRAM_STARS,
          providerAccountId: "telegram_bot_1",
          providerOrderId: "stars_charge_1",
        }),
        currency: "XTR",
      }),
    });

    await expect(
      fulfillServicePaymentOrder(
        paymentEvidence({
          provider: PaymentProvider.TELEGRAM_STARS,
          providerAccountId: "telegram_bot_1",
          providerOrderId: "stars_charge_1",
          currency: "CNY",
        }),
        starsClient,
      ),
    ).rejects.toThrow("must use XTR");

    const fiatClient = new FakeServiceEntitlementClient({
      paymentOrder: paymentOrder({
        currency: "XTR",
      }),
    });
    await expect(
      fulfillServicePaymentOrder(
        paymentEvidence({ currency: "XTR" }),
        fiatClient,
      ),
    ).rejects.toThrow("cannot be fulfilled or refunded by a fiat");
  });

  it("refunds only the original order and only once", async () => {
    const client = new FakeServiceEntitlementClient({
      paymentOrder: paymentOrder(),
    });
    await fulfillServicePaymentOrder(paymentEvidence(), client);
    const refundEvidence = paymentEvidence({
      providerEventId: "stripe_event_refund_1",
    });

    const first = await refundServiceEntitlement(refundEvidence, client);
    const second = await refundServiceEntitlement(refundEvidence, client);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      paymentStatus: "REFUNDED",
      entitlement: {
        remainingUnits: 0,
        reservedUnits: 0,
        status: "EXHAUSTED",
        ledgerKind: "REFUND",
        units: 12,
      },
    });
    expect(client.paymentOrders[0]?.status).toBe(RechargeOrderStatus.REFUNDED);
    expect(client.ledgerEntries.map((entry) => entry.kind)).toEqual([
      "GRANT",
      "REFUND",
    ]);
    expect(client.paymentEvents).toHaveLength(2);
  });

  it("does not allow a paid provider event id to be reused as a refund", async () => {
    const client = new FakeServiceEntitlementClient({
      paymentOrder: paymentOrder(),
    });
    const evidence = paymentEvidence();
    await fulfillServicePaymentOrder(evidence, client);

    await expect(
      refundServiceEntitlement(evidence, client),
    ).rejects.toThrow("reused for a different payment event type");
    expect(client.paymentOrders[0]?.status).toBe(RechargeOrderStatus.PAID);
    expect(client.accounts[0]?.remainingUnits).toBe(12);
  });

  it("rolls back a refund when granted units are reserved or consumed", async () => {
    const client = new FakeServiceEntitlementClient({
      paymentOrder: paymentOrder(),
    });
    await fulfillServicePaymentOrder(paymentEvidence(), client);
    await reserveServiceEntitlement(
      { ...coordinates, units: 1, operationKey: "reserve-before-refund" },
      client,
    );

    await expect(
      refundServiceEntitlement(
        paymentEvidence({ providerEventId: "stripe_event_refund_blocked" }),
        client,
      ),
    ).rejects.toThrow("requires all granted units to remain available");

    expect(client.paymentOrders[0]).toMatchObject({
      status: RechargeOrderStatus.PAID,
      refundedAt: null,
    });
    expect(client.accounts[0]).toMatchObject({
      remainingUnits: 11,
      reservedUnits: 1,
    });
    expect(client.paymentEvents).toHaveLength(1);
    expect(client.ledgerEntries.map((entry) => entry.kind)).toEqual([
      "GRANT",
      "RESERVE",
    ]);
  });
});

type EntitlementAccountRow = {
  id: string;
  audienceIdentityId: string;
  representativeId: string;
  productCode: string;
  unitName: string;
  status: "ACTIVE" | "FROZEN" | "EXHAUSTED" | "EXPIRED";
  grantedUnits: number;
  remainingUnits: number;
  reservedUnits: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type EntitlementLedgerRow = {
  id: string;
  entitlementAccountId: string;
  paymentOrderId: string | null;
  generationRunId: string | null;
  kind: "GRANT" | "RESERVE" | "CONSUME" | "RELEASE" | "REFUND";
  units: number;
  balanceAfter: number;
  reservedAfter: number;
  idempotencyKey: string;
  notes: string | null;
  metadata: unknown;
  createdAt: Date;
};

type PaymentOrderRow = {
  id: string;
  payerAudienceIdentityId: string;
  representativeId: string;
  provider: PaymentProvider;
  providerAccountId: string;
  providerOrderId: string | null;
  providerOrderKey: string | null;
  productCode: string;
  amountMinor: number;
  currency: string;
  entitlementUnits: number;
  priceSnapshot: unknown;
  checkoutUrl: string | null;
  providerPayload: unknown;
  status: RechargeOrderStatus;
  fulfillmentKey: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
};

type PaymentEventRow = {
  id: string;
  paymentOrderId: string | null;
  provider: PaymentProvider;
  providerAccountId: string;
  providerEventId: string;
  eventType: PaymentProviderEventType;
  verifiedAt: Date | null;
  rawPayload: unknown;
  normalizedPayload: unknown;
  processedAt: Date | null;
  receivedAt: Date;
};

class FakeServiceEntitlementClient {
  accounts: EntitlementAccountRow[] = [];
  ledgerEntries: EntitlementLedgerRow[] = [];
  paymentOrders: PaymentOrderRow[];
  paymentEvents: PaymentEventRow[] = [];
  private sequence = 0;

  constructor(options: { paymentOrder?: PaymentOrderRow } = {}) {
    this.paymentOrders = options.paymentOrder ? [options.paymentOrder] : [];
  }

  serviceEntitlementAccount = {
    findUnique: async (args: any) => {
      if (typeof args.where.id === "string") {
        return this.accounts.find((row) => row.id === args.where.id) ?? null;
      }
      const key = args.where.audienceIdentityId_representativeId_productCode;
      return (
        this.accounts.find(
          (row) =>
            row.audienceIdentityId === key.audienceIdentityId &&
            row.representativeId === key.representativeId &&
            row.productCode === key.productCode,
        ) ?? null
      );
    },
    upsert: async (args: any) => {
      const key = args.where.audienceIdentityId_representativeId_productCode;
      const existing = this.accounts.find(
        (row) =>
          row.audienceIdentityId === key.audienceIdentityId &&
          row.representativeId === key.representativeId &&
          row.productCode === key.productCode,
      );
      if (existing) {
        applyData(existing, args.update);
        return existing;
      }
      const now = new Date();
      const created: EntitlementAccountRow = {
        id: this.id("entitlement_account"),
        ...args.create,
        createdAt: now,
        updatedAt: now,
      };
      this.accounts.push(created);
      return created;
    },
    update: async (args: any) => {
      const row = this.accounts.find((account) => account.id === args.where.id);
      if (!row) {
        throw new Error("fake entitlement account not found");
      }
      applyData(row, args.data);
      row.updatedAt = new Date();
      return row;
    },
    updateMany: async (args: any) => {
      const rows = this.accounts.filter((row) => matchesWhere(row, args.where));
      for (const row of rows) {
        applyData(row, args.data);
        row.updatedAt = new Date();
      }
      return { count: rows.length };
    },
  };

  serviceEntitlementLedgerEntry = {
    findUnique: async (args: any) =>
      this.ledgerEntries.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey,
      ) ?? null,
    findMany: async (args: any) =>
      this.ledgerEntries.filter((row) => matchesWhere(row, args.where)),
    create: async (args: any) => {
      if (
        this.ledgerEntries.some(
          (row) => row.idempotencyKey === args.data.idempotencyKey,
        )
      ) {
        throw new Error("fake unique entitlement ledger violation");
      }
      const row: EntitlementLedgerRow = {
        id: this.id("entitlement_ledger"),
        paymentOrderId: null,
        generationRunId: null,
        notes: null,
        metadata: null,
        createdAt: new Date(),
        ...args.data,
      };
      this.ledgerEntries.push(row);
      return row;
    },
  };

  servicePaymentOrder = {
    findUnique: async (args: any) => {
      if (typeof args.where.id === "string") {
        return this.paymentOrders.find((row) => row.id === args.where.id) ?? null;
      }
      if (typeof args.where.providerOrderKey === "string") {
        return (
          this.paymentOrders.find(
            (row) => row.providerOrderKey === args.where.providerOrderKey,
          ) ?? null
        );
      }
      return null;
    },
    findFirst: async (args: any) =>
      this.paymentOrders.find((row) => matchesWhere(row, args.where)) ?? null,
    create: async (args: any) => {
      if (
        this.paymentOrders.some(
          (row) =>
            row.id === args.data.id ||
            row.providerOrderKey === args.data.providerOrderKey,
        )
      ) {
        throw new Error("fake unique service payment order violation");
      }
      const row: PaymentOrderRow = {
        checkoutUrl: null,
        providerPayload: null,
        fulfillmentKey: null,
        paidAt: null,
        refundedAt: null,
        ...args.data,
      };
      this.paymentOrders.push(row);
      return row;
    },
    updateMany: async (args: any) => {
      const rows = this.paymentOrders.filter((row) =>
        matchesWhere(row, args.where),
      );
      for (const row of rows) {
        applyData(row, args.data);
      }
      return { count: rows.length };
    },
  };

  servicePaymentEvent = {
    findUnique: async (args: any) => {
      const key = args.where.provider_providerAccountId_providerEventId;
      return (
        this.paymentEvents.find(
          (row) =>
            row.provider === key.provider &&
            row.providerAccountId === key.providerAccountId &&
            row.providerEventId === key.providerEventId,
        ) ?? null
      );
    },
    create: async (args: any) => {
      const row: PaymentEventRow = {
        id: this.id("payment_event"),
        paymentOrderId: null,
        verifiedAt: null,
        normalizedPayload: null,
        processedAt: null,
        receivedAt: new Date(),
        ...args.data,
      };
      this.paymentEvents.push(row);
      return row;
    },
    update: async (args: any) => {
      const row = this.paymentEvents.find((event) => event.id === args.where.id);
      if (!row) {
        throw new Error("fake payment event not found");
      }
      applyData(row, args.data);
      return row;
    },
  };

  $transaction = async <T>(
    fn: (tx: FakeServiceEntitlementClient) => Promise<T>,
    _options?: { isolationLevel?: "Serializable" },
  ) => {
    const snapshot = structuredClone({
      accounts: this.accounts,
      ledgerEntries: this.ledgerEntries,
      paymentOrders: this.paymentOrders,
      paymentEvents: this.paymentEvents,
      sequence: this.sequence,
    });
    try {
      return await fn(this);
    } catch (error) {
      this.accounts = snapshot.accounts;
      this.ledgerEntries = snapshot.ledgerEntries;
      this.paymentOrders = snapshot.paymentOrders;
      this.paymentEvents = snapshot.paymentEvents;
      this.sequence = snapshot.sequence;
      throw error;
    }
  };

  private id(prefix: string) {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
}

function paymentOrder(
  overrides: Partial<PaymentOrderRow> = {},
): PaymentOrderRow {
  const base = {
    id: "payment_order_1",
    payerAudienceIdentityId: coordinates.audienceIdentityId,
    representativeId: coordinates.representativeId,
    provider: PaymentProvider.STRIPE,
    providerAccountId: "stripe_account_1",
    providerOrderId: "stripe_order_1",
    productCode: coordinates.productCode,
    amountMinor: 1200,
    currency: "CNY",
    entitlementUnits: 12,
    priceSnapshot: { amountMinor: 1200, currency: "CNY" },
    checkoutUrl: null,
    providerPayload: null,
    status: RechargeOrderStatus.REQUIRES_PAYMENT,
    fulfillmentKey: null,
    paidAt: null,
    refundedAt: null,
  } satisfies Omit<PaymentOrderRow, "providerOrderKey">;
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    providerOrderKey:
      overrides.providerOrderKey ??
      servicePaymentProviderOrderKey({
        provider: merged.provider,
        providerAccountId: merged.providerAccountId,
        providerOrderId: merged.providerOrderId!,
      }),
  };
}

function paymentEvidence(
  overrides: Partial<ServicePaymentEvidenceInput> = {},
): ServicePaymentEvidenceInput {
  return {
    ...paymentEvidenceBase(),
    ...overrides,
  };
}

function paymentEvidenceBase() {
  return {
    paymentOrderId: "payment_order_1",
    provider: PaymentProvider.STRIPE,
    providerAccountId: "stripe_account_1",
    providerOrderId: "stripe_order_1",
    providerEventId: "stripe_event_paid_1",
    payerAudienceIdentityId: coordinates.audienceIdentityId,
    amountMinor: 1200,
    currency: "CNY",
    verifiedAt: new Date("2026-07-23T00:00:00.000Z"),
    rawPayload: { verified: true },
  };
}

function matchesWhere(row: Record<string, any>, where: Record<string, any>) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return expected.some((branch: Record<string, any>) =>
        matchesWhere(row, branch),
      );
    }
    const actual = row[key];
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date)
    ) {
      if ("in" in expected) {
        return expected.in.includes(actual);
      }
      if ("gte" in expected && !(actual >= expected.gte)) {
        return false;
      }
      if ("gt" in expected && !(actual > expected.gt)) {
        return false;
      }
      return true;
    }
    return actual === expected;
  });
}

function applyData(row: Record<string, any>, data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      ("increment" in value || "decrement" in value)
    ) {
      row[key] += value.increment ?? 0;
      row[key] -= value.decrement ?? 0;
    } else {
      row[key] = value;
    }
  }
}
