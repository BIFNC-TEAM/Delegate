import {
  AgentTokenPurchaseStatus,
  AgentUsageChargeKind,
  AgentUsageChargeStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  WalletTransactionEventType,
  type Prisma,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
  type WalletLedgerMovement,
} from "./agent-wallet-ledger";
import {
  findWalletTransactionByIdempotencyKey,
  recordWalletTransaction,
  type WalletTransactionClient,
} from "./agent-wallet-transactions";
import {
  assertWalletIdempotencyField,
  resolveWalletOperationId,
  runWalletWriteTransaction,
  type WalletWriteTransactionOptions,
} from "./agent-wallet-write";
import { prisma } from "./prisma";

type UserWalletRecord = {
  id: string;
  externalUserId: string;
  currency: string;
};

type RepresentativeRecord = {
  id: string;
  ownerId: string;
};

type AgentWalletRecord = {
  id: string;
  representativeId: string;
  currency: string;
  tokenBalance: number;
  totalPurchasedTokens: number;
  totalConsumedTokens: number;
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
  representative?: RepresentativeRecord;
};

type UserAgentWalletRecord = {
  id: string;
  userWalletId: string;
  agentWalletId: string;
  currency: string;
  availableTokenAmount: number;
  reservedTokenAmount: number;
  totalPurchasedTokenAmount: number;
  totalConsumedTokenAmount: number;
  userWallet?: UserWalletRecord;
  agentWallet?: AgentWalletRecord;
};

type CreatorEarningRecord = {
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

type AgentTokenPurchaseRecord = {
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
  creatorRevenueShareBps: number;
  creatorPendingCents: number;
  status: AgentTokenPurchaseStatus;
  createdAt: Date;
  userAgentWallet?: UserAgentWalletRecord;
  agentWallet?: AgentWalletRecord;
};

type AgentUsageAllocationRecord = {
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

type AgentUsageChargeRecord = {
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
  providerCostCents: number;
  platformRevenueCents: number;
  currency: string;
  idempotencyKey: string;
  reservedAt: Date | null;
  settledAt: Date | null;
  releasedAt: Date | null;
  userAgentWallet?: UserAgentWalletRecord;
  agentWallet?: AgentWalletRecord;
  creatorEarnings?: CreatorEarningRecord[];
  allocations?: AgentUsageAllocationRecord[];
};

export type UsageChargeClient = Omit<WalletLedgerClient, "$transaction"> &
  WalletTransactionClient & {
    userWallet: {
      findUnique(args: unknown): Promise<UserWalletRecord | null>;
    };
    userAgentWallet: {
      findUnique(args: unknown): Promise<UserAgentWalletRecord | null>;
      update(args: unknown): Promise<UserAgentWalletRecord>;
    };
    agentWallet: {
      findUnique(args: unknown): Promise<AgentWalletRecord | null>;
      update(args: unknown): Promise<AgentWalletRecord>;
    };
    agentTokenPurchase: {
      findUnique(args: unknown): Promise<AgentTokenPurchaseRecord | null>;
      findMany(args: unknown): Promise<AgentTokenPurchaseRecord[]>;
      update(args: unknown): Promise<AgentTokenPurchaseRecord>;
    };
    agentUsageCharge: {
      findUnique(args: unknown): Promise<AgentUsageChargeRecord | null>;
      create(args: unknown): Promise<AgentUsageChargeRecord>;
      update(args: unknown): Promise<AgentUsageChargeRecord>;
    };
    agentUsageAllocation: {
      create(args: unknown): Promise<AgentUsageAllocationRecord>;
      findMany(args: unknown): Promise<AgentUsageAllocationRecord[]>;
    };
    creatorEarning: {
      findFirst(args: unknown): Promise<CreatorEarningRecord | null>;
      update(args: unknown): Promise<CreatorEarningRecord>;
      create(args: unknown): Promise<CreatorEarningRecord>;
    };
    $transaction?<T>(
      fn: (tx: UsageChargeClient) => Promise<T>,
      options?: WalletWriteTransactionOptions,
    ): Promise<T>;
  };

type UsageWalletSelector = {
  externalUserId?: string;
  userWalletId?: string;
  userAgentWalletId?: string;
  tokenPurchaseId?: string;
};

export type GetUserAgentWalletBalanceInput = {
  externalUserId: string;
  representativeId: string;
  currency?: string;
};

export type UserAgentWalletBalanceSnapshot = {
  id: string;
  userWalletId: string;
  agentWalletId: string;
  representativeId: string;
  currency: string;
  availableTokenAmount: number;
  reservedTokenAmount: number;
  totalPurchasedTokenAmount: number;
  totalConsumedTokenAmount: number;
};

export type ReserveAgentUsageCreditsInput = UsageWalletSelector & {
  representativeId: string;
  tokenAmount: number;
  kind?: AgentUsageChargeKind;
  quantity?: number;
  currency?: string;
  idempotencyKey?: string;
};

export type SettleAgentUsageCreditsInput = {
  usageChargeId: string;
  settledTokenAmount: number;
  providerCostCents?: number;
  provider?: string;
  idempotencyKey?: string;
};

export type ReleaseAgentUsageCreditsInput = {
  usageChargeId: string;
  failed?: boolean;
  reason?: string;
  idempotencyKey?: string;
};

export class InsufficientAgentUsageCreditsError extends Error {
  readonly code = "INSUFFICIENT_AGENT_USAGE_CREDITS";

  constructor() {
    super("Insufficient user-agent available service credits.");
    this.name = "InsufficientAgentUsageCreditsError";
  }
}

export type ApplyAgentUsageChargeInput = UsageWalletSelector & {
  representativeId: string;
  tokenAmount: number;
  kind?: AgentUsageChargeKind;
  quantity?: number;
  providerCostCents?: number;
  provider?: string;
  currency?: string;
  idempotencyKey?: string;
};

export type AgentUsageChargeSnapshot = {
  id: string;
  userAgentWalletId: string;
  userWalletId: string;
  agentWalletId: string;
  representativeId: string;
  tokenPurchaseId: string | null;
  kind: AgentUsageChargeKind;
  status:
    | "created"
    | "applied"
    | "reversed"
    | "reserved"
    | "settled"
    | "released"
    | "failed";
  quantity: number;
  tokenAmount: number;
  reservedTokenAmount: number;
  settledTokenAmount: number;
  releasedTokenAmount: number;
  tokenValueCents: number;
  providerCostCents: number;
  platformRevenueCents: number;
  creatorWithdrawableCents: number;
  currency: string;
  idempotencyKey: string;
  availableTokenAmount: number;
  walletReservedTokenAmount: number;
  agentTokenBalance: number;
  allocations: Array<{
    tokenPurchaseId: string;
    tokenAmount: number;
    valueCents: number;
    creatorReleaseCents: number;
  }>;
};

const SUPPORTED_USAGE_CURRENCIES = new Set(["CNY", "USD"]);

export async function getUserAgentWalletBalance(
  input: GetUserAgentWalletBalanceInput,
  client: Pick<UsageChargeClient, "userWallet" | "agentWallet" | "userAgentWallet"> =
    prisma,
): Promise<UserAgentWalletBalanceSnapshot | null> {
  const externalUserId = input.externalUserId.trim();
  const representativeId = input.representativeId.trim();
  const currency = input.currency ?? "CNY";
  if (!externalUserId || !representativeId) {
    throw new Error("externalUserId and representativeId are required.");
  }
  assertSupportedCurrency(currency);

  const [userWallet, agentWallet] = await Promise.all([
    client.userWallet.findUnique({ where: { externalUserId } }),
    client.agentWallet.findUnique({ where: { representativeId } }),
  ]);
  if (!userWallet || !agentWallet) {
    return null;
  }
  if (userWallet.currency !== currency || agentWallet.currency !== currency) {
    return null;
  }

  const scopedWallet = await client.userAgentWallet.findUnique({
    where: {
      userWalletId_agentWalletId_currency: {
        userWalletId: userWallet.id,
        agentWalletId: agentWallet.id,
        currency,
      },
    },
  });
  return scopedWallet
    ? serializeUserAgentWalletBalance(scopedWallet, agentWallet.representativeId)
    : null;
}

export async function reserveAgentUsageCredits(
  input: ReserveAgentUsageCreditsInput,
  client: UsageChargeClient = prisma,
): Promise<AgentUsageChargeSnapshot> {
  const normalized = normalizeReserveInput(input);
  const run = async (tx: UsageChargeClient) => {
    const existing = await findUsageByIdempotencyKey(normalized.idempotencyKey, tx);
    if (existing) {
      assertReservationReplay(existing, normalized);
      return serializeAgentUsageCharge(existing);
    }

    const scopedWallet = await resolveScopedWallet(normalized, tx);
    const agentWallet = scopedWallet.agentWallet;
    if (!agentWallet?.representative) {
      throw new Error("User-agent wallet is missing its representative.");
    }
    if (scopedWallet.availableTokenAmount < normalized.tokenAmount) {
      throw new InsufficientAgentUsageCreditsError();
    }

    const reservedAt = new Date();
    const usageCharge = await tx.agentUsageCharge.create({
      data: {
        userAgentWalletId: scopedWallet.id,
        agentWalletId: scopedWallet.agentWalletId,
        representativeId: agentWallet.representativeId,
        ...(normalized.tokenPurchaseId
          ? { tokenPurchaseId: normalized.tokenPurchaseId }
          : {}),
        kind: normalized.kind,
        status: AgentUsageChargeStatus.RESERVED,
        quantity: normalized.quantity,
        tokenAmount: normalized.tokenAmount,
        reservedTokenAmount: normalized.tokenAmount,
        settledTokenAmount: 0,
        releasedTokenAmount: 0,
        providerCostCents: 0,
        platformRevenueCents: 0,
        currency: normalized.currency,
        idempotencyKey: normalized.idempotencyKey,
        reservedAt,
      },
    });

    const walletTransaction = await recordWalletTransaction(
      {
        eventGroupId: `usage_reservation:${usageCharge.id}`,
        idempotencyKey: `usage_reservation:${normalized.idempotencyKey}`,
        sourceType: "AgentUsageCharge",
        sourceId: usageCharge.id,
        eventType: WalletTransactionEventType.USAGE_RESERVATION,
        currency: normalized.currency,
        ownerId: agentWallet.representative.ownerId,
        representativeId: agentWallet.representativeId,
        userWalletId: scopedWallet.userWalletId,
        metadata: {
          userAgentWalletId: scopedWallet.id,
          tokenAmount: normalized.tokenAmount,
          kind: normalized.kind,
          quantity: normalized.quantity,
        },
      },
      tx,
    );

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `usage_reservation:${usageCharge.id}`,
        idempotencyKey: `usage_reservation:${normalized.idempotencyKey}`,
        currency: normalized.currency,
        initialBalances: {
          [`${AmnWalletAccountType.SERVICE_CREDIT_DEFERRED}:${scopedWallet.id}`]: {
            tokenAmount:
              scopedWallet.availableTokenAmount +
              scopedWallet.reservedTokenAmount,
          },
        },
        movements: [
          {
            entryKey: "service_credit_reserve",
            accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
            entryKind: AmnLedgerEntryKind.SERVICE_CREDIT_RESERVE,
            transactionId: walletTransaction?.id ?? null,
            userWalletId: scopedWallet.userWalletId,
            userAgentWalletId: scopedWallet.id,
            agentWalletId: scopedWallet.agentWalletId,
            representativeId: agentWallet.representativeId,
            usageChargeId: usageCharge.id,
            notes: "service_credit_reservation",
            metadata: {
              availableTokenDelta: -normalized.tokenAmount,
              reservedTokenDelta: normalized.tokenAmount,
            },
          },
        ],
      },
      tx,
    );

    const updatedScopedWallet = await tx.userAgentWallet.update({
      where: { id: scopedWallet.id },
      data: {
        availableTokenAmount: { decrement: normalized.tokenAmount },
        reservedTokenAmount: { increment: normalized.tokenAmount },
      },
    });

    return serializeAgentUsageCharge({
      ...usageCharge,
      userAgentWallet: {
        ...updatedScopedWallet,
        ...(scopedWallet.userWallet
          ? { userWallet: scopedWallet.userWallet }
          : {}),
        agentWallet,
      },
      agentWallet,
      creatorEarnings: [],
      allocations: [],
    });
  };

  return runWalletWriteTransaction(client, run);
}

export async function settleAgentUsageCredits(
  input: SettleAgentUsageCreditsInput,
  client: UsageChargeClient = prisma,
): Promise<AgentUsageChargeSnapshot> {
  const normalized = normalizeSettleInput(input);
  const run = async (tx: UsageChargeClient) => {
    const usageCharge = await findUsageById(normalized.usageChargeId, tx);
    if (!usageCharge?.userAgentWallet || !usageCharge.agentWallet) {
      throw new Error("Reserved agent usage charge not found.");
    }
    if (usageCharge.status === AgentUsageChargeStatus.SETTLED) {
      const replay = await findWalletTransactionByIdempotencyKey(
        `usage_settlement:${normalized.idempotencyKey}`,
        tx,
      );
      if (!replay) {
        throw new Error("Agent usage charge was already settled by another operation.");
      }
      assertWalletIdempotencyField(
        "agent usage settlement",
        "settledTokenAmount",
        usageCharge.settledTokenAmount,
        normalized.settledTokenAmount,
      );
      assertWalletIdempotencyField(
        "agent usage settlement",
        "providerCostCents",
        usageCharge.providerCostCents,
        normalized.providerCostCents,
      );
      assertWalletIdempotencyField(
        "agent usage settlement",
        "provider",
        jsonRecord(replay.metadata).provider,
        normalized.provider,
      );
      return serializeAgentUsageCharge(usageCharge);
    }
    if (usageCharge.status !== AgentUsageChargeStatus.RESERVED) {
      throw new Error(
        `Agent usage charge cannot be settled from status ${usageCharge.status}.`,
      );
    }
    if (normalized.settledTokenAmount > usageCharge.reservedTokenAmount) {
      throw new Error("Settled service credits cannot exceed the reservation.");
    }

    const lots = await tx.agentTokenPurchase.findMany({
      where: {
        userAgentWalletId: usageCharge.userAgentWallet.id,
        status: AgentTokenPurchaseStatus.COMPLETED,
        remainingTokenAmount: { gt: 0 },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const availableInLots = lots.reduce(
      (sum, lot) => sum + (lot.remainingTokenAmount ?? 0),
      0,
    );
    if (availableInLots < normalized.settledTokenAmount) {
      throw new Error("Service-credit purchase lots do not cover settlement.");
    }

    const allocationPlans = buildFifoAllocationPlans(
      lots,
      normalized.settledTokenAmount,
    );
    const creatorPendingById = new Map<string, CreatorEarningRecord>();
    for (const plan of allocationPlans) {
      if (plan.creatorReleaseCents === 0) {
        continue;
      }
      const pendingEarning = await tx.creatorEarning.findFirst({
        where: {
          tokenPurchaseId: plan.purchase.id,
          status: CreatorEarningStatus.PENDING,
          pendingCents: { gt: 0 },
        },
        orderBy: { createdAt: "asc" },
      });
      if (!pendingEarning || pendingEarning.pendingCents < plan.creatorReleaseCents) {
        throw new Error(
          `Creator pending earning is inconsistent for purchase ${plan.purchase.id}.`,
        );
      }
      creatorPendingById.set(plan.purchase.id, pendingEarning);
    }

    const settledAt = new Date();
    const releasedTokenAmount =
      usageCharge.reservedTokenAmount - normalized.settledTokenAmount;
    const creatorWithdrawableEarnings: CreatorEarningRecord[] = [];
    const allocations: AgentUsageAllocationRecord[] = [];

    for (const plan of allocationPlans) {
      await tx.agentTokenPurchase.update({
        where: { id: plan.purchase.id },
        data: {
          remainingTokenAmount: {
            decrement: plan.tokenAmount,
          },
        },
      });

      const pendingEarning = creatorPendingById.get(plan.purchase.id) ?? null;
      let withdrawableEarning: CreatorEarningRecord | null = null;
      if (pendingEarning && plan.creatorReleaseCents > 0) {
        await tx.creatorEarning.update({
          where: { id: pendingEarning.id },
          data: {
            pendingCents: { decrement: plan.creatorReleaseCents },
            status:
              pendingEarning.pendingCents === plan.creatorReleaseCents
                ? CreatorEarningStatus.WITHDRAWABLE
                : CreatorEarningStatus.PENDING,
          },
        });
        withdrawableEarning = await tx.creatorEarning.create({
          data: {
            ownerId: pendingEarning.ownerId,
            representativeId: pendingEarning.representativeId,
            agentWalletId: pendingEarning.agentWalletId,
            tokenPurchaseId: plan.purchase.id,
            usageChargeId: usageCharge.id,
            status: CreatorEarningStatus.WITHDRAWABLE,
            withdrawableCents: plan.creatorReleaseCents,
            currency: usageCharge.currency,
            revenueShareBps: plan.purchase.creatorRevenueShareBps,
            idempotencyKey: `creator_withdrawable:${usageCharge.id}:${plan.purchase.id}`,
          },
        });
        creatorWithdrawableEarnings.push(withdrawableEarning);
      }

      allocations.push(
        await tx.agentUsageAllocation.create({
          data: {
            usageChargeId: usageCharge.id,
            tokenPurchaseId: plan.purchase.id,
            creatorEarningId: withdrawableEarning?.id ?? null,
            tokenAmount: plan.tokenAmount,
            valueCents: plan.valueCents,
            creatorReleaseCents: plan.creatorReleaseCents,
            currency: usageCharge.currency,
            releasedAt: settledAt,
          },
        }),
      );
    }

    const tokenValueCents = allocationPlans.reduce(
      (sum, plan) => sum + plan.valueCents,
      0,
    );
    const creatorReleaseCents = allocationPlans.reduce(
      (sum, plan) => sum + plan.creatorReleaseCents,
      0,
    );
    const platformRevenueCents = tokenValueCents - creatorReleaseCents;
    const walletTransaction = await recordWalletTransaction(
      {
        eventGroupId: `usage_settlement:${usageCharge.id}`,
        idempotencyKey: `usage_settlement:${normalized.idempotencyKey}`,
        sourceType: "AgentUsageCharge",
        sourceId: usageCharge.id,
        eventType: WalletTransactionEventType.USAGE_SETTLEMENT,
        currency: usageCharge.currency,
        ...(usageCharge.agentWallet.representative?.ownerId
          ? { ownerId: usageCharge.agentWallet.representative.ownerId }
          : {}),
        representativeId: usageCharge.representativeId,
        userWalletId: usageCharge.userAgentWallet.userWalletId,
        metadata: {
          userAgentWalletId: usageCharge.userAgentWallet.id,
          reservedTokenAmount: usageCharge.reservedTokenAmount,
          settledTokenAmount: normalized.settledTokenAmount,
          releasedTokenAmount,
          providerCostCents: normalized.providerCostCents,
          provider: normalized.provider,
        },
      },
      tx,
    );

    const movements = buildSettlementLedgerMovements({
      usageCharge,
      allocationPlans,
      creatorPendingById,
      creatorWithdrawableEarnings,
      walletTransactionId: walletTransaction?.id,
      settledTokenAmount: normalized.settledTokenAmount,
      platformRevenueCents,
      providerCostCents: normalized.providerCostCents,
      provider: normalized.provider,
    });
    await recordWalletLedgerTransaction(
      {
        eventGroupId: `usage_settlement:${usageCharge.id}`,
        idempotencyKey: `usage_settlement:${normalized.idempotencyKey}`,
        currency: usageCharge.currency,
        requireBalancedAmount: true,
        initialBalances: settlementInitialBalances(usageCharge),
        movements,
      },
      tx,
    );

    const [updatedScopedWallet, updatedAgentWallet, updatedUsageCharge] =
      await Promise.all([
        tx.userAgentWallet.update({
          where: { id: usageCharge.userAgentWallet.id },
          data: {
            reservedTokenAmount: {
              decrement: usageCharge.reservedTokenAmount,
            },
            ...(releasedTokenAmount > 0
              ? {
                  availableTokenAmount: {
                    increment: releasedTokenAmount,
                  },
                }
              : {}),
            totalConsumedTokenAmount: {
              increment: normalized.settledTokenAmount,
            },
          },
        }),
        tx.agentWallet.update({
          where: { id: usageCharge.agentWallet.id },
          data: {
            tokenBalance: {
              decrement: normalized.settledTokenAmount,
            },
            totalConsumedTokens: {
              increment: normalized.settledTokenAmount,
            },
          },
        }),
        tx.agentUsageCharge.update({
          where: { id: usageCharge.id },
          data: {
            status: AgentUsageChargeStatus.SETTLED,
            settledTokenAmount: normalized.settledTokenAmount,
            releasedTokenAmount,
            providerCostCents: normalized.providerCostCents,
            platformRevenueCents,
            settledAt,
            ...(releasedTokenAmount > 0 ? { releasedAt: settledAt } : {}),
          },
        }),
      ]);

    return serializeAgentUsageCharge({
      ...updatedUsageCharge,
      userAgentWallet: {
        ...updatedScopedWallet,
        ...(usageCharge.userAgentWallet.userWallet
          ? { userWallet: usageCharge.userAgentWallet.userWallet }
          : {}),
        agentWallet: updatedAgentWallet,
      },
      agentWallet: updatedAgentWallet,
      creatorEarnings: creatorWithdrawableEarnings,
      allocations,
    });
  };

  return runWalletWriteTransaction(client, run);
}

export async function releaseAgentUsageCredits(
  input: ReleaseAgentUsageCreditsInput,
  client: UsageChargeClient = prisma,
): Promise<AgentUsageChargeSnapshot> {
  const normalized = normalizeReleaseInput(input);
  const run = async (tx: UsageChargeClient) => {
    const usageCharge = await findUsageById(normalized.usageChargeId, tx);
    if (!usageCharge?.userAgentWallet || !usageCharge.agentWallet) {
      throw new Error("Reserved agent usage charge not found.");
    }
    const targetStatus = normalized.failed
      ? AgentUsageChargeStatus.FAILED
      : AgentUsageChargeStatus.RELEASED;
    if (
      usageCharge.status === AgentUsageChargeStatus.RELEASED ||
      usageCharge.status === AgentUsageChargeStatus.FAILED
    ) {
      const replay = await findWalletTransactionByIdempotencyKey(
        `usage_release:${normalized.idempotencyKey}`,
        tx,
      );
      if (!replay) {
        throw new Error("Agent usage reservation was already released by another operation.");
      }
      assertWalletIdempotencyField(
        "agent usage release",
        "status",
        usageCharge.status,
        targetStatus,
      );
      assertWalletIdempotencyField(
        "agent usage release",
        "reason",
        jsonRecord(replay.metadata).reason,
        normalized.reason,
      );
      return serializeAgentUsageCharge(usageCharge);
    }
    if (usageCharge.status !== AgentUsageChargeStatus.RESERVED) {
      throw new Error(
        `Agent usage charge cannot be released from status ${usageCharge.status}.`,
      );
    }

    const releasedAt = new Date();
    const walletTransaction = await recordWalletTransaction(
      {
        eventGroupId: `usage_release:${usageCharge.id}`,
        idempotencyKey: `usage_release:${normalized.idempotencyKey}`,
        sourceType: "AgentUsageCharge",
        sourceId: usageCharge.id,
        eventType: WalletTransactionEventType.USAGE_RELEASE,
        currency: usageCharge.currency,
        ...(usageCharge.agentWallet.representative?.ownerId
          ? { ownerId: usageCharge.agentWallet.representative.ownerId }
          : {}),
        representativeId: usageCharge.representativeId,
        userWalletId: usageCharge.userAgentWallet.userWalletId,
        metadata: {
          userAgentWalletId: usageCharge.userAgentWallet.id,
          releasedTokenAmount: usageCharge.reservedTokenAmount,
          failed: normalized.failed,
          reason: normalized.reason ?? null,
        },
      },
      tx,
    );
    await recordWalletLedgerTransaction(
      {
        eventGroupId: `usage_release:${usageCharge.id}`,
        idempotencyKey: `usage_release:${normalized.idempotencyKey}`,
        currency: usageCharge.currency,
        initialBalances: {
          [`${AmnWalletAccountType.SERVICE_CREDIT_DEFERRED}:${usageCharge.userAgentWallet.id}`]:
            {
              tokenAmount:
                usageCharge.userAgentWallet.availableTokenAmount +
                usageCharge.userAgentWallet.reservedTokenAmount,
            },
        },
        movements: [
          {
            entryKey: "service_credit_release",
            accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
            entryKind: AmnLedgerEntryKind.SERVICE_CREDIT_RELEASE,
            transactionId: walletTransaction?.id ?? null,
            userWalletId: usageCharge.userAgentWallet.userWalletId,
            userAgentWalletId: usageCharge.userAgentWallet.id,
            agentWalletId: usageCharge.agentWallet.id,
            representativeId: usageCharge.representativeId,
            usageChargeId: usageCharge.id,
            notes: normalized.reason ?? "service_credit_reservation_release",
            metadata: {
              availableTokenDelta: usageCharge.reservedTokenAmount,
              reservedTokenDelta: -usageCharge.reservedTokenAmount,
              failed: normalized.failed,
            },
          },
        ],
      },
      tx,
    );

    const [updatedScopedWallet, updatedUsageCharge] = await Promise.all([
      tx.userAgentWallet.update({
        where: { id: usageCharge.userAgentWallet.id },
        data: {
          availableTokenAmount: {
            increment: usageCharge.reservedTokenAmount,
          },
          reservedTokenAmount: {
            decrement: usageCharge.reservedTokenAmount,
          },
        },
      }),
      tx.agentUsageCharge.update({
        where: { id: usageCharge.id },
        data: {
          status: targetStatus,
          releasedTokenAmount: usageCharge.reservedTokenAmount,
          releasedAt,
        },
      }),
    ]);

    return serializeAgentUsageCharge({
      ...updatedUsageCharge,
      userAgentWallet: {
        ...updatedScopedWallet,
        ...(usageCharge.userAgentWallet.userWallet
          ? { userWallet: usageCharge.userAgentWallet.userWallet }
          : {}),
        agentWallet: usageCharge.agentWallet,
      },
      agentWallet: usageCharge.agentWallet,
      creatorEarnings: [],
      allocations: [],
    });
  };

  return runWalletWriteTransaction(client, run);
}

/**
 * Compatibility helper for callers that still charge in one step. It fails
 * closed unless a user-scoped wallet can be resolved, then executes the same
 * reserve and settle lifecycle with stable derived child keys.
 */
export async function applyAgentUsageCharge(
  input: ApplyAgentUsageChargeInput,
  client: UsageChargeClient = prisma,
): Promise<AgentUsageChargeSnapshot> {
  const operationId = resolveWalletOperationId(
    input.idempotencyKey,
    "agent_usage",
  );
  return runWalletWriteTransaction(
    client,
    async (tx) => {
      const reservation = await reserveAgentUsageCredits(
        {
          representativeId: input.representativeId,
          tokenAmount: input.tokenAmount,
          ...(input.externalUserId ? { externalUserId: input.externalUserId } : {}),
          ...(input.userWalletId ? { userWalletId: input.userWalletId } : {}),
          ...(input.userAgentWalletId
            ? { userAgentWalletId: input.userAgentWalletId }
            : {}),
          ...(input.tokenPurchaseId
            ? { tokenPurchaseId: input.tokenPurchaseId }
            : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.quantity ? { quantity: input.quantity } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          idempotencyKey: operationId,
        },
        tx,
      );

      return settleAgentUsageCredits(
        {
          usageChargeId: reservation.id,
          settledTokenAmount: input.tokenAmount,
          providerCostCents: input.providerCostCents ?? 0,
          ...(input.provider ? { provider: input.provider } : {}),
          idempotencyKey: `${operationId}:settle`,
        },
        tx,
      );
    },
  );
}

type NormalizedReserveInput = Required<
  Pick<
    ReserveAgentUsageCreditsInput,
    | "representativeId"
    | "tokenAmount"
    | "kind"
    | "quantity"
    | "currency"
    | "idempotencyKey"
  >
> &
  UsageWalletSelector;

function normalizeReserveInput(
  input: ReserveAgentUsageCreditsInput,
): NormalizedReserveInput {
  const representativeId = input.representativeId.trim();
  if (!representativeId) {
    throw new Error("representativeId is required.");
  }
  assertPositiveInteger(input.tokenAmount, "tokenAmount");
  const quantity = input.quantity ?? 1;
  assertPositiveInteger(quantity, "quantity");
  const currency = input.currency ?? "CNY";
  assertSupportedCurrency(currency);
  const selectors = normalizeUsageWalletSelector(input);
  if (!Object.values(selectors).some(Boolean)) {
    throw new Error(
      "A user-scoped wallet selector is required (externalUserId, userWalletId, userAgentWalletId, or tokenPurchaseId).",
    );
  }
  return {
    representativeId,
    tokenAmount: input.tokenAmount,
    kind: input.kind ?? AgentUsageChargeKind.MODEL_TOKEN,
    quantity,
    currency,
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      "agent_usage_reservation",
    ),
    ...selectors,
  };
}

function normalizeSettleInput(input: SettleAgentUsageCreditsInput) {
  const usageChargeId = input.usageChargeId.trim();
  if (!usageChargeId) {
    throw new Error("usageChargeId is required.");
  }
  assertNonNegativeInteger(input.settledTokenAmount, "settledTokenAmount");
  const providerCostCents = input.providerCostCents ?? 0;
  assertNonNegativeInteger(providerCostCents, "providerCostCents");
  const provider = input.provider?.trim() || "runtime";
  return {
    usageChargeId,
    settledTokenAmount: input.settledTokenAmount,
    providerCostCents,
    provider,
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      "agent_usage_settlement",
    ),
  };
}

function normalizeReleaseInput(input: ReleaseAgentUsageCreditsInput) {
  const usageChargeId = input.usageChargeId.trim();
  if (!usageChargeId) {
    throw new Error("usageChargeId is required.");
  }
  return {
    usageChargeId,
    failed: input.failed ?? false,
    reason: input.reason?.trim() || undefined,
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      "agent_usage_release",
    ),
  };
}

function normalizeUsageWalletSelector(
  input: UsageWalletSelector,
): UsageWalletSelector {
  return {
    ...(input.externalUserId?.trim()
      ? { externalUserId: input.externalUserId.trim() }
      : {}),
    ...(input.userWalletId?.trim()
      ? { userWalletId: input.userWalletId.trim() }
      : {}),
    ...(input.userAgentWalletId?.trim()
      ? { userAgentWalletId: input.userAgentWalletId.trim() }
      : {}),
    ...(input.tokenPurchaseId?.trim()
      ? { tokenPurchaseId: input.tokenPurchaseId.trim() }
      : {}),
  };
}

async function resolveScopedWallet(
  input: NormalizedReserveInput,
  tx: UsageChargeClient,
): Promise<UserAgentWalletRecord> {
  if (input.tokenPurchaseId) {
    const purchase = await tx.agentTokenPurchase.findUnique({
      where: { id: input.tokenPurchaseId },
      include: {
        userAgentWallet: {
          include: {
            userWallet: true,
            agentWallet: { include: { representative: true } },
          },
        },
      },
    });
    if (!purchase?.userAgentWalletId || !purchase.userAgentWallet) {
      throw new Error(
        "Token purchase is historical or ambiguous and cannot identify a user-agent wallet.",
      );
    }
    if (purchase.status !== AgentTokenPurchaseStatus.COMPLETED) {
      throw new Error("Token purchase is not available for usage.");
    }
    return validateResolvedScopedWallet(purchase.userAgentWallet, input);
  }

  if (input.userAgentWalletId) {
    const scopedWallet = await tx.userAgentWallet.findUnique({
      where: { id: input.userAgentWalletId },
      include: {
        userWallet: true,
        agentWallet: { include: { representative: true } },
      },
    });
    if (!scopedWallet) {
      throw new Error("User-agent wallet not found.");
    }
    return validateResolvedScopedWallet(scopedWallet, input);
  }

  let userWalletId = input.userWalletId;
  if (!userWalletId && input.externalUserId) {
    const userWallet = await tx.userWallet.findUnique({
      where: { externalUserId: input.externalUserId },
    });
    if (!userWallet) {
      throw new InsufficientAgentUsageCreditsError();
    }
    userWalletId = userWallet.id;
  }
  if (!userWalletId) {
    throw new Error("A user wallet selector is required.");
  }

  const agentWallet = await tx.agentWallet.findUnique({
    where: { representativeId: input.representativeId },
    include: { representative: true },
  });
  if (!agentWallet) {
    throw new Error("Agent wallet not found.");
  }
  const scopedWallet = await tx.userAgentWallet.findUnique({
    where: {
      userWalletId_agentWalletId_currency: {
        userWalletId,
        agentWalletId: agentWallet.id,
        currency: input.currency,
      },
    },
    include: {
      userWallet: true,
      agentWallet: { include: { representative: true } },
    },
  });
  if (!scopedWallet) {
    throw new InsufficientAgentUsageCreditsError();
  }
  return validateResolvedScopedWallet(scopedWallet, input);
}

function validateResolvedScopedWallet(
  scopedWallet: UserAgentWalletRecord,
  input: NormalizedReserveInput,
): UserAgentWalletRecord {
  if (!scopedWallet.agentWallet) {
    throw new Error("User-agent wallet is missing its agent wallet.");
  }
  if (scopedWallet.agentWallet.representativeId !== input.representativeId) {
    throw new Error("User-agent wallet does not belong to this representative.");
  }
  if (
    scopedWallet.currency !== input.currency ||
    scopedWallet.agentWallet.currency !== input.currency
  ) {
    throw new Error("User-agent wallet currency does not match usage currency.");
  }
  if (
    input.userAgentWalletId &&
    scopedWallet.id !== input.userAgentWalletId
  ) {
    throw new Error("Resolved service credits do not match userAgentWalletId.");
  }
  if (
    input.userWalletId &&
    scopedWallet.userWalletId !== input.userWalletId
  ) {
    throw new Error("User-agent wallet does not belong to this user wallet.");
  }
  if (
    input.externalUserId &&
    scopedWallet.userWallet?.externalUserId !== input.externalUserId
  ) {
    throw new Error("User-agent wallet does not belong to this external user.");
  }
  return scopedWallet;
}

async function findUsageByIdempotencyKey(
  idempotencyKey: string,
  tx: UsageChargeClient,
): Promise<AgentUsageChargeRecord | null> {
  return tx.agentUsageCharge.findUnique({
    where: { idempotencyKey },
    include: usageRelationsInclude,
  });
}

async function findUsageById(
  id: string,
  tx: UsageChargeClient,
): Promise<AgentUsageChargeRecord | null> {
  return tx.agentUsageCharge.findUnique({
    where: { id },
    include: usageRelationsInclude,
  });
}

const usageRelationsInclude = {
  userAgentWallet: {
    include: {
      userWallet: true,
      agentWallet: { include: { representative: true } },
    },
  },
  agentWallet: { include: { representative: true } },
  creatorEarnings: true,
  allocations: true,
};

function assertReservationReplay(
  existing: AgentUsageChargeRecord,
  input: NormalizedReserveInput,
): void {
  assertWalletIdempotencyField(
    "agent usage reservation",
    "representativeId",
    existing.representativeId,
    input.representativeId,
  );
  assertWalletIdempotencyField(
    "agent usage reservation",
    "tokenAmount",
    existing.tokenAmount,
    input.tokenAmount,
  );
  assertWalletIdempotencyField(
    "agent usage reservation",
    "kind",
    existing.kind,
    input.kind,
  );
  assertWalletIdempotencyField(
    "agent usage reservation",
    "quantity",
    existing.quantity,
    input.quantity,
  );
  assertWalletIdempotencyField(
    "agent usage reservation",
    "currency",
    existing.currency,
    input.currency,
  );
  assertWalletIdempotencyField(
    "agent usage reservation",
    "tokenPurchaseId",
    existing.tokenPurchaseId,
    input.tokenPurchaseId,
  );
  if (input.userAgentWalletId) {
    assertWalletIdempotencyField(
      "agent usage reservation",
      "userAgentWalletId",
      existing.userAgentWalletId,
      input.userAgentWalletId,
    );
  }
  if (input.userWalletId) {
    assertWalletIdempotencyField(
      "agent usage reservation",
      "userWalletId",
      existing.userAgentWallet?.userWalletId,
      input.userWalletId,
    );
  }
  if (input.externalUserId) {
    assertWalletIdempotencyField(
      "agent usage reservation",
      "externalUserId",
      existing.userAgentWallet?.userWallet?.externalUserId,
      input.externalUserId,
    );
  }
}

type AllocationPlan = {
  purchase: AgentTokenPurchaseRecord;
  tokenAmount: number;
  valueCents: number;
  creatorReleaseCents: number;
};

function buildFifoAllocationPlans(
  lots: AgentTokenPurchaseRecord[],
  settledTokenAmount: number,
): AllocationPlan[] {
  let left = settledTokenAmount;
  const plans: AllocationPlan[] = [];
  for (const purchase of lots) {
    if (left === 0) {
      break;
    }
    const remaining = purchase.remainingTokenAmount;
    if (remaining === null) {
      throw new Error(
        `Historical token purchase ${purchase.id} has no scoped remaining balance.`,
      );
    }
    const tokenAmount = Math.min(left, remaining);
    if (tokenAmount === 0) {
      continue;
    }
    const consumedBefore = purchase.tokenAmount - remaining;
    const consumedAfter = consumedBefore + tokenAmount;
    const creatorBefore = Math.floor(
      (purchase.creatorPendingCents * consumedBefore) /
        purchase.tokenAmount,
    );
    const creatorAfter = Math.floor(
      (purchase.creatorPendingCents * consumedAfter) /
        purchase.tokenAmount,
    );
    plans.push({
      purchase,
      tokenAmount,
      valueCents: tokenAmount * purchase.tokenUnitPriceCents,
      creatorReleaseCents: creatorAfter - creatorBefore,
    });
    left -= tokenAmount;
  }
  if (left !== 0) {
    throw new Error("Service-credit purchase lots do not cover settlement.");
  }
  return plans;
}

function buildSettlementLedgerMovements(input: {
  usageCharge: AgentUsageChargeRecord;
  allocationPlans: AllocationPlan[];
  creatorPendingById: Map<string, CreatorEarningRecord>;
  creatorWithdrawableEarnings: CreatorEarningRecord[];
  walletTransactionId: string | undefined;
  settledTokenAmount: number;
  platformRevenueCents: number;
  providerCostCents: number;
  provider: string;
}): WalletLedgerMovement[] {
  const scopedWallet = input.usageCharge.userAgentWallet;
  if (!scopedWallet) {
    throw new Error("Usage settlement is missing a user-agent wallet.");
  }
  const movements: WalletLedgerMovement[] = [
    {
      entryKey: "service_credit_settle",
      accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
      entryKind: AmnLedgerEntryKind.SERVICE_CREDIT_SETTLE,
      transactionId: input.walletTransactionId ?? null,
      userWalletId: scopedWallet.userWalletId,
      userAgentWalletId: scopedWallet.id,
      agentWalletId: input.usageCharge.agentWalletId,
      representativeId: input.usageCharge.representativeId,
      usageChargeId: input.usageCharge.id,
      tokenAmount: -input.settledTokenAmount,
      notes: "service_credit_settlement",
      metadata: {
        reservedTokenDelta: -input.usageCharge.reservedTokenAmount,
        availableTokenDelta:
          input.usageCharge.reservedTokenAmount -
          input.settledTokenAmount,
      },
    },
  ];

  for (const [index, plan] of input.allocationPlans.entries()) {
    const pending = input.creatorPendingById.get(plan.purchase.id);
    const withdrawable = input.creatorWithdrawableEarnings.find(
      (earning) => earning.tokenPurchaseId === plan.purchase.id,
    );
    if (!pending || !withdrawable || plan.creatorReleaseCents === 0) {
      continue;
    }
    movements.push(
      {
        entryKey: `creator_pending_debit_${index}`,
        accountType: AmnWalletAccountType.CREATOR_PENDING,
        entryKind: AmnLedgerEntryKind.CREATOR_PENDING_DEBIT,
        transactionId: input.walletTransactionId ?? null,
        ownerId: pending.ownerId,
        representativeId: pending.representativeId,
        agentWalletId: pending.agentWalletId,
        creatorEarningId: pending.id,
        tokenPurchaseId: plan.purchase.id,
        usageChargeId: input.usageCharge.id,
        amountCents: -plan.creatorReleaseCents,
        notes: "service_credit_creator_release",
      },
      {
        entryKey: `creator_withdrawable_credit_${index}`,
        accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
        entryKind: AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
        transactionId: input.walletTransactionId ?? null,
        ownerId: withdrawable.ownerId,
        representativeId: withdrawable.representativeId,
        agentWalletId: withdrawable.agentWalletId,
        creatorEarningId: withdrawable.id,
        tokenPurchaseId: plan.purchase.id,
        usageChargeId: input.usageCharge.id,
        amountCents: plan.creatorReleaseCents,
        notes: "service_credit_creator_release",
      },
    );
  }

  if (input.platformRevenueCents > 0) {
    movements.push(
      {
        entryKey: "platform_deferred_revenue_debit",
        accountType: AmnWalletAccountType.PLATFORM_DEFERRED_REVENUE,
        entryKind: AmnLedgerEntryKind.PLATFORM_DEFERRED_REVENUE_DEBIT,
        transactionId: input.walletTransactionId ?? null,
        representativeId: input.usageCharge.representativeId,
        agentWalletId: input.usageCharge.agentWalletId,
        usageChargeId: input.usageCharge.id,
        amountCents: -input.platformRevenueCents,
        notes: "service_credit_platform_revenue_recognition",
      },
      {
        entryKey: "platform_earned_revenue_credit",
        accountType: AmnWalletAccountType.PLATFORM_EARNED_REVENUE,
        entryKind: AmnLedgerEntryKind.PLATFORM_EARNED_REVENUE_CREDIT,
        transactionId: input.walletTransactionId ?? null,
        representativeId: input.usageCharge.representativeId,
        agentWalletId: input.usageCharge.agentWalletId,
        usageChargeId: input.usageCharge.id,
        amountCents: input.platformRevenueCents,
        notes: "service_credit_platform_revenue_recognition",
      },
    );
  }

  if (input.providerCostCents > 0) {
    movements.push(
      {
        entryKey: "provider_cost_debit",
        accountType: AmnWalletAccountType.PROVIDER_COST,
        entryKind: AmnLedgerEntryKind.PROVIDER_COST_DEBIT,
        transactionId: input.walletTransactionId ?? null,
        representativeId: input.usageCharge.representativeId,
        agentWalletId: input.usageCharge.agentWalletId,
        usageChargeId: input.usageCharge.id,
        amountCents: -input.providerCostCents,
        notes: "runtime_provider_cost",
      },
      {
        entryKey: "provider_settlement_credit",
        accountType: AmnWalletAccountType.EXTERNAL_SETTLEMENT,
        entryKind: AmnLedgerEntryKind.EXTERNAL_SETTLEMENT_CREDIT,
        transactionId: input.walletTransactionId ?? null,
        representativeId: input.usageCharge.representativeId,
        agentWalletId: input.usageCharge.agentWalletId,
        usageChargeId: input.usageCharge.id,
        amountCents: input.providerCostCents,
        notes: "runtime_provider_cost_payable",
        metadata: {
          provider: input.provider,
        },
      },
    );
  }

  return movements;
}

function settlementInitialBalances(
  usageCharge: AgentUsageChargeRecord,
): Record<string, { amountCents?: number; tokenAmount?: number }> {
  const scopedWallet = usageCharge.userAgentWallet;
  if (!scopedWallet) {
    throw new Error("Usage settlement is missing a user-agent wallet.");
  }
  return {
    [`${AmnWalletAccountType.SERVICE_CREDIT_DEFERRED}:${scopedWallet.id}`]: {
      tokenAmount:
        scopedWallet.availableTokenAmount +
        scopedWallet.reservedTokenAmount,
    },
  };
}

function serializeAgentUsageCharge(
  usageCharge: AgentUsageChargeRecord,
): AgentUsageChargeSnapshot {
  if (!usageCharge.userAgentWallet) {
    throw new Error("Agent usage charge is missing user-agent wallet.");
  }
  if (!usageCharge.agentWallet) {
    throw new Error("Agent usage charge is missing agent wallet.");
  }
  const allocations = usageCharge.allocations ?? [];
  return {
    id: usageCharge.id,
    userAgentWalletId: usageCharge.userAgentWallet.id,
    userWalletId: usageCharge.userAgentWallet.userWalletId,
    agentWalletId: usageCharge.agentWalletId,
    representativeId: usageCharge.representativeId,
    tokenPurchaseId: usageCharge.tokenPurchaseId,
    kind: usageCharge.kind,
    status:
      usageCharge.status.toLowerCase() as AgentUsageChargeSnapshot["status"],
    quantity: usageCharge.quantity,
    tokenAmount: usageCharge.tokenAmount,
    reservedTokenAmount: usageCharge.reservedTokenAmount,
    settledTokenAmount: usageCharge.settledTokenAmount,
    releasedTokenAmount: usageCharge.releasedTokenAmount,
    tokenValueCents: allocations.reduce(
      (sum, allocation) => sum + allocation.valueCents,
      0,
    ),
    providerCostCents: usageCharge.providerCostCents,
    platformRevenueCents: usageCharge.platformRevenueCents,
    creatorWithdrawableCents:
      usageCharge.creatorEarnings?.reduce(
        (sum, earning) => sum + earning.withdrawableCents,
        0,
      ) ?? 0,
    currency: usageCharge.currency,
    idempotencyKey: usageCharge.idempotencyKey,
    availableTokenAmount:
      usageCharge.userAgentWallet.availableTokenAmount,
    walletReservedTokenAmount:
      usageCharge.userAgentWallet.reservedTokenAmount,
    agentTokenBalance: usageCharge.agentWallet.tokenBalance,
    allocations: allocations.map((allocation) => ({
      tokenPurchaseId: allocation.tokenPurchaseId,
      tokenAmount: allocation.tokenAmount,
      valueCents: allocation.valueCents,
      creatorReleaseCents: allocation.creatorReleaseCents,
    })),
  };
}

function serializeUserAgentWalletBalance(
  wallet: UserAgentWalletRecord,
  representativeId: string,
): UserAgentWalletBalanceSnapshot {
  return {
    id: wallet.id,
    userWalletId: wallet.userWalletId,
    agentWalletId: wallet.agentWalletId,
    representativeId,
    currency: wallet.currency,
    availableTokenAmount: wallet.availableTokenAmount,
    reservedTokenAmount: wallet.reservedTokenAmount,
    totalPurchasedTokenAmount: wallet.totalPurchasedTokenAmount,
    totalConsumedTokenAmount: wallet.totalConsumedTokenAmount,
  };
}

function assertSupportedCurrency(currency: string): void {
  if (!SUPPORTED_USAGE_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported usage currency: ${currency}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
