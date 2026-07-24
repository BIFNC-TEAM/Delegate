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
import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  consumeServiceEntitlement,
  releaseServiceEntitlement,
  resolveServiceEntitlementAudienceIdentityId,
  reserveServiceEntitlement,
  serviceEntitlementOperationKey,
  type ServiceEntitlementClient,
  type ServiceEntitlementSnapshot,
} from "./service-entitlements";

type UserWalletRecord = {
  id: string;
  audienceIdentityId?: string | null;
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
  audienceIdentityId?: string | null;
  entitlementAccountId?: string | null;
  conversationId?: string | null;
  generationRunId?: string | null;
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

type ServiceEntitlementAccountRecord = {
  id: string;
  audienceIdentityId: string;
  representativeId: string;
  productCode: string;
  remainingUnits: number;
  reservedUnits: number;
};

type ServiceEntitlementLedgerRecord = {
  id: string;
  entitlementAccountId: string;
  generationRunId: string | null;
  kind: string;
  units: number;
  idempotencyKey: string;
};

type GenerationRunRecord = {
  id: string;
  conversationId: string | null;
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
      updateMany?(args: unknown): Promise<{ count: number }>;
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
    serviceEntitlementAccount?: {
      findUnique(args: unknown): Promise<ServiceEntitlementAccountRecord | null>;
    };
    serviceEntitlementLedgerEntry?: {
      findUnique(args: unknown): Promise<ServiceEntitlementLedgerRecord | null>;
      findMany(args: unknown): Promise<ServiceEntitlementLedgerRecord[]>;
    };
    generationRun?: {
      findUnique(args: unknown): Promise<GenerationRunRecord | null>;
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

export class AgentWalletReconciliationError extends Error {
  readonly code = "AGENT_WALLET_RECONCILIATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "AgentWalletReconciliationError";
  }
}

export type ReserveAgentUsageCreditsInput = UsageWalletSelector & {
  representativeId: string;
  tokenAmount: number;
  kind?: AgentUsageChargeKind;
  quantity?: number;
  currency?: string;
  idempotencyKey?: string;
  audienceIdentityId?: string;
  entitlementAccountId?: string;
  conversationId?: string;
  generationRunId?: string;
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

type AgentUsageLifecycleInternalOptions = {
  allowBoundEntitlementLifecycle?: boolean;
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
  audienceIdentityId: string | null;
  entitlementAccountId: string | null;
  conversationId: string | null;
  generationRunId: string | null;
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

export type ReserveConversationWalletUsageInput = UsageWalletSelector & {
  audienceIdentityId: string;
  representativeId: string;
  generationRunId: string;
  conversationId: string;
  tokenAmount: number;
  kind?: AgentUsageChargeKind;
  quantity?: number;
  currency?: string;
  idempotencyKey: string;
};

export type SettleConversationWalletUsageInput = {
  usageChargeId: string;
  settledTokenAmount: number;
  providerCostCents?: number;
  provider?: string;
  idempotencyKey?: string;
};

export type ReleaseConversationWalletUsageInput = {
  usageChargeId: string;
  failed?: boolean;
  reason?: string;
  idempotencyKey?: string;
};

export type VerifyAgentUsageEntitlementReservationInput = {
  usageChargeId: string;
  representativeId: string;
  generationRunId: string;
  audienceIdentityId?: string;
  tokenAmount?: number;
};

export type VerifiedAgentUsageEntitlementReservation = {
  usageChargeId: string;
  entitlementAccountId: string;
  audienceIdentityId: string;
  representativeId: string;
  generationRunId: string;
  reserveGenerationRunId: string;
  tokenAmount: number;
  productCode: typeof AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE;
  reserveLedgerEntryId: string;
};

export type TransferAgentUsageEntitlementReservationInput = {
  usageChargeId: string;
  fromGenerationRunId: string;
  toGenerationRunId: string;
  conversationId: string;
};

export type AgentUsageEntitlementVerificationClient = {
  agentUsageCharge: Pick<
    UsageChargeClient["agentUsageCharge"],
    "findUnique"
  >;
  serviceEntitlementAccount: NonNullable<
    UsageChargeClient["serviceEntitlementAccount"]
  >;
  serviceEntitlementLedgerEntry: NonNullable<
    UsageChargeClient["serviceEntitlementLedgerEntry"]
  >;
  generationRun: NonNullable<UsageChargeClient["generationRun"]>;
};

type ConversationWalletUsageReadClient = {
  agentUsageCharge: Pick<
    UsageChargeClient["agentUsageCharge"],
    "findUnique"
  >;
  serviceEntitlementAccount?: UsageChargeClient["serviceEntitlementAccount"];
  serviceEntitlementLedgerEntry?: UsageChargeClient["serviceEntitlementLedgerEntry"];
  generationRun?: UsageChargeClient["generationRun"];
};

export type ConversationWalletUsageSnapshot = {
  usageCharge: AgentUsageChargeSnapshot;
  entitlement: {
    consumed: ServiceEntitlementSnapshot | null;
    released: ServiceEntitlementSnapshot | null;
    current: ServiceEntitlementSnapshot;
  };
};

const SUPPORTED_USAGE_CURRENCIES = new Set(["CNY", "USD"]);

type WalletBalanceClient = Pick<
  UsageChargeClient,
  "userWallet" | "agentWallet" | "userAgentWallet"
> & {
  serviceEntitlementAccount: NonNullable<
    UsageChargeClient["serviceEntitlementAccount"]
  >;
};

export async function getUserAgentWalletBalance(
  input: GetUserAgentWalletBalanceInput,
  client: WalletBalanceClient = prisma as unknown as WalletBalanceClient,
): Promise<UserAgentWalletBalanceSnapshot | null> {
  const externalUserId = input.externalUserId.trim();
  const representativeId = input.representativeId.trim();
  const currency = input.currency ?? "CNY";
  if (!externalUserId || !representativeId) {
    throw new Error("externalUserId and representativeId are required.");
  }
  assertSupportedCurrency(currency);

  return runWalletWriteTransaction(client, async (tx) => {
    const [userWallet, agentWallet] = await Promise.all([
      tx.userWallet.findUnique({ where: { externalUserId } }),
      tx.agentWallet.findUnique({ where: { representativeId } }),
    ]);
    if (!userWallet || !agentWallet) {
      return null;
    }
    if (!userWallet.audienceIdentityId) {
      throw new AgentWalletReconciliationError(
        "User wallet is missing audienceIdentityId and cannot be reconciled with service entitlement.",
      );
    }
    if (userWallet.currency !== currency || agentWallet.currency !== currency) {
      return null;
    }
    const canonicalAudienceIdentityId =
      await resolveServiceEntitlementAudienceIdentityId(
        userWallet.audienceIdentityId,
        tx as unknown as ServiceEntitlementClient,
      );

    const [scopedWallet, entitlementAccount] = await Promise.all([
      tx.userAgentWallet.findUnique({
        where: {
          userWalletId_agentWalletId_currency: {
            userWalletId: userWallet.id,
            agentWalletId: agentWallet.id,
            currency,
          },
        },
      }),
      tx.serviceEntitlementAccount.findUnique({
        where: {
          audienceIdentityId_representativeId_productCode: {
            audienceIdentityId: canonicalAudienceIdentityId,
            representativeId: agentWallet.representativeId,
            productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        },
      }),
    ]);

    if (!scopedWallet) {
      if (
        entitlementAccount
        && (entitlementAccount.remainingUnits !== 0
          || entitlementAccount.reservedUnits !== 0)
      ) {
        throw new AgentWalletReconciliationError(
          "Service entitlement has a non-zero balance but the user-agent wallet is missing.",
        );
      }
      return null;
    }
    if (!entitlementAccount) {
      if (
        scopedWallet.availableTokenAmount !== 0
        || scopedWallet.reservedTokenAmount !== 0
      ) {
        throw new AgentWalletReconciliationError(
          "User-agent wallet has a non-zero balance but its service entitlement account is missing.",
        );
      }
      return serializeUserAgentWalletBalance(
        scopedWallet,
        agentWallet.representativeId,
      );
    }
    assertWalletEntitlementBalances(
      scopedWallet,
      entitlementAccount,
      "User-agent wallet balance",
    );
    return serializeUserAgentWalletBalance(
      scopedWallet,
      agentWallet.representativeId,
    );
  });
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
    await assertUsageEntitlementBinding(normalized, scopedWallet, tx);
    if (scopedWallet.availableTokenAmount < normalized.tokenAmount) {
      throw new InsufficientAgentUsageCreditsError();
    }

    const reservedAt = new Date();
    const usageCharge = await tx.agentUsageCharge.create({
      data: {
        userAgentWalletId: scopedWallet.id,
        agentWalletId: scopedWallet.agentWalletId,
        representativeId: agentWallet.representativeId,
        ...(normalized.audienceIdentityId
          ? { audienceIdentityId: normalized.audienceIdentityId }
          : {}),
        ...(normalized.entitlementAccountId
          ? { entitlementAccountId: normalized.entitlementAccountId }
          : {}),
        ...(normalized.conversationId
          ? { conversationId: normalized.conversationId }
          : {}),
        ...(normalized.generationRunId
          ? { generationRunId: normalized.generationRunId }
          : {}),
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
          audienceIdentityId: normalized.audienceIdentityId ?? null,
          entitlementAccountId: normalized.entitlementAccountId ?? null,
          conversationId: normalized.conversationId ?? null,
          generationRunId: normalized.generationRunId ?? null,
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
              audienceIdentityId: normalized.audienceIdentityId ?? null,
              entitlementAccountId: normalized.entitlementAccountId ?? null,
              conversationId: normalized.conversationId ?? null,
              generationRunId: normalized.generationRunId ?? null,
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
  internalOptions: AgentUsageLifecycleInternalOptions = {},
): Promise<AgentUsageChargeSnapshot> {
  const normalized = normalizeSettleInput(input);
  const run = async (tx: UsageChargeClient) => {
    const usageCharge = await findUsageById(normalized.usageChargeId, tx);
    if (!usageCharge?.userAgentWallet || !usageCharge.agentWallet) {
      throw new Error("Reserved agent usage charge not found.");
    }
    assertStandaloneUsageLifecycleAllowed(usageCharge, internalOptions);
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
  internalOptions: AgentUsageLifecycleInternalOptions = {},
): Promise<AgentUsageChargeSnapshot> {
  const normalized = normalizeReleaseInput(input);
  const run = async (tx: UsageChargeClient) => {
    const usageCharge = await findUsageById(normalized.usageChargeId, tx);
    if (!usageCharge?.userAgentWallet || !usageCharge.agentWallet) {
      throw new Error("Reserved agent usage charge not found.");
    }
    assertStandaloneUsageLifecycleAllowed(usageCharge, internalOptions);
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
 * Atomically reserves the same service-credit units in both wallet and
 * entitlement ledgers. The entitlement account is resolved server-side from
 * the immutable audience/representative/product coordinates, then persisted
 * on AgentUsageCharge so terminal callers never rely on a client handle.
 */
export async function reserveConversationWalletUsage(
  input: ReserveConversationWalletUsageInput,
  client: UsageChargeClient = prisma,
): Promise<ConversationWalletUsageSnapshot> {
  const audienceIdentityId = requiredUsageContextText(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const representativeId = requiredUsageContextText(
    input.representativeId,
    "representativeId",
  );
  const generationRunId = requiredUsageContextText(
    input.generationRunId,
    "generationRunId",
  );
  const idempotencyKey = requiredUsageContextText(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const conversationId = requiredUsageContextText(
    input.conversationId,
    "conversationId",
  );

  return runWalletWriteTransaction(client, async (walletTx) => {
    const tx = walletTx as UsageChargeClient & ServiceEntitlementClient;
    const canonicalAudienceIdentityId =
      await resolveServiceEntitlementAudienceIdentityId(
        audienceIdentityId,
        tx,
      );
    const walletReservationInput: ReserveAgentUsageCreditsInput = {
      representativeId,
      tokenAmount: input.tokenAmount,
      ...(input.externalUserId
        ? { externalUserId: input.externalUserId }
        : {}),
      ...(input.userWalletId ? { userWalletId: input.userWalletId } : {}),
      ...(input.userAgentWalletId
        ? { userAgentWalletId: input.userAgentWalletId }
        : {}),
      ...(input.tokenPurchaseId
        ? { tokenPurchaseId: input.tokenPurchaseId }
        : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      idempotencyKey,
    };
    const normalizedWalletReservation =
      normalizeReserveInput(walletReservationInput);
    const existingUsageCharge = await findUsageByIdempotencyKey(
      idempotencyKey,
      tx,
    );
    if (!existingUsageCharge) {
      const scopedWallet = await resolveScopedWallet(
        normalizedWalletReservation,
        tx,
      );
      if (scopedWallet.availableTokenAmount < input.tokenAmount) {
        throw new InsufficientAgentUsageCreditsError();
      }
      if (!scopedWallet.userWallet?.audienceIdentityId) {
        throw new AgentWalletReconciliationError(
          "User-agent wallet is missing its audience identity.",
        );
      }
      const canonicalWalletAudienceIdentityId =
        await resolveServiceEntitlementAudienceIdentityId(
          scopedWallet.userWallet.audienceIdentityId,
          tx,
        );
      if (
        canonicalWalletAudienceIdentityId
        !== canonicalAudienceIdentityId
      ) {
        throw new AgentWalletReconciliationError(
          "User-agent wallet does not belong to the service entitlement audience.",
        );
      }
      const entitlementAccount = await tx.serviceEntitlementAccount.findUnique({
        where: {
          audienceIdentityId_representativeId_productCode: {
            audienceIdentityId: canonicalAudienceIdentityId,
            representativeId,
            productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        },
      });
      if (!entitlementAccount) {
        throw new AgentWalletReconciliationError(
          "User-agent wallet has service credits but its entitlement account is missing.",
        );
      }
      assertWalletEntitlementBalances(
        scopedWallet,
        entitlementAccount,
        "Before conversation wallet reservation",
      );
    }
    await assertGenerationRunConversation(
      generationRunId,
      conversationId,
      tx,
    );
    const entitlement = await reserveServiceEntitlement(
      {
        audienceIdentityId: canonicalAudienceIdentityId,
        representativeId,
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        units: input.tokenAmount,
        operationKey: conversationWalletEntitlementOperationKey(
          "reserve",
          idempotencyKey,
        ),
        generationRunId,
        notes: "Reserved with an agent-wallet usage charge.",
        metadata: {
          scope: "agent_wallet_usage",
          walletReservationKey: idempotencyKey,
          conversationId,
        },
      },
      tx,
    );
    const usageCharge = await reserveAgentUsageCredits(
      {
        ...walletReservationInput,
        audienceIdentityId: entitlement.audienceIdentityId,
        entitlementAccountId: entitlement.accountId,
        generationRunId,
        conversationId,
      },
      tx,
    );
    if (
      entitlement.remainingUnits !== usageCharge.availableTokenAmount
      || entitlement.reservedUnits
        !== usageCharge.walletReservedTokenAmount
    ) {
      throw new AgentWalletReconciliationError(
        "Dual-ledger reservation produced inconsistent wallet and service entitlement balances.",
      );
    }
    assertConversationWalletUsageBinding(usageCharge, {
      audienceIdentityId: entitlement.audienceIdentityId,
      representativeId,
      entitlementAccountId: entitlement.accountId,
      generationRunId,
      conversationId,
    });
    await verifyAgentUsageEntitlementReservationWithinTransaction(
      {
        usageChargeId: usageCharge.id,
        representativeId,
        generationRunId,
        audienceIdentityId: entitlement.audienceIdentityId,
        tokenAmount: input.tokenAmount,
      },
      tx,
    );
    return {
      usageCharge,
      entitlement: {
        consumed: null,
        released: null,
        current: entitlement,
      },
    };
  });
}

/**
 * Atomically settles the wallet charge and consumes the matching entitlement
 * reservation. Any unused wallet reservation is released on both ledgers.
 */
export async function settleConversationWalletUsage(
  input: SettleConversationWalletUsageInput,
  client: UsageChargeClient = prisma,
): Promise<ConversationWalletUsageSnapshot> {
  const usageChargeId = requiredUsageContextText(
    input.usageChargeId,
    "usageChargeId",
  );
  assertNonNegativeInteger(input.settledTokenAmount, "settledTokenAmount");

  return runWalletWriteTransaction(client, async (walletTx) => {
    const tx = walletTx as UsageChargeClient & ServiceEntitlementClient;
    const binding = await requireConversationWalletUsageBinding(
      usageChargeId,
      tx,
    );
    if (binding.status === AgentUsageChargeStatus.RESERVED) {
      await verifyAgentUsageEntitlementReservationWithinTransaction(
        {
          usageChargeId,
          representativeId: binding.representativeId,
          generationRunId: binding.generationRunId,
          audienceIdentityId: binding.audienceIdentityId,
          tokenAmount: binding.reservedTokenAmount,
        },
        tx,
      );
    }
    if (input.settledTokenAmount > binding.reservedTokenAmount) {
      throw new Error(
        "Settled service credits cannot exceed the dual-ledger reservation.",
      );
    }

    let consumed: ServiceEntitlementSnapshot | null = null;
    if (input.settledTokenAmount > 0) {
      consumed = await consumeServiceEntitlement(
        {
          audienceIdentityId: binding.audienceIdentityId,
          representativeId: binding.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          units: input.settledTokenAmount,
          operationKey: conversationWalletEntitlementOperationKey(
            "settle-consume",
            binding.id,
          ),
          generationRunId: binding.generationRunId,
          notes: "Consumed with an agent-wallet usage settlement.",
          metadata: {
            scope: "agent_wallet_usage",
            usageChargeId: binding.id,
          },
        },
        tx,
      );
    }
    const unusedTokenAmount =
      binding.reservedTokenAmount - input.settledTokenAmount;
    let released: ServiceEntitlementSnapshot | null = null;
    if (unusedTokenAmount > 0) {
      released = await releaseServiceEntitlement(
        {
          audienceIdentityId: binding.audienceIdentityId,
          representativeId: binding.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          units: unusedTokenAmount,
          operationKey: conversationWalletEntitlementOperationKey(
            "settle-release-unused",
            binding.id,
          ),
          generationRunId: binding.generationRunId,
          notes: "Released unused units after an agent-wallet usage settlement.",
          metadata: {
            scope: "agent_wallet_usage",
            usageChargeId: binding.id,
          },
        },
        tx,
      );
    }
    const usageCharge = await settleAgentUsageCredits(
      {
        usageChargeId,
        settledTokenAmount: input.settledTokenAmount,
        ...(input.providerCostCents !== undefined
          ? { providerCostCents: input.providerCostCents }
          : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        idempotencyKey:
          input.idempotencyKey
          ?? `conversation_wallet:${usageChargeId}:settle`,
      },
      tx,
      { allowBoundEntitlementLifecycle: true },
    );
    assertConversationWalletUsageBinding(usageCharge, binding);
    const current = released ?? consumed;
    if (!current) {
      throw new Error("Dual-ledger settlement produced no entitlement mutation.");
    }
    return {
      usageCharge,
      entitlement: { consumed, released, current },
    };
  });
}

/**
 * Atomically releases both sides of a conversation usage reservation.
 */
export async function releaseConversationWalletUsage(
  input: ReleaseConversationWalletUsageInput,
  client: UsageChargeClient = prisma,
): Promise<ConversationWalletUsageSnapshot> {
  const usageChargeId = requiredUsageContextText(
    input.usageChargeId,
    "usageChargeId",
  );
  return runWalletWriteTransaction(client, async (walletTx) => {
    const tx = walletTx as UsageChargeClient & ServiceEntitlementClient;
    const binding = await requireConversationWalletUsageBinding(
      usageChargeId,
      tx,
    );
    if (binding.status === AgentUsageChargeStatus.RESERVED) {
      await verifyAgentUsageEntitlementReservationWithinTransaction(
        {
          usageChargeId,
          representativeId: binding.representativeId,
          generationRunId: binding.generationRunId,
          audienceIdentityId: binding.audienceIdentityId,
          tokenAmount: binding.reservedTokenAmount,
        },
        tx,
      );
    }
    const entitlement = await releaseServiceEntitlement(
      {
        audienceIdentityId: binding.audienceIdentityId,
        representativeId: binding.representativeId,
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        units: binding.reservedTokenAmount,
        operationKey: conversationWalletEntitlementOperationKey(
          "release",
          binding.id,
        ),
        generationRunId: binding.generationRunId,
        notes: input.reason?.trim()
          ? `Released with agent-wallet usage: ${input.reason.trim()}`
          : "Released with an agent-wallet usage charge.",
        metadata: {
          scope: "agent_wallet_usage",
          usageChargeId: binding.id,
          failed: input.failed ?? false,
        },
      },
      tx,
    );
    const usageCharge = await releaseAgentUsageCredits(
      {
        usageChargeId,
        ...(input.failed === undefined ? {} : { failed: input.failed }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        idempotencyKey:
          input.idempotencyKey
          ?? `conversation_wallet:${usageChargeId}:release`,
      },
      tx,
      { allowBoundEntitlementLifecycle: true },
    );
    assertConversationWalletUsageBinding(usageCharge, binding);
    return {
      usageCharge,
      entitlement: {
        consumed: null,
        released: entitlement,
        current: entitlement,
      },
    };
  });
}

/**
 * Verifies the server-owned authorization facts for a reserved wallet usage
 * charge. This is intentionally read-only and fails closed if either ledger is
 * missing, inconsistent, or already has a terminal mutation for this charge.
 */
export async function verifyAgentUsageEntitlementReservation(
  input: VerifyAgentUsageEntitlementReservationInput,
  client: AgentUsageEntitlementVerificationClient =
    prisma as unknown as AgentUsageEntitlementVerificationClient,
): Promise<VerifiedAgentUsageEntitlementReservation> {
  const normalized = normalizeUsageEntitlementVerificationInput(input);
  return runWalletWriteTransaction(client, (tx) =>
    verifyAgentUsageEntitlementReservationWithinTransaction(normalized, tx),
  );
}

/**
 * Moves the current authorization owner to the next generation run without
 * rewriting the immutable entitlement reserve ledger. The conditional update
 * closes the race with settlement/release and permits only current-owner
 * transfer or an exact replay where the target is already current.
 */
export async function transferAgentUsageEntitlementReservation(
  input: TransferAgentUsageEntitlementReservationInput,
  client: UsageChargeClient = prisma,
): Promise<AgentUsageChargeSnapshot> {
  const usageChargeId = requiredUsageContextText(
    input.usageChargeId,
    "usageChargeId",
  );
  const fromGenerationRunId = requiredUsageContextText(
    input.fromGenerationRunId,
    "fromGenerationRunId",
  );
  const toGenerationRunId = requiredUsageContextText(
    input.toGenerationRunId,
    "toGenerationRunId",
  );
  const conversationId = requiredUsageContextText(
    input.conversationId,
    "conversationId",
  );
  if (fromGenerationRunId === toGenerationRunId) {
    throw new Error(
      "Agent usage entitlement reservation transfer requires a different target owner.",
    );
  }

  return runWalletWriteTransaction(client, async (tx) => {
    const binding = await requireConversationWalletUsageBinding(
      usageChargeId,
      tx,
    );
    if (binding.status !== AgentUsageChargeStatus.RESERVED) {
      throw new Error(
        `Agent usage entitlement reservation cannot be transferred from status ${binding.status}.`,
      );
    }
    if (binding.conversationId !== conversationId) {
      throw new Error(
        "Agent usage entitlement reservation does not belong to this conversation.",
      );
    }
    if (binding.generationRunId === toGenerationRunId) {
      const verified =
        await verifyAgentUsageEntitlementReservationWithinTransaction(
          {
            usageChargeId,
            representativeId: binding.representativeId,
            generationRunId: toGenerationRunId,
            audienceIdentityId: binding.audienceIdentityId,
            tokenAmount: binding.reservedTokenAmount,
          },
          tx,
        );
      await requireAgentUsageEntitlementTransferReplay(
        binding,
        fromGenerationRunId,
        toGenerationRunId,
        verified.reserveLedgerEntryId,
        tx,
      );
      return serializeAgentUsageCharge(binding);
    }
    if (binding.generationRunId !== fromGenerationRunId) {
      throw new Error(
        "Agent usage entitlement reservation is owned by a different generation run.",
      );
    }
    await assertGenerationRunConversation(
      toGenerationRunId,
      conversationId,
      tx,
    );

    const verified =
      await verifyAgentUsageEntitlementReservationWithinTransaction(
        {
          usageChargeId,
          representativeId: binding.representativeId,
          generationRunId: fromGenerationRunId,
          audienceIdentityId: binding.audienceIdentityId,
          tokenAmount: binding.reservedTokenAmount,
        },
        tx,
      );
    const transferTransaction = await recordWalletTransaction(
      agentUsageEntitlementTransferTransactionInput(
        binding,
        fromGenerationRunId,
        toGenerationRunId,
        verified.reserveLedgerEntryId,
      ),
      tx,
    );
    if (!transferTransaction) {
      throw new Error(
        "Wallet transaction audit is required for entitlement owner transfer.",
      );
    }
    if (!tx.agentUsageCharge.updateMany) {
      throw new Error(
        "Conditional usage-charge update is required for reservation transfer.",
      );
    }
    const transferred = await tx.agentUsageCharge.updateMany({
      where: {
        id: usageChargeId,
        status: AgentUsageChargeStatus.RESERVED,
        generationRunId: fromGenerationRunId,
        conversationId,
      },
      data: { generationRunId: toGenerationRunId },
    });
    if (transferred.count !== 1) {
      throw new Error(
        "Agent usage entitlement reservation owner changed concurrently.",
      );
    }

    const updated = await requireConversationWalletUsageBinding(
      usageChargeId,
      tx,
    );
    await verifyAgentUsageEntitlementReservationWithinTransaction(
      {
        usageChargeId,
        representativeId: updated.representativeId,
        generationRunId: toGenerationRunId,
        audienceIdentityId: updated.audienceIdentityId,
        tokenAmount: updated.reservedTokenAmount,
      },
      tx,
    );
    return serializeAgentUsageCharge(updated);
  });
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
  UsageWalletSelector & {
    audienceIdentityId?: string;
    entitlementAccountId?: string;
    conversationId?: string;
    generationRunId?: string;
  };

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
  const entitlementContext = normalizeUsageEntitlementContext(input);
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
    ...entitlementContext,
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

function normalizeUsageEntitlementContext(
  input: Pick<
    ReserveAgentUsageCreditsInput,
    | "audienceIdentityId"
    | "entitlementAccountId"
    | "conversationId"
    | "generationRunId"
  >,
) {
  const audienceIdentityId = optionalUsageContextText(
    input.audienceIdentityId,
  );
  const entitlementAccountId = optionalUsageContextText(
    input.entitlementAccountId,
  );
  const conversationId = optionalUsageContextText(input.conversationId);
  const generationRunId = optionalUsageContextText(input.generationRunId);
  const hasAnyContext = Boolean(
    audienceIdentityId
    || entitlementAccountId
    || conversationId
    || generationRunId,
  );
  if (!hasAnyContext) return {};
  if (!audienceIdentityId || !entitlementAccountId || !generationRunId) {
    throw new Error(
      "audienceIdentityId, entitlementAccountId, and generationRunId are required together.",
    );
  }
  return {
    audienceIdentityId,
    entitlementAccountId,
    generationRunId,
    ...(conversationId ? { conversationId } : {}),
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

async function assertUsageEntitlementBinding(
  input: NormalizedReserveInput,
  scopedWallet: UserAgentWalletRecord,
  tx: UsageChargeClient,
) {
  if (!input.audienceIdentityId) return;
  if (
    !input.entitlementAccountId
    || !input.generationRunId
    || !scopedWallet.userWallet
  ) {
    throw new Error("Agent usage entitlement binding is incomplete.");
  }
  if (
    scopedWallet.userWallet.audienceIdentityId !== input.audienceIdentityId
  ) {
    throw new Error(
      "User wallet does not belong to the usage audience identity.",
    );
  }
  if (!tx.serviceEntitlementAccount) {
    throw new Error(
      "Service entitlement account lookup is required for bound usage.",
    );
  }
  const entitlementAccount = await tx.serviceEntitlementAccount.findUnique({
    where: { id: input.entitlementAccountId },
  });
  if (
    !entitlementAccount
    || entitlementAccount.audienceIdentityId !== input.audienceIdentityId
    || entitlementAccount.representativeId !== input.representativeId
    || entitlementAccount.productCode
      !== AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
  ) {
    throw new Error(
      "Service entitlement account does not match the usage coordinates.",
    );
  }
  if (
    entitlementAccount.remainingUnits
      !== scopedWallet.availableTokenAmount - input.tokenAmount
    || entitlementAccount.reservedUnits
      !== scopedWallet.reservedTokenAmount + input.tokenAmount
  ) {
    throw new AgentWalletReconciliationError(
      "Dual-ledger reservation would leave wallet and service entitlement balances inconsistent.",
    );
  }
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
  tx: Pick<ConversationWalletUsageReadClient, "agentUsageCharge">,
): Promise<AgentUsageChargeRecord | null> {
  return tx.agentUsageCharge.findUnique({
    where: { id },
    include: usageRelationsInclude,
  });
}

function assertStandaloneUsageLifecycleAllowed(
  usageCharge: AgentUsageChargeRecord,
  options: AgentUsageLifecycleInternalOptions,
) {
  const hasEntitlementBinding = Boolean(
    usageCharge.audienceIdentityId
    || usageCharge.entitlementAccountId
    || usageCharge.conversationId
    || usageCharge.generationRunId,
  );
  if (hasEntitlementBinding && !options.allowBoundEntitlementLifecycle) {
    throw new Error(
      "Entitlement-bound usage charges must use the atomic conversation wallet lifecycle.",
    );
  }
}

type ConversationWalletUsageBinding = AgentUsageChargeRecord & {
  audienceIdentityId: string;
  entitlementAccountId: string;
  conversationId: string;
  generationRunId: string;
};

async function requireConversationWalletUsageBinding(
  usageChargeId: string,
  tx: ConversationWalletUsageReadClient,
): Promise<ConversationWalletUsageBinding> {
  const usageCharge = await findUsageById(usageChargeId, tx);
  if (
    !usageCharge
    || !usageCharge.userAgentWallet?.userWallet
    || !usageCharge.agentWallet
    || !usageCharge.audienceIdentityId
    || !usageCharge.entitlementAccountId
    || !usageCharge.conversationId
    || !usageCharge.generationRunId
  ) {
    throw new Error(
      "Agent usage charge does not contain a complete entitlement binding.",
    );
  }
  if (
    usageCharge.userAgentWallet.userWallet.audienceIdentityId
      !== usageCharge.audienceIdentityId
  ) {
    throw new Error(
      "Agent usage charge audience identity no longer matches its user wallet.",
    );
  }
  if (!tx.serviceEntitlementAccount) {
    throw new Error(
      "Service entitlement account lookup is required for bound usage.",
    );
  }
  const entitlementAccount = await tx.serviceEntitlementAccount.findUnique({
    where: { id: usageCharge.entitlementAccountId },
  });
  if (
    !entitlementAccount
    || entitlementAccount.audienceIdentityId
      !== usageCharge.audienceIdentityId
    || entitlementAccount.representativeId
      !== usageCharge.representativeId
    || entitlementAccount.productCode
      !== AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
  ) {
    throw new Error(
      "Agent usage charge entitlement account no longer matches its persisted binding.",
    );
  }
  assertWalletEntitlementBalances(
    usageCharge.userAgentWallet,
    entitlementAccount,
    "Agent usage charge",
  );
  await assertGenerationRunConversation(
    usageCharge.generationRunId,
    usageCharge.conversationId,
    tx,
  );
  return usageCharge as ConversationWalletUsageBinding;
}

async function assertGenerationRunConversation(
  generationRunId: string,
  conversationId: string,
  tx: Pick<ConversationWalletUsageReadClient, "generationRun">,
) {
  if (!tx.generationRun) {
    throw new Error(
      "Generation run lookup is required for wallet entitlement authorization.",
    );
  }
  const generationRun = await tx.generationRun.findUnique({
    where: { id: generationRunId },
    select: { id: true, conversationId: true },
  });
  if (!generationRun || generationRun.conversationId !== conversationId) {
    throw new Error(
      "Generation run does not belong to the wallet usage conversation.",
    );
  }
}

function normalizeUsageEntitlementVerificationInput(
  input: VerifyAgentUsageEntitlementReservationInput,
) {
  const audienceIdentityId =
    input.audienceIdentityId === undefined
      ? undefined
      : requiredUsageContextText(
          input.audienceIdentityId,
          "audienceIdentityId",
        );
  if (input.tokenAmount !== undefined) {
    assertPositiveInteger(input.tokenAmount, "tokenAmount");
  }
  return {
    usageChargeId: requiredUsageContextText(
      input.usageChargeId,
      "usageChargeId",
    ),
    representativeId: requiredUsageContextText(
      input.representativeId,
      "representativeId",
    ),
    generationRunId: requiredUsageContextText(
      input.generationRunId,
      "generationRunId",
    ),
    ...(audienceIdentityId ? { audienceIdentityId } : {}),
    ...(input.tokenAmount === undefined
      ? {}
      : { tokenAmount: input.tokenAmount }),
  };
}

async function verifyAgentUsageEntitlementReservationWithinTransaction(
  input: ReturnType<typeof normalizeUsageEntitlementVerificationInput>,
  tx: ConversationWalletUsageReadClient,
): Promise<VerifiedAgentUsageEntitlementReservation> {
  const binding = await requireConversationWalletUsageBinding(
    input.usageChargeId,
    tx,
  );
  if (binding.status !== AgentUsageChargeStatus.RESERVED) {
    throw new Error(
      `Agent usage entitlement authorization requires RESERVED status, received ${binding.status}.`,
    );
  }
  if (
    binding.settledTokenAmount !== 0
    || binding.releasedTokenAmount !== 0
    || binding.reservedTokenAmount <= 0
    || binding.tokenAmount !== binding.reservedTokenAmount
  ) {
    throw new Error(
      "Agent usage charge does not contain an intact reservation.",
    );
  }
  assertWalletIdempotencyField(
    "agent usage entitlement authorization",
    "representativeId",
    binding.representativeId,
    input.representativeId,
  );
  assertWalletIdempotencyField(
    "agent usage entitlement authorization",
    "generationRunId",
    binding.generationRunId,
    input.generationRunId,
  );
  if (input.audienceIdentityId) {
    assertWalletIdempotencyField(
      "agent usage entitlement authorization",
      "audienceIdentityId",
      binding.audienceIdentityId,
      input.audienceIdentityId,
    );
  }
  if (input.tokenAmount !== undefined) {
    assertWalletIdempotencyField(
      "agent usage entitlement authorization",
      "tokenAmount",
      binding.reservedTokenAmount,
      input.tokenAmount,
    );
  }
  if (!tx.serviceEntitlementLedgerEntry) {
    throw new Error(
      "Service entitlement ledger lookup is required for usage authorization.",
    );
  }

  const coordinates = {
    audienceIdentityId: binding.audienceIdentityId,
    representativeId: binding.representativeId,
    productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  };
  const reserveLedgerKey = serviceEntitlementOperationKey(
    "RESERVE",
    coordinates,
    conversationWalletEntitlementOperationKey(
      "reserve",
      binding.idempotencyKey,
    ),
  );
  const reserveEntry = await tx.serviceEntitlementLedgerEntry.findUnique({
    where: { idempotencyKey: reserveLedgerKey },
  });
  if (
    !reserveEntry
    || reserveEntry.kind !== "RESERVE"
    || reserveEntry.entitlementAccountId !== binding.entitlementAccountId
    || reserveEntry.units !== binding.reservedTokenAmount
    || !reserveEntry.generationRunId
    || reserveEntry.idempotencyKey !== reserveLedgerKey
  ) {
    throw new Error(
      "Agent usage charge is missing its matching service entitlement reserve ledger entry.",
    );
  }

  const terminalLedgerKeys = [
    serviceEntitlementOperationKey(
      "CONSUME",
      coordinates,
      conversationWalletEntitlementOperationKey(
        "settle-consume",
        binding.id,
      ),
    ),
    serviceEntitlementOperationKey(
      "RELEASE",
      coordinates,
      conversationWalletEntitlementOperationKey(
        "settle-release-unused",
        binding.id,
      ),
    ),
    serviceEntitlementOperationKey(
      "RELEASE",
      coordinates,
      conversationWalletEntitlementOperationKey("release", binding.id),
    ),
  ];
  const terminalEntries = await tx.serviceEntitlementLedgerEntry.findMany({
    where: {
      idempotencyKey: { in: terminalLedgerKeys },
    },
  });
  if (terminalEntries.length > 0) {
    throw new Error(
      "Agent usage entitlement reservation already has a terminal ledger mutation.",
    );
  }

  return {
    usageChargeId: binding.id,
    entitlementAccountId: binding.entitlementAccountId,
    audienceIdentityId: binding.audienceIdentityId,
    representativeId: binding.representativeId,
    generationRunId: binding.generationRunId,
    reserveGenerationRunId: reserveEntry.generationRunId,
    tokenAmount: binding.reservedTokenAmount,
    productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
    reserveLedgerEntryId: reserveEntry.id,
  };
}

function assertConversationWalletUsageBinding(
  usageCharge: AgentUsageChargeSnapshot,
  expected: {
    audienceIdentityId: string;
    representativeId: string;
    entitlementAccountId: string;
    generationRunId: string;
    conversationId: string;
  },
) {
  assertWalletIdempotencyField(
    "conversation wallet usage",
    "audienceIdentityId",
    usageCharge.audienceIdentityId,
    expected.audienceIdentityId,
  );
  assertWalletIdempotencyField(
    "conversation wallet usage",
    "representativeId",
    usageCharge.representativeId,
    expected.representativeId,
  );
  assertWalletIdempotencyField(
    "conversation wallet usage",
    "entitlementAccountId",
    usageCharge.entitlementAccountId,
    expected.entitlementAccountId,
  );
  assertWalletIdempotencyField(
    "conversation wallet usage",
    "generationRunId",
    usageCharge.generationRunId,
    expected.generationRunId,
  );
  assertWalletIdempotencyField(
    "conversation wallet usage",
    "conversationId",
    usageCharge.conversationId,
    expected.conversationId,
  );
}

function assertWalletEntitlementBalances(
  wallet: Pick<
    UserAgentWalletRecord,
    "availableTokenAmount" | "reservedTokenAmount"
  >,
  entitlementAccount: Pick<
    ServiceEntitlementAccountRecord,
    "remainingUnits" | "reservedUnits"
  >,
  scope: string,
) {
  if (
    entitlementAccount.remainingUnits !== wallet.availableTokenAmount
    || entitlementAccount.reservedUnits !== wallet.reservedTokenAmount
  ) {
    throw new AgentWalletReconciliationError(
      `${scope} reconciliation failed: wallet available/reserved ${wallet.availableTokenAmount}/${wallet.reservedTokenAmount} does not match entitlement remaining/reserved ${entitlementAccount.remainingUnits}/${entitlementAccount.reservedUnits}.`,
    );
  }
}

function agentUsageEntitlementTransferTransactionInput(
  binding: ConversationWalletUsageBinding,
  fromGenerationRunId: string,
  toGenerationRunId: string,
  reserveLedgerEntryId: string,
) {
  return {
    eventGroupId: `usage_entitlement_transfer:${binding.id}`,
    idempotencyKey: [
      "usage_entitlement_transfer",
      encodeURIComponent(binding.id),
      encodeURIComponent(fromGenerationRunId),
      encodeURIComponent(toGenerationRunId),
    ].join(":"),
    sourceType: "AgentUsageEntitlementTransfer",
    sourceId: binding.id,
    eventType: WalletTransactionEventType.ADJUSTMENT,
    currency: binding.currency,
    ownerId: binding.agentWallet?.representative?.ownerId ?? null,
    representativeId: binding.representativeId,
    userWalletId: binding.userAgentWallet?.userWalletId ?? null,
    metadata: {
      usageChargeId: binding.id,
      entitlementAccountId: binding.entitlementAccountId,
      audienceIdentityId: binding.audienceIdentityId,
      conversationId: binding.conversationId,
      fromGenerationRunId,
      toGenerationRunId,
      reserveLedgerEntryId,
    },
  };
}

async function requireAgentUsageEntitlementTransferReplay(
  binding: ConversationWalletUsageBinding,
  fromGenerationRunId: string,
  toGenerationRunId: string,
  reserveLedgerEntryId: string,
  tx: UsageChargeClient,
) {
  const transactionInput = agentUsageEntitlementTransferTransactionInput(
    binding,
    fromGenerationRunId,
    toGenerationRunId,
    reserveLedgerEntryId,
  );
  const existing = await findWalletTransactionByIdempotencyKey(
    transactionInput.idempotencyKey,
    tx,
  );
  if (!existing) {
    throw new Error(
      "Agent usage entitlement reservation is owned by the target run, but no matching transfer audit exists.",
    );
  }
  const replay = await recordWalletTransaction(transactionInput, tx);
  if (!replay) {
    throw new Error(
      "Wallet transaction audit is required for entitlement owner transfer.",
    );
  }
}

function conversationWalletEntitlementOperationKey(
  action:
    | "reserve"
    | "settle-consume"
    | "settle-release-unused"
    | "release",
  operationId: string,
) {
  return [
    "agent-wallet",
    "service-credit",
    action,
    encodeURIComponent(requiredUsageContextText(operationId, "operationId")),
  ].join(":");
}

function requiredUsageContextText(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function optionalUsageContextText(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
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
  if (input.audienceIdentityId) {
    assertWalletIdempotencyField(
      "agent usage reservation",
      "audienceIdentityId",
      existing.audienceIdentityId,
      input.audienceIdentityId,
    );
    assertWalletIdempotencyField(
      "agent usage reservation",
      "entitlementAccountId",
      existing.entitlementAccountId,
      input.entitlementAccountId,
    );
    assertWalletIdempotencyField(
      "agent usage reservation",
      "conversationId",
      existing.conversationId,
      input.conversationId ?? null,
    );
    assertWalletIdempotencyField(
      "agent usage reservation",
      "generationRunId",
      existing.generationRunId,
      input.generationRunId,
    );
  }
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
    audienceIdentityId: usageCharge.audienceIdentityId ?? null,
    entitlementAccountId: usageCharge.entitlementAccountId ?? null,
    conversationId: usageCharge.conversationId ?? null,
    generationRunId: usageCharge.generationRunId ?? null,
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
