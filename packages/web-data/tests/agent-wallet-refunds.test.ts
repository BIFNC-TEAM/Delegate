import {
  AgentTokenPurchaseStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  refundRechargeOrder,
  reverseAgentTokenPurchase,
} from "../src/agent-wallet-refunds";

describe("agent wallet refunds and reversals", () => {
  it("refunds a paid recharge once and debits user cash", async () => {
    const client = new FakeRefundClient();

    const refunded = await refundRechargeOrder(
      "recharge_1",
      { providerEventId: "refund_evt_1" },
      client,
    );
    const refundedAgain = await refundRechargeOrder("recharge_1", {}, client);

    expect(refunded).toMatchObject({
      rechargeOrderId: "recharge_1",
      status: "refunded",
      amountCents: 1200,
      cashBalanceCents: 0,
      paymentProviderEventId: "provider_event_1",
    });
    expect(refundedAgain.status).toBe("refunded");
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
    expect(client.rechargeOrders[0]?.status).toBe(RechargeOrderStatus.REFUNDED);
    expect(client.providerEvents).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);
    expect(client.ledgerEntries[0]).toMatchObject({
      accountType: AmnWalletAccountType.USER_CASH,
      entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
      amountCents: -1200,
    });
  });

  it("rejects recharge refund when cash has already been spent", async () => {
    const client = new FakeRefundClient({
      userCashBalanceCents: 200,
    });

    await expect(refundRechargeOrder("recharge_1", {}, client)).rejects.toThrow(
      "unspent user wallet cash",
    );
    expect(client.rechargeOrders[0]?.status).toBe(RechargeOrderStatus.PAID);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(200);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("reverses an unconsumed token purchase and removes creator pending share", async () => {
    const client = new FakeRefundClient({
      userCashBalanceCents: 200,
    });

    const reversal = await reverseAgentTokenPurchase(
      "purchase_1",
      { reason: "user_request", idempotencyKey: "reversal_1" },
      client,
    );
    const reversedAgain = await reverseAgentTokenPurchase(
      "purchase_1",
      { idempotencyKey: "reversal_1" },
      client,
    );
    await expect(
      reverseAgentTokenPurchase(
        "purchase_1",
        { tokenAmount: 999, idempotencyKey: "reversal_1" },
        client,
      ),
    ).rejects.toThrow("Idempotency key was already used");

    expect(reversal).toMatchObject({
      purchaseId: "purchase_1",
      status: "reversed",
      amountCents: 1000,
      tokenAmount: 1000,
      remainingTokenAmount: 0,
      reversedAmountCents: 1000,
      cashBalanceCents: 1200,
      agentTokenBalance: 0,
      creatorReversedCents: 200,
    });
    expect(reversedAgain.status).toBe("reversed");
    expect(client.agentWallets[0]).toMatchObject({
      tokenBalance: 0,
      totalPurchasedTokens: 0,
    });
    expect(client.creatorEarnings[0]).toMatchObject({
      status: CreatorEarningStatus.REVERSED,
      pendingCents: 0,
    });
    expect(client.ledgerEntries.slice(-4)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: AmnWalletAccountType.USER_CASH,
          amountCents: 1000,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
          tokenAmount: -1000,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_PENDING,
          amountCents: -200,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.PLATFORM_DEFERRED_REVENUE,
          amountCents: -800,
        }),
      ]),
    );
  });

  it("refunds only the unconsumed remainder after partial usage", async () => {
    const client = new FakeRefundClient({
      agentTokenBalance: 500,
    });

    await expect(
      reverseAgentTokenPurchase(
        "purchase_1",
        { tokenAmount: 501, idempotencyKey: "too_much" },
        client,
      ),
    ).rejects.toThrow("unconsumed service credits");

    const reversal = await reverseAgentTokenPurchase(
      "purchase_1",
      { idempotencyKey: "remaining_refund" },
      client,
    );

    expect(reversal).toMatchObject({
      status: "refunded",
      tokenAmount: 500,
      remainingTokenAmount: 0,
      reversedAmountCents: 500,
      creatorReversedCents: 100,
      cashBalanceCents: 1700,
    });
    expect(client.agentWallets[0]?.tokenBalance).toBe(0);
    expect(client.userAgentWallets[0]?.availableTokenAmount).toBe(0);
  });

  it("rejects a reversal when the purchase has no unconsumed credits", async () => {
    const client = new FakeRefundClient({
      agentTokenBalance: 0,
    });

    await expect(
      reverseAgentTokenPurchase(
        "purchase_1",
        { idempotencyKey: "fully_consumed_refund" },
        client,
      ),
    ).rejects.toThrow("tokenAmount must be a positive integer");
    expect(client.walletTransactions).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.tokenPurchases[0]).toMatchObject({
      remainingTokenAmount: 0,
      status: AgentTokenPurchaseStatus.COMPLETED,
    });
  });
});

type UserWalletRow = {
  id: string;
  externalUserId: string;
  currency: string;
  cashBalanceCents: number;
};

type AgentWalletRow = {
  id: string;
  representativeId: string;
  currency: string;
  tokenBalance: number;
  totalPurchasedTokens: number;
  totalConsumedTokens: number;
};

type UserAgentWalletRow = {
  id: string;
  userWalletId: string;
  agentWalletId: string;
  currency: string;
  availableTokenAmount: number;
  reservedTokenAmount: number;
  totalPurchasedTokenAmount: number;
  totalConsumedTokenAmount: number;
};

type RechargeOrderRow = {
  id: string;
  userWalletId: string;
  provider: PaymentProvider;
  providerOrderId: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  refundedAt: Date | null;
  userWallet?: UserWalletRow;
};

type ProviderEventRow = {
  id: string;
  provider: PaymentProvider;
  providerEventId: string;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
};

type TokenPurchaseRow = {
  id: string;
  userWalletId: string;
  userAgentWalletId: string | null;
  agentWalletId: string;
  representativeId: string;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  remainingTokenAmount: number | null;
  tokenUnitPriceCents: number;
  creatorPendingCents: number;
  status: AgentTokenPurchaseStatus;
  idempotencyKey: string;
  refundedAt: Date | null;
  userWallet?: UserWalletRow;
  userAgentWallet?: UserAgentWalletRow;
  agentWallet?: AgentWalletRow;
  creatorEarnings?: CreatorEarningRow[];
};

type CreatorEarningRow = {
  id: string;
  ownerId: string;
  representativeId: string;
  agentWalletId: string;
  tokenPurchaseId: string | null;
  status: CreatorEarningStatus;
  pendingCents: number;
  withdrawableCents: number;
  currency: string;
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

class FakeRefundClient {
  userWallets: UserWalletRow[];
  agentWallets: AgentWalletRow[];
  userAgentWallets: UserAgentWalletRow[];
  rechargeOrders: RechargeOrderRow[];
  providerEvents: ProviderEventRow[] = [];
  tokenPurchases: TokenPurchaseRow[];
  creatorEarnings: CreatorEarningRow[];
  ledgerEntries: LedgerRow[] = [];
  walletTransactions: any[] = [];

  constructor(
    options: {
      userCashBalanceCents?: number;
      agentTokenBalance?: number;
    } = {},
  ) {
    this.userWallets = [
      {
        id: "user_wallet_1",
        externalUserId: "user_1",
        currency: "CNY",
        cashBalanceCents: options.userCashBalanceCents ?? 1200,
      },
    ];
    this.agentWallets = [
      {
        id: "agent_wallet_1",
        representativeId: "rep_1",
        currency: "CNY",
        tokenBalance: options.agentTokenBalance ?? 1000,
        totalPurchasedTokens: 1000,
        totalConsumedTokens: 1000 - (options.agentTokenBalance ?? 1000),
      },
    ];
    this.userAgentWallets = [
      {
        id: "user_agent_wallet_1",
        userWalletId: "user_wallet_1",
        agentWalletId: "agent_wallet_1",
        currency: "CNY",
        availableTokenAmount: options.agentTokenBalance ?? 1000,
        reservedTokenAmount: 0,
        totalPurchasedTokenAmount: 1000,
        totalConsumedTokenAmount: 1000 - (options.agentTokenBalance ?? 1000),
      },
    ];
    this.rechargeOrders = [
      {
        id: "recharge_1",
        userWalletId: "user_wallet_1",
        provider: PaymentProvider.MOCK,
        providerOrderId: "mock_recharge_1",
        amountCents: 1200,
        currency: "CNY",
        status: RechargeOrderStatus.PAID,
        refundedAt: null,
      },
    ];
    this.tokenPurchases = [
      {
        id: "purchase_1",
        userWalletId: "user_wallet_1",
        userAgentWalletId: "user_agent_wallet_1",
        agentWalletId: "agent_wallet_1",
        representativeId: "rep_1",
        amountCents: 1000,
        currency: "CNY",
        tokenAmount: 1000,
        remainingTokenAmount: options.agentTokenBalance ?? 1000,
        tokenUnitPriceCents: 1,
        creatorPendingCents: 200,
        status: AgentTokenPurchaseStatus.COMPLETED,
        idempotencyKey: "purchase_1_key",
        refundedAt: null,
      },
    ];
    this.creatorEarnings = [
      {
        id: "earning_pending_1",
        ownerId: "owner_1",
        representativeId: "rep_1",
        agentWalletId: "agent_wallet_1",
        tokenPurchaseId: "purchase_1",
        status: CreatorEarningStatus.PENDING,
        pendingCents: (options.agentTokenBalance ?? 1000) / 5,
        withdrawableCents: 0,
        currency: "CNY",
      },
    ];
  }

  userWallet = {
    update: async (args: any) => {
      const wallet = this.userWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("user wallet not found");
      }
      if (typeof args.data.cashBalanceCents?.increment === "number") {
        wallet.cashBalanceCents += args.data.cashBalanceCents.increment;
      }
      if (typeof args.data.cashBalanceCents?.decrement === "number") {
        wallet.cashBalanceCents -= args.data.cashBalanceCents.decrement;
      }
      return wallet;
    },
  };

  agentWallet = {
    update: async (args: any) => {
      const wallet = this.agentWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("agent wallet not found");
      }
      if (typeof args.data.tokenBalance?.decrement === "number") {
        wallet.tokenBalance -= args.data.tokenBalance.decrement;
      }
      if (typeof args.data.totalPurchasedTokens?.decrement === "number") {
        wallet.totalPurchasedTokens -= args.data.totalPurchasedTokens.decrement;
      }
      return wallet;
    },
  };

  userAgentWallet = {
    update: async (args: any) => {
      const wallet = this.userAgentWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("user-agent wallet not found");
      }
      applyDelta(wallet, "availableTokenAmount", args.data.availableTokenAmount);
      applyDelta(
        wallet,
        "totalPurchasedTokenAmount",
        args.data.totalPurchasedTokenAmount,
      );
      return wallet;
    },
  };

  rechargeOrder = {
    findUnique: async (args: any) => {
      const order = this.rechargeOrders.find((row) => row.id === args.where.id);
      return order ? this.withRechargeRelations(order) : null;
    },
    update: async (args: any) => {
      const order = this.rechargeOrders.find((row) => row.id === args.where.id);
      if (!order) {
        throw new Error("recharge order not found");
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
        return existing;
      }
      const event: ProviderEventRow = {
        id: `provider_event_${this.providerEvents.length + 1}`,
        provider: args.create.provider,
        providerEventId: args.create.providerEventId,
        eventType: args.create.eventType,
        rechargeOrderId: args.create.rechargeOrderId ?? null,
      };
      this.providerEvents.push(event);
      return event;
    },
  };

  agentTokenPurchase = {
    findUnique: async (args: any) => {
      const purchase = this.tokenPurchases.find((row) => row.id === args.where.id);
      return purchase ? this.withPurchaseRelations(purchase) : null;
    },
    update: async (args: any) => {
      const purchase = this.tokenPurchases.find((row) => row.id === args.where.id);
      if (!purchase) {
        throw new Error("purchase not found");
      }
      applyDelta(
        purchase,
        "remainingTokenAmount",
        args.data.remainingTokenAmount,
      );
      if (args.data.status) purchase.status = args.data.status;
      if (args.data.refundedAt) purchase.refundedAt = args.data.refundedAt;
      return purchase;
    },
  };

  creatorEarning = {
    findFirst: async (args: any) => {
      return (
        this.creatorEarnings.find((earning) => {
          if (earning.tokenPurchaseId !== args.where.tokenPurchaseId) {
            return false;
          }
          if (earning.status !== args.where.status) {
            return false;
          }
          return earning.pendingCents > args.where.pendingCents.gt;
        }) ?? null
      );
    },
    update: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (!earning) {
        throw new Error("creator earning not found");
      }
      applyDelta(earning, "pendingCents", args.data.pendingCents);
      if (args.data.status) earning.status = args.data.status;
      return earning;
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
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, this.ledgerEntries.length)),
      };
      this.ledgerEntries.push(entry);
      return entry;
    },
  };

  async $transaction<T>(fn: (tx: FakeRefundClient) => Promise<T>): Promise<T> {
    const userWallets = this.userWallets.map((row) => ({ ...row }));
    const agentWallets = this.agentWallets.map((row) => ({ ...row }));
    const userAgentWallets = this.userAgentWallets.map((row) => ({ ...row }));
    const rechargeOrders = this.rechargeOrders.map((row) => ({ ...row }));
    const providerEvents = this.providerEvents.map((row) => ({ ...row }));
    const tokenPurchases = this.tokenPurchases.map((row) => ({ ...row }));
    const creatorEarnings = this.creatorEarnings.map((row) => ({ ...row }));
    const ledgerEntries = this.ledgerEntries.map((row) => ({ ...row }));
    const walletTransactions = this.walletTransactions.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (error) {
      this.userWallets = userWallets;
      this.agentWallets = agentWallets;
      this.userAgentWallets = userAgentWallets;
      this.rechargeOrders = rechargeOrders;
      this.providerEvents = providerEvents;
      this.tokenPurchases = tokenPurchases;
      this.creatorEarnings = creatorEarnings;
      this.ledgerEntries = ledgerEntries;
      this.walletTransactions = walletTransactions;
      throw error;
    }
  }

  private withRechargeRelations(order: RechargeOrderRow): RechargeOrderRow {
    const userWallet = this.userWallets.find((wallet) => wallet.id === order.userWalletId);
    return userWallet ? { ...order, userWallet } : order;
  }

  private withPurchaseRelations(purchase: TokenPurchaseRow): TokenPurchaseRow {
    const userWallet = this.userWallets.find((wallet) => wallet.id === purchase.userWalletId);
    const agentWallet = this.agentWallets.find(
      (wallet) => wallet.id === purchase.agentWalletId,
    );
    const userAgentWallet = this.userAgentWallets.find(
      (wallet) => wallet.id === purchase.userAgentWalletId,
    );
    return {
      ...purchase,
      ...(userWallet ? { userWallet } : {}),
      ...(agentWallet ? { agentWallet } : {}),
      ...(userAgentWallet ? { userAgentWallet } : {}),
      creatorEarnings: this.creatorEarnings.filter(
        (earning) => earning.tokenPurchaseId === purchase.id,
      ),
    };
  }
}

function applyDelta<T extends Record<K, number | null>, K extends keyof T>(
  row: T,
  key: K,
  value: { increment?: number; decrement?: number } | number | undefined,
) {
  if (typeof value === "number") {
    row[key] = value as T[K];
    return;
  }
  if (value) {
    row[key] = (
      (row[key] ?? 0) +
      (value.increment ?? 0) -
      (value.decrement ?? 0)
    ) as T[K];
  }
}
