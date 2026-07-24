import {
  AgentTokenPurchaseStatus,
  AgentUsageChargeKind,
  AgentUsageChargeStatus,
  AmnWalletAccountType,
  CreatorEarningStatus,
  WalletTransactionStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  applyAgentUsageCharge,
  getUserAgentWalletBalance,
  InsufficientAgentUsageCreditsError,
  releaseAgentUsageCredits,
  reserveAgentUsageCredits,
  settleAgentUsageCredits,
} from "../src/agent-wallet-usage-charge";

describe("user-scoped service-credit usage", () => {
  it("rolls back the reservation when the compatibility settlement fails", async () => {
    const client = new FakeServiceCreditUsageClient();
    client.failNextAllocation = true;

    await expect(
      applyAgentUsageCharge(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          tokenAmount: 200,
          providerCostCents: 20,
          idempotencyKey: "atomic_apply_failure",
        },
        client,
      ),
    ).rejects.toThrow("allocation write failed");

    expect(client.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
      totalConsumedTokenAmount: 0,
    });
    expect(client.usageCharges).toHaveLength(0);
    expect(client.usageAllocations).toHaveLength(0);
    expect(client.walletTransactions).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("reserves, settles FIFO lots, and returns the unused reservation", async () => {
    const client = new FakeServiceCreditUsageClient();

    const reservation = await reserveAgentUsageCredits(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        tokenAmount: 700,
        idempotencyKey: "usage_1",
      },
      client,
    );

    expect(reservation).toMatchObject({
      status: "reserved",
      availableTokenAmount: 300,
      walletReservedTokenAmount: 700,
      creatorWithdrawableCents: 0,
    });
    expect(client.creatorEarnings).toHaveLength(3);

    const settled = await settleAgentUsageCredits(
      {
        usageChargeId: reservation.id,
        settledTokenAmount: 650,
        providerCostCents: 30,
        provider: "model-provider",
        idempotencyKey: "usage_1_settle",
      },
      client,
    );

    expect(settled).toMatchObject({
      status: "settled",
      settledTokenAmount: 650,
      releasedTokenAmount: 50,
      tokenValueCents: 650,
      creatorWithdrawableCents: 130,
      platformRevenueCents: 520,
      providerCostCents: 30,
      availableTokenAmount: 350,
      walletReservedTokenAmount: 0,
      agentTokenBalance: 850,
    });
    expect(settled.allocations).toEqual([
      {
        tokenPurchaseId: "purchase_1",
        tokenAmount: 600,
        valueCents: 600,
        creatorReleaseCents: 120,
      },
      {
        tokenPurchaseId: "purchase_2",
        tokenAmount: 50,
        valueCents: 50,
        creatorReleaseCents: 10,
      },
    ]);
    expect(client.tokenPurchases.find((lot) => lot.id === "purchase_1"))
      .toMatchObject({ remainingTokenAmount: 0 });
    expect(client.tokenPurchases.find((lot) => lot.id === "purchase_2"))
      .toMatchObject({ remainingTokenAmount: 350 });
    expect(
      sumLedgerAmount(
        client.ledgerEntries.filter(
          (entry) => entry.eventGroupId === `usage_settlement:${reservation.id}`,
        ),
      ),
    ).toBe(0);
    const settlementTransaction = client.walletTransactions.find(
      (transaction) =>
        transaction.eventGroupId === `usage_settlement:${reservation.id}`,
    );
    expect(settlementTransaction).toBeTruthy();
    expect(
      client.ledgerEntries
        .filter(
          (entry) => entry.eventGroupId === `usage_settlement:${reservation.id}`,
        )
        .every((entry) => entry.transactionId === settlementTransaction?.id),
    ).toBe(true);
  });

  it("releases a failed reservation without releasing creator earnings", async () => {
    const client = new FakeServiceCreditUsageClient();
    const reservation = await reserveAgentUsageCredits(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        tokenAmount: 200,
        idempotencyKey: "usage_failed",
      },
      client,
    );

    const released = await releaseAgentUsageCredits(
      {
        usageChargeId: reservation.id,
        failed: true,
        reason: "provider_timeout",
        idempotencyKey: "usage_failed_release",
      },
      client,
    );

    expect(released).toMatchObject({
      status: "failed",
      releasedTokenAmount: 200,
      availableTokenAmount: 1000,
      walletReservedTokenAmount: 0,
      creatorWithdrawableCents: 0,
    });
    expect(client.creatorEarnings).toHaveLength(3);
    expect(client.usageAllocations).toHaveLength(0);
  });

  it("never resolves a token purchase to another user", async () => {
    const client = new FakeServiceCreditUsageClient();

    await expect(
      reserveAgentUsageCredits(
        {
          externalUserId: "user_2",
          tokenPurchaseId: "purchase_1",
          representativeId: "rep_1",
          tokenAmount: 100,
          idempotencyKey: "cross_user",
        },
        client,
      ),
    ).rejects.toThrow("does not belong to this external user");

    expect(client.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
    });
    expect(client.userAgentWallets[1]).toMatchObject({
      availableTokenAmount: 500,
      reservedTokenAmount: 0,
    });
  });

  it("fails closed without an unambiguous user-scoped selector", async () => {
    const client = new FakeServiceCreditUsageClient();

    await expect(
      reserveAgentUsageCredits(
        {
          representativeId: "rep_1",
          tokenAmount: 100,
          idempotencyKey: "ambiguous",
        },
        client,
      ),
    ).rejects.toThrow("user-scoped wallet selector");
  });

  it("treats a missing user wallet or scoped wallet as zero available credits", async () => {
    const missingUserClient = new FakeServiceCreditUsageClient();
    await expect(
      reserveAgentUsageCredits(
        {
          externalUserId: "user_without_wallet",
          representativeId: "rep_1",
          tokenAmount: 1,
          idempotencyKey: "missing_user_wallet",
        },
        missingUserClient,
      ),
    ).rejects.toBeInstanceOf(InsufficientAgentUsageCreditsError);

    const missingScopedWalletClient = new FakeServiceCreditUsageClient();
    missingScopedWalletClient.userAgentWallets =
      missingScopedWalletClient.userAgentWallets.filter(
        (wallet) => wallet.userWalletId !== "user_wallet_1",
      );
    await expect(
      reserveAgentUsageCredits(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          tokenAmount: 1,
          idempotencyKey: "missing_scoped_wallet",
        },
        missingScopedWalletClient,
      ),
    ).rejects.toBeInstanceOf(InsufficientAgentUsageCreditsError);
  });

  it("replays matching keys, rejects mismatches, and rolls back partial settlement", async () => {
    const client = new FakeServiceCreditUsageClient();
    const input = {
      externalUserId: "user_1",
      representativeId: "rep_1",
      tokenAmount: 200,
      idempotencyKey: "usage_retry",
    };
    const first = await reserveAgentUsageCredits(input, client);
    const replay = await reserveAgentUsageCredits(input, client);
    expect(replay.id).toBe(first.id);

    await expect(
      reserveAgentUsageCredits(
        { ...input, tokenAmount: 201 },
        client,
      ),
    ).rejects.toThrow("Idempotency key was already used");

    client.failNextAllocation = true;
    await expect(
      settleAgentUsageCredits(
        {
          usageChargeId: first.id,
          settledTokenAmount: 100,
          idempotencyKey: "usage_retry_settle",
        },
        client,
      ),
    ).rejects.toThrow("allocation write failed");

    expect(client.usageCharges[0]).toMatchObject({
      status: AgentUsageChargeStatus.RESERVED,
      settledTokenAmount: 0,
    });
    expect(client.tokenPurchases[0]).toMatchObject({
      remainingTokenAmount: 600,
    });
    expect(client.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 800,
      reservedTokenAmount: 200,
    });
  });

  it("reads scoped available and reserved balances by external user and representative", async () => {
    const client = new FakeServiceCreditUsageClient();
    const balance = await getUserAgentWalletBalance(
      {
        externalUserId: "user_2",
        representativeId: "rep_1",
      },
      client,
    );

    expect(balance).toMatchObject({
      userWalletId: "user_wallet_2",
      availableTokenAmount: 500,
      reservedTokenAmount: 0,
    });
  });

  it("releases the exact sale-time creator share across rounding boundaries", async () => {
    const client = new FakeServiceCreditUsageClient();
    client.agentWallets[0]!.tokenBalance = 3;
    client.agentWallets[0]!.totalPurchasedTokens = 3;
    client.userAgentWallets[0]!.availableTokenAmount = 3;
    client.userAgentWallets[0]!.totalPurchasedTokenAmount = 3;
    client.tokenPurchases = [
      {
        ...client.tokenPurchases[0]!,
        id: "rounding_purchase",
        amountCents: 3,
        tokenAmount: 3,
        remainingTokenAmount: 3,
        creatorPendingCents: 1,
      },
    ];
    client.creatorEarnings = [
      {
        ...client.creatorEarnings[0]!,
        id: "rounding_pending",
        tokenPurchaseId: "rounding_purchase",
        pendingCents: 1,
      },
    ];

    const released: number[] = [];
    const platform: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const reservation = await reserveAgentUsageCredits(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          tokenAmount: 1,
          idempotencyKey: `rounding_reserve_${index}`,
        },
        client,
      );
      const settlement = await settleAgentUsageCredits(
        {
          usageChargeId: reservation.id,
          settledTokenAmount: 1,
          idempotencyKey: `rounding_settle_${index}`,
        },
        client,
      );
      released.push(settlement.creatorWithdrawableCents);
      platform.push(settlement.platformRevenueCents);
    }

    expect(released).toEqual([0, 0, 1]);
    expect(released.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(platform.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(client.tokenPurchases[0]?.remainingTokenAmount).toBe(0);
  });
});

class FakeServiceCreditUsageClient {
  users = [
    { id: "user_wallet_1", externalUserId: "user_1", currency: "CNY" },
    { id: "user_wallet_2", externalUserId: "user_2", currency: "CNY" },
  ];
  representatives = [{ id: "rep_1", ownerId: "owner_1" }];
  agentWallets = [
    {
      id: "agent_wallet_1",
      representativeId: "rep_1",
      currency: "CNY",
      tokenBalance: 1500,
      totalPurchasedTokens: 1500,
      totalConsumedTokens: 0,
      tokenUnitPriceCents: 1,
      creatorRevenueShareBps: 2000,
    },
  ];
  userAgentWallets = [
    {
      id: "user_agent_wallet_1",
      userWalletId: "user_wallet_1",
      agentWalletId: "agent_wallet_1",
      currency: "CNY",
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
      totalPurchasedTokenAmount: 1000,
      totalConsumedTokenAmount: 0,
    },
    {
      id: "user_agent_wallet_2",
      userWalletId: "user_wallet_2",
      agentWalletId: "agent_wallet_1",
      currency: "CNY",
      availableTokenAmount: 500,
      reservedTokenAmount: 0,
      totalPurchasedTokenAmount: 500,
      totalConsumedTokenAmount: 0,
    },
  ];
  tokenPurchases = [
    this.purchase("purchase_1", "user_wallet_1", "user_agent_wallet_1", 600, 0),
    this.purchase("purchase_2", "user_wallet_1", "user_agent_wallet_1", 400, 1),
    this.purchase("purchase_3", "user_wallet_2", "user_agent_wallet_2", 500, 2),
  ];
  usageCharges: any[] = [];
  usageAllocations: any[] = [];
  creatorEarnings: any[] = [
    this.pendingEarning("earning_1", "purchase_1", 120),
    this.pendingEarning("earning_2", "purchase_2", 80),
    this.pendingEarning("earning_3", "purchase_3", 100),
  ];
  ledgerEntries: any[] = [];
  walletTransactions: any[] = [];
  failNextAllocation = false;

  userWallet = {
    findUnique: async (args: any) =>
      this.users.find(
        (user) =>
          user.id === args.where.id ||
          user.externalUserId === args.where.externalUserId,
      ) ?? null,
  };

  agentWallet = {
    findUnique: async (args: any) => {
      const wallet = this.agentWallets.find(
        (row) =>
          row.id === args.where.id ||
          row.representativeId === args.where.representativeId,
      );
      return wallet ? this.withAgentRelations(wallet) : null;
    },
    update: async (args: any) => {
      const wallet = this.agentWallets.find((row) => row.id === args.where.id);
      if (!wallet) throw new Error("agent wallet not found");
      applyDelta(wallet, "tokenBalance", args.data.tokenBalance);
      applyDelta(wallet, "totalConsumedTokens", args.data.totalConsumedTokens);
      return wallet;
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
      return wallet ? this.withScopedWalletRelations(wallet) : null;
    },
    update: async (args: any) => {
      const wallet = this.userAgentWallets.find((row) => row.id === args.where.id);
      if (!wallet) throw new Error("user-agent wallet not found");
      applyDelta(wallet, "availableTokenAmount", args.data.availableTokenAmount);
      applyDelta(wallet, "reservedTokenAmount", args.data.reservedTokenAmount);
      applyDelta(
        wallet,
        "totalConsumedTokenAmount",
        args.data.totalConsumedTokenAmount,
      );
      return wallet;
    },
  };

  agentTokenPurchase = {
    findUnique: async (args: any) => {
      const purchase = this.tokenPurchases.find((row) => row.id === args.where.id);
      return purchase ? this.withPurchaseRelations(purchase) : null;
    },
    findMany: async (args: any) =>
      this.tokenPurchases
        .filter(
          (row) =>
            row.userAgentWalletId === args.where.userAgentWalletId &&
            row.status === args.where.status &&
            (row.remainingTokenAmount ?? 0) > args.where.remainingTokenAmount.gt,
        )
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        )
        .map((row) => ({ ...row })),
    update: async (args: any) => {
      const purchase = this.tokenPurchases.find((row) => row.id === args.where.id);
      if (!purchase) throw new Error("purchase not found");
      applyDelta(
        purchase,
        "remainingTokenAmount",
        args.data.remainingTokenAmount,
      );
      return purchase;
    },
  };

  agentUsageCharge = {
    findUnique: async (args: any) => {
      const row = this.usageCharges.find(
        (usage) =>
          usage.id === args.where.id ||
          usage.idempotencyKey === args.where.idempotencyKey,
      );
      return row ? this.withUsageRelations(row) : null;
    },
    create: async (args: any) => {
      const row = {
        id: `usage_${this.usageCharges.length + 1}`,
        userAgentWalletId: args.data.userAgentWalletId ?? null,
        agentWalletId: args.data.agentWalletId,
        representativeId: args.data.representativeId,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        kind: args.data.kind as AgentUsageChargeKind,
        status: args.data.status as AgentUsageChargeStatus,
        quantity: args.data.quantity,
        tokenAmount: args.data.tokenAmount,
        reservedTokenAmount: args.data.reservedTokenAmount ?? 0,
        settledTokenAmount: args.data.settledTokenAmount ?? 0,
        releasedTokenAmount: args.data.releasedTokenAmount ?? 0,
        providerCostCents: args.data.providerCostCents ?? 0,
        platformRevenueCents: args.data.platformRevenueCents ?? 0,
        currency: args.data.currency,
        idempotencyKey: args.data.idempotencyKey,
        reservedAt: args.data.reservedAt ?? null,
        settledAt: args.data.settledAt ?? null,
        releasedAt: args.data.releasedAt ?? null,
      };
      this.usageCharges.push(row);
      return row;
    },
    update: async (args: any) => {
      const row = this.usageCharges.find((usage) => usage.id === args.where.id);
      if (!row) throw new Error("usage not found");
      Object.assign(row, args.data);
      return row;
    },
  };

  agentUsageAllocation = {
    create: async (args: any) => {
      if (this.failNextAllocation) {
        this.failNextAllocation = false;
        throw new Error("allocation write failed");
      }
      const row = {
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
      this.usageAllocations.push(row);
      return row;
    },
    findMany: async (args: any) =>
      this.usageAllocations.filter(
        (row) => row.usageChargeId === args.where.usageChargeId,
      ),
  };

  creatorEarning = {
    findFirst: async (args: any) =>
      this.creatorEarnings.find(
        (earning) =>
          earning.tokenPurchaseId === args.where.tokenPurchaseId &&
          earning.status === args.where.status &&
          earning.pendingCents > args.where.pendingCents.gt,
      ) ?? null,
    update: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (!earning) throw new Error("earning not found");
      applyDelta(earning, "pendingCents", args.data.pendingCents);
      if (args.data.status) earning.status = args.data.status;
      return earning;
    },
    create: async (args: any) => {
      const earning = {
        id: `earning_${this.creatorEarnings.length + 1}`,
        ownerId: args.data.ownerId,
        representativeId: args.data.representativeId,
        agentWalletId: args.data.agentWalletId,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        usageChargeId: args.data.usageChargeId ?? null,
        status: args.data.status as CreatorEarningStatus,
        pendingCents: args.data.pendingCents ?? 0,
        withdrawableCents: args.data.withdrawableCents ?? 0,
        frozenCents: 0,
        withdrawnCents: 0,
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
        status: args.data.status ?? WalletTransactionStatus.SUCCEEDED,
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
    findFirst: async (args: any) =>
      this.ledgerEntries.find(
        (entry) =>
          entry.eventGroupId === args.where.eventGroupId &&
          entry.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith),
      ) ?? null,
    findMany: async (args: any) =>
      this.ledgerEntries.filter(
        (entry) => entry.eventGroupId === args.where.eventGroupId,
      ),
    create: async (args: {
      data: Prisma.WalletLedgerEntryUncheckedCreateInput;
    }) => {
      const row = {
        id: `ledger_${this.ledgerEntries.length + 1}`,
        ...args.data,
        amountCents: args.data.amountCents ?? 0,
        tokenAmount: args.data.tokenAmount ?? 0,
        currency: args.data.currency ?? "CNY",
        transactionId: args.data.transactionId ?? null,
        createdAt: new Date(),
      };
      this.ledgerEntries.push(row);
      return row;
    },
  };

  async $transaction<T>(
    fn: (tx: FakeServiceCreditUsageClient) => Promise<T>,
  ): Promise<T> {
    const snapshot = structuredClone({
      users: this.users,
      agentWallets: this.agentWallets,
      userAgentWallets: this.userAgentWallets,
      tokenPurchases: this.tokenPurchases,
      usageCharges: this.usageCharges,
      usageAllocations: this.usageAllocations,
      creatorEarnings: this.creatorEarnings,
      ledgerEntries: this.ledgerEntries,
      walletTransactions: this.walletTransactions,
    });
    try {
      return await fn(this);
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  private purchase(
    id: string,
    userWalletId: string,
    userAgentWalletId: string,
    tokenAmount: number,
    seconds: number,
  ) {
    return {
      id,
      userWalletId,
      userAgentWalletId,
      agentWalletId: "agent_wallet_1",
      representativeId: "rep_1",
      amountCents: tokenAmount,
      currency: "CNY",
      tokenAmount,
      remainingTokenAmount: tokenAmount as number | null,
      tokenUnitPriceCents: 1,
      creatorRevenueShareBps: 2000,
      creatorPendingCents: tokenAmount / 5,
      status: AgentTokenPurchaseStatus.COMPLETED,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
    };
  }

  private pendingEarning(
    id: string,
    tokenPurchaseId: string,
    pendingCents: number,
  ) {
    return {
      id,
      ownerId: "owner_1",
      representativeId: "rep_1",
      agentWalletId: "agent_wallet_1",
      tokenPurchaseId,
      usageChargeId: null as string | null,
      status: CreatorEarningStatus.PENDING,
      pendingCents,
      withdrawableCents: 0,
      frozenCents: 0,
      withdrawnCents: 0,
      currency: "CNY",
      revenueShareBps: 2000,
      idempotencyKey: `pending:${tokenPurchaseId}`,
    };
  }

  private withAgentRelations(wallet: any) {
    return {
      ...wallet,
      representative: this.representatives.find(
        (row) => row.id === wallet.representativeId,
      ),
    };
  }

  private withScopedWalletRelations(wallet: any) {
    const agentWallet = this.agentWallets.find(
      (row) => row.id === wallet.agentWalletId,
    );
    return {
      ...wallet,
      userWallet: this.users.find((row) => row.id === wallet.userWalletId),
      agentWallet: agentWallet
        ? this.withAgentRelations(agentWallet)
        : undefined,
    };
  }

  private withPurchaseRelations(purchase: any) {
    const scopedWallet = this.userAgentWallets.find(
      (row) => row.id === purchase.userAgentWalletId,
    );
    return {
      ...purchase,
      userAgentWallet: scopedWallet
        ? this.withScopedWalletRelations(scopedWallet)
        : undefined,
    };
  }

  private withUsageRelations(usage: any) {
    const scopedWallet = this.userAgentWallets.find(
      (row) => row.id === usage.userAgentWalletId,
    );
    const agentWallet = this.agentWallets.find(
      (row) => row.id === usage.agentWalletId,
    );
    return {
      ...usage,
      userAgentWallet: scopedWallet
        ? this.withScopedWalletRelations(scopedWallet)
        : undefined,
      agentWallet: agentWallet
        ? this.withAgentRelations(agentWallet)
        : undefined,
      creatorEarnings: this.creatorEarnings.filter(
        (earning) => earning.usageChargeId === usage.id,
      ),
      allocations: this.usageAllocations.filter(
        (allocation) => allocation.usageChargeId === usage.id,
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
  } else if (value) {
    const current = row[key] ?? 0;
    row[key] = (
      current +
      (value.increment ?? 0) -
      (value.decrement ?? 0)
    ) as T[K];
  }
}

function sumLedgerAmount(entries: Array<{ amountCents: number }>): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
