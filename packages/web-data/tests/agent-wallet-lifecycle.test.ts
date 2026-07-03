import {
  AgentTokenPurchaseStatus,
  AgentUsageChargeKind,
  AgentUsageChargeStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  CreatorVerificationStatus,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  RepresentativeClaimStatus,
  WithdrawRequestStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { completeMockRechargeOrder, createMockRechargeOrder } from "../src/agent-wallet-recharge";
import { purchaseAgentTokens } from "../src/agent-wallet-token-purchase";
import { applyAgentUsageCharge } from "../src/agent-wallet-usage-charge";
import { createWithdrawRequest } from "../src/agent-wallet-withdrawals";

describe("agent wallet lifecycle acceptance", () => {
  it("runs recharge, token purchase, usage release, and withdrawal freeze end to end", async () => {
    const client = new FakeAmnLifecycleClient();

    const recharge = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        amountCents: 1000,
        idempotencyKey: "lifecycle_recharge_1",
      },
      client,
    );
    const paidRecharge = await completeMockRechargeOrder(recharge.id, {}, client);
    const purchase = await purchaseAgentTokens(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        amountCents: 1000,
        idempotencyKey: "lifecycle_purchase_1",
      },
      client,
    );
    const usage = await applyAgentUsageCharge(
      {
        representativeId: "rep_1",
        tokenPurchaseId: purchase.id,
        tokenAmount: 500,
        providerCostCents: 50,
        idempotencyKey: "lifecycle_usage_1",
      },
      client,
    );
    const withdraw = await createWithdrawRequest(
      {
        ownerId: "owner_1",
        representativeId: "rep_1",
        amountCents: 100,
        idempotencyKey: "lifecycle_withdraw_1",
      },
      client,
    );

    expect(paidRecharge).toMatchObject({
      status: "paid",
      cashBalanceCents: 1000,
    });
    expect(purchase).toMatchObject({
      cashBalanceCents: 0,
      tokenAmount: 1000,
      creatorPendingCents: 200,
      agentTokenBalance: 1000,
    });
    expect(usage).toMatchObject({
      tokenAmount: 500,
      creatorWithdrawableCents: 100,
      providerCostCents: 50,
      platformRevenueCents: 350,
      agentTokenBalance: 500,
    });
    expect(withdraw).toMatchObject({
      status: "pending_review",
      amountCents: 100,
      frozenCents: 100,
    });
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
    expect(client.agentWallets[0]).toMatchObject({
      tokenBalance: 500,
      totalPurchasedTokens: 1000,
      totalConsumedTokens: 500,
    });
    expect(sumCreatorPending(client.creatorEarnings)).toBe(100);
    expect(sumCreatorWithdrawable(client.creatorEarnings)).toBe(0);
    expect(sumCreatorFrozen(client.creatorEarnings)).toBe(100);
    expect(client.withdrawRequests).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(11);
    expect(client.ledgerEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryKind: AmnLedgerEntryKind.USER_RECHARGE,
          amountCents: 1000,
        }),
        expect.objectContaining({
          entryKind: AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
          tokenAmount: 1000,
        }),
        expect.objectContaining({
          entryKind: AmnLedgerEntryKind.AGENT_TOKEN_DEBIT,
          tokenAmount: -500,
        }),
        expect.objectContaining({
          entryKind: AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
          amountCents: -100,
        }),
      ]),
    );
  });
});

type OwnerRow = {
  id: string;
  creatorVerificationStatus: CreatorVerificationStatus;
};

type RepresentativeRow = {
  id: string;
  ownerId: string;
  claimStatus: RepresentativeClaimStatus;
};

type UserWalletRow = {
  id: string;
  externalUserId: string;
  telegramUserId: string | null;
  email: string | null;
  displayName: string | null;
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
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
  representative?: RepresentativeRow;
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

type TokenPurchaseRow = {
  id: string;
  userWalletId: string;
  agentWalletId: string;
  representativeId: string;
  rechargeOrderId: string | null;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
  creatorPendingCents: number;
  status: AgentTokenPurchaseStatus;
  idempotencyKey: string;
  userWallet?: UserWalletRow;
  agentWallet?: AgentWalletRow;
  creatorEarnings?: CreatorEarningRow[];
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

type WithdrawRequestRow = {
  id: string;
  ownerId: string;
  representativeId: string | null;
  status: WithdrawRequestStatus;
  amountCents: number;
  currency: string;
  requestedAt: Date;
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

class FakeAmnLifecycleClient {
  owners: OwnerRow[] = [
    { id: "owner_1", creatorVerificationStatus: CreatorVerificationStatus.VERIFIED },
  ];
  representatives: RepresentativeRow[] = [
    { id: "rep_1", ownerId: "owner_1", claimStatus: RepresentativeClaimStatus.CLAIMED },
  ];
  userWallets: UserWalletRow[] = [];
  agentWallets: AgentWalletRow[] = [
    {
      id: "agent_wallet_1",
      representativeId: "rep_1",
      currency: "CNY",
      tokenBalance: 0,
      totalPurchasedTokens: 0,
      totalConsumedTokens: 0,
      tokenUnitPriceCents: 1,
      creatorRevenueShareBps: 2000,
    },
  ];
  rechargeOrders: RechargeOrderRow[] = [];
  providerEvents: ProviderEventRow[] = [];
  tokenPurchases: TokenPurchaseRow[] = [];
  usageCharges: UsageChargeRow[] = [];
  creatorEarnings: CreatorEarningRow[] = [];
  withdrawRequests: WithdrawRequestRow[] = [];
  ledgerEntries: LedgerRow[] = [];

  owner = {
    findUnique: async (args: any) => {
      return this.owners.find((owner) => owner.id === args.where.id) ?? null;
    },
  };

  representative = {
    findUnique: async (args: any) => {
      return this.representatives.find((rep) => rep.id === args.where.id) ?? null;
    },
  };

  userWallet = {
    findUnique: async (args: any) => {
      if (typeof args.where.id === "string") {
        return this.userWallets.find((wallet) => wallet.id === args.where.id) ?? null;
      }
      return this.userWallets.find((wallet) => wallet.externalUserId === args.where.externalUserId) ?? null;
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
        id: `user_wallet_${this.userWallets.length + 1}`,
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
        throw new Error("user wallet not found");
      }
      applyIncrementDecrement(wallet, "cashBalanceCents", args.data.cashBalanceCents);
      return wallet;
    },
  };

  agentWallet = {
    findUnique: async (args: any) => {
      const wallet =
        typeof args.where.id === "string"
          ? this.agentWallets.find((row) => row.id === args.where.id)
          : this.agentWallets.find((row) => row.representativeId === args.where.representativeId);
      return wallet ? this.withRepresentative(wallet) : null;
    },
    update: async (args: any) => {
      const wallet = this.agentWallets.find((row) => row.id === args.where.id);
      if (!wallet) {
        throw new Error("agent wallet not found");
      }
      applyIncrementDecrement(wallet, "tokenBalance", args.data.tokenBalance);
      applyIncrementDecrement(wallet, "totalPurchasedTokens", args.data.totalPurchasedTokens);
      applyIncrementDecrement(wallet, "totalConsumedTokens", args.data.totalConsumedTokens);
      return wallet;
    },
  };

  rechargeOrder = {
    findUnique: async (args: any) => {
      const order =
        typeof args.where.id === "string"
          ? this.rechargeOrders.find((row) => row.id === args.where.id)
          : this.rechargeOrders.find((row) => row.idempotencyKey === args.where.idempotencyKey);
      return order ? this.withRechargeRelations(order) : null;
    },
    create: async (args: any) => {
      const order: RechargeOrderRow = {
        id: `recharge_${this.rechargeOrders.length + 1}`,
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
        (event) => event.provider === key.provider && event.providerEventId === key.providerEventId,
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

  agentTokenPurchase = {
    findUnique: async (args: any) => {
      const purchase = this.tokenPurchases.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey || row.id === args.where.id,
      );
      return purchase ? this.withPurchaseRelations(purchase) : null;
    },
    create: async (args: any) => {
      const purchase: TokenPurchaseRow = {
        id: `purchase_${this.tokenPurchases.length + 1}`,
        userWalletId: args.data.userWalletId,
        agentWalletId: args.data.agentWalletId,
        representativeId: args.data.representativeId,
        rechargeOrderId: args.data.rechargeOrderId ?? null,
        amountCents: args.data.amountCents,
        currency: args.data.currency,
        tokenAmount: args.data.tokenAmount,
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

  agentUsageCharge = {
    findUnique: async (args: any) => {
      const usage = this.usageCharges.find((row) => row.idempotencyKey === args.where.idempotencyKey);
      return usage ? this.withUsageRelations(usage) : null;
    },
    create: async (args: any) => {
      const usage: UsageChargeRow = {
        id: `usage_${this.usageCharges.length + 1}`,
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
          if (args.where.agentWalletId && earning.agentWalletId !== args.where.agentWalletId) {
            return false;
          }
          if (args.where.ownerId && earning.ownerId !== args.where.ownerId) {
            return false;
          }
          if (args.where.representativeId && earning.representativeId !== args.where.representativeId) {
            return false;
          }
          if (args.where.tokenPurchaseId && earning.tokenPurchaseId !== args.where.tokenPurchaseId) {
            return false;
          }
          if (args.where.status && earning.status !== args.where.status) {
            return false;
          }
          if (args.where.pendingCents?.gt !== undefined && !(earning.pendingCents > args.where.pendingCents.gt)) {
            return false;
          }
          return true;
        }) ?? null
      );
    },
    findMany: async (args: any) => {
      return this.creatorEarnings.filter((earning) => {
        if (earning.ownerId !== args.where.ownerId) {
          return false;
        }
        if (earning.representativeId !== args.where.representativeId) {
          return false;
        }
        if (earning.status !== args.where.status) {
          return false;
        }
        if (earning.currency !== args.where.currency) {
          return false;
        }
        return earning.withdrawableCents > args.where.withdrawableCents.gt;
      });
    },
    create: async (args: any) => {
      const earning: CreatorEarningRow = {
        id: `earning_${this.creatorEarnings.length + 1}`,
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
    update: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (!earning) {
        throw new Error("creator earning not found");
      }
      applyIncrementDecrement(earning, "pendingCents", args.data.pendingCents);
      applyIncrementDecrement(earning, "withdrawableCents", args.data.withdrawableCents);
      applyIncrementDecrement(earning, "frozenCents", args.data.frozenCents);
      if (args.data.status) {
        earning.status = args.data.status;
      }
      return earning;
    },
  };

  withdrawRequest = {
    findUnique: async (args: any) => {
      return this.withdrawRequests.find((request) => request.idempotencyKey === args.where.idempotencyKey) ?? null;
    },
    create: async (args: any) => {
      const request: WithdrawRequestRow = {
        id: `withdraw_${this.withdrawRequests.length + 1}`,
        ownerId: args.data.ownerId,
        representativeId: args.data.representativeId ?? null,
        status: args.data.status,
        amountCents: args.data.amountCents,
        currency: args.data.currency,
        requestedAt: new Date(Date.UTC(2026, 6, 3)),
        idempotencyKey: args.data.idempotencyKey,
      };
      this.withdrawRequests.push(request);
      return request;
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

  async $transaction<T>(fn: (tx: FakeAmnLifecycleClient) => Promise<T>): Promise<T> {
    const snapshot = this.clone();
    try {
      return await fn(this);
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  private clone() {
    return {
      userWallets: this.userWallets.map((row) => ({ ...row })),
      agentWallets: this.agentWallets.map((row) => ({ ...row })),
      rechargeOrders: this.rechargeOrders.map((row) => ({ ...row })),
      providerEvents: this.providerEvents.map((row) => ({ ...row })),
      tokenPurchases: this.tokenPurchases.map((row) => ({ ...row })),
      usageCharges: this.usageCharges.map((row) => ({ ...row })),
      creatorEarnings: this.creatorEarnings.map((row) => ({ ...row })),
      withdrawRequests: this.withdrawRequests.map((row) => ({ ...row })),
      ledgerEntries: this.ledgerEntries.map((row) => ({ ...row })),
    };
  }

  private withRepresentative(wallet: AgentWalletRow): AgentWalletRow {
    const representative = this.representatives.find((row) => row.id === wallet.representativeId);
    return representative ? { ...wallet, representative } : wallet;
  }

  private withRechargeRelations(order: RechargeOrderRow): RechargeOrderRow {
    const userWallet = this.userWallets.find((wallet) => wallet.id === order.userWalletId);
    return userWallet ? { ...order, userWallet } : order;
  }

  private withPurchaseRelations(purchase: TokenPurchaseRow): TokenPurchaseRow {
    const userWallet = this.userWallets.find((wallet) => wallet.id === purchase.userWalletId);
    const agentWallet = this.agentWallets.find((wallet) => wallet.id === purchase.agentWalletId);
    return {
      ...purchase,
      ...(userWallet ? { userWallet } : {}),
      ...(agentWallet ? { agentWallet } : {}),
      creatorEarnings: this.creatorEarnings.filter((earning) => earning.tokenPurchaseId === purchase.id),
    };
  }

  private withUsageRelations(usage: UsageChargeRow): UsageChargeRow {
    const agentWallet = this.agentWallets.find((wallet) => wallet.id === usage.agentWalletId);
    return {
      ...usage,
      ...(agentWallet ? { agentWallet } : {}),
      creatorEarnings: this.creatorEarnings.filter((earning) => earning.usageChargeId === usage.id),
    };
  }
}

function applyIncrementDecrement<T extends Record<K, number>, K extends keyof T>(
  row: T,
  key: K,
  value: { increment?: number; decrement?: number } | number | undefined,
) {
  if (typeof value === "number") {
    row[key] = value as T[K];
    return;
  }
  if (typeof value?.increment === "number") {
    row[key] = (row[key] + value.increment) as T[K];
  }
  if (typeof value?.decrement === "number") {
    row[key] = (row[key] - value.decrement) as T[K];
  }
}

function sumCreatorPending(earnings: CreatorEarningRow[]): number {
  return earnings.reduce((sum, earning) => sum + earning.pendingCents, 0);
}

function sumCreatorWithdrawable(earnings: CreatorEarningRow[]): number {
  return earnings.reduce((sum, earning) => sum + earning.withdrawableCents, 0);
}

function sumCreatorFrozen(earnings: CreatorEarningRow[]): number {
  return earnings.reduce((sum, earning) => sum + earning.frozenCents, 0);
}
