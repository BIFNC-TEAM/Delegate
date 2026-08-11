import {
  AgentTokenPurchaseStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  RechargeOrderStatus,
  WalletTransactionEventType,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
} from "./agent-wallet-ledger";
import { calculateAgentWalletRevenueSplit } from "./agent-wallet-revenue-policy";
import {
  recordWalletTransaction,
  type WalletTransactionClient,
} from "./agent-wallet-transactions";
import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  resolveServiceEntitlementAudienceIdentityId,
  type ServiceEntitlementClient,
} from "./service-entitlements";
import { grantAgentWalletServiceCreditEntitlement } from "./service-entitlements-wallet-internal";
import {
  assertWalletIdempotencyField,
  resolveWalletOperationId,
  runWalletWriteTransaction,
  type WalletWriteTransactionOptions,
} from "./agent-wallet-write";
import { AgentWalletReconciliationError } from "./agent-wallet-usage-charge";
import { projectCompatibilityUnitPrice } from "./commercial-ratio";
import { prisma } from "./prisma";

type UserWalletRecord = {
  id: string;
  externalUserId: string;
  audienceIdentityId: string | null;
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

type UserAgentWalletRecord = {
  id: string;
  userWalletId: string;
  agentWalletId: string;
  currency: string;
  availableTokenAmount: number;
  reservedTokenAmount: number;
  totalPurchasedTokenAmount: number;
  totalConsumedTokenAmount: number;
};

type AgentTokenPurchaseRecord = {
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
  userWallet?: UserWalletRecord;
  userAgentWallet?: UserAgentWalletRecord;
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

type TokenPurchaseClient = Omit<WalletLedgerClient, "$transaction"> &
  WalletTransactionClient & {
  audienceIdentity?: ServiceEntitlementClient["audienceIdentity"];
  serviceEntitlementAccount: ServiceEntitlementClient["serviceEntitlementAccount"];
  serviceEntitlementLedgerEntry: ServiceEntitlementClient["serviceEntitlementLedgerEntry"];
  userWallet: {
    findUnique(args: unknown): Promise<UserWalletRecord | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  agentWallet: {
    findUnique(args: unknown): Promise<AgentWalletRecord | null>;
    update(args: unknown): Promise<AgentWalletRecord>;
  };
  userAgentWallet: {
    upsert(args: unknown): Promise<UserAgentWalletRecord>;
    update(args: unknown): Promise<UserAgentWalletRecord>;
  };
  agentTokenPurchase: {
    findUnique(args: unknown): Promise<AgentTokenPurchaseRecord | null>;
    create(args: unknown): Promise<AgentTokenPurchaseRecord>;
  };
  creatorEarning: {
    create(args: unknown): Promise<CreatorEarningRecord>;
  };
  rechargeOrder?: {
    findUnique(args: unknown): Promise<{
      id: string;
      userWalletId: string;
      representativeId: string | null;
      productCode: string | null;
      currency: string;
      amountCents: number;
      status: RechargeOrderStatus;
      productKindSnapshot?: string | null;
      billingPriceVersionId?: string | null;
      unitNameSnapshot?: string | null;
      entitlementUnitsSnapshot?: number | null;
      creatorRevenueShareBpsSnapshot?: number | null;
      platformRevenueShareBpsSnapshot?: number | null;
      refundPolicySnapshot?: string | null;
      expiryPolicySnapshot?: string | null;
      entitlementValidityDaysSnapshot?: number | null;
    } | null>;
  };
  $transaction?<T>(
    fn: (tx: TokenPurchaseClient) => Promise<T>,
    options?: WalletWriteTransactionOptions,
  ): Promise<T>;
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
  userAgentWalletId: string;
  agentWalletId: string;
  representativeId: string;
  amountCents: number;
  currency: string;
  tokenAmount: number;
  remainingTokenAmount: number;
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
  creatorPendingCents: number;
  status: "pending" | "completed" | "failed" | "refunded" | "reversed";
  idempotencyKey: string;
  audienceIdentityId: string;
  entitlementAccountId: string;
  cashBalanceCents: number;
  agentTokenBalance: number;
  availableTokenAmount: number;
  reservedTokenAmount: number;
  creatorEarningId: string | null;
};

const SUPPORTED_PURCHASE_CURRENCIES = new Set(["CNY", "USD"]);

export async function purchaseAgentTokens(
  input: PurchaseAgentTokensInput,
  client: TokenPurchaseClient = prisma as unknown as TokenPurchaseClient,
): Promise<AgentTokenPurchaseSnapshot> {
  const normalized = normalizePurchaseAgentTokensInput(input);
  const run = async (tx: TokenPurchaseClient) => {
    const existing = await tx.agentTokenPurchase.findUnique({
      where: { idempotencyKey: normalized.idempotencyKey },
      include: {
        userWallet: true,
        userAgentWallet: true,
        agentWallet: true,
        creatorEarnings: true,
      },
    });
    if (existing) {
      assertWalletIdempotencyField(
        "agent token purchase",
        "externalUserId",
        existing.userWallet?.externalUserId,
        normalized.externalUserId,
      );
      assertWalletIdempotencyField(
        "agent token purchase",
        "representativeId",
        existing.representativeId,
        normalized.representativeId,
      );
      assertWalletIdempotencyField(
        "agent token purchase",
        "amountCents",
        existing.amountCents,
        normalized.amountCents,
      );
      assertWalletIdempotencyField(
        "agent token purchase",
        "currency",
        existing.currency,
        normalized.currency,
      );
      assertWalletIdempotencyField(
        "agent token purchase",
        "rechargeOrderId",
        existing.rechargeOrderId,
        normalized.rechargeOrderId,
      );
      assertExistingTokenPurchaseMatches(existing, normalized);
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
    if (!userWallet.audienceIdentityId) {
      throw new Error(
        "User wallet must be linked to an audience identity before purchasing agent tokens.",
      );
    }
    if (userWallet.cashBalanceCents < normalized.amountCents) {
      throw new Error("Insufficient user wallet balance.");
    }
    const initialUserCashBalanceCents = userWallet.cashBalanceCents;
    let rechargeOrderTerms: RechargeOrderPurchaseTerms | null = null;
    if (normalized.rechargeOrderId && tx.rechargeOrder) {
      const rechargeOrder = await tx.rechargeOrder.findUnique({
        where: { id: normalized.rechargeOrderId },
      });
      if (
        !rechargeOrder ||
        rechargeOrder.userWalletId !== userWallet.id ||
        rechargeOrder.representativeId !== normalized.representativeId ||
        rechargeOrder.currency !== normalized.currency ||
        rechargeOrder.amountCents !== normalized.amountCents ||
        rechargeOrder.status !== RechargeOrderStatus.PAID
      ) {
        throw new Error(
          "Recharge order is not a paid order for this wallet, representative, amount, and currency.",
        );
      }
      rechargeOrderTerms =
        resolveRechargeOrderPurchaseTerms(rechargeOrder);
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
    const tokenAmount =
      rechargeOrderTerms?.entitlementUnits
      ?? resolveLegacyTokenAmount(
        normalized.amountCents,
        agentWallet.tokenUnitPriceCents,
      );
    const tokenUnitPriceCents =
      rechargeOrderTerms?.tokenUnitPriceCents
      ?? agentWallet.tokenUnitPriceCents;
    const entitlementAudienceIdentityId =
      await resolveServiceEntitlementAudienceIdentityId(
        userWallet.audienceIdentityId,
        tx as unknown as ServiceEntitlementClient,
      );
    const revenueSplit = calculateAgentWalletRevenueSplit({
      grossAmountCents: normalized.amountCents,
      creatorRevenueShareBps:
        rechargeOrderTerms?.creatorRevenueShareBps
        ?? agentWallet.creatorRevenueShareBps,
    });
    const userAgentWallet = await tx.userAgentWallet.upsert({
      where: {
        userWalletId_agentWalletId_currency: {
          userWalletId: userWallet.id,
          agentWalletId: agentWallet.id,
          currency: normalized.currency,
        },
      },
      create: {
        userWalletId: userWallet.id,
        agentWalletId: agentWallet.id,
        currency: normalized.currency,
      },
      update: {},
    });
    await assertPurchaseWalletEntitlementParity(
      {
        audienceIdentityId: entitlementAudienceIdentityId,
        representativeId: agentWallet.representativeId,
        userAgentWallet,
        scope: "Before agent token purchase",
      },
      tx,
    );

    const debit = await tx.userWallet.updateMany({
      where: {
        id: userWallet.id,
        currency: normalized.currency,
        cashBalanceCents: {
          equals: initialUserCashBalanceCents,
          gte: normalized.amountCents,
        },
      },
      data: {
        cashBalanceCents: {
          decrement: normalized.amountCents,
        },
      },
    });
    if (debit.count !== 1) {
      const concurrent = await tx.agentTokenPurchase.findUnique({
        where: { idempotencyKey: normalized.idempotencyKey },
        include: {
          userWallet: true,
          userAgentWallet: true,
          agentWallet: true,
          creatorEarnings: true,
        },
      });
      if (concurrent) {
        assertExistingTokenPurchaseMatches(concurrent, normalized);
        return serializeAgentTokenPurchase(concurrent);
      }
      throw new Error("Insufficient user wallet balance.");
    }

    const entitlement = await grantAgentWalletServiceCreditEntitlement(
      {
        audienceIdentityId: entitlementAudienceIdentityId,
        representativeId: agentWallet.representativeId,
        units: tokenAmount,
        ...(rechargeOrderTerms
          ? { unitName: rechargeOrderTerms.unitName }
          : {}),
        operationKey: `agent-token-purchase:${normalized.idempotencyKey}`,
        notes: "Granted from an agent token purchase.",
        metadata: {
          purchaseIdempotencyKey: normalized.idempotencyKey,
          userWalletId: userWallet.id,
          amountCents: normalized.amountCents,
          currency: normalized.currency,
          ...(normalized.rechargeOrderId
            ? { rechargeOrderId: normalized.rechargeOrderId }
            : {}),
          ...(rechargeOrderTerms
            ? {
                billingPriceVersionId:
                  rechargeOrderTerms.billingPriceVersionId,
              }
            : {}),
        },
      },
      tx as unknown as ServiceEntitlementClient,
    );

    const purchase = await tx.agentTokenPurchase.create({
      data: {
        userWalletId: userWallet.id,
        userAgentWalletId: userAgentWallet.id,
        agentWalletId: agentWallet.id,
        representativeId: agentWallet.representativeId,
        ...(normalized.rechargeOrderId ? { rechargeOrderId: normalized.rechargeOrderId } : {}),
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        tokenAmount,
        remainingTokenAmount: tokenAmount,
        tokenUnitPriceCents,
        creatorRevenueShareBps: revenueSplit.creatorRevenueShareBps,
        creatorPendingCents: revenueSplit.creatorShareCents,
        status: AgentTokenPurchaseStatus.COMPLETED,
        idempotencyKey: normalized.idempotencyKey,
        audienceIdentityId: entitlement.audienceIdentityId,
        entitlementAccountId: entitlement.accountId,
      },
    });
    const creatorEarning = await tx.creatorEarning.create({
      data: {
        ownerId: agentWallet.representative.ownerId,
        representativeId: agentWallet.representativeId,
        agentWalletId: agentWallet.id,
        tokenPurchaseId: purchase.id,
        status: CreatorEarningStatus.PENDING,
        pendingCents: revenueSplit.creatorShareCents,
        currency: normalized.currency,
        revenueShareBps: revenueSplit.creatorRevenueShareBps,
        idempotencyKey: `creator_earning:${normalized.idempotencyKey}`,
      },
    });

    const walletTransaction = await recordWalletTransaction(
      {
        eventGroupId: `token_purchase:${purchase.id}`,
        idempotencyKey: `token_purchase:${normalized.idempotencyKey}`,
        sourceType: "AgentTokenPurchase",
        sourceId: purchase.id,
        eventType: WalletTransactionEventType.AGENT_TOKEN_PURCHASE,
        currency: normalized.currency,
        ownerId: agentWallet.representative.ownerId,
        representativeId: agentWallet.representativeId,
        userWalletId: userWallet.id,
        metadata: {
          amountCents: normalized.amountCents,
          tokenAmount,
          userAgentWalletId: userAgentWallet.id,
          audienceIdentityId: entitlement.audienceIdentityId,
          entitlementAccountId: entitlement.accountId,
          tokenUnitPriceCents,
          creatorRevenueShareBps: revenueSplit.creatorRevenueShareBps,
        },
      },
      tx,
    );

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `token_purchase:${purchase.id}`,
        idempotencyKey: `token_purchase:${normalized.idempotencyKey}`,
        currency: normalized.currency,
        requireBalancedAmount: true,
        initialBalances: {
          [`${AmnWalletAccountType.USER_CASH}:${userWallet.id}`]: {
            amountCents: initialUserCashBalanceCents,
          },
          [`${AmnWalletAccountType.SERVICE_CREDIT_DEFERRED}:${userAgentWallet.id}`]: {
            tokenAmount:
              userAgentWallet.availableTokenAmount +
              userAgentWallet.reservedTokenAmount,
          },
        },
        movements: [
          {
            entryKey: "user_cash_debit",
            accountType: AmnWalletAccountType.USER_CASH,
            entryKind: AmnLedgerEntryKind.USER_CASH_DEBIT,
            transactionId: walletTransaction?.id ?? null,
            userWalletId: userWallet.id,
            tokenPurchaseId: purchase.id,
            amountCents: -normalized.amountCents,
            notes: "agent_token_purchase",
          },
          {
            entryKey: "service_credit_deferred_credit",
            accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
            entryKind: AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
            transactionId: walletTransaction?.id ?? null,
            userWalletId: userWallet.id,
            userAgentWalletId: userAgentWallet.id,
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
            transactionId: walletTransaction?.id ?? null,
            ownerId: agentWallet.representative.ownerId,
            representativeId: agentWallet.representativeId,
            agentWalletId: agentWallet.id,
            creatorEarningId: creatorEarning.id,
            tokenPurchaseId: purchase.id,
            amountCents: revenueSplit.creatorShareCents,
            notes: "agent_token_purchase_creator_share",
          },
          {
            entryKey: "platform_deferred_revenue_credit",
            accountType: AmnWalletAccountType.PLATFORM_DEFERRED_REVENUE,
            entryKind: AmnLedgerEntryKind.PLATFORM_DEFERRED_REVENUE_CREDIT,
            transactionId: walletTransaction?.id ?? null,
            representativeId: agentWallet.representativeId,
            tokenPurchaseId: purchase.id,
            amountCents: revenueSplit.platformGrossCents,
            notes: "agent_token_purchase_platform_deferred_share",
          },
        ],
      },
      tx,
    );

    const [updatedUserWallet, updatedUserAgentWallet, updatedAgentWallet] =
      await Promise.all([
        tx.userWallet.findUnique({
          where: { id: userWallet.id },
        }),
        tx.userAgentWallet.update({
          where: { id: userAgentWallet.id },
          data: {
            availableTokenAmount: {
              increment: tokenAmount,
            },
            totalPurchasedTokenAmount: {
              increment: tokenAmount,
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
    if (!updatedUserWallet) {
      throw new Error("User wallet disappeared during token purchase.");
    }
    if (
      entitlement.remainingUnits !== updatedUserAgentWallet.availableTokenAmount
      || entitlement.reservedUnits !== updatedUserAgentWallet.reservedTokenAmount
    ) {
      throw new AgentWalletReconciliationError(
        "Agent token purchase left wallet and service entitlement balances inconsistent.",
      );
    }

    return serializeAgentTokenPurchase({
      ...purchase,
      userWallet: updatedUserWallet,
      userAgentWallet: updatedUserAgentWallet,
      agentWallet: updatedAgentWallet,
      creatorEarnings: [creatorEarning],
    });
  };

  return runWalletWriteTransaction(client, run);
}

type RechargeOrderPurchaseTerms = {
  billingPriceVersionId: string;
  unitName: string;
  entitlementUnits: number;
  tokenUnitPriceCents: number;
  creatorRevenueShareBps: number;
};

function resolveRechargeOrderPurchaseTerms(
  order: {
    productCode: string | null;
    amountCents: number;
    productKindSnapshot?: string | null;
    billingPriceVersionId?: string | null;
    unitNameSnapshot?: string | null;
    entitlementUnitsSnapshot?: number | null;
    creatorRevenueShareBpsSnapshot?: number | null;
    platformRevenueShareBpsSnapshot?: number | null;
    refundPolicySnapshot?: string | null;
    expiryPolicySnapshot?: string | null;
    entitlementValidityDaysSnapshot?: number | null;
  },
): RechargeOrderPurchaseTerms | null {
  if (!order.billingPriceVersionId) {
    return null;
  }
  const unitName = order.unitNameSnapshot?.trim();
  const entitlementUnits = order.entitlementUnitsSnapshot;
  const creatorRevenueShareBps =
    order.creatorRevenueShareBpsSnapshot;
  const platformRevenueShareBps =
    order.platformRevenueShareBpsSnapshot;
  if (
    order.productCode !== AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
    || (order.productKindSnapshot != null
      && order.productKindSnapshot !== "SERVICE_PACKAGE")
    || unitName !== "credit"
    || typeof entitlementUnits !== "number"
    || !Number.isSafeInteger(entitlementUnits)
    || entitlementUnits <= 0
    || typeof creatorRevenueShareBps !== "number"
    || !Number.isSafeInteger(creatorRevenueShareBps)
    || creatorRevenueShareBps < 0
    || creatorRevenueShareBps > 10_000
    || typeof platformRevenueShareBps !== "number"
    || !Number.isSafeInteger(platformRevenueShareBps)
    || platformRevenueShareBps < 0
    || platformRevenueShareBps > 10_000
    || creatorRevenueShareBps + platformRevenueShareBps !== 10_000
    || order.refundPolicySnapshot !== "FULL_WHEN_UNUSED"
    || order.expiryPolicySnapshot !== "NEVER_EXPIRES"
    || order.entitlementValidityDaysSnapshot !== null
  ) {
    throw new Error(
      "Recharge order has an incomplete or unsupported commercial snapshot.",
    );
  }
  return {
    billingPriceVersionId: order.billingPriceVersionId,
    unitName,
    entitlementUnits,
    tokenUnitPriceCents: projectCompatibilityUnitPrice({
      totalAmount: order.amountCents,
      totalUnits: entitlementUnits,
    }),
    creatorRevenueShareBps,
  };
}

function resolveLegacyTokenAmount(
  amountCents: number,
  tokenUnitPriceCents: number,
): number {
  assertPositiveInteger(tokenUnitPriceCents, "tokenUnitPriceCents");
  if (amountCents % tokenUnitPriceCents !== 0) {
    throw new Error("Purchase amount must divide evenly into agent tokens.");
  }
  return amountCents / tokenUnitPriceCents;
}

async function assertPurchaseWalletEntitlementParity(
  input: {
    audienceIdentityId: string;
    representativeId: string;
    userAgentWallet: UserAgentWalletRecord;
    scope: string;
  },
  tx: TokenPurchaseClient,
) {
  const entitlementAccount = await tx.serviceEntitlementAccount.findUnique({
    where: {
      audienceIdentityId_representativeId_productCode: {
        audienceIdentityId: input.audienceIdentityId,
        representativeId: input.representativeId,
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      },
    },
  });
  if (!entitlementAccount) {
    if (
      input.userAgentWallet.availableTokenAmount !== 0
      || input.userAgentWallet.reservedTokenAmount !== 0
    ) {
      throw new AgentWalletReconciliationError(
        `${input.scope}: wallet has a balance but its service entitlement account is missing.`,
      );
    }
    return;
  }
  if (
    entitlementAccount.remainingUnits
      !== input.userAgentWallet.availableTokenAmount
    || entitlementAccount.reservedUnits
      !== input.userAgentWallet.reservedTokenAmount
  ) {
    throw new AgentWalletReconciliationError(
      `${input.scope}: wallet and service entitlement balances do not match.`,
    );
  }
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
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      "agent_token_purchase",
    ),
    ...(input.rechargeOrderId ? { rechargeOrderId: input.rechargeOrderId } : {}),
  };
}

function assertExistingTokenPurchaseMatches(
  purchase: AgentTokenPurchaseRecord,
  normalized: ReturnType<typeof normalizePurchaseAgentTokensInput>,
): void {
  if (!purchase.userWallet || !purchase.agentWallet) {
    throw new Error("Existing token purchase is missing wallet relations.");
  }
  if (!purchase.audienceIdentityId || !purchase.entitlementAccountId) {
    throw new Error(
      "Existing token purchase is missing its service entitlement link.",
    );
  }
  const mismatches = [
    purchase.userWallet.externalUserId !== normalized.externalUserId ? "owner" : null,
    purchase.representativeId !== normalized.representativeId ? "representative" : null,
    purchase.amountCents !== normalized.amountCents ? "amount" : null,
    purchase.currency !== normalized.currency ? "currency" : null,
    purchase.rechargeOrderId !== (normalized.rechargeOrderId ?? null)
      ? "recharge order"
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new Error(
      `Token purchase idempotency key was reused with different ${mismatches.join(", ")}.`,
    );
  }
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
    userAgentWalletId:
      purchase.userAgentWalletId ??
      purchase.userAgentWallet?.id ??
      missingScopedWallet("Agent token purchase is missing user-agent wallet."),
    agentWalletId: purchase.agentWalletId,
    representativeId: purchase.representativeId,
    amountCents: purchase.amountCents,
    currency: purchase.currency,
    tokenAmount: purchase.tokenAmount,
    remainingTokenAmount:
      purchase.remainingTokenAmount ?? purchase.tokenAmount,
    tokenUnitPriceCents: purchase.tokenUnitPriceCents,
    creatorRevenueShareBps: purchase.creatorRevenueShareBps,
    creatorPendingCents: purchase.creatorPendingCents,
    status: purchase.status.toLowerCase() as AgentTokenPurchaseSnapshot["status"],
    idempotencyKey: purchase.idempotencyKey,
    audienceIdentityId:
      purchase.audienceIdentityId ??
      missingScopedWallet(
        "Agent token purchase is missing its audience identity.",
      ),
    entitlementAccountId:
      purchase.entitlementAccountId ??
      missingScopedWallet(
        "Agent token purchase is missing its service entitlement account.",
      ),
    cashBalanceCents: purchase.userWallet.cashBalanceCents,
    agentTokenBalance: purchase.agentWallet.tokenBalance,
    availableTokenAmount:
      purchase.userAgentWallet?.availableTokenAmount ??
      missingScopedWallet("Agent token purchase is missing user-agent wallet."),
    reservedTokenAmount:
      purchase.userAgentWallet?.reservedTokenAmount ??
      missingScopedWallet("Agent token purchase is missing user-agent wallet."),
    creatorEarningId: creatorEarning?.id ?? null,
  };
}

function missingScopedWallet(message: string): never {
  throw new Error(message);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
