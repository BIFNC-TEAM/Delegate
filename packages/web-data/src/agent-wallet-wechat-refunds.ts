import {
  AgentTokenPurchaseStatus,
  BillingProductKind,
  BillingRefundPolicy,
  CreatorEarningStatus,
  PaymentProvider,
  PaymentProviderEventType,
  Prisma,
  RechargeOrderStatus,
  RechargeRefundProviderStatus,
  RechargeRefundReversalStatus,
  RechargeRefundSubmissionStatus,
  ServiceEntitlementStatus,
} from "@prisma/client";

import {
  commercialRefundPolicyConflictReason,
  freezeHandoffGrantForRefund,
  handoffGrantRefundConflictReason,
  lockTipCreatorEarningForRefund,
  reverseForcedTipContributionRefund,
  refundHandoffGrant,
  restoreHandoffGrantAfterFailedRefund,
} from "./commercial-refund-entitlements";
import {
  refundRechargeOrder,
  reverseAgentTokenPurchase,
} from "./agent-wallet-refunds";
import {
  RechargePaymentConflictError,
} from "./agent-wallet-recharge";
import {
  assertWalletIdempotencyField,
  runWalletWriteTransaction,
  WalletIdempotencyConflictError,
} from "./agent-wallet-write";
import { prisma } from "./prisma";
import type {
  NormalizedWeChatPayRefundResult,
  WeChatPayRefundApiResult,
} from "./wechat-pay-api-v3";

export const WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE =
  "wechat_pay.refund.apply";
const WECHAT_REFUND_REVERSAL_AGGREGATE_TYPE = "recharge_refund";
const DEFAULT_REFUND_REVERSAL_LEASE_MS = 30_000;
const DEFAULT_REFUND_REVERSAL_MAX_ATTEMPTS = 8;
const DEFAULT_REFUND_REVERSAL_MAX_BACKOFF_MS = 10 * 60_000;

export class WeChatRefundReversalLeaseLostError extends Error {
  readonly code = "WECHAT_REFUND_REVERSAL_LEASE_LOST";

  constructor(outboxId: string, attempt: number) {
    super(
      `WeChat refund reversal lease was lost for ${outboxId} at attempt ${attempt}.`,
    );
    this.name = "WeChatRefundReversalLeaseLostError";
  }
}

export type WeChatRefundPersistenceSnapshot = {
  providerEventId: string;
  refundId: string | null;
  rechargeOrderId: string | null;
  providerRefundId: string;
  providerRefundOrderId: string;
  providerStatus: "succeeded" | "closed" | "abnormal";
  reversalStatus:
    | "pending"
    | "applied"
    | "not_required"
    | "reconciliation_required";
  processingError: string | null;
};

export type WeChatRefundApiPersistenceSnapshot = {
  providerEventId: string;
  refundId: string;
  rechargeOrderId: string;
  providerRefundId: string;
  providerRefundOrderId: string;
  providerStatus:
    | "processing"
    | "succeeded"
    | "closed"
    | "abnormal";
  reversalStatus:
    | "pending"
    | "applied"
    | "not_required"
    | "reconciliation_required";
  processingError: string | null;
};

export type WeChatRefundReversalTickSummary = {
  claimed: number;
  applied: number;
  reconciliationRequired: number;
  retryScheduled: number;
  unresolved: number;
};

type ClaimedRefundReversal = {
  outboxId: string;
  rechargeRefundId: string;
  leaseAttempt: number;
};

/**
 * Persists a verified provider fact before any wallet mutation. This is the
 * callback's durability boundary: once it commits, the provider may receive a
 * success response while the outbox applies or quarantines the local reversal.
 */
export async function persistVerifiedWeChatPayRefund(
  result: NormalizedWeChatPayRefundResult,
  client: typeof prisma = prisma,
): Promise<WeChatRefundPersistenceSnapshot> {
  return runWalletWriteTransaction(client, async (tx) => {
    const providerEventType = refundProviderEventType(
      result.refundStatus,
    );
    const existingProviderEvent =
      await tx.paymentProviderEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: PaymentProvider.WECHAT_PAY,
            providerEventId: result.providerEventId,
          },
        },
      });
    if (existingProviderEvent) {
      assertRefundProviderEventMatches(
        existingProviderEvent,
        result,
        providerEventType,
      );
    }

    const order = await tx.rechargeOrder.findUnique({
      where: { id: result.outTradeNo },
      include: {
        handoffEntitlementGrant: true,
        tokenPurchases: {
          include: {
            userAgentWallet: true,
            creatorEarnings: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!order) {
      const processingError = "wechat_refund_order_missing";
      const providerEvent = await tx.paymentProviderEvent.upsert({
        where: {
          provider_providerEventId: {
            provider: PaymentProvider.WECHAT_PAY,
            providerEventId: result.providerEventId,
          },
        },
        create: {
          provider: PaymentProvider.WECHAT_PAY,
          providerEventId: result.providerEventId,
          eventType: providerEventType,
          rawPayload: result.rawPayload as Prisma.InputJsonValue,
          normalizedPayload:
            result.normalizedPayload as Prisma.InputJsonValue,
          verifiedAt: result.verifiedAt,
          processingError,
          idempotencyKey:
            `wechat_pay:refund_notification:${result.providerEventId}`,
        },
        update: {},
      });
      assertRefundProviderEventMatches(
        providerEvent,
        result,
        providerEventType,
      );
      assertWalletIdempotencyField(
        "WeChat Pay unmatched refund event",
        "rechargeOrderId",
        providerEvent.rechargeOrderId,
        null,
      );
      assertWalletIdempotencyField(
        "WeChat Pay unmatched refund event",
        "rechargeRefundId",
        providerEvent.rechargeRefundId,
        null,
      );
      return {
        providerEventId: providerEvent.providerEventId,
        refundId: null,
        rechargeOrderId: null,
        providerRefundId: result.refundId,
        providerRefundOrderId: result.outRefundNo,
        providerStatus:
          serializeRefundProviderStatus(
            refundProviderStatus(result.refundStatus),
          ),
        reversalStatus: "reconciliation_required",
        processingError,
      };
    }

    await lockTipCreatorEarningForRefund(
      tx as unknown as Prisma.TransactionClient,
      order.id,
    );

    const matchingPurchase =
      order.tokenPurchases.length === 1
        ? order.tokenPurchases[0]!
        : null;
    const initialReconciliationError =
      result.refundStatus === "SUCCESS"
        ? refundReconciliationReason({
            order,
            purchase: matchingPurchase,
            result: {
              transactionId: result.transactionId,
              originalAmountCents: result.originalAmountCents,
              refundAmountCents: result.refundAmountCents,
              payerOriginalAmountCents: result.payerAmountCents,
              payerRefundAmountCents:
                result.payerRefundAmountCents,
            },
          })
        : null;
    const desiredProviderStatus =
      refundProviderStatus(result.refundStatus);

    const [refundByProviderId, refundByMerchantId] = await Promise.all([
      tx.rechargeRefund.findUnique({
        where: {
          provider_providerRefundId: {
            provider: PaymentProvider.WECHAT_PAY,
            providerRefundId: result.refundId,
          },
        },
      }),
      tx.rechargeRefund.findUnique({
        where: {
          provider_providerRefundOrderId: {
            provider: PaymentProvider.WECHAT_PAY,
            providerRefundOrderId: result.outRefundNo,
          },
        },
      }),
    ]);
    if (
      refundByProviderId
      && refundByMerchantId
      && refundByProviderId.id !== refundByMerchantId.id
    ) {
      throw new WalletIdempotencyConflictError(
        "WeChat Pay refund",
        "provider refund identity",
      );
    }

    let refund = refundByProviderId ?? refundByMerchantId;
    if (refund) {
      assertPersistedRefundMatches(refund, order.id, result);
      const currentProviderStatus = refund.providerStatus;
      const keepSuccessfulTerminal =
        currentProviderStatus
          === RechargeRefundProviderStatus.SUCCEEDED
        && desiredProviderStatus
          !== RechargeRefundProviderStatus.SUCCEEDED;
      const keepClosedTerminal =
        currentProviderStatus
          === RechargeRefundProviderStatus.CLOSED
        && desiredProviderStatus
          !== RechargeRefundProviderStatus.SUCCEEDED;
      const signedTerminalConflict =
        currentProviderStatus
          === RechargeRefundProviderStatus.CLOSED
        && desiredProviderStatus
          === RechargeRefundProviderStatus.SUCCEEDED
          ? "wechat_refund_terminal_status_conflict"
          : null;
      const transitionAllowed =
        currentProviderStatus === null
        || currentProviderStatus
          === RechargeRefundProviderStatus.PROCESSING
        || currentProviderStatus
          === RechargeRefundProviderStatus.ABNORMAL
        || currentProviderStatus === desiredProviderStatus
        || keepSuccessfulTerminal
        || keepClosedTerminal
        || signedTerminalConflict !== null;
      if (!transitionAllowed) {
        throw new WalletIdempotencyConflictError(
          "WeChat Pay refund",
          "provider status transition",
        );
      }
      const effectiveProviderStatus =
        keepSuccessfulTerminal
          ? RechargeRefundProviderStatus.SUCCEEDED
          : keepClosedTerminal
            ? RechargeRefundProviderStatus.CLOSED
            : desiredProviderStatus;
      const existingReconciliationError =
        signedTerminalConflict
        ?? initialReconciliationError;
      const delegateInitiated =
        refund.submissionStatus
          !== RechargeRefundSubmissionStatus.EXTERNAL;
      const preserveReconciliation =
        refund.reversalStatus
          === RechargeRefundReversalStatus.RECONCILIATION_REQUIRED;
      const preservedReconciliationError =
        refund.processingError
        ?? "wechat_refund_reconciliation_required";
      refund = await tx.rechargeRefund.update({
        where: { id: refund.id },
        data: {
          providerRefundId: result.refundId,
          payerOriginalAmountCents: result.payerAmountCents,
          payerRefundAmountCents: result.payerRefundAmountCents,
          providerStatus: effectiveProviderStatus,
          ...(delegateInitiated
            ? {
                submissionStatus:
                  RechargeRefundSubmissionStatus.ACCEPTED,
              }
            : {}),
          ...(effectiveProviderStatus
            === RechargeRefundProviderStatus.SUCCEEDED
            ? {
                providerSucceededAt:
                  refund.providerSucceededAt
                  ?? result.providerOccurredAt,
                ...(refund.reversalStatus
                  === RechargeRefundReversalStatus.APPLIED
                  ? {
                      reversalStatus:
                        RechargeRefundReversalStatus.APPLIED,
                      processingError: null,
                    }
                  : preserveReconciliation
                    ? {
                        reversalStatus:
                          RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
                        processingError:
                          preservedReconciliationError,
                      }
                  : {
                      reversalStatus: existingReconciliationError
                        ? RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
                        : RechargeRefundReversalStatus.PENDING,
                      processingError:
                        existingReconciliationError,
                    }),
              }
            : preserveReconciliation
              ? {
                  reversalStatus:
                    RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
                  processingError:
                    preservedReconciliationError,
                }
              : effectiveProviderStatus
                === RechargeRefundProviderStatus.CLOSED
              ? {
                  reversalStatus:
                    RechargeRefundReversalStatus.NOT_REQUIRED,
                  processingError: null,
                }
              : {
                  reversalStatus: delegateInitiated
                    ? RechargeRefundReversalStatus.PENDING
                    : RechargeRefundReversalStatus.NOT_REQUIRED,
                  processingError: null,
                }),
        },
      });
    } else {
      refund = await tx.rechargeRefund.create({
        data: {
          rechargeOrderId: order.id,
          ...(matchingPurchase
            ? { tokenPurchaseId: matchingPurchase.id }
            : {}),
          provider: PaymentProvider.WECHAT_PAY,
          providerRefundOrderId: result.outRefundNo,
          providerRefundId: result.refundId,
          paymentTransactionId: result.transactionId,
          originalAmountCents: result.originalAmountCents,
          refundAmountCents: result.refundAmountCents,
          payerOriginalAmountCents: result.payerAmountCents,
          payerRefundAmountCents: result.payerRefundAmountCents,
          currency: order.currency,
          providerStatus: desiredProviderStatus,
          reversalStatus:
            desiredProviderStatus
              === RechargeRefundProviderStatus.SUCCEEDED
              ? initialReconciliationError
                ? RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
                : RechargeRefundReversalStatus.PENDING
              : RechargeRefundReversalStatus.NOT_REQUIRED,
          ...(desiredProviderStatus
            === RechargeRefundProviderStatus.SUCCEEDED
            ? { providerSucceededAt: result.providerOccurredAt }
            : {}),
          processingError:
            desiredProviderStatus
              === RechargeRefundProviderStatus.SUCCEEDED
              ? initialReconciliationError
              : null,
        },
      });
    }

    let providerEvent = await tx.paymentProviderEvent.upsert({
      where: {
        provider_providerEventId: {
          provider: PaymentProvider.WECHAT_PAY,
          providerEventId: result.providerEventId,
        },
      },
      create: {
        provider: PaymentProvider.WECHAT_PAY,
        providerEventId: result.providerEventId,
        eventType: providerEventType,
        rechargeOrderId: order.id,
        rechargeRefundId: refund.id,
        rawPayload: result.rawPayload as Prisma.InputJsonValue,
        normalizedPayload:
          result.normalizedPayload as Prisma.InputJsonValue,
        verifiedAt: result.verifiedAt,
        processedAt:
          result.refundStatus === "SUCCESS"
            ? refund.reversalStatus
                === RechargeRefundReversalStatus.APPLIED
              ? result.verifiedAt
              : null
            : result.verifiedAt,
        processingError:
          result.refundStatus === "ABNORMAL"
            ? "wechat_refund_provider_abnormal"
            : refund.processingError,
        idempotencyKey:
          `wechat_pay:refund_notification:${result.providerEventId}`,
      },
      // A provider event id is an immutable external fact. Returning the
      // existing row unchanged lets the assertions below reject a replay that
      // tries to bind the same event id to another order or refund.
      update: {},
    });
    assertRefundProviderEventMatches(
      providerEvent,
      result,
      providerEventType,
    );
    if (
      providerEvent.rechargeOrderId === null
      && providerEvent.rechargeRefundId === null
    ) {
      const rebound = await tx.paymentProviderEvent.updateMany({
        where: {
          id: providerEvent.id,
          rechargeOrderId: null,
          rechargeRefundId: null,
        },
        data: {
          rechargeOrderId: order.id,
          rechargeRefundId: refund.id,
          processedAt:
            result.refundStatus === "SUCCESS"
              ? refund.reversalStatus
                  === RechargeRefundReversalStatus.APPLIED
                ? result.verifiedAt
                : null
              : result.verifiedAt,
          processingError:
            result.refundStatus === "ABNORMAL"
              ? "wechat_refund_provider_abnormal"
              : refund.processingError,
        },
      });
      if (rebound.count !== 1) {
        throw new WalletIdempotencyConflictError(
          "WeChat Pay refund event",
          "provider event binding",
        );
      }
      providerEvent = await tx.paymentProviderEvent.findUniqueOrThrow({
        where: { id: providerEvent.id },
      });
    }
    assertWalletIdempotencyField(
      "WeChat Pay refund event",
      "rechargeOrderId",
      providerEvent.rechargeOrderId,
      order.id,
    );
    assertWalletIdempotencyField(
      "WeChat Pay refund event",
      "rechargeRefundId",
      providerEvent.rechargeRefundId,
      refund.id,
    );
    assertWalletIdempotencyField(
      "WeChat Pay refund event",
      "eventType",
      providerEvent.eventType,
      providerEventType,
    );
    await bindRelatedUnmatchedRefundEvents(
      tx as unknown as Prisma.TransactionClient,
      {
        id: refund.id,
        providerStatus: refund.providerStatus,
        reversalStatus: refund.reversalStatus,
        processingError: refund.processingError,
      },
      order.id,
      result,
    );

    const entitlementAccountIds = Array.from(
      new Set(
        order.tokenPurchases.flatMap((purchase) =>
          purchase.entitlementAccountId
            ? [purchase.entitlementAccountId]
            : [],
        ),
      ),
    );
    if (
      (
        refund.providerStatus
          === RechargeRefundProviderStatus.SUCCEEDED
        && refund.reversalStatus
          !== RechargeRefundReversalStatus.APPLIED
      )
      || refund.providerStatus
        === RechargeRefundProviderStatus.ABNORMAL
    ) {
      await tx.serviceEntitlementAccount.updateMany({
        where: { id: { in: entitlementAccountIds } },
        data: { status: ServiceEntitlementStatus.FROZEN },
      });
      if (
        refund.reversalStatus
        !== RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
      ) {
        await freezeHandoffGrantForRefund(
          tx as unknown as Prisma.TransactionClient,
          order.id,
        );
      }
    } else if (
      refund.providerStatus
        === RechargeRefundProviderStatus.CLOSED
      && refund.reversalStatus
        === RechargeRefundReversalStatus.NOT_REQUIRED
    ) {
      await restoreResolvedRefundEntitlements(
        tx as unknown as Prisma.TransactionClient,
        refund.id,
        entitlementAccountIds,
        result.verifiedAt,
      );
      await restoreHandoffGrantAfterFailedRefund(
        tx as unknown as Prisma.TransactionClient,
        refund.id,
        result.verifiedAt,
      );
    }

    if (
      refund.providerStatus
        === RechargeRefundProviderStatus.SUCCEEDED
      &&
      refund.reversalStatus
      === RechargeRefundReversalStatus.PENDING
    ) {
      await tx.outboxEvent.upsert({
        where: {
          idempotencyKey:
            `wechat_pay:refund:${refund.providerRefundId}:apply`,
        },
        create: {
          aggregateType: WECHAT_REFUND_REVERSAL_AGGREGATE_TYPE,
          aggregateId: refund.id,
          eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
          payload: { version: 1 },
          idempotencyKey:
            `wechat_pay:refund:${refund.providerRefundId}:apply`,
        },
        update: {},
      });
    }

    return serializeRefund(refund, providerEvent.providerEventId);
  });
}

/**
 * Merges a signed refund submission/query response into the intent created
 * before the provider call. Terminal states are monotonic: a late PROCESSING
 * response can never overwrite a callback-confirmed SUCCESS or CLOSED state.
 */
export async function persistVerifiedWeChatPayRefundApiResult(
  result: WeChatPayRefundApiResult,
  client: typeof prisma = prisma,
): Promise<WeChatRefundApiPersistenceSnapshot> {
  return runWalletWriteTransaction(client, async (tx) => {
    const order = await tx.rechargeOrder.findUnique({
      where: { id: result.outTradeNo },
      include: {
        handoffEntitlementGrant: true,
        tokenPurchases: {
          include: {
            userAgentWallet: true,
            creatorEarnings: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!order || order.provider !== PaymentProvider.WECHAT_PAY) {
      throw new WalletIdempotencyConflictError(
        "WeChat Pay refund API response",
        "recharge order identity",
      );
    }
    await lockTipCreatorEarningForRefund(
      tx as unknown as Prisma.TransactionClient,
      order.id,
    );
    const [byProviderId, byMerchantId] = await Promise.all([
      tx.rechargeRefund.findUnique({
        where: {
          provider_providerRefundId: {
            provider: PaymentProvider.WECHAT_PAY,
            providerRefundId: result.refundId,
          },
        },
      }),
      tx.rechargeRefund.findUnique({
        where: {
          provider_providerRefundOrderId: {
            provider: PaymentProvider.WECHAT_PAY,
            providerRefundOrderId: result.outRefundNo,
          },
        },
      }),
    ]);
    if (
      byProviderId
      && byMerchantId
      && byProviderId.id !== byMerchantId.id
    ) {
      throw new WalletIdempotencyConflictError(
        "WeChat Pay refund API response",
        "provider refund identity",
      );
    }
    const existing = byProviderId ?? byMerchantId;
    if (!existing) {
      throw new WalletIdempotencyConflictError(
        "WeChat Pay refund API response",
        "local refund intent",
      );
    }
    assertPersistedApiRefundMatches(existing, order.id, result);

    const desiredProviderStatus =
      refundApiProviderStatus(result.refundStatus);
    const effectiveProviderStatus =
      monotonicRefundProviderStatus(
        existing.providerStatus,
        desiredProviderStatus,
      );
    const matchingPurchase =
      order.tokenPurchases.length === 1
        ? order.tokenPurchases[0]!
        : null;
    const signedSuccessConflict =
      existing.providerStatus
        === RechargeRefundProviderStatus.CLOSED
      && desiredProviderStatus
        === RechargeRefundProviderStatus.SUCCEEDED
        ? "wechat_refund_terminal_status_conflict"
        : null;
    const preserveReconciliation =
      existing.reversalStatus
        === RechargeRefundReversalStatus.RECONCILIATION_REQUIRED;
    const reconciliationError =
      preserveReconciliation
        ? existing.processingError
          ?? "wechat_refund_reconciliation_required"
      : effectiveProviderStatus
        === RechargeRefundProviderStatus.SUCCEEDED
      ? signedSuccessConflict
        ?? refundReconciliationReason({
          order,
          purchase: matchingPurchase,
          result: {
            transactionId: result.transactionId,
            originalAmountCents: result.originalAmountCents,
            refundAmountCents: result.refundAmountCents,
            payerOriginalAmountCents: result.payerAmountCents,
            payerRefundAmountCents:
              result.payerRefundAmountCents,
          },
        })
      : null;
    const reversalStatus =
      existing.reversalStatus
        === RechargeRefundReversalStatus.APPLIED
      ? RechargeRefundReversalStatus.APPLIED
      : preserveReconciliation
        ? RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
      : effectiveProviderStatus
          === RechargeRefundProviderStatus.SUCCEEDED
        ? reconciliationError
          ? RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
          : RechargeRefundReversalStatus.PENDING
        : effectiveProviderStatus
            === RechargeRefundProviderStatus.CLOSED
          ? RechargeRefundReversalStatus.NOT_REQUIRED
          : RechargeRefundReversalStatus.PENDING;
    const updated = await tx.rechargeRefund.update({
      where: { id: existing.id },
      data: {
        providerRefundId: result.refundId,
        payerOriginalAmountCents: result.payerAmountCents,
        payerRefundAmountCents: result.payerRefundAmountCents,
        submissionStatus:
          RechargeRefundSubmissionStatus.ACCEPTED,
        providerStatus: effectiveProviderStatus,
        providerCreatedAt:
          existing.providerCreatedAt ?? result.providerCreatedAt,
        ...(result.source === "refund_query"
          ? { lastProviderQueryAt: result.verifiedAt }
          : {}),
        ...(effectiveProviderStatus
          === RechargeRefundProviderStatus.SUCCEEDED
          ? {
              providerSucceededAt:
                existing.providerSucceededAt
                ?? result.providerOccurredAt,
            }
          : {}),
        reversalStatus,
        processingError:
          reversalStatus
            === RechargeRefundReversalStatus.APPLIED
            ? null
            : reconciliationError,
      },
    });

    const providerEventType =
      refundApiProviderEventType(result.refundStatus);
    const event = await tx.paymentProviderEvent.upsert({
      where: {
        provider_providerEventId: {
          provider: PaymentProvider.WECHAT_PAY,
          providerEventId: result.providerEventId,
        },
      },
      create: {
        provider: PaymentProvider.WECHAT_PAY,
        providerEventId: result.providerEventId,
        eventType: providerEventType,
        rechargeOrderId: order.id,
        rechargeRefundId: updated.id,
        // Never set providerTransactionId on refund events: the schema makes
        // it unique per provider and the payment event already owns it.
        rawPayload: result.rawPayload as Prisma.InputJsonValue,
        normalizedPayload:
          result.normalizedPayload as Prisma.InputJsonValue,
        verifiedAt: result.verifiedAt,
        processedAt:
          providerEventType
              === PaymentProviderEventType.REFUND_SUCCEEDED
            ? reversalStatus
                === RechargeRefundReversalStatus.APPLIED
              ? result.verifiedAt
              : null
            : result.verifiedAt,
        processingError:
          reconciliationError
          ?? (
            providerEventType
              === PaymentProviderEventType.REFUND_ABNORMAL
              ? "wechat_refund_provider_abnormal"
              : null
          ),
        idempotencyKey:
          `wechat_pay:refund_api:${result.providerEventId}`,
      },
      update: {},
    });
    assertApiRefundProviderEventMatches(
      event,
      result,
      providerEventType,
      order.id,
      updated.id,
    );

    const entitlementAccountIds = Array.from(
      new Set(
        order.tokenPurchases.flatMap((purchase) =>
          purchase.entitlementAccountId
            ? [purchase.entitlementAccountId]
            : [],
        ),
      ),
    );
    if (
      effectiveProviderStatus
        === RechargeRefundProviderStatus.SUCCEEDED
      || effectiveProviderStatus
        === RechargeRefundProviderStatus.PROCESSING
      || effectiveProviderStatus
        === RechargeRefundProviderStatus.ABNORMAL
    ) {
      await tx.serviceEntitlementAccount.updateMany({
        where: { id: { in: entitlementAccountIds } },
        data: { status: ServiceEntitlementStatus.FROZEN },
      });
      if (
        reversalStatus
        !== RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
      ) {
        await freezeHandoffGrantForRefund(
          tx as unknown as Prisma.TransactionClient,
          order.id,
        );
      }
    } else if (
      effectiveProviderStatus
      === RechargeRefundProviderStatus.CLOSED
      && reversalStatus
        === RechargeRefundReversalStatus.NOT_REQUIRED
    ) {
      await restoreResolvedRefundEntitlements(
        tx as unknown as Prisma.TransactionClient,
        updated.id,
        entitlementAccountIds,
        result.verifiedAt,
      );
      await restoreHandoffGrantAfterFailedRefund(
        tx as unknown as Prisma.TransactionClient,
        updated.id,
        result.verifiedAt,
      );
    }

    if (
      effectiveProviderStatus
        === RechargeRefundProviderStatus.SUCCEEDED
      && reversalStatus
        === RechargeRefundReversalStatus.PENDING
    ) {
      await tx.outboxEvent.upsert({
        where: {
          idempotencyKey:
            `wechat_pay:refund:${result.refundId}:apply`,
        },
        create: {
          aggregateType: WECHAT_REFUND_REVERSAL_AGGREGATE_TYPE,
          aggregateId: updated.id,
          eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
          payload: { version: 1 },
          idempotencyKey:
            `wechat_pay:refund:${result.refundId}:apply`,
        },
        update: {},
      });
    }

    return {
      providerEventId: event.providerEventId,
      refundId: updated.id,
      rechargeOrderId: updated.rechargeOrderId,
      providerRefundId: result.refundId,
      providerRefundOrderId: updated.providerRefundOrderId,
      providerStatus:
        serializeRefundApiProviderStatus(
          effectiveProviderStatus,
        ),
      reversalStatus:
        serializeRefundReversalStatus(reversalStatus),
      processingError: updated.processingError,
    };
  });
}

/**
 * Applies only the deliberately narrow automatic policy: one full, undiscounted
 * refund whose representative-scoped credits have never been consumed or
 * reserved and whose creator proceeds remain pending.
 */
export async function applyVerifiedWeChatPayRefund(
  rechargeRefundId: string,
  client: typeof prisma = prisma,
): Promise<WeChatRefundPersistenceSnapshot> {
  if (!rechargeRefundId.trim()) {
    throw new Error("Recharge refund id is required.");
  }

  return runWalletWriteTransaction(client, async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "RechargeRefund"
      WHERE "id" = ${rechargeRefundId}
      FOR UPDATE
    `);
    const refund = await tx.rechargeRefund.findUnique({
      where: { id: rechargeRefundId },
      include: {
        rechargeOrder: {
          include: { handoffEntitlementGrant: true },
        },
        tokenPurchase: {
          include: {
            userAgentWallet: true,
            creatorEarnings: true,
            entitlementAccount: true,
          },
        },
        providerEvents: {
          orderBy: { receivedAt: "asc" },
        },
      },
    });
    if (!refund) {
      throw new Error("Recharge refund not found.");
    }
    const providerEventId =
      refund.providerEvents.find(
        (event) =>
          event.eventType
            === PaymentProviderEventType.REFUND_SUCCEEDED,
      )?.providerEventId
      ?? `wechat_refund_${refund.providerRefundId}`;
    const forcedTipRefund = isForcedTipRefundOrder(
      refund.rechargeOrder,
    );
    if (
      refund.reversalStatus
      === RechargeRefundReversalStatus.APPLIED
      || refund.reversalStatus
        === RechargeRefundReversalStatus.NOT_REQUIRED
      || (
        refund.reversalStatus
          === RechargeRefundReversalStatus.RECONCILIATION_REQUIRED
        && !forcedTipRefund
      )
    ) {
      return serializeRefund(refund, providerEventId);
    }
    if (
      refund.providerStatus
      !== RechargeRefundProviderStatus.SUCCEEDED
    ) {
      throw new Error(
        "Recharge refund cannot be reversed before provider success.",
      );
    }
    if (
      !refund.providerRefundId
      || refund.payerOriginalAmountCents === null
      || refund.payerRefundAmountCents === null
    ) {
      throw new Error(
        "Successful recharge refund is missing provider identity or payer amounts.",
      );
    }

    const reconciliationError = refundReconciliationReason({
      order: refund.rechargeOrder,
      purchase: refund.tokenPurchase,
      result: {
        transactionId: refund.paymentTransactionId,
        originalAmountCents: refund.originalAmountCents,
        refundAmountCents: refund.refundAmountCents,
        payerOriginalAmountCents: refund.payerOriginalAmountCents,
        payerRefundAmountCents: refund.payerRefundAmountCents,
      },
    });
    if (reconciliationError) {
      const quarantined = await tx.rechargeRefund.update({
        where: { id: refund.id },
        data: {
          reversalStatus:
            RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
          processingError: reconciliationError,
        },
      });
      await tx.paymentProviderEvent.updateMany({
        where: { rechargeRefundId: refund.id },
        data: { processingError: reconciliationError },
      });
      return serializeRefund(quarantined, providerEventId);
    }

    const purchase = refund.tokenPurchase;
    if (forcedTipRefund) {
      const reversal = await reverseForcedTipContributionRefund(
        tx as unknown as Prisma.TransactionClient,
        {
          rechargeRefundId: refund.id,
          rechargeOrderId: refund.rechargeOrderId,
          paymentProviderEventId:
            refund.providerEvents.find(
              (event) =>
                event.eventType
                  === PaymentProviderEventType.REFUND_SUCCEEDED,
            )?.id ?? null,
          reversedAt: refund.providerSucceededAt ?? new Date(),
        },
      );
      if (!reversal.reversed) {
        const processingError =
          reversal.processingError
          ?? "wechat_refund_tip_reversal_required";
        const quarantined = await tx.rechargeRefund.update({
          where: { id: refund.id },
          data: {
            reversalStatus:
              RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
            processingError,
          },
        });
        await tx.paymentProviderEvent.updateMany({
          where: { rechargeRefundId: refund.id },
          data: { processingError },
        });
        return serializeRefund(quarantined, providerEventId);
      }
    } else {
      const servicePurchase = purchase!;
      await reverseAgentTokenPurchase(
        servicePurchase.id,
        {
          tokenAmount: servicePurchase.tokenAmount,
          idempotencyKey:
            `wechat_refund:${refund.providerRefundId}:purchase`,
          reason: "wechat_pay_external_refund",
        },
        tx as unknown as NonNullable<
          Parameters<typeof reverseAgentTokenPurchase>[2]
        >,
      );
      await refundHandoffGrant(
        tx as unknown as Prisma.TransactionClient,
        refund.rechargeOrderId,
        refund.id,
      );
    }
    await refundRechargeOrder(
      refund.rechargeOrderId,
      {
        providerEventId,
        rechargeRefundId: refund.id,
        refundedAt: refund.providerSucceededAt ?? new Date(),
        reason: "wechat_pay_external_refund",
      },
      tx as unknown as NonNullable<
        Parameters<typeof refundRechargeOrder>[2]
      >,
    );

    const appliedAt = new Date();
    const applied = await tx.rechargeRefund.update({
      where: { id: refund.id },
      data: {
        reversalStatus: RechargeRefundReversalStatus.APPLIED,
        reversalAppliedAt: appliedAt,
        processingError: null,
      },
    });
    await tx.paymentProviderEvent.updateMany({
      where: { rechargeRefundId: refund.id },
      data: {
        processedAt: appliedAt,
        processingError: null,
      },
    });

    if (purchase?.entitlementAccountId) {
      const unresolved = await tx.rechargeRefund.count({
        where: {
          id: { not: refund.id },
          reversalStatus: {
            in: [
              RechargeRefundReversalStatus.PENDING,
              RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
            ],
          },
          tokenPurchase: {
            entitlementAccountId: purchase.entitlementAccountId,
          },
        },
      });
      if (unresolved === 0) {
        const account = await tx.serviceEntitlementAccount.findUnique({
          where: { id: purchase.entitlementAccountId },
        });
        if (account) {
          const expired =
            account.expiresAt !== null
            && account.expiresAt.getTime() <= appliedAt.getTime();
          await tx.serviceEntitlementAccount.update({
            where: { id: account.id },
            data: {
              status: expired
                ? ServiceEntitlementStatus.EXPIRED
                : account.remainingUnits === 0
                    && account.reservedUnits === 0
                  ? ServiceEntitlementStatus.EXHAUSTED
                  : ServiceEntitlementStatus.ACTIVE,
            },
          });
        }
      }
    }

    return serializeRefund(applied, providerEventId);
  });
}

export async function runWeChatRefundReversalTick(
  options: {
    limit?: number;
    leaseMs?: number;
    maxAttempts?: number;
    maxBackoffMs?: number;
  } = {},
): Promise<WeChatRefundReversalTickSummary> {
  const limit = boundedInteger(options.limit, 10, 1, 100);
  const leaseMs = boundedInteger(
    options.leaseMs,
    DEFAULT_REFUND_REVERSAL_LEASE_MS,
    30_000,
    10 * 60_000,
  );
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    DEFAULT_REFUND_REVERSAL_MAX_ATTEMPTS,
    1,
    100,
  );
  const maxBackoffMs = boundedInteger(
    options.maxBackoffMs,
    DEFAULT_REFUND_REVERSAL_MAX_BACKOFF_MS,
    1_000,
    24 * 60 * 60_000,
  );
  const summary: WeChatRefundReversalTickSummary = {
    claimed: 0,
    applied: 0,
    reconciliationRequired: 0,
    retryScheduled: 0,
    unresolved: 0,
  };

  for (let index = 0; index < limit; index += 1) {
    const claim = await claimNextRefundReversal({
      leaseMs,
      maxAttempts,
    });
    if (!claim) {
      break;
    }
    summary.claimed += 1;
    try {
      const result = await applyVerifiedWeChatPayRefund(
        claim.rechargeRefundId,
      );
      if (result.reversalStatus === "applied") {
        await finalizeRefundReversalClaim(
          claim,
          "PROCESSED",
          null,
        );
        summary.applied += 1;
      } else {
        await finalizeRefundReversalClaim(
          claim,
          "DEAD_LETTER",
          result.processingError
            ?? "wechat_refund_reconciliation_required",
        );
        summary.reconciliationRequired += 1;
      }
    } catch (error) {
      await rescheduleRefundReversalClaim(
        claim,
        safeRefundFailureCode(error),
        maxBackoffMs,
      );
      summary.retryScheduled += 1;
    }
  }

  const [unresolvedRefunds, unmatchedRefundEvents] =
    await Promise.all([
      prisma.rechargeRefund.count({
        where: {
          OR: [
            {
              reversalStatus:
                RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
            },
            {
              providerStatus:
                RechargeRefundProviderStatus.SUCCEEDED,
              reversalStatus:
                RechargeRefundReversalStatus.PENDING,
            },
            {
              providerStatus:
                RechargeRefundProviderStatus.ABNORMAL,
            },
          ],
        },
      }),
      prisma.paymentProviderEvent.count({
        where: {
          provider: PaymentProvider.WECHAT_PAY,
          eventType: {
            in: [
              PaymentProviderEventType.REFUND_SUCCEEDED,
              PaymentProviderEventType.REFUND_CLOSED,
              PaymentProviderEventType.REFUND_ABNORMAL,
            ],
          },
          rechargeRefundId: null,
          processingError: { not: null },
        },
      }),
    ]);
  summary.unresolved = unresolvedRefunds + unmatchedRefundEvents;
  return summary;
}

async function claimNextRefundReversal(input: {
  leaseMs: number;
  maxAttempts: number;
}): Promise<ClaimedRefundReversal | null> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{
      id: string;
      aggregateId: string;
      attemptCount: number;
      claimedAt: Date;
    }>>`
      SELECT "id", "aggregateId", "attemptCount", NOW() AS "claimedAt"
      FROM "OutboxEvent"
      WHERE "status" IN ('PENDING', 'FAILED', 'PROCESSING')
        AND "aggregateType" = ${WECHAT_REFUND_REVERSAL_AGGREGATE_TYPE}
        AND "eventType" = ${WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE}
        AND "availableAt" <= NOW()
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) {
      return null;
    }
    if (candidate.attemptCount >= input.maxAttempts) {
      const errorCode = "wechat_refund_reversal_attempts_exhausted";
      await Promise.all([
        tx.rechargeRefund.updateMany({
          where: {
            id: candidate.aggregateId,
            reversalStatus: RechargeRefundReversalStatus.PENDING,
          },
          data: {
            reversalStatus:
              RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
            processingError: errorCode,
          },
        }),
        tx.paymentProviderEvent.updateMany({
          where: { rechargeRefundId: candidate.aggregateId },
          data: { processingError: errorCode },
        }),
        tx.outboxEvent.update({
          where: { id: candidate.id },
          data: {
            status: "DEAD_LETTER",
            lastError: errorCode,
          },
        }),
      ]);
      return null;
    }

    const outbox = await tx.outboxEvent.update({
      where: { id: candidate.id },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: new Date(
          candidate.claimedAt.getTime() + input.leaseMs,
        ),
        processedAt: null,
        lastError: null,
      },
    });
    const refund = await tx.rechargeRefund.findUnique({
      where: { id: outbox.aggregateId },
      select: { reversalStatus: true },
    });
    if (!refund) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: {
          status: "DEAD_LETTER",
          lastError: "wechat_refund_missing",
        },
      });
      return null;
    }
    if (
      refund.reversalStatus
      !== RechargeRefundReversalStatus.PENDING
    ) {
      const completed =
        refund.reversalStatus
          === RechargeRefundReversalStatus.APPLIED
        || refund.reversalStatus
          === RechargeRefundReversalStatus.NOT_REQUIRED;
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: {
          status: completed ? "PROCESSED" : "DEAD_LETTER",
          processedAt: completed ? new Date() : null,
          lastError: completed
            ? null
            : "wechat_refund_reconciliation_required",
        },
      });
      return null;
    }
    return {
      outboxId: outbox.id,
      rechargeRefundId: outbox.aggregateId,
      leaseAttempt: outbox.attemptCount,
    };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}

async function finalizeRefundReversalClaim(
  claim: ClaimedRefundReversal,
  status: "PROCESSED" | "DEAD_LETTER",
  lastError: string | null,
): Promise<void> {
  const completed = await prisma.outboxEvent.updateMany({
    where: {
      id: claim.outboxId,
      aggregateId: claim.rechargeRefundId,
      aggregateType: WECHAT_REFUND_REVERSAL_AGGREGATE_TYPE,
      eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
      status: "PROCESSING",
      attemptCount: claim.leaseAttempt,
    },
    data: {
      status,
      processedAt: status === "PROCESSED" ? new Date() : null,
      lastError,
    },
  });
  if (completed.count !== 1) {
    throw new WeChatRefundReversalLeaseLostError(
      claim.outboxId,
      claim.leaseAttempt,
    );
  }
}

async function rescheduleRefundReversalClaim(
  claim: ClaimedRefundReversal,
  errorCode: string,
  maxBackoffMs: number,
): Promise<void> {
  const backoffMs = Math.min(
    maxBackoffMs,
    2 ** Math.min(claim.leaseAttempt, 20) * 1_000,
  );
  const failed = await prisma.$executeRaw`
    UPDATE "OutboxEvent"
    SET
      "status" = 'FAILED',
      "availableAt" =
        NOW() + (${backoffMs} * INTERVAL '1 millisecond'),
      "lastError" = ${errorCode},
      "updatedAt" = NOW()
    WHERE "id" = ${claim.outboxId}
      AND "aggregateId" = ${claim.rechargeRefundId}
      AND "aggregateType" =
        ${WECHAT_REFUND_REVERSAL_AGGREGATE_TYPE}
      AND "eventType" =
        ${WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE}
      AND "status" = 'PROCESSING'
      AND "attemptCount" = ${claim.leaseAttempt}
  `;
  if (failed !== 1) {
    throw new WeChatRefundReversalLeaseLostError(
      claim.outboxId,
      claim.leaseAttempt,
    );
  }
}

function refundProviderEventType(
  status: NormalizedWeChatPayRefundResult["refundStatus"],
): PaymentProviderEventType {
  switch (status) {
    case "SUCCESS":
      return PaymentProviderEventType.REFUND_SUCCEEDED;
    case "CLOSED":
      return PaymentProviderEventType.REFUND_CLOSED;
    case "ABNORMAL":
      return PaymentProviderEventType.REFUND_ABNORMAL;
  }
}

function refundApiProviderEventType(
  status: WeChatPayRefundApiResult["refundStatus"],
): PaymentProviderEventType {
  switch (status) {
    case "PROCESSING":
      return PaymentProviderEventType.REFUND_PROCESSING;
    case "SUCCESS":
      return PaymentProviderEventType.REFUND_SUCCEEDED;
    case "CLOSED":
      return PaymentProviderEventType.REFUND_CLOSED;
    case "ABNORMAL":
      return PaymentProviderEventType.REFUND_ABNORMAL;
  }
}

function refundProviderStatus(
  status: NormalizedWeChatPayRefundResult["refundStatus"],
): RechargeRefundProviderStatus {
  switch (status) {
    case "SUCCESS":
      return RechargeRefundProviderStatus.SUCCEEDED;
    case "CLOSED":
      return RechargeRefundProviderStatus.CLOSED;
    case "ABNORMAL":
      return RechargeRefundProviderStatus.ABNORMAL;
  }
}

function refundApiProviderStatus(
  status: WeChatPayRefundApiResult["refundStatus"],
): RechargeRefundProviderStatus {
  switch (status) {
    case "PROCESSING":
      return RechargeRefundProviderStatus.PROCESSING;
    case "SUCCESS":
      return RechargeRefundProviderStatus.SUCCEEDED;
    case "CLOSED":
      return RechargeRefundProviderStatus.CLOSED;
    case "ABNORMAL":
      return RechargeRefundProviderStatus.ABNORMAL;
  }
}

function monotonicRefundProviderStatus(
  current: RechargeRefundProviderStatus | null,
  desired: RechargeRefundProviderStatus,
): RechargeRefundProviderStatus {
  if (
    current === RechargeRefundProviderStatus.SUCCEEDED
    || desired === RechargeRefundProviderStatus.SUCCEEDED
  ) {
    return RechargeRefundProviderStatus.SUCCEEDED;
  }
  if (current === RechargeRefundProviderStatus.CLOSED) {
    return RechargeRefundProviderStatus.CLOSED;
  }
  if (
    current === RechargeRefundProviderStatus.ABNORMAL
    && desired === RechargeRefundProviderStatus.PROCESSING
  ) {
    return RechargeRefundProviderStatus.ABNORMAL;
  }
  return desired;
}

function assertApiRefundProviderEventMatches(
  event: {
    provider: PaymentProvider;
    providerEventId: string;
    eventType: PaymentProviderEventType;
    rechargeOrderId: string | null;
    rechargeRefundId: string | null;
    providerTransactionId: string | null;
    rawPayload: Prisma.JsonValue;
    normalizedPayload: Prisma.JsonValue | null;
    idempotencyKey: string | null;
  },
  result: WeChatPayRefundApiResult,
  eventType: PaymentProviderEventType,
  rechargeOrderId: string,
  rechargeRefundId: string,
): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["provider", event.provider, PaymentProvider.WECHAT_PAY],
    ["providerEventId", event.providerEventId, result.providerEventId],
    ["eventType", event.eventType, eventType],
    ["rechargeOrderId", event.rechargeOrderId, rechargeOrderId],
    ["rechargeRefundId", event.rechargeRefundId, rechargeRefundId],
    ["providerTransactionId", event.providerTransactionId, null],
    [
      "idempotencyKey",
      event.idempotencyKey,
      `wechat_pay:refund_api:${result.providerEventId}`,
    ],
    [
      "rawPayload",
      stableJson(event.rawPayload),
      stableJson(result.rawPayload),
    ],
    [
      "normalizedPayload",
      stableJson(event.normalizedPayload),
      stableJson(result.normalizedPayload),
    ],
  ];
  for (const [field, actual, expected] of fields) {
    assertWalletIdempotencyField(
      "WeChat Pay refund API event",
      field,
      actual,
      expected,
    );
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [
          key,
          canonicalJsonValue(nested),
        ]),
    );
  }
  return value;
}

function assertPersistedApiRefundMatches(
  refund: {
    rechargeOrderId: string;
    provider: PaymentProvider;
    providerRefundOrderId: string;
    providerRefundId: string | null;
    paymentTransactionId: string;
    originalAmountCents: number;
    refundAmountCents: number;
    payerOriginalAmountCents: number | null;
    payerRefundAmountCents: number | null;
    currency: string;
    submissionStatus: RechargeRefundSubmissionStatus;
    requestIdempotencyKey: string | null;
  },
  rechargeOrderId: string,
  result: WeChatPayRefundApiResult,
): void {
  if (
    refund.submissionStatus
      === RechargeRefundSubmissionStatus.EXTERNAL
    || !refund.requestIdempotencyKey
  ) {
    throw new WalletIdempotencyConflictError(
      "WeChat Pay refund API response",
      "submission intent",
    );
  }
  const fields: Array<[string, unknown, unknown]> = [
    ["rechargeOrderId", refund.rechargeOrderId, rechargeOrderId],
    ["provider", refund.provider, PaymentProvider.WECHAT_PAY],
    [
      "providerRefundOrderId",
      refund.providerRefundOrderId,
      result.outRefundNo,
    ],
    [
      "paymentTransactionId",
      refund.paymentTransactionId,
      result.transactionId,
    ],
    [
      "originalAmountCents",
      refund.originalAmountCents,
      result.originalAmountCents,
    ],
    [
      "refundAmountCents",
      refund.refundAmountCents,
      result.refundAmountCents,
    ],
    ["currency", refund.currency, "CNY"],
  ];
  if (refund.providerRefundId !== null) {
    fields.push([
      "providerRefundId",
      refund.providerRefundId,
      result.refundId,
    ]);
  }
  if (refund.payerOriginalAmountCents !== null) {
    fields.push([
      "payerOriginalAmountCents",
      refund.payerOriginalAmountCents,
      result.payerAmountCents,
    ]);
  }
  if (refund.payerRefundAmountCents !== null) {
    fields.push([
      "payerRefundAmountCents",
      refund.payerRefundAmountCents,
      result.payerRefundAmountCents,
    ]);
  }
  for (const [field, actual, expected] of fields) {
    assertWalletIdempotencyField(
      "WeChat Pay refund API response",
      field,
      actual,
      expected,
    );
  }
}

async function restoreResolvedRefundEntitlements(
  tx: Prisma.TransactionClient,
  rechargeRefundId: string,
  entitlementAccountIds: string[],
  now: Date,
): Promise<void> {
  for (const entitlementAccountId of entitlementAccountIds) {
    const unresolved = await tx.rechargeRefund.count({
      where: {
        id: { not: rechargeRefundId },
        tokenPurchase: { entitlementAccountId },
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
    if (unresolved !== 0) continue;

    const account =
      await tx.serviceEntitlementAccount.findUnique({
        where: { id: entitlementAccountId },
      });
    if (!account) continue;
    const expired =
      account.expiresAt !== null
      && account.expiresAt.getTime() <= now.getTime();
    await tx.serviceEntitlementAccount.update({
      where: { id: account.id },
      data: {
        status: expired
          ? ServiceEntitlementStatus.EXPIRED
          : account.remainingUnits === 0
              && account.reservedUnits === 0
            ? ServiceEntitlementStatus.EXHAUSTED
            : ServiceEntitlementStatus.ACTIVE,
      },
    });
  }
}

function assertRefundProviderEventMatches(
  event: {
    provider: PaymentProvider;
    providerEventId: string;
    eventType: PaymentProviderEventType;
    rawPayload: Prisma.JsonValue;
    normalizedPayload: Prisma.JsonValue | null;
    idempotencyKey: string | null;
  },
  result: NormalizedWeChatPayRefundResult,
  expectedEventType: PaymentProviderEventType,
): void {
  const expectedIdempotencyKey =
    `wechat_pay:refund_notification:${result.providerEventId}`;
  const fields: Array<[string, unknown, unknown]> = [
    ["provider", event.provider, PaymentProvider.WECHAT_PAY],
    ["providerEventId", event.providerEventId, result.providerEventId],
    ["eventType", event.eventType, expectedEventType],
    [
      "idempotencyKey",
      event.idempotencyKey,
      expectedIdempotencyKey,
    ],
  ];
  const normalized = jsonObject(event.normalizedPayload);
  const expectedNormalized = result.normalizedPayload;
  const raw = jsonObject(event.rawPayload);
  const rawResource = jsonObject(raw.resource ?? null);
  const expectedRaw = result.rawPayload;
  const expectedRawResource = expectedRaw.resource;
  for (const [field, actual, expected] of [
    ["rawPayload.id", raw.id, expectedRaw.id],
    [
      "rawPayload.createTime",
      raw.createTime,
      expectedRaw.createTime,
    ],
    [
      "rawPayload.resourceType",
      raw.resourceType,
      expectedRaw.resourceType,
    ],
    [
      "rawPayload.eventType",
      raw.eventType,
      expectedRaw.eventType,
    ],
    ["rawPayload.summary", raw.summary, expectedRaw.summary],
    [
      "rawPayload.resource.algorithm",
      rawResource.algorithm,
      expectedRawResource.algorithm,
    ],
    [
      "rawPayload.resource.ciphertext",
      rawResource.ciphertext,
      expectedRawResource.ciphertext,
    ],
    [
      "rawPayload.resource.nonce",
      rawResource.nonce,
      expectedRawResource.nonce,
    ],
    [
      "rawPayload.resource.associatedData",
      rawResource.associatedData,
      expectedRawResource.associatedData,
    ],
    [
      "rawPayload.resource.originalType",
      rawResource.originalType,
      expectedRawResource.originalType,
    ],
  ] as Array<[string, unknown, unknown]>) {
    fields.push([field, actual, expected]);
  }
  for (const field of [
    "type",
    "provider",
    "providerEventId",
    "providerRefundId",
    "providerRefundOrderId",
    "providerPaymentTransactionId",
    "rechargeOrderId",
    "merchantId",
    "refundStatus",
    "originalAmountCents",
    "refundAmountCents",
    "payerAmountCents",
    "payerRefundAmountCents",
    "providerOccurredAt",
  ] as const) {
    fields.push([
      `normalizedPayload.${field}`,
      normalized[field],
      expectedNormalized[field],
    ]);
  }
  for (const [field, actual, expected] of fields) {
    assertWalletIdempotencyField(
      "WeChat Pay refund event",
      field,
      actual,
      expected,
    );
  }
}

function jsonObject(
  value: Prisma.JsonValue | null,
): Prisma.JsonObject {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return {};
  }
  return value;
}

async function bindRelatedUnmatchedRefundEvents(
  tx: Prisma.TransactionClient,
  refund: {
    id: string;
    providerStatus: RechargeRefundProviderStatus | null;
    reversalStatus: RechargeRefundReversalStatus;
    processingError: string | null;
  },
  rechargeOrderId: string,
  result: NormalizedWeChatPayRefundResult,
): Promise<void> {
  const candidates = await tx.paymentProviderEvent.findMany({
    where: {
      provider: PaymentProvider.WECHAT_PAY,
      eventType: {
        in: [
          PaymentProviderEventType.REFUND_SUCCEEDED,
          PaymentProviderEventType.REFUND_CLOSED,
          PaymentProviderEventType.REFUND_ABNORMAL,
        ],
      },
      rechargeOrderId: null,
      rechargeRefundId: null,
      normalizedPayload: {
        path: ["providerRefundId"],
        equals: result.refundId,
      },
    },
  });

  for (const event of candidates) {
    const normalized = jsonObject(event.normalizedPayload);
    if (
      !relatedRefundIdentityMatches(normalized, result)
      || !relatedRefundStatusCanBind(
        event.eventType,
        refund.providerStatus,
      )
    ) {
      await tx.paymentProviderEvent.updateMany({
        where: {
          id: event.id,
          rechargeOrderId: null,
          rechargeRefundId: null,
        },
        data: {
          processingError:
            "wechat_refund_unmatched_identity_or_status_conflict",
        },
      });
      continue;
    }

    const successfulReversalStillPending =
      event.eventType
        === PaymentProviderEventType.REFUND_SUCCEEDED
      && refund.reversalStatus
        !== RechargeRefundReversalStatus.APPLIED;
    await tx.paymentProviderEvent.updateMany({
      where: {
        id: event.id,
        rechargeOrderId: null,
        rechargeRefundId: null,
      },
      data: {
        rechargeOrderId,
        rechargeRefundId: refund.id,
        processedAt: successfulReversalStillPending
          ? null
          : event.processedAt
            ?? event.verifiedAt
            ?? event.receivedAt,
        processingError:
          refund.providerStatus
            === RechargeRefundProviderStatus.ABNORMAL
            ? "wechat_refund_provider_abnormal"
            : refund.processingError,
      },
    });
  }
}

function relatedRefundIdentityMatches(
  normalized: Prisma.JsonObject,
  result: NormalizedWeChatPayRefundResult,
): boolean {
  const expected = result.normalizedPayload;
  const identityFields = [
    "provider",
    "providerRefundId",
    "providerRefundOrderId",
    "providerPaymentTransactionId",
    "rechargeOrderId",
    "merchantId",
    "originalAmountCents",
    "refundAmountCents",
    "payerAmountCents",
    "payerRefundAmountCents",
  ] as const;
  return identityFields.every(
    (field) => Object.is(normalized[field], expected[field]),
  );
}

function relatedRefundStatusCanBind(
  eventType: PaymentProviderEventType,
  providerStatus: RechargeRefundProviderStatus | null,
): boolean {
  if (providerStatus === null) return false;
  switch (providerStatus) {
    case RechargeRefundProviderStatus.SUCCEEDED:
      return eventType === PaymentProviderEventType.REFUND_SUCCEEDED
        || eventType === PaymentProviderEventType.REFUND_CLOSED
        || eventType === PaymentProviderEventType.REFUND_ABNORMAL;
    case RechargeRefundProviderStatus.CLOSED:
      return eventType === PaymentProviderEventType.REFUND_CLOSED
        || eventType === PaymentProviderEventType.REFUND_ABNORMAL;
    case RechargeRefundProviderStatus.ABNORMAL:
      return eventType === PaymentProviderEventType.REFUND_ABNORMAL;
    case RechargeRefundProviderStatus.PROCESSING:
      return false;
  }
}

function refundReconciliationReason(input: {
  order: {
    id: string;
    productKindSnapshot: BillingProductKind | null;
    refundPolicySnapshot: BillingRefundPolicy | null;
    provider: PaymentProvider;
    providerTransactionId: string | null;
    amountCents: number;
    currency: string;
    status: RechargeOrderStatus;
    handoffEntitlementGrant: Parameters<
      typeof handoffGrantRefundConflictReason
    >[0];
  };
  purchase: {
    rechargeOrderId: string | null;
    amountCents: number;
    currency: string;
    tokenAmount: number;
    remainingTokenAmount: number | null;
    creatorPendingCents: number;
    status: AgentTokenPurchaseStatus;
    entitlementAccountId: string | null;
    userAgentWallet: {
      reservedTokenAmount: number;
    } | null;
    creatorEarnings: Array<{
      status: CreatorEarningStatus;
      pendingCents: number;
      withdrawableCents: number;
    }>;
  } | null;
  result: {
    transactionId: string;
    originalAmountCents: number;
    refundAmountCents: number;
    payerOriginalAmountCents: number;
    payerRefundAmountCents: number;
  };
}): string | null {
  const { order, purchase, result } = input;
  if (order.provider !== PaymentProvider.WECHAT_PAY) {
    return "wechat_refund_provider_mismatch";
  }
  if (
    !order.providerTransactionId
    || order.providerTransactionId !== result.transactionId
  ) {
    return "wechat_refund_payment_transaction_mismatch";
  }
  if (
    order.status !== RechargeOrderStatus.PAID
    && order.status !== RechargeOrderStatus.REFUNDED
  ) {
    return "wechat_refund_order_not_paid";
  }
  if (
    order.currency !== "CNY"
    || result.originalAmountCents !== order.amountCents
  ) {
    return "wechat_refund_original_amount_mismatch";
  }
  if (
    result.refundAmountCents !== order.amountCents
    || result.payerOriginalAmountCents !== order.amountCents
    || result.payerRefundAmountCents !== order.amountCents
  ) {
    return "wechat_refund_partial_or_discounted_not_supported";
  }
  const policyConflict = commercialRefundPolicyConflictReason(order);
  if (policyConflict && !isForcedTipRefundOrder(order)) {
    return policyConflict;
  }
  if (isForcedTipRefundOrder(order)) {
    if (order.handoffEntitlementGrant) {
      return "wechat_refund_tip_unexpected_handoff_entitlement";
    }
    if (purchase) {
      return "wechat_refund_tip_unexpected_token_purchase";
    }
    return null;
  }
  const handoffConflict = handoffGrantRefundConflictReason(
    order.handoffEntitlementGrant,
  );
  if (handoffConflict) return handoffConflict;
  if (!purchase) {
    return "wechat_refund_purchase_missing_or_ambiguous";
  }
  if (
    purchase.rechargeOrderId !== order.id
    || purchase.amountCents !== order.amountCents
    || purchase.currency !== order.currency
  ) {
    return "wechat_refund_purchase_mismatch";
  }
  if (
    purchase.status !== AgentTokenPurchaseStatus.COMPLETED
    || purchase.remainingTokenAmount !== purchase.tokenAmount
  ) {
    return "wechat_refund_credits_already_consumed";
  }
  if (!purchase.entitlementAccountId) {
    return "wechat_refund_entitlement_link_missing";
  }
  if (!purchase.userAgentWallet) {
    return "wechat_refund_scoped_wallet_missing";
  }
  if (purchase.userAgentWallet.reservedTokenAmount !== 0) {
    return "wechat_refund_credits_reserved";
  }
  if (
    purchase.creatorEarnings.some(
      (earning) =>
        earning.status !== CreatorEarningStatus.PENDING
        || earning.withdrawableCents !== 0,
    )
  ) {
    return "wechat_refund_creator_earning_already_released";
  }
  const pendingCreatorCents = purchase.creatorEarnings.reduce(
    (sum, earning) => sum + earning.pendingCents,
    0,
  );
  if (pendingCreatorCents !== purchase.creatorPendingCents) {
    return "wechat_refund_creator_earning_mismatch";
  }
  return null;
}

function isForcedTipRefundOrder(order: {
  productKindSnapshot: BillingProductKind | null;
  refundPolicySnapshot: BillingRefundPolicy | null;
}): boolean {
  return (
    order.productKindSnapshot === BillingProductKind.TIP
    && order.refundPolicySnapshot === BillingRefundPolicy.NON_REFUNDABLE
  );
}

function assertPersistedRefundMatches(
  refund: {
    rechargeOrderId: string;
    provider: PaymentProvider;
    providerRefundOrderId: string;
    providerRefundId: string | null;
    paymentTransactionId: string;
    originalAmountCents: number;
    refundAmountCents: number;
    payerOriginalAmountCents: number | null;
    payerRefundAmountCents: number | null;
  },
  rechargeOrderId: string,
  result: NormalizedWeChatPayRefundResult,
): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["rechargeOrderId", refund.rechargeOrderId, rechargeOrderId],
    ["provider", refund.provider, PaymentProvider.WECHAT_PAY],
    [
      "providerRefundOrderId",
      refund.providerRefundOrderId,
      result.outRefundNo,
    ],
    [
      "paymentTransactionId",
      refund.paymentTransactionId,
      result.transactionId,
    ],
    [
      "originalAmountCents",
      refund.originalAmountCents,
      result.originalAmountCents,
    ],
    [
      "refundAmountCents",
      refund.refundAmountCents,
      result.refundAmountCents,
    ],
  ];
  if (refund.providerRefundId !== null) {
    fields.push([
      "providerRefundId",
      refund.providerRefundId,
      result.refundId,
    ]);
  }
  if (refund.payerOriginalAmountCents !== null) {
    fields.push([
      "payerOriginalAmountCents",
      refund.payerOriginalAmountCents,
      result.payerAmountCents,
    ]);
  }
  if (refund.payerRefundAmountCents !== null) {
    fields.push([
      "payerRefundAmountCents",
      refund.payerRefundAmountCents,
      result.payerRefundAmountCents,
    ]);
  }
  for (const [field, actual, expected] of fields) {
    assertWalletIdempotencyField(
      "WeChat Pay refund",
      field,
      actual,
      expected,
    );
  }
}

function serializeRefund(refund: {
  id: string;
  rechargeOrderId: string;
  providerRefundId: string | null;
  providerRefundOrderId: string;
  providerStatus: RechargeRefundProviderStatus | null;
  reversalStatus: RechargeRefundReversalStatus;
  processingError: string | null;
}, providerEventId: string): WeChatRefundPersistenceSnapshot {
  if (!refund.providerRefundId || !refund.providerStatus) {
    throw new Error(
      "WeChat refund persistence snapshot requires provider identity.",
    );
  }
  return {
    providerEventId,
    refundId: refund.id,
    rechargeOrderId: refund.rechargeOrderId,
    providerRefundId: refund.providerRefundId,
    providerRefundOrderId: refund.providerRefundOrderId,
    providerStatus:
      serializeRefundProviderStatus(refund.providerStatus),
    reversalStatus:
      serializeRefundReversalStatus(refund.reversalStatus),
    processingError: refund.processingError,
  };
}

function serializeRefundProviderStatus(
  status: RechargeRefundProviderStatus,
): WeChatRefundPersistenceSnapshot["providerStatus"] {
  switch (status) {
    case RechargeRefundProviderStatus.SUCCEEDED:
      return "succeeded";
    case RechargeRefundProviderStatus.CLOSED:
      return "closed";
    case RechargeRefundProviderStatus.ABNORMAL:
      return "abnormal";
    case RechargeRefundProviderStatus.PROCESSING:
      throw new Error(
        "WeChat refund persistence snapshot is not terminal.",
      );
  }
}

function serializeRefundApiProviderStatus(
  status: RechargeRefundProviderStatus,
): WeChatRefundApiPersistenceSnapshot["providerStatus"] {
  if (status === RechargeRefundProviderStatus.PROCESSING) {
    return "processing";
  }
  return serializeRefundProviderStatus(status);
}

function serializeRefundReversalStatus(
  status: RechargeRefundReversalStatus,
): WeChatRefundPersistenceSnapshot["reversalStatus"] {
  switch (status) {
    case RechargeRefundReversalStatus.PENDING:
      return "pending";
    case RechargeRefundReversalStatus.APPLIED:
      return "applied";
    case RechargeRefundReversalStatus.NOT_REQUIRED:
      return "not_required";
    case RechargeRefundReversalStatus.RECONCILIATION_REQUIRED:
      return "reconciliation_required";
  }
}

function safeRefundFailureCode(error: unknown): string {
  if (
    error instanceof WeChatRefundReversalLeaseLostError
    || error instanceof RechargePaymentConflictError
    || error instanceof WalletIdempotencyConflictError
  ) {
    return error.code.toLowerCase();
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z0-9_]{1,80}$/.test(error.code)
  ) {
    return error.code.toLowerCase();
  }
  return "wechat_refund_reversal_failed";
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < minimum
    || resolved > maximum
  ) {
    throw new Error(
      `Expected an integer between ${minimum} and ${maximum}.`,
    );
  }
  return resolved;
}
