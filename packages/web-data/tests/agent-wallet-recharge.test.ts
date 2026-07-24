import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  assertMockRechargeMutationsEnabled,
  completeMockRechargeOrder,
  createMockRechargeOrder,
} from "../src/agent-wallet-recharge";

describe("agent wallet mock recharge", () => {
  it("disables mock recharge mutations in production", () => {
    expect(() =>
      assertMockRechargeMutationsEnabled({ NODE_ENV: "production" }),
    ).toThrow("disabled in production");
    expect(() =>
      assertMockRechargeMutationsEnabled({ NODE_ENV: "development" }),
    ).not.toThrow();
    expect(() =>
      assertMockRechargeMutationsEnabled({}),
    ).toThrow("production-like");
  });

  it("rejects direct mock recharge writes before touching storage in production", async () => {
    const client = new FakeRechargeClient();
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        createMockRechargeOrder(
          {
            externalUserId: "user_1",
            amountCents: 1200,
          },
          client,
        ),
      ).rejects.toThrow("disabled in production");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(client.userWallets).toHaveLength(0);
    expect(client.rechargeOrders).toHaveLength(0);
  });

  it("creates a mock recharge order idempotently", async () => {
    const client = new FakeRechargeClient();
    const first = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        displayName: "User One",
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(first.status).toBe("requires_payment");
    expect(client.rechargeOrders).toHaveLength(1);
    expect(client.userWallets[0]).toMatchObject({
      externalUserId: "user_1",
      cashBalanceCents: 0,
    });
  });

  it("rejects an idempotency key reused by another owner, amount, or currency", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "recharge_facts_bound",
      },
      client,
    );

    const mismatchedRequests = [
      {
          externalUserId: "user_2",
          amountCents: 1200,
          currency: "CNY",
          idempotencyKey: "recharge_facts_bound",
      },
      {
          externalUserId: "user_1",
          amountCents: 1201,
          currency: "CNY",
          idempotencyKey: "recharge_facts_bound",
      },
      {
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "USD",
          idempotencyKey: "recharge_facts_bound",
      },
    ];

    for (const request of mismatchedRequests) {
      await expect(
        createMockRechargeOrder(request, client),
      ).rejects.toThrow();
    }

    expect(client.rechargeOrders).toHaveLength(1);
    expect(client.userWallets).toHaveLength(1);
  });

  it("persists representative product intent and rejects cross-context replay", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        amountCents: 1200,
        idempotencyKey: "recharge_purchase_intent",
      },
      client,
    );

    expect(client.rechargeOrders[0]).toMatchObject({
      representativeId: "rep_1",
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
    });
    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          representativeId: "rep_other",
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1200,
          idempotencyKey: "recharge_purchase_intent",
        },
        client,
      ),
    ).rejects.toThrow("different representative");
  });

  it("does not collapse separate keyless same-amount recharge operations", async () => {
    const client = new FakeRechargeClient();
    const first = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
      },
      client,
    );

    expect(second.id).not.toBe(first.id);
    expect(client.rechargeOrders).toHaveLength(2);
  });

  it("attaches mock recharge wallets to an audience identity when provided", async () => {
    const client = new FakeRechargeClient();

    await createMockRechargeOrder(
      {
        externalUserId: "web:rep:aud_123",
        audienceIdentityId: "identity-1",
        amountCents: 1200,
        idempotencyKey: "recharge_identity_1_1200",
      },
      client,
    );

    expect(client.userWallets[0]).toMatchObject({
      externalUserId: "web:rep:aud_123",
      audienceIdentityId: "identity-1",
    });
  });

  it("reuses the audience identity wallet across changing payment external ids", async () => {
    const client = new FakeRechargeClient();

    const first = await createMockRechargeOrder(
      {
        externalUserId: "web:rep:aud_first",
        audienceIdentityId: "identity-1",
        amountCents: 1200,
        idempotencyKey: "recharge_identity_1_first",
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "web:rep:aud_second",
        audienceIdentityId: "identity-1",
        amountCents: 2400,
        idempotencyKey: "recharge_identity_1_second",
      },
      client,
    );

    expect(second.userWalletId).toBe(first.userWalletId);
    expect(second.externalUserId).toBe("web:rep:aud_first");
    expect(client.userWallets).toHaveLength(1);
    expect(client.identityLinks).toEqual([
      expect.objectContaining({
        audienceIdentityId: "identity-1",
        provider: "PAYMENT_EXTERNAL_USER",
        providerSubject: "web:rep:aud_first",
      }),
      expect.objectContaining({
        audienceIdentityId: "identity-1",
        provider: "PAYMENT_EXTERNAL_USER",
        providerSubject: "web:rep:aud_second",
      }),
    ]);
  });

  it("does not change the currency of an existing user wallet", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "recharge_cny",
      },
      client,
    );

    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "USD",
          idempotencyKey: "recharge_usd",
        },
        client,
      ),
    ).rejects.toThrow("currency cannot be changed");
    expect(client.userWallets[0]?.currency).toBe("CNY");
  });

  it("completes payment once and credits the user wallet ledger", async () => {
    const client = new FakeRechargeClient();
    const created = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );

    const paid = await completeMockRechargeOrder(created.id, {}, client);
    const paidAgain = await completeMockRechargeOrder(created.id, {}, client);

    expect(paid.status).toBe("paid");
    expect(paid.cashBalanceCents).toBe(1200);
    expect(paidAgain.cashBalanceCents).toBe(1200);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries[0]).toMatchObject({
      amountCents: 1200,
      currency: "CNY",
      idempotencyKey: `recharge:${created.id}:paid:user_cash_recharge`,
    });
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
  });

  it("rejects a mock payment with the wrong amount", async () => {
    const client = new FakeRechargeClient();
    const created = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_user_1_1200",
      },
      client,
    );

    await expect(
      completeMockRechargeOrder(created.id, { amountCents: 1000 }, client),
    ).rejects.toThrow("amount does not match");
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("does not allow a provider event id to be attached to another order", async () => {
    const client = new FakeRechargeClient();
    const first = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_first",
      },
      client,
    );
    const second = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        idempotencyKey: "recharge_second",
      },
      client,
    );

    await completeMockRechargeOrder(
      first.id,
      { providerEventId: "evt_bound_once" },
      client,
    );
    await expect(
      completeMockRechargeOrder(
        second.id,
        { providerEventId: "evt_bound_once" },
        client,
      ),
    ).rejects.toThrow("already attached to another");
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
  });

  it("rejects invalid recharge input", async () => {
    const client = new FakeRechargeClient();
    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "",
          amountCents: 1200,
        },
        client,
      ),
    ).rejects.toThrow("externalUserId");
    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          amountCents: 12.5,
        },
        client,
      ),
    ).rejects.toThrow("positive integer");
  });

  it("does not relabel an existing wallet into another currency", async () => {
    const client = new FakeRechargeClient();
    await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1200,
        currency: "CNY",
        idempotencyKey: "recharge_cny",
      },
      client,
    );

    await expect(
      createMockRechargeOrder(
        {
          externalUserId: "user_1",
          amountCents: 1200,
          currency: "USD",
          idempotencyKey: "recharge_usd",
        },
        client,
      ),
    ).rejects.toThrow("currency cannot be changed");
    expect(client.userWallets[0]?.currency).toBe("CNY");
  });
});

type UserWalletRow = {
  id: string;
  audienceIdentityId: string | null;
  externalUserId: string;
  telegramUserId: string | null;
  email: string | null;
  displayName: string | null;
  currency: string;
  cashBalanceCents: number;
};

type RechargeOrderRow = {
  id: string;
  userWalletId: string;
  representativeId: string | null;
  productCode: string | null;
  provider: PaymentProvider;
  providerOrderId: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  idempotencyKey: string;
  checkoutUrl: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  userWallet?: UserWalletRow;
};

type ProviderEventRow = {
  id: string;
  provider: PaymentProvider;
  providerEventId: string;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
  processedAt: Date | null;
};

type LedgerRow = {
  id: string;
  eventGroupId: string;
  idempotencyKey: string;
  accountType: AmnWalletAccountType;
  entryKind: AmnLedgerEntryKind;
  amountCents: number;
  tokenAmount: number;
  currency: string;
  transactionId: string | null;
  createdAt: Date;
};

type IdentityLinkRow = {
  id: string;
  audienceIdentityId: string;
  provider: string;
  providerSubject: string;
};

class FakeRechargeClient {
  userWallets: UserWalletRow[] = [];
  rechargeOrders: RechargeOrderRow[] = [];
  providerEvents: ProviderEventRow[] = [];
  ledgerEntries: LedgerRow[] = [];
  identityLinks: IdentityLinkRow[] = [];
  walletTransactions: any[] = [];

  userWallet = {
    findFirst: async (args: any) => {
      return (
        this.userWallets.find(
          (wallet) => wallet.audienceIdentityId === args.where.audienceIdentityId,
        ) ?? null
      );
    },
    upsert: async (args: any) => {
      const existing = this.userWallets.find(
        (wallet) => wallet.externalUserId === args.where.externalUserId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const wallet: UserWalletRow = {
        id: args.create.id ?? `user_wallet_${this.userWallets.length + 1}`,
        audienceIdentityId: args.create.audienceIdentityId ?? null,
        externalUserId: args.create.externalUserId,
        telegramUserId: args.create.telegramUserId ?? null,
        email: args.create.email ?? null,
        displayName: args.create.displayName ?? null,
        currency: args.create.currency ?? "CNY",
        cashBalanceCents: args.create.cashBalanceCents ?? 0,
      };
      this.userWallets.push(wallet);
      return wallet;
    },
    update: async (args: any) => {
      const wallet = this.userWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("wallet not found");
      }
      if (typeof args.data.cashBalanceCents?.increment === "number") {
        wallet.cashBalanceCents += args.data.cashBalanceCents.increment;
      }
      if (args.data.audienceIdentityId !== undefined) {
        wallet.audienceIdentityId = args.data.audienceIdentityId;
      }
      if (args.data.telegramUserId !== undefined) {
        wallet.telegramUserId = args.data.telegramUserId;
      }
      if (args.data.displayName !== undefined) {
        wallet.displayName = args.data.displayName;
      }
      if (args.data.currency !== undefined) {
        wallet.currency = args.data.currency;
      }
      return wallet;
    },
  };

  identityLink = {
    upsert: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const existing = this.identityLinks.find(
        (link) => link.provider === key.provider && link.providerSubject === key.providerSubject,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const link: IdentityLinkRow = {
        id: `identity_link_${this.identityLinks.length + 1}`,
        audienceIdentityId: args.create.audienceIdentityId,
        provider: args.create.provider,
        providerSubject: args.create.providerSubject,
      };
      this.identityLinks.push(link);
      return link;
    },
  };

  rechargeOrder = {
    findUnique: async (args: any) => {
      const order =
        typeof args.where.id === "string"
          ? this.rechargeOrders.find((row) => row.id === args.where.id)
          : this.rechargeOrders.find(
              (row) => row.idempotencyKey === args.where.idempotencyKey,
            );
      return order ? this.withUserWallet(order) : null;
    },
    create: async (args: any) => {
      const order: RechargeOrderRow = {
        id: args.data.id ?? `recharge_${this.rechargeOrders.length + 1}`,
        userWalletId: args.data.userWalletId,
        representativeId: args.data.representativeId ?? null,
        productCode: args.data.productCode ?? null,
        provider: args.data.provider,
        providerOrderId: args.data.providerOrderId ?? null,
        amountCents: args.data.amountCents,
        currency: args.data.currency,
        status: args.data.status,
        idempotencyKey: args.data.idempotencyKey,
        checkoutUrl: args.data.checkoutUrl ?? null,
        paidAt: null,
        refundedAt: null,
      };
      this.rechargeOrders.push(order);
      return order;
    },
    update: async (args: any) => {
      const order = this.rechargeOrders.find((row) => row.id === args.where.id);
      if (!order) {
        throw new Error("order not found");
      }
      Object.assign(order, args.data);
      return order;
    },
    updateMany: async (args: any) => {
      const order = this.rechargeOrders.find((row) => row.id === args.where.id);
      if (
        !order ||
        (args.where.provider && order.provider !== args.where.provider) ||
        (typeof args.where.amountCents === "number" &&
          order.amountCents !== args.where.amountCents) ||
        (args.where.currency && order.currency !== args.where.currency) ||
        (args.where.status && order.status !== args.where.status)
      ) {
        return { count: 0 };
      }
      Object.assign(order, args.data);
      return { count: 1 };
    },
  };

  paymentProviderEvent = {
    findUnique: async (args: any) => {
      const key = args.where.provider_providerEventId;
      return (
        this.providerEvents.find(
          (event) =>
            event.provider === key.provider && event.providerEventId === key.providerEventId,
        ) ?? null
      );
    },
    upsert: async (args: any) => {
      const key = args.where.provider_providerEventId;
      const existing = this.providerEvents.find(
        (event) =>
          event.provider === key.provider && event.providerEventId === key.providerEventId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const event: ProviderEventRow = {
        id: `provider_event_${this.providerEvents.length + 1}`,
        provider: args.create.provider,
        providerEventId: args.create.providerEventId,
        eventType: args.create.eventType,
        rechargeOrderId: args.create.rechargeOrderId ?? null,
        processedAt: args.create.processedAt ?? null,
      };
      this.providerEvents.push(event);
      return event;
    },
  };

  walletTransaction = {
    findUnique: async (args: any) =>
      this.walletTransactions.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey,
      ) ?? null,
    create: async (args: any) => {
      const row = {
        id: `wallet_transaction_${this.walletTransactions.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        sourceType: args.data.sourceType,
        sourceId: args.data.sourceId ?? null,
        eventType: args.data.eventType,
        status: args.data.status,
        currency: args.data.currency,
        ownerId: args.data.ownerId ?? null,
        representativeId: args.data.representativeId ?? null,
        userWalletId: args.data.userWalletId ?? null,
        metadata: args.data.metadata ?? null,
      };
      this.walletTransactions.push(row);
      return row;
    },
  };

  walletLedgerEntry = {
    findFirst: async (args: any) => {
      return (
        this.ledgerEntries.find(
          (entry) =>
            entry.eventGroupId === args.where.eventGroupId &&
            entry.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith),
        ) ?? null
      );
    },
    findMany: async (args: any) => {
      return this.ledgerEntries.filter((entry) => entry.eventGroupId === args.where.eventGroupId);
    },
    create: async (args: { data: Prisma.WalletLedgerEntryUncheckedCreateInput }) => {
      const entry: LedgerRow = {
        id: `ledger_${this.ledgerEntries.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        accountType: args.data.accountType,
        entryKind: args.data.entryKind,
        amountCents: args.data.amountCents ?? 0,
        tokenAmount: args.data.tokenAmount ?? 0,
        currency: args.data.currency ?? "CNY",
        transactionId: args.data.transactionId ?? null,
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, this.ledgerEntries.length)),
      };
      this.ledgerEntries.push(entry);
      return entry;
    },
  };

  async $transaction<T>(fn: (tx: FakeRechargeClient) => Promise<T>): Promise<T> {
    const userWallets = this.userWallets.map((row) => ({ ...row }));
    const rechargeOrders = this.rechargeOrders.map((row) => ({ ...row }));
    const providerEvents = this.providerEvents.map((row) => ({ ...row }));
    const ledgerEntries = this.ledgerEntries.map((row) => ({ ...row }));
    const identityLinks = this.identityLinks.map((row) => ({ ...row }));
    const walletTransactions = this.walletTransactions.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (error) {
      this.userWallets = userWallets;
      this.rechargeOrders = rechargeOrders;
      this.providerEvents = providerEvents;
      this.ledgerEntries = ledgerEntries;
      this.identityLinks = identityLinks;
      this.walletTransactions = walletTransactions;
      throw error;
    }
  }

  private withUserWallet(order: RechargeOrderRow): RechargeOrderRow {
    const userWallet = this.userWallets.find((wallet) => wallet.id === order.userWalletId);
    if (!userWallet) {
      return order;
    }
    return { ...order, userWallet };
  }
}

function sumLedgerAmount(entries: LedgerRow[]): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
