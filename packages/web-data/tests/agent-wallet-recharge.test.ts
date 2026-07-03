import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  completeMockRechargeOrder,
  createMockRechargeOrder,
} from "../src/agent-wallet-recharge";

describe("agent wallet mock recharge", () => {
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
    expect(client.ledgerEntries).toHaveLength(1);
    expect(client.ledgerEntries[0]).toMatchObject({
      amountCents: 1200,
      currency: "CNY",
      idempotencyKey: `recharge:${created.id}:paid:user_cash_recharge`,
    });
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
  createdAt: Date;
};

class FakeRechargeClient {
  userWallets: UserWalletRow[] = [];
  rechargeOrders: RechargeOrderRow[] = [];
  providerEvents: ProviderEventRow[] = [];
  ledgerEntries: LedgerRow[] = [];

  userWallet = {
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
      return wallet;
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
  };

  paymentProviderEvent = {
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
    try {
      return await fn(this);
    } catch (error) {
      this.userWallets = userWallets;
      this.rechargeOrders = rechargeOrders;
      this.providerEvents = providerEvents;
      this.ledgerEntries = ledgerEntries;
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
