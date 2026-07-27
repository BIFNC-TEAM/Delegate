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

import {
  completeMockRechargeAndPurchaseAgentTokens,
  completeMockRechargeOrder,
  createMockRechargeOrder,
} from "../src/agent-wallet-recharge";
import { purchaseAgentTokens } from "../src/agent-wallet-token-purchase";
import { applyAgentUsageCharge } from "../src/agent-wallet-usage-charge";
import { createWithdrawRequest } from "../src/agent-wallet-withdrawals";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "../src/service-entitlements";

describe("agent wallet lifecycle acceptance", () => {
  it("completes recharge and representative-scoped purchase as one operation", async () => {
    const client = new FakeAmnLifecycleClient();
    const recharge = await createMockRechargeOrder(
      {
        externalUserId: "user_atomic",
        audienceIdentityId: "audience_canonical",
        representativeId: "rep_1",
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        amountCents: 1000,
        idempotencyKey: "lifecycle_atomic_recharge",
      },
      client,
    );

    const completed = await completeMockRechargeAndPurchaseAgentTokens(
      {
        rechargeOrderId: recharge.id,
        externalUserId: "user_atomic",
        representativeId: "rep_1",
        purchaseIdempotencyKey: "lifecycle_atomic_purchase",
      },
      client as never,
    );

    expect(completed.rechargeOrder).toMatchObject({
      status: "paid",
      cashBalanceCents: 0,
    });
    expect(completed.tokenPurchase).toMatchObject({
      representativeId: "rep_1",
      amountCents: 1000,
      availableTokenAmount: 1000,
      cashBalanceCents: 0,
    });
    expect(client.rechargeOrders[0]?.status).toBe(RechargeOrderStatus.PAID);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
  });

  it("rejects completing a recharge against a different representative intent", async () => {
    const client = new FakeAmnLifecycleClient();
    const recharge = await createMockRechargeOrder(
      {
        externalUserId: "user_atomic",
        audienceIdentityId: "audience_canonical",
        representativeId: "rep_1",
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        amountCents: 1000,
        idempotencyKey: "lifecycle_cross_rep_recharge",
      },
      client,
    );

    await expect(
      completeMockRechargeAndPurchaseAgentTokens(
        {
          rechargeOrderId: recharge.id,
          externalUserId: "user_atomic",
          representativeId: "rep_other",
          purchaseIdempotencyKey: "lifecycle_cross_rep_purchase",
        },
        client as never,
      ),
    ).rejects.toThrow("intended representative service product");

    expect(client.rechargeOrders[0]?.status).toBe(
      RechargeOrderStatus.REQUIRES_PAYMENT,
    );
    expect(client.tokenPurchases).toHaveLength(0);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(0);
  });

  it("runs recharge, token purchase, usage release, and withdrawal freeze end to end", async () => {
    const client = new FakeAmnLifecycleClient();

    const recharge = await createMockRechargeOrder(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_canonical",
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
      platformRevenueCents: 400,
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
    expect(client.ledgerEntries.length).toBeGreaterThanOrEqual(13);
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
          entryKind: AmnLedgerEntryKind.SERVICE_CREDIT_SETTLE,
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
  audienceIdentityId: string | null;
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
  audienceIdentityId: string | null;
  entitlementAccountId: string | null;
  createdAt: Date;
  userWallet?: UserWalletRow;
  userAgentWallet?: UserAgentWalletRow;
  agentWallet?: AgentWalletRow;
  creatorEarnings?: CreatorEarningRow[];
};

type UsageChargeRow = {
  id: string;
  userAgentWalletId: string | null;
  agentWalletId: string;
  representativeId: string;
  tokenPurchaseId: string | null;
  kind: AgentUsageChargeKind;
  status: AgentUsageChargeStatus;
  quantity: number;
  tokenAmount: number;
  reservedTokenAmount: number;
  settledTokenAmount: number;
  releasedTokenAmount: number;
  audienceIdentityId: string | null;
  entitlementAccountId: string | null;
  conversationId: string | null;
  generationRunId: string | null;
  providerCostCents: number;
  platformRevenueCents: number;
  currency: string;
  idempotencyKey: string;
  reservedAt: Date | null;
  settledAt: Date | null;
  releasedAt: Date | null;
  userAgentWallet?: UserAgentWalletRow;
  agentWallet?: AgentWalletRow;
  creatorEarnings?: CreatorEarningRow[];
  allocations?: UsageAllocationRow[];
};

type UsageAllocationRow = {
  id: string;
  usageChargeId: string;
  tokenPurchaseId: string;
  creatorEarningId: string | null;
  tokenAmount: number;
  valueCents: number;
  creatorReleaseCents: number;
  currency: string;
  releasedAt: Date | null;
  reversedAt: Date | null;
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

type AudienceIdentityRow = {
  id: string;
  status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
  mergedIntoId: string | null;
};

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
  userAgentWallets: UserAgentWalletRow[] = [];
  rechargeOrders: RechargeOrderRow[] = [];
  providerEvents: ProviderEventRow[] = [];
  tokenPurchases: TokenPurchaseRow[] = [];
  usageCharges: UsageChargeRow[] = [];
  usageAllocations: UsageAllocationRow[] = [];
  creatorEarnings: CreatorEarningRow[] = [];
  withdrawRequests: WithdrawRequestRow[] = [];
  ledgerEntries: LedgerRow[] = [];
  identities: AudienceIdentityRow[] = [
    {
      id: "audience_canonical",
      status: "REGISTERED",
      mergedIntoId: null,
    },
  ];
  entitlementAccounts: EntitlementAccountRow[] = [];
  entitlementLedgerEntries: EntitlementLedgerRow[] = [];
  private entitlementSequence = 0;

  walletFundsWriteGate = {
    assertAllowed: async () => undefined,
  };

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

  audienceIdentity = {
    findUnique: async (args: any) =>
      this.identities.find((row) => row.id === args.where.id) ?? null,
  };

  serviceEntitlementAccount = {
    findUnique: async (args: any) => {
      if (typeof args.where.id === "string") {
        return (
          this.entitlementAccounts.find((row) => row.id === args.where.id) ??
          null
        );
      }
      const key = args.where.audienceIdentityId_representativeId_productCode;
      return (
        this.entitlementAccounts.find(
          (row) =>
            row.audienceIdentityId === key.audienceIdentityId &&
            row.representativeId === key.representativeId &&
            row.productCode === key.productCode,
        ) ?? null
      );
    },
    upsert: async (args: any) => {
      const key = args.where.audienceIdentityId_representativeId_productCode;
      const existing = this.entitlementAccounts.find(
        (row) =>
          row.audienceIdentityId === key.audienceIdentityId &&
          row.representativeId === key.representativeId &&
          row.productCode === key.productCode,
      );
      if (existing) {
        applyEntitlementData(existing, args.update);
        return existing;
      }
      const now = new Date();
      const created: EntitlementAccountRow = {
        id: this.entitlementId("entitlement_account"),
        ...args.create,
        createdAt: now,
        updatedAt: now,
      };
      this.entitlementAccounts.push(created);
      return created;
    },
    update: async (args: any) => {
      const account = this.entitlementAccounts.find(
        (row) => row.id === args.where.id,
      );
      if (!account) throw new Error("entitlement account not found");
      applyEntitlementData(account, args.data);
      account.updatedAt = new Date();
      return account;
    },
    updateMany: async (args: any) => {
      const rows = this.entitlementAccounts.filter((row) =>
        matchesEntitlementWhere(row, args.where),
      );
      for (const row of rows) {
        applyEntitlementData(row, args.data);
        row.updatedAt = new Date();
      }
      return { count: rows.length };
    },
  };

  serviceEntitlementLedgerEntry = {
    findUnique: async (args: any) =>
      this.entitlementLedgerEntries.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey,
      ) ?? null,
    findMany: async (args: any) =>
      this.entitlementLedgerEntries.filter((row) =>
        matchesEntitlementWhere(row, args.where),
      ),
    create: async (args: any) => {
      if (
        this.entitlementLedgerEntries.some(
          (row) => row.idempotencyKey === args.data.idempotencyKey,
        )
      ) {
        throw new Error("duplicate entitlement ledger operation");
      }
      const created: EntitlementLedgerRow = {
        id: this.entitlementId("entitlement_ledger"),
        paymentOrderId: null,
        generationRunId: null,
        notes: null,
        metadata: null,
        createdAt: new Date(),
        ...args.data,
      };
      this.entitlementLedgerEntries.push(created);
      return created;
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
        throw new Error("user wallet not found");
      }
      applyIncrementDecrement(wallet, "cashBalanceCents", args.data.cashBalanceCents);
      return wallet;
    },
    updateMany: async (args: any) => {
      const wallet = this.userWallets.find((row) => row.id === args.where.id);
      if (
        !wallet ||
        (args.where.currency && wallet.currency !== args.where.currency) ||
        (typeof args.where.cashBalanceCents?.equals === "number" &&
          wallet.cashBalanceCents !== args.where.cashBalanceCents.equals) ||
        (typeof args.where.cashBalanceCents?.gte === "number" &&
          wallet.cashBalanceCents < args.where.cashBalanceCents.gte)
      ) {
        return { count: 0 };
      }
      applyIncrementDecrement(wallet, "cashBalanceCents", args.data.cashBalanceCents);
      return { count: 1 };
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
    updateMany: async (args: any) => {
      const wallet = this.agentWallets.find((row) => row.id === args.where.id);
      if (
        !wallet ||
        (args.where.currency && wallet.currency !== args.where.currency) ||
        (typeof args.where.tokenBalance?.equals === "number" &&
          wallet.tokenBalance !== args.where.tokenBalance.equals) ||
        (typeof args.where.tokenBalance?.gte === "number" &&
          wallet.tokenBalance < args.where.tokenBalance.gte)
      ) {
        return { count: 0 };
      }
      applyIncrementDecrement(wallet, "tokenBalance", args.data.tokenBalance);
      applyIncrementDecrement(wallet, "totalConsumedTokens", args.data.totalConsumedTokens);
      return { count: 1 };
    },
  };

  userAgentWallet = {
    findUnique: async (args: any) => {
      const compound = args.where.userWalletId_agentWalletId_currency;
      const wallet = this.userAgentWallets.find((row) =>
        typeof args.where.id === "string"
          ? row.id === args.where.id
          : row.userWalletId === compound?.userWalletId &&
            row.agentWalletId === compound?.agentWalletId &&
            row.currency === compound?.currency,
      );
      return wallet ? this.withUserAgentWalletRelations(wallet) : null;
    },
    upsert: async (args: any) => {
      const key = args.where.userWalletId_agentWalletId_currency;
      const existing = this.userAgentWallets.find(
        (row) =>
          row.userWalletId === key.userWalletId &&
          row.agentWalletId === key.agentWalletId &&
          row.currency === key.currency,
      );
      if (existing) return existing;
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
      if (!wallet) throw new Error("user-agent wallet not found");
      applyIncrementDecrement(wallet, "availableTokenAmount", args.data.availableTokenAmount);
      applyIncrementDecrement(wallet, "reservedTokenAmount", args.data.reservedTokenAmount);
      applyIncrementDecrement(
        wallet,
        "totalPurchasedTokenAmount",
        args.data.totalPurchasedTokenAmount,
      );
      applyIncrementDecrement(
        wallet,
        "totalConsumedTokenAmount",
        args.data.totalConsumedTokenAmount,
      );
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
        throw new Error("recharge order not found");
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

  rechargeRefund = {
    findFirst: async () => null,
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
        audienceIdentityId: args.data.audienceIdentityId ?? null,
        entitlementAccountId: args.data.entitlementAccountId ?? null,
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, this.tokenPurchases.length)),
      };
      this.tokenPurchases.push(purchase);
      return purchase;
    },
    findMany: async (args: any) =>
      this.tokenPurchases
        .filter(
          (row) =>
            row.userAgentWalletId === args.where.userAgentWalletId &&
            row.status === args.where.status &&
            (row.remainingTokenAmount ?? 0) > args.where.remainingTokenAmount.gt,
        )
        .sort((left, right) => left.id.localeCompare(right.id)),
    update: async (args: any) => {
      const purchase = this.tokenPurchases.find((row) => row.id === args.where.id);
      if (!purchase) throw new Error("purchase not found");
      applyIncrementDecrement(
        purchase,
        "remainingTokenAmount",
        args.data.remainingTokenAmount,
      );
      return purchase;
    },
  };

  agentUsageCharge = {
    findUnique: async (args: any) => {
      const usage = this.usageCharges.find(
        (row) =>
          row.id === args.where.id ||
          row.idempotencyKey === args.where.idempotencyKey,
      );
      return usage ? this.withUsageRelations(usage) : null;
    },
    create: async (args: any) => {
      const usage: UsageChargeRow = {
        id: `usage_${this.usageCharges.length + 1}`,
        userAgentWalletId: args.data.userAgentWalletId ?? null,
        agentWalletId: args.data.agentWalletId,
        representativeId: args.data.representativeId,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        kind: args.data.kind,
        status: args.data.status,
        quantity: args.data.quantity,
        tokenAmount: args.data.tokenAmount,
        reservedTokenAmount: args.data.reservedTokenAmount ?? 0,
        settledTokenAmount: args.data.settledTokenAmount ?? 0,
        releasedTokenAmount: args.data.releasedTokenAmount ?? 0,
        audienceIdentityId: args.data.audienceIdentityId ?? null,
        entitlementAccountId: args.data.entitlementAccountId ?? null,
        conversationId: args.data.conversationId ?? null,
        generationRunId: args.data.generationRunId ?? null,
        providerCostCents: args.data.providerCostCents,
        platformRevenueCents: args.data.platformRevenueCents,
        currency: args.data.currency,
        idempotencyKey: args.data.idempotencyKey,
        reservedAt: args.data.reservedAt ?? null,
        settledAt: args.data.settledAt ?? null,
        releasedAt: args.data.releasedAt ?? null,
      };
      this.usageCharges.push(usage);
      return usage;
    },
    update: async (args: any) => {
      const usage = this.usageCharges.find((row) => row.id === args.where.id);
      if (!usage) throw new Error("usage not found");
      Object.assign(usage, args.data);
      return usage;
    },
  };

  agentUsageAllocation = {
    create: async (args: any) => {
      const allocation: UsageAllocationRow = {
        id: `allocation_${this.usageAllocations.length + 1}`,
        usageChargeId: args.data.usageChargeId,
        tokenPurchaseId: args.data.tokenPurchaseId,
        creatorEarningId: args.data.creatorEarningId ?? null,
        tokenAmount: args.data.tokenAmount,
        valueCents: args.data.valueCents,
        creatorReleaseCents: args.data.creatorReleaseCents,
        currency: args.data.currency,
        releasedAt: args.data.releasedAt ?? null,
        reversedAt: null,
      };
      this.usageAllocations.push(allocation);
      return allocation;
    },
    findMany: async (args: any) =>
      this.usageAllocations.filter(
        (row) => row.usageChargeId === args.where.usageChargeId,
      ),
  };

  creatorEarning = {
    findUnique: async (args: any) => {
      return this.creatorEarnings.find((earning) => earning.id === args.where.id) ?? null;
    },
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
    updateMany: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (
        !earning ||
        (args.where.status && earning.status !== args.where.status) ||
        (typeof args.where.pendingCents?.equals === "number" &&
          earning.pendingCents !== args.where.pendingCents.equals) ||
        (typeof args.where.pendingCents?.gte === "number" &&
          earning.pendingCents < args.where.pendingCents.gte)
      ) {
        return { count: 0 };
      }
      applyIncrementDecrement(earning, "pendingCents", args.data.pendingCents);
      if (args.data.status) {
        earning.status = args.data.status;
      }
      return { count: 1 };
    },
  };

  withdrawRequest = {
    findUnique: async (args: any) => {
      return this.withdrawRequests.find((request) => request.idempotencyKey === args.where.idempotencyKey) ?? null;
    },
    findFirst: async (args: any) => {
      if (typeof args.where.id === "string") {
        return this.withdrawRequests.find(
          (request) =>
            request.id === args.where.id &&
            request.ownerId === args.where.ownerId,
        ) ?? null;
      }
      return this.withdrawRequests.find(
        (request) =>
          request.ownerId === args.where.ownerId &&
          request.representativeId === args.where.representativeId &&
          request.currency === args.where.currency &&
          (
            request.status === WithdrawRequestStatus.PENDING_REVIEW ||
            request.status === WithdrawRequestStatus.APPROVED ||
            request.status === WithdrawRequestStatus.FAILED
          ),
      ) ?? null;
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
      userAgentWallets: this.userAgentWallets.map((row) => ({ ...row })),
      rechargeOrders: this.rechargeOrders.map((row) => ({ ...row })),
      providerEvents: this.providerEvents.map((row) => ({ ...row })),
      tokenPurchases: this.tokenPurchases.map((row) => ({ ...row })),
      usageCharges: this.usageCharges.map((row) => ({ ...row })),
      usageAllocations: this.usageAllocations.map((row) => ({ ...row })),
      creatorEarnings: this.creatorEarnings.map((row) => ({ ...row })),
      withdrawRequests: this.withdrawRequests.map((row) => ({ ...row })),
      ledgerEntries: this.ledgerEntries.map((row) => ({ ...row })),
      entitlementAccounts: this.entitlementAccounts.map((row) => ({
        ...row,
      })),
      entitlementLedgerEntries: this.entitlementLedgerEntries.map((row) => ({
        ...row,
      })),
      entitlementSequence: this.entitlementSequence,
    };
  }

  private entitlementId(prefix: string) {
    this.entitlementSequence += 1;
    return `${prefix}_${this.entitlementSequence}`;
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
    const userAgentWallet = this.userAgentWallets.find(
      (wallet) => wallet.id === purchase.userAgentWalletId,
    );
    return {
      ...purchase,
      ...(userWallet ? { userWallet } : {}),
      ...(agentWallet ? { agentWallet } : {}),
      ...(userAgentWallet
        ? { userAgentWallet: this.withUserAgentWalletRelations(userAgentWallet) }
        : {}),
      creatorEarnings: this.creatorEarnings.filter((earning) => earning.tokenPurchaseId === purchase.id),
    };
  }

  private withUsageRelations(usage: UsageChargeRow): UsageChargeRow {
    const agentWallet = this.agentWallets.find((wallet) => wallet.id === usage.agentWalletId);
    const userAgentWallet = this.userAgentWallets.find(
      (wallet) => wallet.id === usage.userAgentWalletId,
    );
    return {
      ...usage,
      ...(agentWallet ? { agentWallet } : {}),
      ...(userAgentWallet
        ? { userAgentWallet: this.withUserAgentWalletRelations(userAgentWallet) }
        : {}),
      creatorEarnings: this.creatorEarnings.filter((earning) => earning.usageChargeId === usage.id),
      allocations: this.usageAllocations.filter(
        (allocation) => allocation.usageChargeId === usage.id,
      ),
    };
  }

  private withUserAgentWalletRelations(wallet: UserAgentWalletRow) {
    const agentWallet = this.agentWallets.find(
      (row) => row.id === wallet.agentWalletId,
    );
    const userWallet = this.userWallets.find(
      (row) => row.id === wallet.userWalletId,
    );
    return {
      ...wallet,
      ...(userWallet ? { userWallet } : {}),
      ...(agentWallet
        ? { agentWallet: this.withRepresentative(agentWallet) }
        : {}),
    };
  }
}

function applyIncrementDecrement<T extends Record<K, number | null>, K extends keyof T>(
  row: T,
  key: K,
  value: { increment?: number; decrement?: number } | number | undefined,
) {
  if (typeof value === "number") {
    row[key] = value as T[K];
    return;
  }
  if (typeof value?.increment === "number") {
    row[key] = ((row[key] ?? 0) + value.increment) as T[K];
  }
  if (typeof value?.decrement === "number") {
    row[key] = ((row[key] ?? 0) - value.decrement) as T[K];
  }
}

function matchesEntitlementWhere(
  row: Record<string, any>,
  where: Record<string, any>,
) {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date)
    ) {
      if ("in" in expected) return expected.in.includes(actual);
      if ("gte" in expected && !(actual >= expected.gte)) return false;
      return true;
    }
    return actual === expected;
  });
}

function applyEntitlementData(
  row: Record<string, any>,
  data: Record<string, any>,
) {
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

function sumCreatorPending(earnings: CreatorEarningRow[]): number {
  return earnings.reduce((sum, earning) => sum + earning.pendingCents, 0);
}

function sumCreatorWithdrawable(earnings: CreatorEarningRow[]): number {
  return earnings.reduce((sum, earning) => sum + earning.withdrawableCents, 0);
}

function sumCreatorFrozen(earnings: CreatorEarningRow[]): number {
  return earnings.reduce((sum, earning) => sum + earning.frozenCents, 0);
}
