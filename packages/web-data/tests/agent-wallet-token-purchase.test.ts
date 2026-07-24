import {
  AgentTokenPurchaseStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { purchaseAgentTokens } from "../src/agent-wallet-token-purchase";

describe("agent wallet token purchase", () => {
  it("moves user cash into agent tokens and creator pending earning", async () => {
    const client = new FakeTokenPurchaseClient();

    const purchase = await purchaseAgentTokens(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        amountCents: 1000,
        idempotencyKey: "purchase_user_1_rep_1_1000",
      },
      client,
    );

    expect(purchase).toMatchObject({
      amountCents: 1000,
      tokenAmount: 1000,
      remainingTokenAmount: 1000,
      creatorPendingCents: 200,
      cashBalanceCents: 200,
      agentTokenBalance: 1000,
      availableTokenAmount: 1000,
      status: "completed",
    });
    expect(client.userWallets[0]?.cashBalanceCents).toBe(200);
    expect(client.agentWallets[0]?.tokenBalance).toBe(1000);
    expect(client.creatorEarnings[0]).toMatchObject({
      ownerId: "owner_1",
      pendingCents: 200,
      status: CreatorEarningStatus.PENDING,
    });
    expect(client.ledgerEntries).toHaveLength(4);
    expect(client.walletTransactions).toHaveLength(1);
    expect(
      client.ledgerEntries.every(
        (entry) => entry.transactionId === client.walletTransactions[0]?.id,
      ),
    ).toBe(true);
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
    expect(client.ledgerEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: AmnWalletAccountType.USER_CASH,
          entryKind: AmnLedgerEntryKind.USER_CASH_DEBIT,
          amountCents: -1000,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
          entryKind: AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
          tokenAmount: 1000,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_PENDING,
          amountCents: 200,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.PLATFORM_DEFERRED_REVENUE,
          amountCents: 800,
        }),
      ]),
    );
  });

  it("is idempotent for repeated purchase requests", async () => {
    const client = new FakeTokenPurchaseClient();
    const input = {
      externalUserId: "user_1",
      representativeId: "rep_1",
      amountCents: 1000,
      idempotencyKey: "purchase_once",
    };

    const first = await purchaseAgentTokens(input, client);
    const second = await purchaseAgentTokens(input, client);

    expect(second.id).toBe(first.id);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(200);
    expect(client.agentWallets[0]?.tokenBalance).toBe(1000);
    expect(client.tokenPurchases).toHaveLength(1);
    expect(client.creatorEarnings).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(4);
  });

  it("rejects reuse of a purchase idempotency key with different parameters", async () => {
    const client = new FakeTokenPurchaseClient();
    await purchaseAgentTokens(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        amountCents: 500,
        idempotencyKey: "purchase_conflict",
      },
      client,
    );

    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 600,
          idempotencyKey: "purchase_conflict",
        },
        client,
      ),
    ).rejects.toThrow("Idempotency key was already used");
    expect(client.tokenPurchases).toHaveLength(1);
  });

  it("rejects insufficient user wallet balance without partial writes", async () => {
    const client = new FakeTokenPurchaseClient({
      userCashBalanceCents: 300,
    });

    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 1000,
        },
        client,
      ),
    ).rejects.toThrow("Insufficient user wallet balance");
    expect(client.userWallets[0]?.cashBalanceCents).toBe(300);
    expect(client.agentWallets[0]?.tokenBalance).toBe(0);
    expect(client.tokenPurchases).toHaveLength(0);
    expect(client.creatorEarnings).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("updates only the selected representative agent wallet", async () => {
    const client = new FakeTokenPurchaseClient();

    await purchaseAgentTokens(
      {
        externalUserId: "user_1",
        representativeId: "rep_2",
        amountCents: 500,
      },
      client,
    );

    expect(client.agentWallets.find((wallet) => wallet.representativeId === "rep_1")?.tokenBalance).toBe(0);
    expect(client.agentWallets.find((wallet) => wallet.representativeId === "rep_2")?.tokenBalance).toBe(500);
    expect(client.creatorEarnings[0]?.ownerId).toBe("owner_2");
  });

  it("rejects purchases that cannot divide evenly into agent tokens", async () => {
    const client = new FakeTokenPurchaseClient({
      tokenUnitPriceCents: 3,
    });

    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 1000,
        },
        client,
      ),
    ).rejects.toThrow("divide evenly");
  });
});

type UserWalletRow = {
  id: string;
  externalUserId: string;
  currency: string;
  cashBalanceCents: number;
};

type RepresentativeRow = {
  id: string;
  ownerId: string;
};

type AgentWalletRow = {
  id: string;
  representativeId: string;
  currency: string;
  tokenBalance: number;
  totalPurchasedTokens: number;
  totalConsumedTokens: number;
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
  representative?: RepresentativeRow;
};

type TokenPurchaseRow = {
  id: string;
  userWalletId: string;
  userAgentWalletId: string | null;
  agentWalletId: string;
  representativeId: string;
  rechargeOrderId: string | null;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  remainingTokenAmount: number | null;
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
  creatorPendingCents: number;
  status: AgentTokenPurchaseStatus;
  idempotencyKey: string;
  userWallet?: UserWalletRow;
  userAgentWallet?: UserAgentWalletRow;
  agentWallet?: AgentWalletRow;
  creatorEarnings?: CreatorEarningRow[];
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

type CreatorEarningRow = {
  id: string;
  ownerId: string;
  representativeId: string;
  agentWalletId: string;
  tokenPurchaseId: string | null;
  usageChargeId: string | null;
  status: CreatorEarningStatus;
  pendingCents: number;
  withdrawableCents: number;
  currency: string;
  revenueShareBps: number;
  idempotencyKey: string;
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

class FakeTokenPurchaseClient {
  userWallets: UserWalletRow[];
  representatives: RepresentativeRow[] = [
    { id: "rep_1", ownerId: "owner_1" },
    { id: "rep_2", ownerId: "owner_2" },
  ];
  agentWallets: AgentWalletRow[];
  userAgentWallets: UserAgentWalletRow[] = [];
  tokenPurchases: TokenPurchaseRow[] = [];
  creatorEarnings: CreatorEarningRow[] = [];
  ledgerEntries: LedgerRow[] = [];
  walletTransactions: any[] = [];

  constructor(
    options: {
      userCashBalanceCents?: number;
      tokenUnitPriceCents?: number;
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
      this.createAgentWallet("agent_wallet_1", "rep_1", options.tokenUnitPriceCents ?? 1),
      this.createAgentWallet("agent_wallet_2", "rep_2", 1),
    ];
  }

  userWallet = {
    findUnique: async (args: any) => {
      if (typeof args.where.id === "string") {
        return this.userWallets.find((wallet) => wallet.id === args.where.id) ?? null;
      }
      return (
        this.userWallets.find(
          (wallet) => wallet.externalUserId === args.where.externalUserId,
        ) ?? null
      );
    },
    update: async (args: any) => {
      const wallet = this.userWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("user wallet not found");
      }
      if (typeof args.data.cashBalanceCents?.decrement === "number") {
        wallet.cashBalanceCents -= args.data.cashBalanceCents.decrement;
      }
      if (typeof args.data.cashBalanceCents?.increment === "number") {
        wallet.cashBalanceCents += args.data.cashBalanceCents.increment;
      }
      return wallet;
    },
  };

  agentWallet = {
    findUnique: async (args: any) => {
      const wallet =
        typeof args.where.id === "string"
          ? this.agentWallets.find((row) => row.id === args.where.id)
          : this.agentWallets.find(
              (row) => row.representativeId === args.where.representativeId,
            );
      return wallet ? this.withRepresentative(wallet) : null;
    },
    update: async (args: any) => {
      const wallet = this.agentWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("agent wallet not found");
      }
      if (typeof args.data.tokenBalance?.increment === "number") {
        wallet.tokenBalance += args.data.tokenBalance.increment;
      }
      if (typeof args.data.totalPurchasedTokens?.increment === "number") {
        wallet.totalPurchasedTokens += args.data.totalPurchasedTokens.increment;
      }
      return wallet;
    },
  };

  userAgentWallet = {
    upsert: async (args: any) => {
      const key = args.where.userWalletId_agentWalletId_currency;
      const existing = this.userAgentWallets.find(
        (wallet) =>
          wallet.userWalletId === key.userWalletId &&
          wallet.agentWalletId === key.agentWalletId &&
          wallet.currency === key.currency,
      );
      if (existing) {
        return existing;
      }
      const wallet: UserAgentWalletRow = {
        id: `user_agent_wallet_${this.userAgentWallets.length + 1}`,
        userWalletId: args.create.userWalletId,
        agentWalletId: args.create.agentWalletId,
        currency: args.create.currency,
        availableTokenAmount: 0,
        reservedTokenAmount: 0,
        totalPurchasedTokenAmount: 0,
        totalConsumedTokenAmount: 0,
      };
      this.userAgentWallets.push(wallet);
      return wallet;
    },
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

  agentTokenPurchase = {
    findUnique: async (args: any) => {
      const purchase = this.tokenPurchases.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey,
      );
      return purchase ? this.withPurchaseRelations(purchase) : null;
    },
    create: async (args: any) => {
      const purchase: TokenPurchaseRow = {
        id: args.data.id ?? `purchase_${this.tokenPurchases.length + 1}`,
        userWalletId: args.data.userWalletId,
        userAgentWalletId: args.data.userAgentWalletId ?? null,
        agentWalletId: args.data.agentWalletId,
        representativeId: args.data.representativeId,
        rechargeOrderId: args.data.rechargeOrderId ?? null,
        amountCents: args.data.amountCents,
        currency: args.data.currency,
        tokenAmount: args.data.tokenAmount,
        remainingTokenAmount: args.data.remainingTokenAmount ?? null,
        tokenUnitPriceCents: args.data.tokenUnitPriceCents,
        creatorRevenueShareBps: args.data.creatorRevenueShareBps,
        creatorPendingCents: args.data.creatorPendingCents,
        status: args.data.status,
        idempotencyKey: args.data.idempotencyKey,
      };
      this.tokenPurchases.push(purchase);
      return purchase;
    },
  };

  creatorEarning = {
    create: async (args: any) => {
      const earning: CreatorEarningRow = {
        id: args.data.id ?? `creator_earning_${this.creatorEarnings.length + 1}`,
        ownerId: args.data.ownerId,
        representativeId: args.data.representativeId,
        agentWalletId: args.data.agentWalletId,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        usageChargeId: args.data.usageChargeId ?? null,
        status: args.data.status,
        pendingCents: args.data.pendingCents ?? 0,
        withdrawableCents: args.data.withdrawableCents ?? 0,
        currency: args.data.currency,
        revenueShareBps: args.data.revenueShareBps,
        idempotencyKey: args.data.idempotencyKey,
      };
      this.creatorEarnings.push(earning);
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
        transactionId: args.data.transactionId ?? null,
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, this.ledgerEntries.length)),
      };
      this.ledgerEntries.push(entry);
      return entry;
    },
  };

  async $transaction<T>(fn: (tx: FakeTokenPurchaseClient) => Promise<T>): Promise<T> {
    const userWallets = this.userWallets.map((row) => ({ ...row }));
    const agentWallets = this.agentWallets.map((row) => ({ ...row }));
    const tokenPurchases = this.tokenPurchases.map((row) => ({ ...row }));
    const userAgentWallets = this.userAgentWallets.map((row) => ({ ...row }));
    const creatorEarnings = this.creatorEarnings.map((row) => ({ ...row }));
    const ledgerEntries = this.ledgerEntries.map((row) => ({ ...row }));
    const walletTransactions = this.walletTransactions.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (error) {
      this.userWallets = userWallets;
      this.agentWallets = agentWallets;
      this.tokenPurchases = tokenPurchases;
      this.userAgentWallets = userAgentWallets;
      this.creatorEarnings = creatorEarnings;
      this.ledgerEntries = ledgerEntries;
      this.walletTransactions = walletTransactions;
      throw error;
    }
  }

  private createAgentWallet(
    id: string,
    representativeId: string,
    tokenUnitPriceCents: number,
  ): AgentWalletRow {
    return {
      id,
      representativeId,
      currency: "CNY",
      tokenBalance: 0,
      totalPurchasedTokens: 0,
      totalConsumedTokens: 0,
      tokenUnitPriceCents,
      creatorRevenueShareBps: 2000,
    };
  }

  private withRepresentative(wallet: AgentWalletRow): AgentWalletRow {
    const representative = this.representatives.find(
      (row) => row.id === wallet.representativeId,
    );
    return representative ? { ...wallet, representative } : wallet;
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

function applyDelta<T extends Record<K, number>, K extends keyof T>(
  row: T,
  key: K,
  value: { increment?: number; decrement?: number } | undefined,
) {
  if (typeof value?.increment === "number") {
    row[key] = (row[key] + value.increment) as T[K];
  }
  if (typeof value?.decrement === "number") {
    row[key] = (row[key] - value.decrement) as T[K];
  }
}

function sumLedgerAmount(entries: LedgerRow[]): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
