import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  BillingHandoffAllowance,
  BillingProductKind,
  BillingRefundPolicy,
  CreatorEarningStatus,
  HandoffEntitlementGrantStatus,
  HandoffEntitlementLedgerKind,
  PaymentProvider,
  Prisma,
  RechargeOrderStatus,
  RechargeRefundProviderStatus,
  RechargeRefundReversalStatus,
  RechargeRefundSubmissionStatus,
  TipContributionStatus,
  WalletTransactionEventType,
  WithdrawRequestStatus,
} from "@prisma/client";

import { recordWalletLedgerTransaction } from "./agent-wallet-ledger";
import { recordWalletTransaction } from "./agent-wallet-transactions";
import { cancelWithdrawRequestForForcedRefund } from "./agent-wallet-withdrawals";

type CommercialRefundClient = Prisma.TransactionClient;

export type ForcedTipRefundReversalSnapshot = {
  reversed: boolean;
  processingError: string | null;
};

const TIP_REFUND_IRREVERSIBLE_WITHDRAWAL =
  "wechat_refund_tip_creator_proceeds_already_withdrawn_manual_recovery_required";
const TIP_REFUND_PAYOUT_STATUS_UNKNOWN =
  "wechat_refund_tip_creator_payout_status_unknown_manual_recovery_required";
const TIP_REFUND_EARNING_STATE_MISMATCH =
  "wechat_refund_tip_creator_earning_state_mismatch";

type HandoffGrantRefundShape = {
  id: string;
  allowance: BillingHandoffAllowance;
  grantedUses: number | null;
  remainingUses: number | null;
  reservedUses: number;
  consumedUses: number;
  status: HandoffEntitlementGrantStatus;
  expiresAt: Date | null;
};

export function commercialRefundPolicyConflictReason(input: {
  productKindSnapshot?: BillingProductKind | null | undefined;
  refundPolicySnapshot?: BillingRefundPolicy | null | undefined;
}): string | null {
  if (
    input.productKindSnapshot === BillingProductKind.TIP
    || input.refundPolicySnapshot === BillingRefundPolicy.NON_REFUNDABLE
  ) {
    return "wechat_refund_tip_non_refundable_manual_reversal_required";
  }
  if (
    input.productKindSnapshot !== null
    && input.productKindSnapshot !== undefined
    && input.productKindSnapshot !== BillingProductKind.SERVICE_PACKAGE
  ) {
    return "wechat_refund_product_not_refundable";
  }
  return null;
}

/**
 * Serializes a provider-side tip reversal with withdrawal creation/approval.
 * Withdrawal code locks the same CreatorEarning rows before its final refund
 * predicate read, so a refund fact that owns this lock cannot be paid through.
 */
export async function lockTipCreatorEarningForRefund(
  tx: CommercialRefundClient,
  rechargeOrderId: string,
): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "earning"."id"
    FROM "TipContribution" AS "tip"
    INNER JOIN "CreatorEarning" AS "earning"
      ON "earning"."id" = "tip"."creatorEarningId"
    WHERE "tip"."rechargeOrderId" = ${rechargeOrderId}
    ORDER BY "earning"."id"
    FOR UPDATE OF "earning"
  `);
}

/**
 * Locks the complete forced-tip reversal graph in a stable parent-to-child
 * order. The refund row is the operation mutex; the creator earning lock is
 * shared with withdrawal creation/approval/payment so either the refund fact
 * or the payout wins serially, never both.
 */
export async function lockForcedTipRefundGraph(
  tx: CommercialRefundClient,
  rechargeRefundId: string,
): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "RechargeRefund"
    WHERE "id" = ${rechargeRefundId}
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "tip"."id"
    FROM "TipContribution" AS "tip"
    INNER JOIN "RechargeRefund" AS "refund"
      ON "refund"."rechargeOrderId" = "tip"."rechargeOrderId"
    WHERE "refund"."id" = ${rechargeRefundId}
    ORDER BY "tip"."id"
    FOR UPDATE OF "tip"
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "earning"."id"
    FROM "RechargeRefund" AS "refund"
    INNER JOIN "TipContribution" AS "tip"
      ON "tip"."rechargeOrderId" = "refund"."rechargeOrderId"
    INNER JOIN "CreatorEarning" AS "earning"
      ON
        "earning"."id" = "tip"."creatorEarningId"
        OR EXISTS (
          SELECT 1
          FROM "WithdrawalAllocation" AS "tipAllocation"
          INNER JOIN "WithdrawalAllocation" AS "requestAllocation"
            ON "requestAllocation"."withdrawRequestId"
              = "tipAllocation"."withdrawRequestId"
          WHERE
            "tipAllocation"."creatorEarningId" = "tip"."creatorEarningId"
            AND "requestAllocation"."creatorEarningId" = "earning"."id"
        )
    WHERE "refund"."id" = ${rechargeRefundId}
    ORDER BY "earning"."id"
    FOR UPDATE OF "earning"
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "allocation"."id"
    FROM "RechargeRefund" AS "refund"
    INNER JOIN "TipContribution" AS "tip"
      ON "tip"."rechargeOrderId" = "refund"."rechargeOrderId"
    INNER JOIN "WithdrawalAllocation" AS "allocation"
      ON "allocation"."withdrawRequestId" IN (
        SELECT "tipAllocation"."withdrawRequestId"
        FROM "WithdrawalAllocation" AS "tipAllocation"
        WHERE "tipAllocation"."creatorEarningId" = "tip"."creatorEarningId"
      )
    WHERE "refund"."id" = ${rechargeRefundId}
    ORDER BY "allocation"."id"
    FOR UPDATE OF "allocation"
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "request"."id"
    FROM "RechargeRefund" AS "refund"
    INNER JOIN "TipContribution" AS "tip"
      ON "tip"."rechargeOrderId" = "refund"."rechargeOrderId"
    INNER JOIN "WithdrawalAllocation" AS "allocation"
      ON "allocation"."creatorEarningId" = "tip"."creatorEarningId"
    INNER JOIN "WithdrawRequest" AS "request"
      ON "request"."id" = "allocation"."withdrawRequestId"
    WHERE "refund"."id" = ${rechargeRefundId}
    ORDER BY "request"."id"
    FOR UPDATE OF "request"
  `);
}

/**
 * Reverses a provider-forced refund of an otherwise non-refundable tip.
 *
 * This intentionally restores the tip amount to USER_CASH first. The existing
 * RechargeOrder refund path then debits USER_CASH and credits the provider's
 * external-settlement account, so the payer's wallet is unchanged and the
 * provider refund is recorded exactly once.
 */
export async function reverseForcedTipContributionRefund(
  tx: CommercialRefundClient,
  input: {
    rechargeRefundId: string;
    rechargeOrderId: string;
    paymentProviderEventId: string | null;
    reversedAt: Date;
  },
): Promise<ForcedTipRefundReversalSnapshot> {
  await lockForcedTipRefundGraph(tx, input.rechargeRefundId);

  const refund = await tx.rechargeRefund.findUnique({
    where: { id: input.rechargeRefundId },
  });
  if (
    !refund
    || refund.rechargeOrderId !== input.rechargeOrderId
    || refund.provider !== PaymentProvider.WECHAT_PAY
    || refund.providerStatus !== RechargeRefundProviderStatus.SUCCEEDED
    || refund.refundAmountCents !== refund.originalAmountCents
    || refund.payerRefundAmountCents !== refund.payerOriginalAmountCents
  ) {
    return {
      reversed: false,
      processingError: "wechat_refund_tip_provider_fact_mismatch",
    };
  }

  const tip = await tx.tipContribution.findUnique({
    where: { rechargeOrderId: input.rechargeOrderId },
    include: {
      creatorEarning: true,
      rechargeOrder: { include: { userWallet: true } },
    },
  });
  if (!tip) {
    return {
      reversed: false,
      processingError: "wechat_refund_tip_contribution_missing",
    };
  }
  if (
    tip.rechargeOrder.status === RechargeOrderStatus.REFUNDED
    || tip.status !== TipContributionStatus.COMPLETED
  ) {
    const existingTransaction = await tx.walletTransaction.findUnique({
      where: {
        idempotencyKey: `tip_refund:${input.rechargeRefundId}:reversed`,
      },
    });
    if (
      existingTransaction
      && tip.status === TipContributionStatus.REFUNDED
      && tip.creatorEarning.status === CreatorEarningStatus.REVERSED
      && tip.creatorEarning.pendingCents === 0
      && tip.creatorEarning.withdrawableCents === 0
      && tip.creatorEarning.frozenCents === 0
      && tip.creatorEarning.withdrawnCents === 0
    ) {
      return { reversed: true, processingError: null };
    }
    return {
      reversed: false,
      processingError:
        "wechat_refund_tip_already_reversed_by_another_operation",
    };
  }

  let earning = tip.creatorEarning;
  const allocations = await tx.withdrawalAllocation.findMany({
    where: { creatorEarningId: earning.id },
    include: { withdrawRequest: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const paidAllocation = allocations.find(
    (allocation) =>
      allocation.paidAt !== null
      || allocation.withdrawRequest.status === WithdrawRequestStatus.PAID,
  );
  if (
    paidAllocation
    || earning.status === CreatorEarningStatus.WITHDRAWN
    || earning.withdrawnCents > 0
  ) {
    return {
      reversed: false,
      processingError: TIP_REFUND_IRREVERSIBLE_WITHDRAWAL,
    };
  }

  const activeAllocations = allocations.filter(
    (allocation) =>
      allocation.releasedAt === null && allocation.paidAt === null,
  );
  if (activeAllocations.length > 1) {
    return {
      reversed: false,
      processingError: TIP_REFUND_EARNING_STATE_MISMATCH,
    };
  }
  const activeAllocation = activeAllocations[0];
  if (activeAllocation) {
    const requestAllocations = await tx.withdrawalAllocation.findMany({
      where: {
        withdrawRequestId: activeAllocation.withdrawRequestId,
      },
      include: { withdrawRequest: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (
      requestAllocations.some(
        (allocation) =>
          allocation.paidAt !== null
          || allocation.withdrawRequest.status === WithdrawRequestStatus.PAID,
      )
    ) {
      return {
        reversed: false,
        processingError: TIP_REFUND_IRREVERSIBLE_WITHDRAWAL,
      };
    }
    if (
      activeAllocation.withdrawRequest.status
        !== WithdrawRequestStatus.PENDING_REVIEW
    ) {
      return {
        reversed: false,
        processingError:
          activeAllocation.withdrawRequest.status
            === WithdrawRequestStatus.APPROVED
          || activeAllocation.withdrawRequest.status
            === WithdrawRequestStatus.FAILED
            ? TIP_REFUND_PAYOUT_STATUS_UNKNOWN
            : TIP_REFUND_EARNING_STATE_MISMATCH,
      };
    }
    await cancelWithdrawRequestForForcedRefund(
      {
        ownerId: earning.ownerId,
        withdrawRequestId: activeAllocation.withdrawRequestId,
        reason: "provider_forced_tip_refund",
        idempotencyKey:
          `forced_tip_refund:${input.rechargeRefundId}:cancel:${activeAllocation.withdrawRequestId}`,
      },
      tx as never,
    );
    earning = await tx.creatorEarning.findUniqueOrThrow({
      where: { id: earning.id },
    });
  }

  if (
    earning.status !== CreatorEarningStatus.WITHDRAWABLE
    || earning.pendingCents !== 0
    || earning.withdrawableCents !== tip.creatorAmountMinor
    || earning.frozenCents !== 0
    || earning.withdrawnCents !== 0
    || earning.currency !== tip.currency
  ) {
    return {
      reversed: false,
      processingError: TIP_REFUND_EARNING_STATE_MISMATCH,
    };
  }
  if (
    tip.amountMinor !== tip.creatorAmountMinor + tip.platformAmountMinor
    || tip.rechargeOrder.amountCents !== tip.amountMinor
    || tip.rechargeOrder.currency !== tip.currency
  ) {
    return {
      reversed: false,
      processingError: "wechat_refund_tip_amount_mismatch",
    };
  }

  const eventGroupId = `tip_refund:${tip.id}:${input.rechargeRefundId}`;
  const idempotencyKey = `tip_refund:${input.rechargeRefundId}:reversed`;
  const transaction = await recordWalletTransaction(
    {
      eventGroupId,
      idempotencyKey,
      sourceType: "RechargeRefund",
      sourceId: input.rechargeRefundId,
      eventType: WalletTransactionEventType.REVERSAL,
      currency: tip.currency,
      ownerId: earning.ownerId,
      representativeId: tip.representativeId,
      userWalletId: tip.rechargeOrder.userWalletId,
      reversedAt: input.reversedAt,
      metadata: {
        rechargeOrderId: input.rechargeOrderId,
        tipContributionId: tip.id,
        creatorEarningId: earning.id,
        amountCents: tip.amountMinor,
        creatorAmountCents: tip.creatorAmountMinor,
        platformAmountCents: tip.platformAmountMinor,
        reason: "wechat_pay_forced_tip_refund",
      },
    },
    tx,
  );
  if (!transaction) {
    throw new Error("Wallet transaction storage is required for tip refunds.");
  }
  await recordWalletLedgerTransaction(
    {
      eventGroupId,
      idempotencyKey,
      currency: tip.currency,
      requireBalancedAmount: true,
      initialBalances: {
        [`${AmnWalletAccountType.CREATOR_WITHDRAWABLE}:${earning.ownerId}:${tip.representativeId}`]: {
          amountCents: earning.withdrawableCents,
        },
        [`${AmnWalletAccountType.PLATFORM_EARNED_REVENUE}:${tip.representativeId}`]: {
          amountCents: tip.platformAmountMinor,
        },
        [`${AmnWalletAccountType.USER_CASH}:${tip.rechargeOrder.userWalletId}`]: {
          amountCents: tip.rechargeOrder.userWallet.cashBalanceCents,
        },
      },
      movements: [
        {
          entryKey: "creator_withdrawable_refund_debit",
          accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
          entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
          transactionId: transaction.id,
          ownerId: earning.ownerId,
          representativeId: tip.representativeId,
          agentWalletId: tip.agentWalletId,
          creatorEarningId: earning.id,
          rechargeOrderId: input.rechargeOrderId,
          paymentProviderEventId: input.paymentProviderEventId,
          amountCents: -tip.creatorAmountMinor,
          // Creator accounts aggregate every earning for the owner/rep. The
          // tip amount is only a conservative non-negative floor, not the
          // authoritative aggregate balance.
          balanceAfterCents: null,
          notes: "wechat_pay_forced_tip_refund",
        },
        {
          entryKey: "platform_earned_refund_debit",
          accountType: AmnWalletAccountType.PLATFORM_EARNED_REVENUE,
          entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
          transactionId: transaction.id,
          representativeId: tip.representativeId,
          agentWalletId: tip.agentWalletId,
          rechargeOrderId: input.rechargeOrderId,
          paymentProviderEventId: input.paymentProviderEventId,
          amountCents: -tip.platformAmountMinor,
          // Platform earned revenue is representative-scoped and may include
          // unrelated products, so never persist a fabricated zero balance.
          balanceAfterCents: null,
          notes: "wechat_pay_forced_tip_refund",
        },
        {
          entryKey: "user_cash_tip_refund_credit",
          accountType: AmnWalletAccountType.USER_CASH,
          entryKind: AmnLedgerEntryKind.REFUND_REVERSAL,
          transactionId: transaction.id,
          userWalletId: tip.rechargeOrder.userWalletId,
          representativeId: tip.representativeId,
          rechargeOrderId: input.rechargeOrderId,
          paymentProviderEventId: input.paymentProviderEventId,
          amountCents: tip.amountMinor,
          notes: "wechat_pay_forced_tip_refund",
        },
      ],
    },
    tx,
  );

  const earningUpdate = await tx.creatorEarning.updateMany({
    where: {
      id: earning.id,
      status: CreatorEarningStatus.WITHDRAWABLE,
      pendingCents: 0,
      withdrawableCents: tip.creatorAmountMinor,
      frozenCents: 0,
      withdrawnCents: 0,
    },
    data: {
      status: CreatorEarningStatus.REVERSED,
      withdrawableCents: 0,
    },
  });
  if (earningUpdate.count !== 1) {
    throw new Error("wechat_refund_tip_creator_earning_state_changed");
  }
  await tx.tipContribution.update({
    where: { id: tip.id },
    data: {
      status: TipContributionStatus.REFUNDED,
      refundedAt: input.reversedAt,
    },
  });
  const walletUpdate = await tx.userWallet.updateMany({
    where: {
      id: tip.rechargeOrder.userWalletId,
      currency: tip.currency,
      cashBalanceCents: tip.rechargeOrder.userWallet.cashBalanceCents,
    },
    data: { cashBalanceCents: { increment: tip.amountMinor } },
  });
  if (walletUpdate.count !== 1) {
    throw new Error("wechat_refund_tip_payer_wallet_state_changed");
  }

  return { reversed: true, processingError: null };
}

export function handoffGrantRefundConflictReason(
  grant: HandoffGrantRefundShape | null | undefined,
): string | null {
  if (!grant) return null;
  if (grant.status === HandoffEntitlementGrantStatus.REFUNDED) {
    return "wechat_refund_handoff_already_refunded";
  }
  if (grant.reservedUses !== 0) {
    return "wechat_refund_handoff_reserved";
  }
  if (grant.consumedUses !== 0) {
    return "wechat_refund_handoff_already_consumed";
  }
  if (
    grant.allowance === BillingHandoffAllowance.LIMITED
    && (
      grant.grantedUses === null
      || grant.remainingUses !== grant.grantedUses
    )
  ) {
    return "wechat_refund_handoff_balance_mismatch";
  }
  if (
    grant.allowance === BillingHandoffAllowance.UNLIMITED
    && (
      grant.grantedUses !== null
      || grant.remainingUses !== null
    )
  ) {
    return "wechat_refund_handoff_balance_mismatch";
  }
  if (
    grant.status !== HandoffEntitlementGrantStatus.ACTIVE
    && grant.status !== HandoffEntitlementGrantStatus.EXPIRED
    && grant.status !== HandoffEntitlementGrantStatus.FROZEN
  ) {
    return "wechat_refund_handoff_not_refundable";
  }
  return null;
}

/**
 * Freezes an unused handoff grant behind the same transaction boundary as the
 * refund intent. The conditional update closes the race with a simultaneous
 * reserve/consume operation: only one side can leave ACTIVE/EXPIRED.
 */
export async function freezeHandoffGrantForRefund(
  tx: CommercialRefundClient,
  rechargeOrderId: string,
): Promise<HandoffGrantRefundShape | null> {
  const grant = await tx.handoffEntitlementGrant.findUnique({
    where: { rechargeOrderId },
  });
  if (!grant) return null;

  const conflict = handoffGrantRefundConflictReason(grant);
  if (conflict) throw new Error(conflict);
  if (grant.status === HandoffEntitlementGrantStatus.FROZEN) {
    return grant;
  }

  const frozen = await tx.handoffEntitlementGrant.updateMany({
    where: {
      id: grant.id,
      status: {
        in: [
          HandoffEntitlementGrantStatus.ACTIVE,
          HandoffEntitlementGrantStatus.EXPIRED,
        ],
      },
      reservedUses: 0,
      consumedUses: 0,
      ...(grant.allowance === BillingHandoffAllowance.LIMITED
        ? {
            grantedUses: grant.grantedUses,
            remainingUses: grant.grantedUses,
          }
        : {
            grantedUses: null,
            remainingUses: null,
          }),
    },
    data: { status: HandoffEntitlementGrantStatus.FROZEN },
  });
  if (frozen.count !== 1) {
    throw new Error("wechat_refund_handoff_state_changed");
  }
  return {
    ...grant,
    status: HandoffEntitlementGrantStatus.FROZEN,
  };
}

/** Restores a failed/rejected refund without reopening an expired grant. */
export async function restoreHandoffGrantAfterFailedRefund(
  tx: CommercialRefundClient,
  rechargeRefundId: string,
  now: Date,
): Promise<void> {
  const refund = await tx.rechargeRefund.findUnique({
    where: { id: rechargeRefundId },
    select: { rechargeOrderId: true },
  });
  if (!refund) return;

  const unresolved = await tx.rechargeRefund.count({
    where: {
      id: { not: rechargeRefundId },
      rechargeOrderId: refund.rechargeOrderId,
      OR: [
        {
          submissionStatus: {
            in: [
              RechargeRefundSubmissionStatus.QUEUED,
              RechargeRefundSubmissionStatus.UNKNOWN,
            ],
          },
        },
        {
          providerStatus: {
            in: [
              RechargeRefundProviderStatus.PROCESSING,
              RechargeRefundProviderStatus.ABNORMAL,
              RechargeRefundProviderStatus.SUCCEEDED,
            ],
          },
          reversalStatus: {
            in: [
              RechargeRefundReversalStatus.PENDING,
              RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
            ],
          },
        },
      ],
    },
  });
  if (unresolved !== 0) return;

  const grant = await tx.handoffEntitlementGrant.findUnique({
    where: { rechargeOrderId: refund.rechargeOrderId },
  });
  if (!grant || grant.status !== HandoffEntitlementGrantStatus.FROZEN) {
    return;
  }

  const expired =
    grant.expiresAt !== null
    && grant.expiresAt.getTime() <= now.getTime();
  const targetStatus = expired
    ? HandoffEntitlementGrantStatus.EXPIRED
    : HandoffEntitlementGrantStatus.ACTIVE;
  const restored = await tx.handoffEntitlementGrant.updateMany({
    where: {
      id: grant.id,
      status: HandoffEntitlementGrantStatus.FROZEN,
      reservedUses: 0,
      consumedUses: 0,
    },
    data: { status: targetStatus },
  });
  if (restored.count !== 1) return;

  if (targetStatus === HandoffEntitlementGrantStatus.EXPIRED) {
    const existingExpiry =
      await tx.handoffEntitlementLedgerEntry.findFirst({
        where: {
          grantId: grant.id,
          kind: HandoffEntitlementLedgerKind.EXPIRE,
        },
      });
    if (!existingExpiry) {
      await tx.handoffEntitlementLedgerEntry.create({
        data: {
          grantId: grant.id,
          kind: HandoffEntitlementLedgerKind.EXPIRE,
          uses: grant.grantedUses ?? 1,
          remainingAfter: grant.remainingUses,
          reservedAfter: grant.reservedUses,
          consumedAfter: grant.consumedUses,
          idempotencyKey: `handoff-grant:${grant.id}:expire`,
          metadata: {
            rechargeRefundId,
            reason: "refund_failed_after_entitlement_expiry",
          },
        },
      });
    }
  }
}

/** Marks the handoff half of a paid bundle refunded and closes its ledger. */
export async function refundHandoffGrant(
  tx: CommercialRefundClient,
  rechargeOrderId: string,
  rechargeRefundId: string,
): Promise<void> {
  let grant = await tx.handoffEntitlementGrant.findUnique({
    where: { rechargeOrderId },
  });
  if (!grant) return; // Orders predating handoff grants remain refundable.

  if (grant.status === HandoffEntitlementGrantStatus.REFUNDED) {
    const receipt = await tx.handoffEntitlementLedgerEntry.findFirst({
      where: {
        grantId: grant.id,
        kind: HandoffEntitlementLedgerKind.REFUND,
      },
    });
    if (!receipt) {
      throw new Error("wechat_refund_handoff_receipt_missing");
    }
    return;
  }

  const conflict = handoffGrantRefundConflictReason(grant);
  if (conflict) throw new Error(conflict);
  if (grant.status !== HandoffEntitlementGrantStatus.FROZEN) {
    await freezeHandoffGrantForRefund(tx, rechargeOrderId);
    grant = (await tx.handoffEntitlementGrant.findUnique({
      where: { rechargeOrderId },
    }))!;
  }

  const refunded = await tx.handoffEntitlementGrant.updateMany({
    where: {
      id: grant.id,
      status: HandoffEntitlementGrantStatus.FROZEN,
      reservedUses: 0,
      consumedUses: 0,
    },
    data: { status: HandoffEntitlementGrantStatus.REFUNDED },
  });
  if (refunded.count !== 1) {
    throw new Error("wechat_refund_handoff_state_changed");
  }
  await tx.handoffEntitlementLedgerEntry.create({
    data: {
      grantId: grant.id,
      kind: HandoffEntitlementLedgerKind.REFUND,
      uses: grant.grantedUses ?? 1,
      remainingAfter: grant.remainingUses,
      reservedAfter: grant.reservedUses,
      consumedAfter: grant.consumedUses,
      idempotencyKey:
        `handoff-grant:${grant.id}:refund:${rechargeRefundId}`,
      metadata: { rechargeRefundId },
    },
  });
}
