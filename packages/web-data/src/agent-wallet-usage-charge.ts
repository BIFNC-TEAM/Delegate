import {
  AgentUsageChargeKind,
  AgentUsageChargeStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
  type WalletLedgerMovement,
} from "./agent-wallet-ledger";
import { prisma } from "./prisma";

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

type AgentUsageChargeRecord = {
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
  agentWallet?: AgentWalletRecord;
  creatorEarnings?: CreatorEarningRecord[];
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
  frozenCents?: number;
  withdrawnCents?: number;
  currency: string;
  revenueShareBps: number;
  idempotencyKey: string;
};

type UsageChargeClient = Omit<WalletLedgerClient, "$transaction"> & {
  agentWallet: {
    findUnique(args: unknown): Promise<AgentWalletRecord | null>;
    update(args: unknown): Promise<AgentWalletRecord>;
  };
  agentUsageCharge: {
    findUnique(args: unknown): Promise<AgentUsageChargeRecord | null>;
    create(args: unknown): Promise<AgentUsageChargeRecord>;
  };
  creatorEarning: {
    findFirst(args: unknown): Promise<CreatorEarningRecord | null>;
    update(args: unknown): Promise<CreatorEarningRecord>;
    create(args: unknown): Promise<CreatorEarningRecord>;
  };
  $transaction?<T>(fn: (tx: UsageChargeClient) => Promise<T>): Promise<T>;
};

export type ApplyAgentUsageChargeInput = {
  representativeId: string;
  tokenAmount: number;
  kind?: AgentUsageChargeKind;
  quantity?: number;
  providerCostCents?: number;
  currency?: string;
  tokenPurchaseId?: string;
  idempotencyKey?: string;
};

export type AgentUsageChargeSnapshot = {
  id: string;
  agentWalletId: string;
  representativeId: string;
  tokenPurchaseId: string | null;
  kind: AgentUsageChargeKind;
  status: "created" | "applied" | "reversed";
  quantity: number;
  tokenAmount: number;
  tokenValueCents: number;
  providerCostCents: number;
  platformRevenueCents: number;
  creatorWithdrawableCents: number;
  currency: string;
  idempotencyKey: string;
  agentTokenBalance: number;
};

const SUPPORTED_USAGE_CURRENCIES = new Set(["CNY", "USD"]);

export async function applyAgentUsageCharge(
  input: ApplyAgentUsageChargeInput,
  client: UsageChargeClient = prisma,
): Promise<AgentUsageChargeSnapshot> {
  const normalized = normalizeApplyAgentUsageChargeInput(input);
  const run = async (tx: UsageChargeClient) => {
    const existing = await tx.agentUsageCharge.findUnique({
      where: { idempotencyKey: normalized.idempotencyKey },
      include: {
        agentWallet: true,
        creatorEarnings: true,
      },
    });
    if (existing) {
      return serializeAgentUsageCharge(existing);
    }

    const agentWallet = await tx.agentWallet.findUnique({
      where: { representativeId: normalized.representativeId },
      include: { representative: true },
    });
    if (!agentWallet?.representative) {
      throw new Error("Agent wallet not found.");
    }
    if (agentWallet.currency !== normalized.currency) {
      throw new Error("Agent wallet currency does not match usage currency.");
    }
    if (agentWallet.tokenBalance < normalized.tokenAmount) {
      throw new Error("Insufficient agent token balance.");
    }
    assertPositiveInteger(agentWallet.tokenUnitPriceCents, "tokenUnitPriceCents");

    const tokenValueCents = normalized.tokenAmount * agentWallet.tokenUnitPriceCents;
    const releaseSource = await tx.creatorEarning.findFirst({
      where: {
        agentWalletId: agentWallet.id,
        status: CreatorEarningStatus.PENDING,
        pendingCents: { gt: 0 },
        ...(normalized.tokenPurchaseId ? { tokenPurchaseId: normalized.tokenPurchaseId } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    const creatorWithdrawableCents = calculateCreatorWithdrawableCents(
      tokenValueCents,
      agentWallet.creatorRevenueShareBps,
      releaseSource?.pendingCents ?? 0,
    );
    const platformRevenueCents = Math.max(
      tokenValueCents - creatorWithdrawableCents - normalized.providerCostCents,
      0,
    );

    const usageCharge = await tx.agentUsageCharge.create({
      data: {
        agentWalletId: agentWallet.id,
        representativeId: agentWallet.representativeId,
        ...(normalized.tokenPurchaseId ? { tokenPurchaseId: normalized.tokenPurchaseId } : {}),
        kind: normalized.kind,
        status: AgentUsageChargeStatus.APPLIED,
        quantity: normalized.quantity,
        tokenAmount: normalized.tokenAmount,
        providerCostCents: normalized.providerCostCents,
        platformRevenueCents,
        currency: normalized.currency,
        idempotencyKey: normalized.idempotencyKey,
      },
    });

    const updatedPendingEarning =
      releaseSource && creatorWithdrawableCents > 0
        ? await tx.creatorEarning.update({
            where: { id: releaseSource.id },
            data: {
              pendingCents: {
                decrement: creatorWithdrawableCents,
              },
              status:
                releaseSource.pendingCents === creatorWithdrawableCents
                  ? CreatorEarningStatus.WITHDRAWABLE
                  : CreatorEarningStatus.PENDING,
            },
          })
        : null;
    const withdrawableEarning =
      releaseSource && updatedPendingEarning && creatorWithdrawableCents > 0
        ? await tx.creatorEarning.create({
            data: {
              ownerId: releaseSource.ownerId,
              representativeId: releaseSource.representativeId,
              agentWalletId: releaseSource.agentWalletId,
              tokenPurchaseId: releaseSource.tokenPurchaseId,
              usageChargeId: usageCharge.id,
              status: CreatorEarningStatus.WITHDRAWABLE,
              withdrawableCents: creatorWithdrawableCents,
              currency: normalized.currency,
              revenueShareBps: releaseSource.revenueShareBps,
              idempotencyKey: `creator_withdrawable:${usageCharge.id}`,
            },
          })
        : null;

    const movements = buildUsageLedgerMovements({
      agentWallet,
      usageCharge,
      pendingEarning: updatedPendingEarning,
      withdrawableEarning,
      tokenAmount: normalized.tokenAmount,
      creatorWithdrawableCents,
      providerCostCents: normalized.providerCostCents,
      platformRevenueCents,
    });
    await recordWalletLedgerTransaction(
      {
        eventGroupId: `usage_charge:${usageCharge.id}`,
        idempotencyKey: `usage_charge:${usageCharge.id}:applied`,
        currency: normalized.currency,
        initialBalances: {
          [`${AmnWalletAccountType.AGENT_TOKEN}:${agentWallet.id}`]: {
            tokenAmount: agentWallet.tokenBalance,
          },
          ...(releaseSource
            ? {
                [`${AmnWalletAccountType.CREATOR_PENDING}:${releaseSource.ownerId}:${releaseSource.representativeId}`]:
                  {
                    amountCents: releaseSource.pendingCents,
                  },
                [`${AmnWalletAccountType.CREATOR_WITHDRAWABLE}:${releaseSource.ownerId}:${releaseSource.representativeId}`]:
                  {
                    amountCents: 0,
                  },
              }
            : {}),
        },
        movements,
      },
      tx,
    );

    const updatedAgentWallet = await tx.agentWallet.update({
      where: { id: agentWallet.id },
      data: {
        tokenBalance: {
          decrement: normalized.tokenAmount,
        },
        totalConsumedTokens: {
          increment: normalized.tokenAmount,
        },
      },
    });

    return serializeAgentUsageCharge({
      ...usageCharge,
      agentWallet: updatedAgentWallet,
      creatorEarnings: withdrawableEarning ? [withdrawableEarning] : [],
    });
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

function buildUsageLedgerMovements(input: {
  agentWallet: AgentWalletRecord;
  usageCharge: AgentUsageChargeRecord;
  pendingEarning: CreatorEarningRecord | null;
  withdrawableEarning: CreatorEarningRecord | null;
  tokenAmount: number;
  creatorWithdrawableCents: number;
  providerCostCents: number;
  platformRevenueCents: number;
}): WalletLedgerMovement[] {
  const movements: WalletLedgerMovement[] = [
    {
      entryKey: "agent_token_debit",
      accountType: AmnWalletAccountType.AGENT_TOKEN,
      entryKind: AmnLedgerEntryKind.AGENT_TOKEN_DEBIT,
      agentWalletId: input.agentWallet.id,
      representativeId: input.agentWallet.representativeId,
      usageChargeId: input.usageCharge.id,
      tokenAmount: -input.tokenAmount,
      notes: "agent_usage_charge",
    },
  ];

  if (input.pendingEarning && input.withdrawableEarning && input.creatorWithdrawableCents > 0) {
    movements.push(
      {
        entryKey: "creator_pending_debit",
        accountType: AmnWalletAccountType.CREATOR_PENDING,
        entryKind: AmnLedgerEntryKind.CREATOR_PENDING_DEBIT,
        ownerId: input.pendingEarning.ownerId,
        representativeId: input.pendingEarning.representativeId,
        agentWalletId: input.agentWallet.id,
        creatorEarningId: input.pendingEarning.id,
        usageChargeId: input.usageCharge.id,
        amountCents: -input.creatorWithdrawableCents,
        notes: "agent_usage_creator_release",
      },
      {
        entryKey: "creator_withdrawable_credit",
        accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
        entryKind: AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
        ownerId: input.withdrawableEarning.ownerId,
        representativeId: input.withdrawableEarning.representativeId,
        agentWalletId: input.agentWallet.id,
        creatorEarningId: input.withdrawableEarning.id,
        usageChargeId: input.usageCharge.id,
        amountCents: input.creatorWithdrawableCents,
        notes: "agent_usage_creator_release",
      },
    );
  }

  if (input.providerCostCents > 0) {
    movements.push({
      entryKey: "provider_cost_debit",
      accountType: AmnWalletAccountType.PROVIDER_COST,
      entryKind: AmnLedgerEntryKind.PROVIDER_COST_DEBIT,
      representativeId: input.agentWallet.representativeId,
      agentWalletId: input.agentWallet.id,
      usageChargeId: input.usageCharge.id,
      amountCents: -input.providerCostCents,
      notes: "agent_usage_provider_cost",
    });
  }

  if (input.platformRevenueCents > 0) {
    movements.push({
      entryKey: "platform_revenue_credit",
      accountType: AmnWalletAccountType.PLATFORM_REVENUE,
      entryKind: AmnLedgerEntryKind.PLATFORM_REVENUE_CREDIT,
      representativeId: input.agentWallet.representativeId,
      agentWalletId: input.agentWallet.id,
      usageChargeId: input.usageCharge.id,
      amountCents: input.platformRevenueCents,
      notes: "agent_usage_platform_revenue",
    });
  }

  return movements;
}

function normalizeApplyAgentUsageChargeInput(
  input: ApplyAgentUsageChargeInput,
): Required<
  Pick<
    ApplyAgentUsageChargeInput,
    | "representativeId"
    | "tokenAmount"
    | "kind"
    | "quantity"
    | "providerCostCents"
    | "currency"
    | "idempotencyKey"
  >
> &
  Pick<ApplyAgentUsageChargeInput, "tokenPurchaseId"> {
  const representativeId = input.representativeId.trim();
  if (!representativeId) {
    throw new Error("representativeId is required.");
  }
  assertPositiveInteger(input.tokenAmount, "tokenAmount");
  const quantity = input.quantity ?? 1;
  assertPositiveInteger(quantity, "quantity");
  const providerCostCents = input.providerCostCents ?? 0;
  assertNonNegativeInteger(providerCostCents, "providerCostCents");
  const currency = input.currency ?? "CNY";
  if (!SUPPORTED_USAGE_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported usage currency: ${currency}`);
  }
  const kind = input.kind ?? AgentUsageChargeKind.MODEL_TOKEN;
  return {
    representativeId,
    tokenAmount: input.tokenAmount,
    kind,
    quantity,
    providerCostCents,
    currency,
    idempotencyKey:
      input.idempotencyKey ??
      `agent_usage:${representativeId}:${kind}:${input.tokenAmount}:${providerCostCents}`,
    ...(input.tokenPurchaseId ? { tokenPurchaseId: input.tokenPurchaseId } : {}),
  };
}

function serializeAgentUsageCharge(
  usageCharge: AgentUsageChargeRecord,
): AgentUsageChargeSnapshot {
  if (!usageCharge.agentWallet) {
    throw new Error("Agent usage charge is missing agent wallet.");
  }
  const creatorWithdrawableCents =
    usageCharge.creatorEarnings?.reduce(
      (sum, earning) => sum + earning.withdrawableCents,
      0,
    ) ?? 0;
  return {
    id: usageCharge.id,
    agentWalletId: usageCharge.agentWalletId,
    representativeId: usageCharge.representativeId,
    tokenPurchaseId: usageCharge.tokenPurchaseId,
    kind: usageCharge.kind,
    status: usageCharge.status.toLowerCase() as AgentUsageChargeSnapshot["status"],
    quantity: usageCharge.quantity,
    tokenAmount: usageCharge.tokenAmount,
    tokenValueCents:
      usageCharge.tokenAmount * usageCharge.agentWallet.tokenUnitPriceCents,
    providerCostCents: usageCharge.providerCostCents,
    platformRevenueCents: usageCharge.platformRevenueCents,
    creatorWithdrawableCents,
    currency: usageCharge.currency,
    idempotencyKey: usageCharge.idempotencyKey,
    agentTokenBalance: usageCharge.agentWallet.tokenBalance,
  };
}

function calculateCreatorWithdrawableCents(
  tokenValueCents: number,
  revenueShareBps: number,
  remainingPendingCents: number,
): number {
  if (!Number.isInteger(revenueShareBps) || revenueShareBps < 0 || revenueShareBps > 10_000) {
    throw new Error("creatorRevenueShareBps must be an integer between 0 and 10000.");
  }
  return Math.min(Math.floor((tokenValueCents * revenueShareBps) / 10_000), remainingPendingCents);
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
