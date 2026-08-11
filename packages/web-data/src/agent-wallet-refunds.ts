import {
  AgentTokenPurchaseStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  BillingProductKind,
  BillingRefundPolicy,
  CreatorEarningStatus,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeOrderStatus,
  RechargeRefundProviderStatus,
  TipContributionStatus,
  WalletTransactionEventType,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
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
import { calculateCumulativeRevenueAllocationDifference } from "./commercial-ratio";
import { commercialRefundPolicyConflictReason } from "./commercial-refund-entitlements";
import { prisma } from "./prisma";
import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  type ServiceEntitlementClient,
} from "./service-entitlements";
import { refundAgentWalletServiceCreditEntitlement } from "./service-entitlements-wallet-internal";
import { AgentWalletReconciliationError } from "./agent-wallet-usage-charge";

type UserWalletRecord = {
  id: string;
  externalUserId: string;
  currency: string;
  cashBalanceCents: number;
};

type AgentWalletRecord = {
  id: string;
  representativeId: string;
  currency: string;
  tokenBalance: number;
  totalPurchasedTokens: number;
  totalConsumedTokens: number;
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

type RechargeOrderRecord = {
  id: string;
  userWalletId: string;
  provider: PaymentProvider;
  providerOrderId: string | null;
  amountCents: number;
  currency: string;
  status: RechargeOrderStatus;
  productKindSnapshot?: BillingProductKind | null;
  refundPolicySnapshot?: BillingRefundPolicy | null;
  refundedAt: Date | null;
  userWallet?: UserWalletRecord;
};

type PaymentProviderEventRecord = {
  id: string;
  provider: PaymentProvider;
  providerEventId: string;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
  rechargeRefundId?: string | null;
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
  creatorPendingCents: number;
  status: AgentTokenPurchaseStatus;
  idempotencyKey: string;
  refundedAt: Date | null;
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
  status: CreatorEarningStatus;
  pendingCents: number;
  withdrawableCents: number;
  currency: string;
};

type RechargeRefundClient = Omit<WalletLedgerClient, "$transaction"> &
  WalletTransactionClient & {
  userWallet: {
    update(args: unknown): Promise<UserWalletRecord>;
  };
  rechargeOrder: {
    findUnique(args: unknown): Promise<RechargeOrderRecord | null>;
    update(args: unknown): Promise<RechargeOrderRecord>;
  };
  rechargeRefund?: {
    findUnique(args: unknown): Promise<{
      id: string;
      rechargeOrderId: string;
      provider: PaymentProvider;
      providerStatus: RechargeRefundProviderStatus | null;
      originalAmountCents: number;
      refundAmountCents: number;
      payerOriginalAmountCents: number | null;
      payerRefundAmountCents: number | null;
      currency: string;
    } | null>;
  };
  paymentProviderEvent: {
    upsert(args: unknown): Promise<PaymentProviderEventRecord>;
  };
  $transaction?<T>(
    fn: (tx: RechargeRefundClient) => Promise<T>,
    options?: WalletWriteTransactionOptions,
  ): Promise<T>;
};

type PurchaseReversalClient = Omit<WalletLedgerClient, "$transaction"> &
  WalletTransactionClient & {
  audienceIdentity?: ServiceEntitlementClient["audienceIdentity"];
  serviceEntitlementAccount: ServiceEntitlementClient["serviceEntitlementAccount"];
  serviceEntitlementLedgerEntry: ServiceEntitlementClient["serviceEntitlementLedgerEntry"];
  userWallet: {
    update(args: unknown): Promise<UserWalletRecord>;
  };
  agentWallet: {
    update(args: unknown): Promise<AgentWalletRecord>;
  };
  userAgentWallet: {
    update(args: unknown): Promise<UserAgentWalletRecord>;
  };
  agentTokenPurchase: {
    findUnique(args: unknown): Promise<AgentTokenPurchaseRecord | null>;
    update(args: unknown): Promise<AgentTokenPurchaseRecord>;
  };
  creatorEarning: {
    findFirst(args: unknown): Promise<CreatorEarningRecord | null>;
    update(args: unknown): Promise<CreatorEarningRecord>;
  };
  $transaction?<T>(
    fn: (tx: PurchaseReversalClient) => Promise<T>,
    options?: WalletWriteTransactionOptions,
  ): Promise<T>;
};

export type RefundRechargeOrderInput = {
  providerEventId?: string;
  rechargeRefundId?: string;
  refundedAt?: Date;
  reason?: string;
};

export type RechargeRefundSnapshot = {
  rechargeOrderId: string;
  status: "created" | "requires_payment" | "paid" | "failed" | "canceled" | "refunded";
  amountCents: number;
  currency: string;
  cashBalanceCents: number;
  paymentProviderEventId: string | null;
  refundedAt: string | null;
};

export type ReverseAgentTokenPurchaseInput = {
  reason?: string;
  tokenAmount?: number;
  idempotencyKey?: string;
};

export type AgentTokenPurchaseReversalSnapshot = {
  purchaseId: string;
  status: "pending" | "completed" | "failed" | "refunded" | "reversed";
  amountCents: number;
  currency: string;
  tokenAmount: number;
  remainingTokenAmount: number;
  reversedAmountCents: number;
  cashBalanceCents: number;
  agentTokenBalance: number;
  creatorReversedCents: number;
  refundedAt: string | null;
  audienceIdentityId: string;
  entitlementAccountId: string;
};

export async function refundRechargeOrder(
  rechargeOrderId: string,
  input: RefundRechargeOrderInput = {},
  client: RechargeRefundClient = prisma,
): Promise<RechargeRefundSnapshot> {
  if (!rechargeOrderId.trim()) {
    throw new Error("Recharge order id is required.");
  }

  const run = async (tx: RechargeRefundClient) => {
    const order = await tx.rechargeOrder.findUnique({
      where: { id: rechargeOrderId },
      include: { userWallet: true },
    });
    if (!order?.userWallet) {
      throw new Error("Recharge order not found.");
    }
    if (order.status === RechargeOrderStatus.REFUNDED) {
      return serializeRechargeRefund(order, null);
    }
    if (order.status !== RechargeOrderStatus.PAID) {
      throw new Error(`Recharge order cannot be refunded from status ${order.status}.`);
    }
    if (commercialRefundPolicyConflictReason(order)) {
      const commercialClient = tx as RechargeRefundClient & {
        tipContribution?: {
          findUnique(args: unknown): Promise<{
            status: TipContributionStatus;
            refundedAt: Date | null;
            creatorEarning: {
              status: CreatorEarningStatus;
              pendingCents: number;
              withdrawableCents: number;
              frozenCents: number;
              withdrawnCents: number;
            };
          } | null>;
        };
      };
      const forcedProviderRefund =
        input.rechargeRefundId && tx.rechargeRefund
          ? await tx.rechargeRefund.findUnique({
              where: { id: input.rechargeRefundId },
            })
          : null;
      const reversedTipReceipt =
        order.productKindSnapshot === BillingProductKind.TIP
        && commercialClient.tipContribution
          ? await commercialClient.tipContribution.findUnique({
              where: { rechargeOrderId: order.id },
              include: { creatorEarning: true },
            })
          : null;
      if (
        !forcedProviderRefund
        || forcedProviderRefund.rechargeOrderId !== order.id
        || forcedProviderRefund.provider !== order.provider
        || forcedProviderRefund.providerStatus
          !== RechargeRefundProviderStatus.SUCCEEDED
        || forcedProviderRefund.currency !== order.currency
        || forcedProviderRefund.originalAmountCents !== order.amountCents
        || forcedProviderRefund.refundAmountCents !== order.amountCents
        || forcedProviderRefund.payerOriginalAmountCents !== order.amountCents
        || forcedProviderRefund.payerRefundAmountCents !== order.amountCents
        || !reversedTipReceipt
        || reversedTipReceipt.status !== TipContributionStatus.REFUNDED
        || reversedTipReceipt.refundedAt === null
        || reversedTipReceipt.creatorEarning.status
          !== CreatorEarningStatus.REVERSED
        || reversedTipReceipt.creatorEarning.pendingCents !== 0
        || reversedTipReceipt.creatorEarning.withdrawableCents !== 0
        || reversedTipReceipt.creatorEarning.frozenCents !== 0
        || reversedTipReceipt.creatorEarning.withdrawnCents !== 0
      ) {
        throw new Error(
          "Tips and other non-refundable products cannot be refunded.",
        );
      }
    }
    if (order.userWallet.cashBalanceCents < order.amountCents) {
      throw new Error("Recharge refund requires unspent user wallet cash.");
    }

    const refundedAt = input.refundedAt ?? new Date();
    const providerEventId =
      input.providerEventId ?? `refund_${order.provider.toLowerCase()}_${order.id}`;
    const providerEvent = await tx.paymentProviderEvent.upsert({
      where: {
        provider_providerEventId: {
          provider: order.provider,
          providerEventId,
        },
      },
      create: {
        provider: order.provider,
        providerEventId,
        eventType: PaymentProviderEventType.REFUND_SUCCEEDED,
        rechargeOrderId: order.id,
        ...(input.rechargeRefundId
          ? { rechargeRefundId: input.rechargeRefundId }
          : {}),
        rawPayload: {
          provider: order.provider,
          providerEventId,
          rechargeOrderId: order.id,
          rechargeRefundId: input.rechargeRefundId ?? null,
          reason: input.reason ?? null,
        },
        normalizedPayload: {
          type: "RechargeRefunded",
          rechargeOrderId: order.id,
          rechargeRefundId: input.rechargeRefundId ?? null,
          amountCents: order.amountCents,
          currency: order.currency,
        },
        processedAt: refundedAt,
        idempotencyKey: `refund:${order.provider}:${providerEventId}`,
      },
      update: {
        processedAt: refundedAt,
      },
    });
    assertWalletIdempotencyField(
      "recharge refund event",
      "rechargeOrderId",
      providerEvent.rechargeOrderId,
      order.id,
    );
    assertWalletIdempotencyField(
      "recharge refund event",
      "eventType",
      providerEvent.eventType,
      PaymentProviderEventType.REFUND_SUCCEEDED,
    );
    if (input.rechargeRefundId) {
      assertWalletIdempotencyField(
        "recharge refund event",
        "rechargeRefundId",
        providerEvent.rechargeRefundId ?? null,
        input.rechargeRefundId,
      );
    }

    const walletTransaction = await recordWalletTransaction(
      {
        eventGroupId: `recharge_refund:${order.id}`,
        idempotencyKey: `recharge_refund:${order.id}:completed`,
        sourceType: "RechargeOrder",
        sourceId: order.id,
        eventType: WalletTransactionEventType.REFUND,
        currency: order.currency,
        userWalletId: order.userWallet.id,
        metadata: {
          amountCents: order.amountCents,
          paymentProvider: order.provider,
          paymentProviderEventId: providerEvent.id,
          reason: input.reason ?? null,
        },
      },
      tx,
    );

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `recharge_refund:${order.id}`,
        idempotencyKey: `recharge_refund:${order.id}:completed`,
        currency: order.currency,
        requireBalancedAmount: true,
        initialBalances: {
          [`${AmnWalletAccountType.USER_CASH}:${order.userWallet.id}`]: {
            amountCents: order.userWallet.cashBalanceCents,
          },
        },
        movements: [
          {
            entryKey: "user_cash_refund_debit",
            accountType: AmnWalletAccountType.USER_CASH,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            transactionId: walletTransaction?.id ?? null,
            userWalletId: order.userWallet.id,
            rechargeOrderId: order.id,
            paymentProviderEventId: providerEvent.id,
            amountCents: -order.amountCents,
            notes: input.reason ?? "recharge_refund",
          },
          {
            entryKey: "external_settlement_refund_credit",
            accountType: AmnWalletAccountType.EXTERNAL_SETTLEMENT,
            entryKind: AmnLedgerEntryKind.EXTERNAL_SETTLEMENT_CREDIT,
            transactionId: walletTransaction?.id ?? null,
            rechargeOrderId: order.id,
            paymentProviderEventId: providerEvent.id,
            amountCents: order.amountCents,
            notes: input.reason ?? "recharge_refund",
            metadata: {
              provider: order.provider,
            },
          },
        ],
      },
      tx,
    );

    const [updatedWallet, updatedOrder] = await Promise.all([
      tx.userWallet.update({
        where: { id: order.userWallet.id },
        data: {
          cashBalanceCents: {
            decrement: order.amountCents,
          },
        },
      }),
      tx.rechargeOrder.update({
        where: { id: order.id },
        data: {
          status: RechargeOrderStatus.REFUNDED,
          refundedAt,
        },
      }),
    ]);

    return serializeRechargeRefund(
      { ...updatedOrder, userWallet: updatedWallet },
      providerEvent,
    );
  };

  return runWalletWriteTransaction(client, run);
}

export async function reverseAgentTokenPurchase(
  purchaseId: string,
  input: ReverseAgentTokenPurchaseInput = {},
  client: PurchaseReversalClient = prisma as unknown as PurchaseReversalClient,
): Promise<AgentTokenPurchaseReversalSnapshot> {
  if (!purchaseId.trim()) {
    throw new Error("Agent token purchase id is required.");
  }
  if (typeof input.tokenAmount !== "undefined") {
    assertPositiveInteger(input.tokenAmount, "tokenAmount");
  }
  const operationId = resolveWalletOperationId(
    input.idempotencyKey,
    "agent_token_purchase_reversal",
  );
  const transactionIdempotencyKey = `token_purchase_reversal:${operationId}`;

  const run = async (tx: PurchaseReversalClient) => {
    const existingTransaction = await findWalletTransactionByIdempotencyKey(
      transactionIdempotencyKey,
      tx,
    );
    const purchase = await tx.agentTokenPurchase.findUnique({
      where: { id: purchaseId },
      include: {
        userWallet: true,
        userAgentWallet: true,
        agentWallet: true,
        creatorEarnings: true,
      },
    });
    if (
      !purchase?.userWallet ||
      !purchase.agentWallet ||
      !purchase.userAgentWalletId ||
      !purchase.userAgentWallet ||
      purchase.remainingTokenAmount === null
    ) {
      throw new Error("Agent token purchase not found.");
    }
    if (!purchase.audienceIdentityId || !purchase.entitlementAccountId) {
      throw new Error(
        "Agent token purchase is missing its service entitlement link.",
      );
    }
    if (existingTransaction) {
      assertWalletIdempotencyField(
        "agent token purchase reversal",
        "purchaseId",
        existingTransaction.sourceId,
        purchase.id,
      );
      const metadata = jsonRecord(existingTransaction.metadata);
      if (typeof input.tokenAmount === "number") {
        assertWalletIdempotencyField(
          "agent token purchase reversal",
          "tokenAmount",
          metadata.tokenAmount,
          input.tokenAmount,
        );
      }
      if (typeof input.reason !== "undefined") {
        assertWalletIdempotencyField(
          "agent token purchase reversal",
          "reason",
          metadata.reason,
          input.reason,
        );
      }
      return serializePurchaseReversal(
        purchase,
        numberMetadata(metadata, "creatorReversedCents"),
        numberMetadata(metadata, "tokenAmount"),
        numberMetadata(metadata, "amountCents"),
      );
    }
    if (
      purchase.status === AgentTokenPurchaseStatus.REVERSED ||
      purchase.status === AgentTokenPurchaseStatus.REFUNDED
    ) {
      throw new Error("Agent token purchase was already refunded by another operation.");
    }
    if (purchase.status !== AgentTokenPurchaseStatus.COMPLETED) {
      throw new Error(`Agent token purchase cannot be reversed from status ${purchase.status}.`);
    }
    await assertReversalWalletEntitlementParity(
      {
        ...purchase,
        userAgentWallet: purchase.userAgentWallet,
        audienceIdentityId: purchase.audienceIdentityId,
        entitlementAccountId: purchase.entitlementAccountId,
      },
      tx,
    );
    const tokenAmount = input.tokenAmount ?? purchase.remainingTokenAmount;
    assertPositiveInteger(tokenAmount, "tokenAmount");
    if (tokenAmount > purchase.remainingTokenAmount) {
      throw new Error("Cannot refund more than the purchase's unconsumed service credits.");
    }
    if (purchase.userAgentWallet.availableTokenAmount < tokenAmount) {
      throw new Error("Cannot refund reserved or consumed service credits.");
    }

    const pendingEarning = await tx.creatorEarning.findFirst({
      where: {
        tokenPurchaseId: purchase.id,
        status: CreatorEarningStatus.PENDING,
        pendingCents: { gt: 0 },
      },
      orderBy: { createdAt: "asc" },
    });
    const remainingAfter = purchase.remainingTokenAmount - tokenAmount;
    const consumedOrReversedBefore =
      purchase.tokenAmount - purchase.remainingTokenAmount;
    const releasedBefore = calculateCumulativeRevenueAllocationDifference({
      grossAmount: purchase.amountCents,
      creatorAmount: purchase.creatorPendingCents,
      totalUnits: purchase.tokenAmount,
      unitsBefore: 0,
      unitsDelta: consumedOrReversedBefore,
    }).creatorAmount;
    const reversalAllocation =
      calculateCumulativeRevenueAllocationDifference({
        grossAmount: purchase.amountCents,
        creatorAmount: purchase.creatorPendingCents,
        totalUnits: purchase.tokenAmount,
        unitsBefore: consumedOrReversedBefore,
        unitsDelta: tokenAmount,
      });
    const pendingBefore = purchase.creatorPendingCents - releasedBefore;
    const pendingAfter = pendingBefore - reversalAllocation.creatorAmount;
    if (
      pendingBefore > 0 &&
      (!pendingEarning || pendingEarning.pendingCents !== pendingBefore)
    ) {
      throw new Error("Creator pending earning is inconsistent with purchase remainder.");
    }
    const creatorReversedCents = reversalAllocation.creatorAmount;
    const reversedAmountCents = reversalAllocation.grossAmount;
    const platformReversedCents = reversalAllocation.platformAmount;
    const refundedAt = new Date();

    const entitlementRefund = await refundAgentWalletServiceCreditEntitlement(
      {
        audienceIdentityId: purchase.audienceIdentityId,
        representativeId: purchase.representativeId,
        units: tokenAmount,
        operationKey: `agent-token-purchase-reversal:${operationId}`,
        notes: input.reason ?? "Agent token purchase reversal.",
        metadata: {
          purchaseId: purchase.id,
          purchaseIdempotencyKey: purchase.idempotencyKey,
          amountCents: reversedAmountCents,
          currency: purchase.currency,
        },
      },
      tx as unknown as ServiceEntitlementClient,
    );
    if (entitlementRefund.accountId !== purchase.entitlementAccountId) {
      throw new Error(
        "Agent token purchase entitlement account does not match its persisted link.",
      );
    }

    const updatedPendingEarning =
      pendingEarning && creatorReversedCents > 0
        ? await tx.creatorEarning.update({
            where: { id: pendingEarning.id },
            data: {
              pendingCents: {
                decrement: creatorReversedCents,
              },
              status:
                pendingAfter === 0
                  ? CreatorEarningStatus.REVERSED
                  : CreatorEarningStatus.PENDING,
            },
          })
        : null;

    const walletTransaction = await recordWalletTransaction(
      {
        eventGroupId: `token_purchase_reversal:${purchase.id}:${operationId}`,
        idempotencyKey: transactionIdempotencyKey,
        sourceType: "AgentTokenPurchase",
        sourceId: purchase.id,
        eventType: WalletTransactionEventType.REVERSAL,
        currency: purchase.currency,
        ownerId: pendingEarning?.ownerId ?? null,
        representativeId: purchase.representativeId,
        userWalletId: purchase.userWallet.id,
        metadata: {
          tokenAmount,
          amountCents: reversedAmountCents,
          creatorReversedCents,
          platformReversedCents,
          reason: input.reason ?? null,
          userAgentWalletId: purchase.userAgentWallet.id,
          audienceIdentityId: entitlementRefund.audienceIdentityId,
          entitlementAccountId: entitlementRefund.accountId,
          entitlementRefundLedgerEntryId: entitlementRefund.ledgerEntryId,
        },
      },
      tx,
    );

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `token_purchase_reversal:${purchase.id}:${operationId}`,
        idempotencyKey: transactionIdempotencyKey,
        currency: purchase.currency,
        requireBalancedAmount: true,
        initialBalances: {
          [`${AmnWalletAccountType.USER_CASH}:${purchase.userWallet.id}`]: {
            amountCents: purchase.userWallet.cashBalanceCents,
          },
          [`${AmnWalletAccountType.SERVICE_CREDIT_DEFERRED}:${purchase.userAgentWallet.id}`]:
            {
              tokenAmount:
                purchase.userAgentWallet.availableTokenAmount +
                purchase.userAgentWallet.reservedTokenAmount,
            },
        },
        movements: [
          {
            entryKey: "user_cash_refund_credit",
            accountType: AmnWalletAccountType.USER_CASH,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            transactionId: walletTransaction?.id ?? null,
            userWalletId: purchase.userWallet.id,
            tokenPurchaseId: purchase.id,
            amountCents: reversedAmountCents,
            notes: input.reason ?? "agent_token_purchase_reversal",
          },
          {
            entryKey: "service_credit_reversal_debit",
            accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            transactionId: walletTransaction?.id ?? null,
            userWalletId: purchase.userWallet.id,
            userAgentWalletId: purchase.userAgentWallet.id,
            agentWalletId: purchase.agentWallet.id,
            representativeId: purchase.representativeId,
            tokenPurchaseId: purchase.id,
            tokenAmount: -tokenAmount,
            notes: input.reason ?? "agent_token_purchase_reversal",
          },
          ...(updatedPendingEarning
            ? [
                {
                  entryKey: "creator_pending_reversal_debit",
                  accountType: AmnWalletAccountType.CREATOR_PENDING,
                  entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
                  transactionId: walletTransaction?.id ?? null,
                  ownerId: updatedPendingEarning.ownerId,
                  representativeId: updatedPendingEarning.representativeId,
                  agentWalletId: updatedPendingEarning.agentWalletId,
                  creatorEarningId: updatedPendingEarning.id,
                  tokenPurchaseId: purchase.id,
                  amountCents: -creatorReversedCents,
                  notes: input.reason ?? "agent_token_purchase_reversal",
                },
              ]
            : []),
          {
            entryKey: "platform_deferred_revenue_reversal_debit",
            accountType: AmnWalletAccountType.PLATFORM_DEFERRED_REVENUE,
            entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
            transactionId: walletTransaction?.id ?? null,
            representativeId: purchase.representativeId,
            tokenPurchaseId: purchase.id,
            amountCents: -platformReversedCents,
            notes: input.reason ?? "agent_token_purchase_reversal",
          },
        ],
      },
      tx,
    );

    const [updatedUserWallet, updatedUserAgentWallet, updatedAgentWallet, updatedPurchase] = await Promise.all([
      tx.userWallet.update({
        where: { id: purchase.userWallet.id },
        data: {
          cashBalanceCents: {
            increment: reversedAmountCents,
          },
        },
      }),
      tx.userAgentWallet.update({
        where: { id: purchase.userAgentWallet.id },
        data: {
          availableTokenAmount: {
            decrement: tokenAmount,
          },
          totalPurchasedTokenAmount: {
            decrement: tokenAmount,
          },
        },
      }),
      tx.agentWallet.update({
        where: { id: purchase.agentWallet.id },
        data: {
          tokenBalance: {
            decrement: tokenAmount,
          },
          totalPurchasedTokens: {
            decrement: tokenAmount,
          },
        },
      }),
      tx.agentTokenPurchase.update({
        where: { id: purchase.id },
        data: {
          remainingTokenAmount: {
            decrement: tokenAmount,
          },
          status:
            remainingAfter === 0
              ? purchase.tokenAmount === tokenAmount
                ? AgentTokenPurchaseStatus.REVERSED
                : AgentTokenPurchaseStatus.REFUNDED
              : AgentTokenPurchaseStatus.COMPLETED,
          refundedAt,
        },
      }),
    ]);
    if (
      entitlementRefund.remainingUnits
        !== updatedUserAgentWallet.availableTokenAmount
      || entitlementRefund.reservedUnits
        !== updatedUserAgentWallet.reservedTokenAmount
    ) {
      throw new AgentWalletReconciliationError(
        "Agent token purchase reversal left wallet and service entitlement balances inconsistent.",
      );
    }

    return serializePurchaseReversal(
      {
        ...updatedPurchase,
        userWallet: updatedUserWallet,
        userAgentWallet: updatedUserAgentWallet,
        agentWallet: updatedAgentWallet,
        creatorEarnings: updatedPendingEarning ? [updatedPendingEarning] : [],
      },
      creatorReversedCents,
      tokenAmount,
      reversedAmountCents,
    );
  };

  return runWalletWriteTransaction(client, run);
}

async function assertReversalWalletEntitlementParity(
  purchase: AgentTokenPurchaseRecord & {
    userAgentWallet: UserAgentWalletRecord;
    audienceIdentityId: string;
    entitlementAccountId: string;
  },
  tx: PurchaseReversalClient,
) {
  const entitlementAccount = await tx.serviceEntitlementAccount.findUnique({
    where: { id: purchase.entitlementAccountId },
  });
  if (
    !entitlementAccount
    || entitlementAccount.audienceIdentityId !== purchase.audienceIdentityId
    || entitlementAccount.representativeId !== purchase.representativeId
    || entitlementAccount.productCode
      !== AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE
  ) {
    throw new AgentWalletReconciliationError(
      "Agent token purchase service entitlement link is inconsistent.",
    );
  }
  if (
    entitlementAccount.remainingUnits
      !== purchase.userAgentWallet.availableTokenAmount
    || entitlementAccount.reservedUnits
      !== purchase.userAgentWallet.reservedTokenAmount
  ) {
    throw new AgentWalletReconciliationError(
      "Before agent token purchase reversal: wallet and service entitlement balances do not match.",
    );
  }
}

function serializeRechargeRefund(
  order: RechargeOrderRecord,
  providerEvent: PaymentProviderEventRecord | null,
): RechargeRefundSnapshot {
  if (!order.userWallet) {
    throw new Error("Recharge refund is missing user wallet.");
  }
  return {
    rechargeOrderId: order.id,
    status: order.status.toLowerCase() as RechargeRefundSnapshot["status"],
    amountCents: order.amountCents,
    currency: order.currency,
    cashBalanceCents: order.userWallet.cashBalanceCents,
    paymentProviderEventId: providerEvent?.id ?? null,
    refundedAt: order.refundedAt ? order.refundedAt.toISOString() : null,
  };
}

function serializePurchaseReversal(
  purchase: AgentTokenPurchaseRecord,
  creatorReversedCents: number,
  reversedTokenAmount: number,
  reversedAmountCents: number,
): AgentTokenPurchaseReversalSnapshot {
  if (!purchase.userWallet) {
    throw new Error("Purchase reversal is missing user wallet.");
  }
  if (!purchase.agentWallet) {
    throw new Error("Purchase reversal is missing agent wallet.");
  }
  return {
    purchaseId: purchase.id,
    status: purchase.status.toLowerCase() as AgentTokenPurchaseReversalSnapshot["status"],
    amountCents: purchase.amountCents,
    currency: purchase.currency,
    tokenAmount: reversedTokenAmount,
    remainingTokenAmount:
      purchase.remainingTokenAmount ?? purchase.tokenAmount,
    reversedAmountCents,
    cashBalanceCents: purchase.userWallet.cashBalanceCents,
    agentTokenBalance: purchase.agentWallet.tokenBalance,
    creatorReversedCents,
    refundedAt: purchase.refundedAt ? purchase.refundedAt.toISOString() : null,
    audienceIdentityId:
      purchase.audienceIdentityId ??
      missingPurchaseEntitlement(
        "Purchase reversal is missing its audience identity.",
      ),
    entitlementAccountId:
      purchase.entitlementAccountId ??
      missingPurchaseEntitlement(
        "Purchase reversal is missing its service entitlement account.",
      ),
  };
}

function missingPurchaseEntitlement(message: string): never {
  throw new Error(message);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberMetadata(
  metadata: Record<string, unknown>,
  key: string,
): number {
  const value = metadata[key];
  if (!Number.isInteger(value)) {
    throw new Error(`Wallet transaction metadata is missing ${key}.`);
  }
  return value as number;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
