import {
  AgentTokenPurchaseStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
} from "./agent-wallet-ledger";
import { prisma } from "./prisma";

type UserWalletRecord = {
  id: string;
  externalUserId: string;
  currency: string;
  cashBalanceCents: number;
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

type AgentTokenPurchaseRecord = {
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
  userWallet?: UserWalletRecord;
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
  currency: string;
  revenueShareBps: number;
  idempotencyKey: string;
};

type TokenPurchaseClient = Omit<WalletLedgerClient, "$transaction"> & {
  userWallet: {
    findUnique(args: unknown): Promise<UserWalletRecord | null>;
    update(args: unknown): Promise<UserWalletRecord>;
  };
  agentWallet: {
    findUnique(args: unknown): Promise<AgentWalletRecord | null>;
    update(args: unknown): Promise<AgentWalletRecord>;
  };
  agentTokenPurchase: {
    findUnique(args: unknown): Promise<AgentTokenPurchaseRecord | null>;
    create(args: unknown): Promise<AgentTokenPurchaseRecord>;
  };
  creatorEarning: {
    create(args: unknown): Promise<CreatorEarningRecord>;
  };
  $transaction?<T>(fn: (tx: TokenPurchaseClient) => Promise<T>): Promise<T>;
};

export type PurchaseAgentTokensInput = {
  externalUserId: string;
  representativeId: string;
  amountCents: number;
  currency?: string;
  rechargeOrderId?: string;
  idempotencyKey?: string;
};

export type AgentTokenPurchaseSnapshot = {
  id: string;
  userWalletId: string;
  agentWalletId: string;
  representativeId: string;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
  creatorPendingCents: number;
  status: "pending" | "completed" | "failed" | "refunded" | "reversed";
  idempotencyKey: string;
  cashBalanceCents: number;
  agentTokenBalance: number;
  creatorEarningId: string | null;
};

const SUPPORTED_PURCHASE_CURRENCIES = new Set(["CNY", "USD"]);

export async function purchaseAgentTokens(
  input: PurchaseAgentTokensInput,
  client: TokenPurchaseClient = prisma,
): Promise<AgentTokenPurchaseSnapshot> {
  const normalized = normalizePurchaseAgentTokensInput(input);
  const run = async (tx: TokenPurchaseClient) => {
    const existing = await tx.agentTokenPurchase.findUnique({
      where: { idempotencyKey: normalized.idempotencyKey },
      include: {
        userWallet: true,
        agentWallet: true,
        creatorEarnings: true,
      },
    });
    if (existing) {
      return serializeAgentTokenPurchase(existing);
    }

    const userWallet = await tx.userWallet.findUnique({
      where: { externalUserId: normalized.externalUserId },
    });
    if (!userWallet) {
      throw new Error("User wallet not found.");
    }
    if (userWallet.currency !== normalized.currency) {
      throw new Error("User wallet currency does not match purchase currency.");
    }
    if (userWallet.cashBalanceCents < normalized.amountCents) {
      throw new Error("Insufficient user wallet balance.");
    }

    const agentWallet = await tx.agentWallet.findUnique({
      where: { representativeId: normalized.representativeId },
      include: { representative: true },
    });
    if (!agentWallet?.representative) {
      throw new Error("Agent wallet not found.");
    }
    if (agentWallet.currency !== normalized.currency) {
      throw new Error("Agent wallet currency does not match purchase currency.");
    }
    assertPositiveInteger(agentWallet.tokenUnitPriceCents, "tokenUnitPriceCents");
    if (normalized.amountCents % agentWallet.tokenUnitPriceCents !== 0) {
      throw new Error("Purchase amount must divide evenly into agent tokens.");
    }

    const tokenAmount = normalized.amountCents / agentWallet.tokenUnitPriceCents;
    const creatorRevenueShareBps = normalizeRevenueShareBps(
      agentWallet.creatorRevenueShareBps,
    );
    const creatorPendingCents = calculateCreatorPendingCents(
      normalized.amountCents,
      creatorRevenueShareBps,
    );
    const platformRevenueCents = normalized.amountCents - creatorPendingCents;

    const purchase = await tx.agentTokenPurchase.create({
      data: {
        userWalletId: userWallet.id,
        agentWalletId: agentWallet.id,
        representativeId: agentWallet.representativeId,
        ...(normalized.rechargeOrderId ? { rechargeOrderId: normalized.rechargeOrderId } : {}),
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        tokenAmount,
        tokenUnitPriceCents: agentWallet.tokenUnitPriceCents,
        creatorRevenueShareBps,
        creatorPendingCents,
        status: AgentTokenPurchaseStatus.COMPLETED,
        idempotencyKey: normalized.idempotencyKey,
      },
    });
    const creatorEarning = await tx.creatorEarning.create({
      data: {
        ownerId: agentWallet.representative.ownerId,
        representativeId: agentWallet.representativeId,
        agentWalletId: agentWallet.id,
        tokenPurchaseId: purchase.id,
        status: CreatorEarningStatus.PENDING,
        pendingCents: creatorPendingCents,
        currency: normalized.currency,
        revenueShareBps: creatorRevenueShareBps,
        idempotencyKey: `creator_earning:${normalized.idempotencyKey}`,
      },
    });

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `token_purchase:${purchase.id}`,
        idempotencyKey: `token_purchase:${purchase.id}:completed`,
        currency: normalized.currency,
        requireBalancedAmount: true,
        initialBalances: {
          [`${AmnWalletAccountType.USER_CASH}:${userWallet.id}`]: {
            amountCents: userWallet.cashBalanceCents,
          },
          [`${AmnWalletAccountType.AGENT_TOKEN}:${agentWallet.id}`]: {
            tokenAmount: agentWallet.tokenBalance,
          },
        },
        movements: [
          {
            entryKey: "user_cash_debit",
            accountType: AmnWalletAccountType.USER_CASH,
            entryKind: AmnLedgerEntryKind.USER_CASH_DEBIT,
            userWalletId: userWallet.id,
            tokenPurchaseId: purchase.id,
            amountCents: -normalized.amountCents,
            notes: "agent_token_purchase",
          },
          {
            entryKey: "agent_token_credit",
            accountType: AmnWalletAccountType.AGENT_TOKEN,
            entryKind: AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
            agentWalletId: agentWallet.id,
            representativeId: agentWallet.representativeId,
            tokenPurchaseId: purchase.id,
            tokenAmount,
            notes: "agent_token_purchase",
          },
          {
            entryKey: "creator_pending_credit",
            accountType: AmnWalletAccountType.CREATOR_PENDING,
            entryKind: AmnLedgerEntryKind.CREATOR_PENDING_CREDIT,
            ownerId: agentWallet.representative.ownerId,
            representativeId: agentWallet.representativeId,
            agentWalletId: agentWallet.id,
            creatorEarningId: creatorEarning.id,
            tokenPurchaseId: purchase.id,
            amountCents: creatorPendingCents,
            notes: "agent_token_purchase_creator_share",
          },
          {
            entryKey: "platform_revenue_credit",
            accountType: AmnWalletAccountType.PLATFORM_REVENUE,
            entryKind: AmnLedgerEntryKind.PLATFORM_REVENUE_CREDIT,
            representativeId: agentWallet.representativeId,
            tokenPurchaseId: purchase.id,
            amountCents: platformRevenueCents,
            notes: "agent_token_purchase_platform_share",
          },
        ],
      },
      tx,
    );

    const [updatedUserWallet, updatedAgentWallet] = await Promise.all([
      tx.userWallet.update({
        where: { id: userWallet.id },
        data: {
          cashBalanceCents: {
            decrement: normalized.amountCents,
          },
        },
      }),
      tx.agentWallet.update({
        where: { id: agentWallet.id },
        data: {
          tokenBalance: {
            increment: tokenAmount,
          },
          totalPurchasedTokens: {
            increment: tokenAmount,
          },
        },
      }),
    ]);

    return serializeAgentTokenPurchase({
      ...purchase,
      userWallet: updatedUserWallet,
      agentWallet: updatedAgentWallet,
      creatorEarnings: [creatorEarning],
    });
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

function normalizePurchaseAgentTokensInput(
  input: PurchaseAgentTokensInput,
): Required<
  Pick<
    PurchaseAgentTokensInput,
    "externalUserId" | "representativeId" | "amountCents" | "currency" | "idempotencyKey"
  >
> &
  Pick<PurchaseAgentTokensInput, "rechargeOrderId"> {
  const externalUserId = input.externalUserId.trim();
  const representativeId = input.representativeId.trim();
  if (!externalUserId) {
    throw new Error("externalUserId is required.");
  }
  if (!representativeId) {
    throw new Error("representativeId is required.");
  }
  assertPositiveInteger(input.amountCents, "amountCents");
  const currency = input.currency ?? "CNY";
  if (!SUPPORTED_PURCHASE_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported purchase currency: ${currency}`);
  }
  return {
    externalUserId,
    representativeId,
    amountCents: input.amountCents,
    currency,
    idempotencyKey:
      input.idempotencyKey ??
      `agent_token_purchase:${externalUserId}:${representativeId}:${currency}:${input.amountCents}`,
    ...(input.rechargeOrderId ? { rechargeOrderId: input.rechargeOrderId } : {}),
  };
}

function serializeAgentTokenPurchase(
  purchase: AgentTokenPurchaseRecord,
): AgentTokenPurchaseSnapshot {
  if (!purchase.userWallet) {
    throw new Error("Agent token purchase is missing user wallet.");
  }
  if (!purchase.agentWallet) {
    throw new Error("Agent token purchase is missing agent wallet.");
  }
  const creatorEarning = purchase.creatorEarnings?.[0] ?? null;
  return {
    id: purchase.id,
    userWalletId: purchase.userWalletId,
    agentWalletId: purchase.agentWalletId,
    representativeId: purchase.representativeId,
    amountCents: purchase.amountCents,
    currency: purchase.currency,
    tokenAmount: purchase.tokenAmount,
    tokenUnitPriceCents: purchase.tokenUnitPriceCents,
    creatorRevenueShareBps: purchase.creatorRevenueShareBps,
    creatorPendingCents: purchase.creatorPendingCents,
    status: purchase.status.toLowerCase() as AgentTokenPurchaseSnapshot["status"],
    idempotencyKey: purchase.idempotencyKey,
    cashBalanceCents: purchase.userWallet.cashBalanceCents,
    agentTokenBalance: purchase.agentWallet.tokenBalance,
    creatorEarningId: creatorEarning?.id ?? null,
  };
}

function calculateCreatorPendingCents(amountCents: number, revenueShareBps: number): number {
  return Math.floor((amountCents * revenueShareBps) / 10_000);
}

function normalizeRevenueShareBps(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("creatorRevenueShareBps must be an integer between 0 and 10000.");
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
