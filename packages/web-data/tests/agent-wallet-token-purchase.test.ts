import {
  AgentTokenPurchaseStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { purchaseAgentTokens } from "../src/agent-wallet-token-purchase";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "../src/service-entitlements";

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
      audienceIdentityId: "audience_canonical",
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
    expect(client.entitlementAccounts).toEqual([
      expect.objectContaining({
        id: purchase.entitlementAccountId,
        audienceIdentityId: "audience_canonical",
        representativeId: "rep_1",
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        grantedUnits: 1000,
        remainingUnits: 1000,
      }),
    ]);
    expect(client.entitlementLedgerEntries).toEqual([
      expect.objectContaining({
        entitlementAccountId: purchase.entitlementAccountId,
        kind: "GRANT",
        units: 1000,
      }),
    ]);
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
    expect(client.entitlementLedgerEntries).toHaveLength(1);
  });

  it("rejects an idempotency key reused by another owner or amount", async () => {
    const client = new FakeTokenPurchaseClient();
    await purchaseAgentTokens(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        amountCents: 500,
        idempotencyKey: "purchase_owner_bound",
      },
      client,
    );

    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "attacker",
          representativeId: "rep_1",
          amountCents: 500,
          idempotencyKey: "purchase_owner_bound",
        },
        client,
      ),
    ).rejects.toThrow("externalUserId does not match");
    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 600,
          idempotencyKey: "purchase_owner_bound",
        },
        client,
      ),
    ).rejects.toThrow("amountCents does not match");
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
    expect(client.entitlementAccounts).toHaveLength(0);
    expect(client.entitlementLedgerEntries).toHaveLength(0);
  });

  it("rejects a wallet without an audience identity before writing", async () => {
    const client = new FakeTokenPurchaseClient({
      audienceIdentityId: null,
    });

    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 500,
        },
        client,
      ),
    ).rejects.toThrow("linked to an audience identity");
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.tokenPurchases).toHaveLength(0);
    expect(client.entitlementAccounts).toHaveLength(0);
  });

  it("fails closed before purchase when wallet and entitlement balances drift", async () => {
    const client = new FakeTokenPurchaseClient();
    client.userAgentWallets.push({
      id: "user_agent_wallet_1",
      userWalletId: "user_wallet_1",
      agentWalletId: "agent_wallet_1",
      currency: "CNY",
      availableTokenAmount: 5,
      reservedTokenAmount: 0,
      totalPurchasedTokenAmount: 5,
      totalConsumedTokenAmount: 0,
    });
    const now = new Date();
    client.entitlementAccounts.push({
      id: "entitlement_account_drifted",
      audienceIdentityId: "audience_canonical",
      representativeId: "rep_1",
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      unitName: "unit",
      status: "ACTIVE",
      grantedUnits: 4,
      remainingUnits: 4,
      reservedUnits: 0,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 500,
          idempotencyKey: "purchase-after-drift",
        },
        client,
      ),
    ).rejects.toThrow(
      "wallet and service entitlement balances do not match",
    );
    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.tokenPurchases).toHaveLength(0);
    expect(client.entitlementLedgerEntries).toHaveLength(0);
  });

  it("rolls back the cash debit when the entitlement grant fails", async () => {
    const client = new FakeTokenPurchaseClient();
    client.identities[1]!.status = "DISABLED";

    await expect(
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 500,
          idempotencyKey: "disabled-identity-purchase",
        },
        client,
      ),
    ).rejects.toThrow("Audience identity is disabled");

    expect(client.userWallets[0]?.cashBalanceCents).toBe(1200);
    expect(client.userAgentWallets).toHaveLength(0);
    expect(client.tokenPurchases).toHaveLength(0);
    expect(client.entitlementAccounts).toHaveLength(0);
    expect(client.entitlementLedgerEntries).toHaveLength(0);
  });

  it("allows only one concurrent debit when two purchases exceed the same cash balance", async () => {
    const client = new FakeTokenPurchaseClient({
      userCashBalanceCents: 1200,
    });
    (client as { $transaction?: unknown }).$transaction = undefined;

    const results = await Promise.allSettled([
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 800,
          idempotencyKey: "purchase_concurrent_1",
        },
        client,
      ),
      purchaseAgentTokens(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          amountCents: 800,
          idempotencyKey: "purchase_concurrent_2",
        },
        client,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(client.userWallets[0]?.cashBalanceCents).toBe(400);
    expect(client.tokenPurchases).toHaveLength(1);
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
  audienceIdentityId: string | null;
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
  audienceIdentityId: string | null;
  entitlementAccountId: string | null;
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
  identities: AudienceIdentityRow[] = [
    {
      id: "audience_merged",
      status: "MERGED",
      mergedIntoId: "audience_canonical",
    },
    {
      id: "audience_canonical",
      status: "REGISTERED",
      mergedIntoId: null,
    },
  ];
  entitlementAccounts: EntitlementAccountRow[] = [];
  entitlementLedgerEntries: EntitlementLedgerRow[] = [];
  private entitlementSequence = 0;

  constructor(
    options: {
      userCashBalanceCents?: number;
      tokenUnitPriceCents?: number;
      audienceIdentityId?: string | null;
    } = {},
  ) {
    this.userWallets = [
      {
        id: "user_wallet_1",
        externalUserId: "user_1",
        audienceIdentityId:
          options.audienceIdentityId === undefined
            ? "audience_merged"
            : options.audienceIdentityId,
        currency: "CNY",
        cashBalanceCents: options.userCashBalanceCents ?? 1200,
      },
    ];
    this.agentWallets = [
      this.createAgentWallet("agent_wallet_1", "rep_1", options.tokenUnitPriceCents ?? 1),
      this.createAgentWallet("agent_wallet_2", "rep_2", 1),
    ];
  }

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
      return (
        this.userWallets.find(
          (wallet) => wallet.externalUserId === args.where.externalUserId,
        ) ?? null
      );
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
      if (typeof args.data.cashBalanceCents?.decrement === "number") {
        wallet.cashBalanceCents -= args.data.cashBalanceCents.decrement;
      }
      if (typeof args.data.cashBalanceCents?.increment === "number") {
        wallet.cashBalanceCents += args.data.cashBalanceCents.increment;
      }
      return { count: 1 };
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
        audienceIdentityId: args.data.audienceIdentityId ?? null,
        entitlementAccountId: args.data.entitlementAccountId ?? null,
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
    const entitlementAccounts = this.entitlementAccounts.map((row) => ({
      ...row,
    }));
    const entitlementLedgerEntries = this.entitlementLedgerEntries.map(
      (row) => ({ ...row }),
    );
    const entitlementSequence = this.entitlementSequence;
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
      this.entitlementAccounts = entitlementAccounts;
      this.entitlementLedgerEntries = entitlementLedgerEntries;
      this.entitlementSequence = entitlementSequence;
      throw error;
    }
  }

  private entitlementId(prefix: string) {
    this.entitlementSequence += 1;
    return `${prefix}_${this.entitlementSequence}`;
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
