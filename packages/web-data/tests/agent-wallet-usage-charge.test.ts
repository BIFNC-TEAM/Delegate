import {
  AgentUsageChargeKind,
  AgentUsageChargeStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { applyAgentUsageCharge } from "../src/agent-wallet-usage-charge";

describe("agent wallet usage charge", () => {
  it("consumes agent tokens and releases creator pending earnings", async () => {
    const client = new FakeUsageChargeClient();

    const usage = await applyAgentUsageCharge(
      {
        representativeId: "rep_1",
        tokenAmount: 400,
        providerCostCents: 30,
        tokenPurchaseId: "purchase_1",
        idempotencyKey: "usage_rep_1_400",
      },
      client,
    );

    expect(usage).toMatchObject({
      tokenAmount: 400,
      tokenValueCents: 400,
      providerCostCents: 30,
      platformRevenueCents: 290,
      creatorWithdrawableCents: 80,
      agentTokenBalance: 600,
      status: "applied",
    });
    expect(client.agentWallets[0]).toMatchObject({
      tokenBalance: 600,
      totalConsumedTokens: 400,
    });
    expect(client.creatorEarnings.find((earning) => earning.id === "earning_pending_1")).toMatchObject({
      pendingCents: 120,
      withdrawableCents: 0,
      status: CreatorEarningStatus.PENDING,
    });
    expect(client.creatorEarnings.find((earning) => earning.usageChargeId === usage.id)).toMatchObject({
      pendingCents: 0,
      withdrawableCents: 80,
      status: CreatorEarningStatus.WITHDRAWABLE,
    });
    expect(client.ledgerEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: AmnWalletAccountType.AGENT_TOKEN,
          entryKind: AmnLedgerEntryKind.AGENT_TOKEN_DEBIT,
          tokenAmount: -400,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_PENDING,
          amountCents: -80,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
          amountCents: 80,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.PROVIDER_COST,
          amountCents: -30,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.PLATFORM_REVENUE,
          amountCents: 290,
        }),
      ]),
    );
  });

  it("is idempotent for repeated usage events", async () => {
    const client = new FakeUsageChargeClient();
    const input = {
      representativeId: "rep_1",
      tokenAmount: 400,
      providerCostCents: 30,
      tokenPurchaseId: "purchase_1",
      idempotencyKey: "usage_once",
    };

    const first = await applyAgentUsageCharge(input, client);
    const second = await applyAgentUsageCharge(input, client);

    expect(second.id).toBe(first.id);
    expect(second.creatorWithdrawableCents).toBe(80);
    expect(client.agentWallets[0]?.tokenBalance).toBe(600);
    expect(client.usageCharges).toHaveLength(1);
    expect(client.creatorEarnings.filter((earning) => earning.usageChargeId)).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(5);
  });

  it("rejects insufficient agent token balance without partial writes", async () => {
    const client = new FakeUsageChargeClient({
      tokenBalance: 100,
    });

    await expect(
      applyAgentUsageCharge(
        {
          representativeId: "rep_1",
          tokenAmount: 400,
          idempotencyKey: "usage_too_large",
        },
        client,
      ),
    ).rejects.toThrow("Insufficient agent token balance");
    expect(client.agentWallets[0]?.tokenBalance).toBe(100);
    expect(client.usageCharges).toHaveLength(0);
    expect(client.creatorEarnings).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("does not create withdrawable creator money when no pending earning exists", async () => {
    const client = new FakeUsageChargeClient({
      pendingCreatorCents: 0,
    });

    const usage = await applyAgentUsageCharge(
      {
        representativeId: "rep_1",
        tokenAmount: 200,
        providerCostCents: 20,
        idempotencyKey: "usage_no_pending",
      },
      client,
    );

    expect(usage.creatorWithdrawableCents).toBe(0);
    expect(usage.platformRevenueCents).toBe(180);
    expect(client.creatorEarnings.filter((earning) => earning.usageChargeId)).toHaveLength(0);
    expect(client.agentWallets[0]?.tokenBalance).toBe(800);
  });
});

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

type UsageChargeRow = {
  id: string;
  agentWalletId: string;
  representativeId: string;
  tokenPurchaseId: string | null;
  kind: AgentUsageChargeKind;
  status: AgentUsageChargeStatus;
  quantity: number;
  tokenAmount: number;
  providerCostCents: number;
  platformRevenueCents: number;
  currency: string;
  idempotencyKey: string;
  agentWallet?: AgentWalletRow;
  creatorEarnings?: CreatorEarningRow[];
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
  frozenCents: number;
  withdrawnCents: number;
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
  createdAt: Date;
};

class FakeUsageChargeClient {
  representatives: RepresentativeRow[] = [{ id: "rep_1", ownerId: "owner_1" }];
  agentWallets: AgentWalletRow[];
  usageCharges: UsageChargeRow[] = [];
  creatorEarnings: CreatorEarningRow[];
  ledgerEntries: LedgerRow[] = [];

  constructor(
    options: {
      tokenBalance?: number;
      pendingCreatorCents?: number;
    } = {},
  ) {
    this.agentWallets = [
      {
        id: "agent_wallet_1",
        representativeId: "rep_1",
        currency: "CNY",
        tokenBalance: options.tokenBalance ?? 1000,
        totalPurchasedTokens: 1000,
        totalConsumedTokens: 0,
        tokenUnitPriceCents: 1,
        creatorRevenueShareBps: 2000,
      },
    ];
    this.creatorEarnings =
      (options.pendingCreatorCents ?? 200) > 0
        ? [
            {
              id: "earning_pending_1",
              ownerId: "owner_1",
              representativeId: "rep_1",
              agentWalletId: "agent_wallet_1",
              tokenPurchaseId: "purchase_1",
              usageChargeId: null,
              status: CreatorEarningStatus.PENDING,
              pendingCents: options.pendingCreatorCents ?? 200,
              withdrawableCents: 0,
              frozenCents: 0,
              withdrawnCents: 0,
              currency: "CNY",
              revenueShareBps: 2000,
              idempotencyKey: "creator_earning:purchase_1",
            },
          ]
        : [];
  }

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
      if (typeof args.data.tokenBalance?.decrement === "number") {
        wallet.tokenBalance -= args.data.tokenBalance.decrement;
      }
      if (typeof args.data.totalConsumedTokens?.increment === "number") {
        wallet.totalConsumedTokens += args.data.totalConsumedTokens.increment;
      }
      return wallet;
    },
  };

  agentUsageCharge = {
    findUnique: async (args: any) => {
      const usage = this.usageCharges.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey,
      );
      return usage ? this.withUsageRelations(usage) : null;
    },
    create: async (args: any) => {
      const usage: UsageChargeRow = {
        id: args.data.id ?? `usage_${this.usageCharges.length + 1}`,
        agentWalletId: args.data.agentWalletId,
        representativeId: args.data.representativeId,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        kind: args.data.kind,
        status: args.data.status,
        quantity: args.data.quantity,
        tokenAmount: args.data.tokenAmount,
        providerCostCents: args.data.providerCostCents,
        platformRevenueCents: args.data.platformRevenueCents,
        currency: args.data.currency,
        idempotencyKey: args.data.idempotencyKey,
      };
      this.usageCharges.push(usage);
      return usage;
    },
  };

  creatorEarning = {
    findFirst: async (args: any) => {
      return (
        this.creatorEarnings.find((earning) => {
          if (earning.agentWalletId !== args.where.agentWalletId) {
            return false;
          }
          if (earning.status !== args.where.status) {
            return false;
          }
          if (!(earning.pendingCents > args.where.pendingCents.gt)) {
            return false;
          }
          if (
            typeof args.where.tokenPurchaseId === "string" &&
            earning.tokenPurchaseId !== args.where.tokenPurchaseId
          ) {
            return false;
          }
          return true;
        }) ?? null
      );
    },
    update: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (!earning) {
        throw new Error("creator earning not found");
      }
      if (typeof args.data.pendingCents?.decrement === "number") {
        earning.pendingCents -= args.data.pendingCents.decrement;
      }
      if (args.data.status) {
        earning.status = args.data.status;
      }
      return earning;
    },
    create: async (args: any) => {
      const earning: CreatorEarningRow = {
        id: args.data.id ?? `earning_${this.creatorEarnings.length + 1}`,
        ownerId: args.data.ownerId,
        representativeId: args.data.representativeId,
        agentWalletId: args.data.agentWalletId,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        usageChargeId: args.data.usageChargeId ?? null,
        status: args.data.status,
        pendingCents: args.data.pendingCents ?? 0,
        withdrawableCents: args.data.withdrawableCents ?? 0,
        frozenCents: args.data.frozenCents ?? 0,
        withdrawnCents: args.data.withdrawnCents ?? 0,
        currency: args.data.currency,
        revenueShareBps: args.data.revenueShareBps,
        idempotencyKey: args.data.idempotencyKey,
      };
      this.creatorEarnings.push(earning);
      return earning;
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

  async $transaction<T>(fn: (tx: FakeUsageChargeClient) => Promise<T>): Promise<T> {
    const agentWallets = this.agentWallets.map((row) => ({ ...row }));
    const usageCharges = this.usageCharges.map((row) => ({ ...row }));
    const creatorEarnings = this.creatorEarnings.map((row) => ({ ...row }));
    const ledgerEntries = this.ledgerEntries.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (error) {
      this.agentWallets = agentWallets;
      this.usageCharges = usageCharges;
      this.creatorEarnings = creatorEarnings;
      this.ledgerEntries = ledgerEntries;
      throw error;
    }
  }

  private withRepresentative(wallet: AgentWalletRow): AgentWalletRow {
    const representative = this.representatives.find(
      (row) => row.id === wallet.representativeId,
    );
    return representative ? { ...wallet, representative } : wallet;
  }

  private withUsageRelations(usage: UsageChargeRow): UsageChargeRow {
    const agentWallet = this.agentWallets.find((wallet) => wallet.id === usage.agentWalletId);
    return {
      ...usage,
      ...(agentWallet ? { agentWallet } : {}),
      creatorEarnings: this.creatorEarnings.filter(
        (earning) => earning.usageChargeId === usage.id,
      ),
    };
  }
}
