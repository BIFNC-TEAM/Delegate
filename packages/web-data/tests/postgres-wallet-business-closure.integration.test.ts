import {
  AudienceIdentityStatus,
  Channel,
  CreatorVerificationStatus,
  MessageSenderType,
  PaymentProvider,
  PaymentProviderEventType,
  RechargeRefundReversalStatus,
  RechargeOrderStatus,
  RepresentativeClaimStatus,
  ServiceEntitlementStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { getAgentWalletDashboardSnapshot } from "../src/agent-wallet-dashboard";
import type {
  NormalizedPaymentProviderEvent,
  PaymentProviderAdapter,
} from "../src/agent-wallet-payment-providers";
import {
  completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent,
  completeMockRechargeAndPurchaseAgentTokens,
  createRechargeOrder,
  createMockRechargeOrder,
  RechargePaymentConflictError,
} from "../src/agent-wallet-recharge";
import {
  persistVerifiedWeChatPayRefund,
  runWeChatRefundReversalTick,
  WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
} from "../src/agent-wallet-wechat-refunds";
import {
  reserveConversationWalletUsage,
  settleConversationWalletUsage,
} from "../src/agent-wallet-usage-charge";
import {
  approveWithdrawRequest,
  createWithdrawRequest,
  markWithdrawRequestPaid,
} from "../src/agent-wallet-withdrawals";
import { prisma } from "../src/prisma";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "../src/service-entitlements";
import { getWorkspaceWalletReconciliationReport } from "../src/wallet-reconciliation";
import type {
  NormalizedWeChatPayRefundResult,
} from "../src/wechat-pay-api-v3";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("agent wallet PostgreSQL business closure", () => {
  it("closes one WeChat recharge across concurrent callback/query confirmation and replay", async () => {
    const fixture = await createBusinessClosureFixture();
    const providerTransactionId =
      `wechat-transaction-${fixture.suffix}`;
    const adapter = createLocalWeChatPaymentProviderAdapter();

    try {
      const order = await createRechargeOrder(
        {
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1_000,
          currency: "CNY",
          idempotencyKey: `${fixture.suffix}:wechat-recharge`,
        },
        adapter,
      );
      const callbackEvent = createVerifiedWeChatPaidEvent({
        orderId: order.id,
        providerEventId: `${fixture.suffix}:wechat-callback`,
        providerTransactionId,
      });
      const queryEvent = createVerifiedWeChatPaidEvent({
        orderId: order.id,
        providerEventId: `${fixture.suffix}:wechat-query`,
        providerTransactionId,
      });

      const [callbackResult, queryResult] = await Promise.all([
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          callbackEvent,
        ),
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          queryEvent,
        ),
      ]);
      const [callbackReplay, queryReplay] = await Promise.all([
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          callbackEvent,
        ),
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          queryEvent,
        ),
      ]);

      for (const result of [
        callbackResult,
        queryResult,
        callbackReplay,
        queryReplay,
      ]) {
        expect(result.rechargeOrder).toMatchObject({
          id: order.id,
          status: "paid",
          cashBalanceCents: 0,
        });
        expect(result.tokenPurchase).toMatchObject({
          amountCents: 1_000,
          tokenAmount: 100,
          remainingTokenAmount: 100,
          availableTokenAmount: 100,
          reservedTokenAmount: 0,
          cashBalanceCents: 0,
        });
      }

      const [
        persistedOrder,
        providerEvents,
        purchases,
        userWallet,
        userAgentWallet,
        agentWallet,
        entitlementAccount,
        rechargeTransactionCount,
        purchaseTransactionCount,
        rechargeLedgerCount,
        purchaseLedgerCount,
      ] = await Promise.all([
        prisma.rechargeOrder.findUniqueOrThrow({
          where: { id: order.id },
        }),
        prisma.paymentProviderEvent.findMany({
          where: {
            provider: PaymentProvider.WECHAT_PAY,
            providerTransactionId,
          },
        }),
        prisma.agentTokenPurchase.findMany({
          where: { rechargeOrderId: order.id },
        }),
        prisma.userWallet.findUniqueOrThrow({
          where: { externalUserId: fixture.externalUserId },
        }),
        prisma.userAgentWallet.findFirstOrThrow({
          where: {
            userWallet: {
              externalUserId: fixture.externalUserId,
            },
            agentWalletId: fixture.agentWalletId,
            currency: "CNY",
          },
        }),
        prisma.agentWallet.findUniqueOrThrow({
          where: { id: fixture.agentWalletId },
        }),
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            audienceIdentityId: fixture.audienceIdentityId,
            representativeId: fixture.representativeId,
            productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        }),
        prisma.walletTransaction.count({
          where: {
            sourceType: "RechargeOrder",
            sourceId: order.id,
          },
        }),
        prisma.walletTransaction.count({
          where: {
            sourceType: "AgentTokenPurchase",
            sourceId: {
              in: await prisma.agentTokenPurchase
                .findMany({
                  where: { rechargeOrderId: order.id },
                  select: { id: true },
                })
                .then((rows) => rows.map((row) => row.id)),
            },
          },
        }),
        prisma.walletLedgerEntry.count({
          where: { rechargeOrderId: order.id },
        }),
        prisma.walletLedgerEntry.count({
          where: {
            tokenPurchase: {
              rechargeOrderId: order.id,
            },
          },
        }),
      ]);

      expect(persistedOrder).toMatchObject({
        provider: PaymentProvider.WECHAT_PAY,
        providerOrderId: order.id,
        providerTransactionId,
        status: RechargeOrderStatus.PAID,
      });
      expect(providerEvents).toHaveLength(1);
      expect(providerEvents[0]?.providerEventId).toMatch(
        /:wechat-(callback|query)$/u,
      );
      expect(purchases).toHaveLength(1);
      expect(purchases[0]).toMatchObject({
        amountCents: 1_000,
        tokenAmount: 100,
        remainingTokenAmount: 100,
      });
      expect(userWallet.cashBalanceCents).toBe(0);
      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 100,
        reservedTokenAmount: 0,
        totalPurchasedTokenAmount: 100,
        totalConsumedTokenAmount: 0,
      });
      expect(agentWallet).toMatchObject({
        tokenBalance: 100,
        totalPurchasedTokens: 100,
        totalConsumedTokens: 0,
      });
      expect(entitlementAccount).toMatchObject({
        remainingUnits: 100,
        reservedUnits: 0,
      });
      expect(rechargeTransactionCount).toBe(1);
      expect(purchaseTransactionCount).toBe(1);
      expect(rechargeLedgerCount).toBe(2);
      expect(purchaseLedgerCount).toBe(4);
    } finally {
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);

  it("rolls back a verified WeChat payment when its token purchase fails, then retries atomically", async () => {
    const fixture = await createBusinessClosureFixture();
    const adapter = createLocalWeChatPaymentProviderAdapter();

    try {
      const order = await createRechargeOrder(
        {
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1_000,
          currency: "CNY",
          idempotencyKey: `${fixture.suffix}:wechat-rollback-recharge`,
        },
        adapter,
      );
      const event = createVerifiedWeChatPaidEvent({
        orderId: order.id,
        providerEventId: `${fixture.suffix}:wechat-rollback-callback`,
        providerTransactionId:
          `wechat-rollback-transaction-${fixture.suffix}`,
      });

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: { tokenUnitPriceCents: 0 },
      });
      await expect(
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(event),
      ).rejects.toThrow("tokenUnitPriceCents");

      const [rolledBackOrder, rolledBackWallet, eventCount, purchaseCount] =
        await Promise.all([
          prisma.rechargeOrder.findUniqueOrThrow({
            where: { id: order.id },
          }),
          prisma.userWallet.findUniqueOrThrow({
            where: { externalUserId: fixture.externalUserId },
          }),
          prisma.paymentProviderEvent.count({
            where: { rechargeOrderId: order.id },
          }),
          prisma.agentTokenPurchase.count({
            where: { rechargeOrderId: order.id },
          }),
        ]);
      expect(rolledBackOrder).toMatchObject({
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        providerTransactionId: null,
        paidAt: null,
      });
      expect(rolledBackWallet.cashBalanceCents).toBe(0);
      expect(eventCount).toBe(0);
      expect(purchaseCount).toBe(0);
      await expect(
        prisma.walletLedgerEntry.count({
          where: { rechargeOrderId: order.id },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.walletTransaction.count({
          where: {
            sourceType: "RechargeOrder",
            sourceId: order.id,
          },
        }),
      ).resolves.toBe(0);

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: { tokenUnitPriceCents: 10 },
      });
      const retried =
        await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          event,
        );

      expect(retried.rechargeOrder).toMatchObject({
        id: order.id,
        status: "paid",
        cashBalanceCents: 0,
      });
      expect(retried.tokenPurchase).toMatchObject({
        amountCents: 1_000,
        tokenAmount: 100,
        remainingTokenAmount: 100,
        cashBalanceCents: 0,
      });
      await expect(
        prisma.paymentProviderEvent.count({
          where: { rechargeOrderId: order.id },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.agentTokenPurchase.count({
          where: { rechargeOrderId: order.id },
        }),
      ).resolves.toBe(1);
    } finally {
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);

  it("retains a successful refund received before payment and rejects callback/query crediting", async () => {
    const fixture = await createBusinessClosureFixture();
    const adapter = createLocalWeChatPaymentProviderAdapter();
    const providerTransactionId =
      `wechat-refund-before-payment-${fixture.suffix}`;

    try {
      const order = await createRechargeOrder(
        {
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1_000,
          currency: "CNY",
          idempotencyKey:
            `${fixture.suffix}:wechat-refund-before-payment`,
        },
        adapter,
      );
      const refundResult = createVerifiedWeChatRefundResult({
        fixture,
        orderId: order.id,
        providerTransactionId,
        label: "before-payment",
      });
      const persistedRefund =
        await persistVerifiedWeChatPayRefund(refundResult);
      expect(persistedRefund).toMatchObject({
        rechargeOrderId: order.id,
        providerStatus: "succeeded",
        reversalStatus: "reconciliation_required",
      });

      const callbackEvent = createVerifiedWeChatPaidEvent({
        orderId: order.id,
        providerEventId:
          `${fixture.suffix}:refund-before-payment-callback`,
        providerTransactionId,
      });
      const queryEvent = createVerifiedWeChatPaidEvent({
        orderId: order.id,
        providerEventId:
          `${fixture.suffix}:refund-before-payment-wechat-query`,
        providerTransactionId,
      });

      await expect(
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          callbackEvent,
        ),
      ).rejects.toBeInstanceOf(RechargePaymentConflictError);
      await expect(
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          queryEvent,
        ),
      ).rejects.toBeInstanceOf(RechargePaymentConflictError);

      const concurrentAttempts = await Promise.allSettled([
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          callbackEvent,
        ),
        completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
          queryEvent,
        ),
      ]);
      for (const attempt of concurrentAttempts) {
        expect(attempt.status).toBe("rejected");
        if (attempt.status === "rejected") {
          expect(attempt.reason).toBeInstanceOf(
            RechargePaymentConflictError,
          );
          expect(attempt.reason).toHaveProperty(
            "message",
            expect.stringContaining(
              "already has a successful provider refund",
            ),
          );
        }
      }

      const [
        persistedOrder,
        retainedRefund,
        refundProviderEvent,
        userWallet,
        paidProviderEventCount,
        purchaseCount,
        userAgentWalletCount,
        entitlementCount,
        rechargeTransactionCount,
        rechargeLedgerCount,
        refundOutboxCount,
      ] = await Promise.all([
        prisma.rechargeOrder.findUniqueOrThrow({
          where: { id: order.id },
        }),
        prisma.rechargeRefund.findUniqueOrThrow({
          where: { id: persistedRefund.refundId! },
        }),
        prisma.paymentProviderEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: PaymentProvider.WECHAT_PAY,
              providerEventId: refundResult.providerEventId,
            },
          },
        }),
        prisma.userWallet.findUniqueOrThrow({
          where: { externalUserId: fixture.externalUserId },
        }),
        prisma.paymentProviderEvent.count({
          where: {
            rechargeOrderId: order.id,
            eventType: PaymentProviderEventType.RECHARGE_PAID,
          },
        }),
        prisma.agentTokenPurchase.count({
          where: { rechargeOrderId: order.id },
        }),
        prisma.userAgentWallet.count({
          where: { agentWalletId: fixture.agentWalletId },
        }),
        prisma.serviceEntitlementAccount.count({
          where: {
            representativeId: fixture.representativeId,
            audienceIdentityId: fixture.audienceIdentityId,
            productCode:
              AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        }),
        prisma.walletTransaction.count({
          where: {
            sourceType: "RechargeOrder",
            sourceId: order.id,
          },
        }),
        prisma.walletLedgerEntry.count({
          where: { rechargeOrderId: order.id },
        }),
        prisma.outboxEvent.count({
          where: {
            aggregateType: "recharge_refund",
            aggregateId: persistedRefund.refundId!,
          },
        }),
      ]);

      expect(persistedOrder).toMatchObject({
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        providerTransactionId: null,
        paidAt: null,
        refundedAt: null,
      });
      expect(retainedRefund).toMatchObject({
        rechargeOrderId: order.id,
        provider: PaymentProvider.WECHAT_PAY,
        providerStatus: "SUCCEEDED",
        reversalStatus:
          RechargeRefundReversalStatus.RECONCILIATION_REQUIRED,
      });
      expect(refundProviderEvent).toMatchObject({
        rechargeOrderId: order.id,
        rechargeRefundId: retainedRefund.id,
        eventType: PaymentProviderEventType.REFUND_SUCCEEDED,
      });
      expect(userWallet.cashBalanceCents).toBe(0);
      expect(paidProviderEventCount).toBe(0);
      expect(purchaseCount).toBe(0);
      expect(userAgentWalletCount).toBe(0);
      expect(entitlementCount).toBe(0);
      expect(rechargeTransactionCount).toBe(0);
      expect(rechargeLedgerCount).toBe(0);
      expect(refundOutboxCount).toBe(0);
    } finally {
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);

  it("persists and asynchronously applies one full unused WeChat refund exactly once", async () => {
    const fixture = await createBusinessClosureFixture();
    const adapter = createLocalWeChatPaymentProviderAdapter();
    const providerTransactionId =
      `wechat-refund-transaction-${fixture.suffix}`;

    try {
      const order = await createRechargeOrder(
        {
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1_000,
          currency: "CNY",
          idempotencyKey: `${fixture.suffix}:wechat-refund-recharge`,
        },
        adapter,
      );
      await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
        createVerifiedWeChatPaidEvent({
          orderId: order.id,
          providerEventId:
            `${fixture.suffix}:wechat-refund-payment-callback`,
          providerTransactionId,
        }),
      );
      const abnormalResult = createVerifiedWeChatRefundResult({
        fixture,
        orderId: order.id,
        providerTransactionId,
        label: "full-unused-abnormal",
        refundStatus: "ABNORMAL",
      });
      const abnormalPersist =
        await persistVerifiedWeChatPayRefund(abnormalResult);
      expect(abnormalPersist).toMatchObject({
        providerStatus: "abnormal",
        reversalStatus: "not_required",
      });
      await expect(
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            representativeId: fixture.representativeId,
            audienceIdentityId: fixture.audienceIdentityId,
            productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        }),
      ).resolves.toMatchObject({
        status: ServiceEntitlementStatus.ACTIVE,
        remainingUnits: 100,
      });
      // Reproduce a provider fact that committed before its local binding was
      // available. A later terminal event for the same refund must resolve it.
      await prisma.paymentProviderEvent.update({
        where: {
          provider_providerEventId: {
            provider: PaymentProvider.WECHAT_PAY,
            providerEventId: abnormalResult.providerEventId,
          },
        },
        data: {
          rechargeOrderId: null,
          rechargeRefundId: null,
          processedAt: null,
          processingError: "wechat_refund_order_missing",
        },
      });

      const refundResult = createVerifiedWeChatRefundResult({
        fixture,
        orderId: order.id,
        providerTransactionId,
        label: "full-unused-success",
      });
      refundResult.refundId = abnormalResult.refundId;
      refundResult.outRefundNo = abnormalResult.outRefundNo;
      refundResult.normalizedPayload.providerRefundId =
        abnormalResult.refundId;
      refundResult.normalizedPayload.providerRefundOrderId =
        abnormalResult.outRefundNo;

      const [firstPersist, concurrentReplay] = await Promise.all([
        persistVerifiedWeChatPayRefund(refundResult),
        persistVerifiedWeChatPayRefund(refundResult),
      ]);

      expect(concurrentReplay).toEqual(firstPersist);
      const conflictingRefund = createVerifiedWeChatRefundResult({
        fixture,
        orderId: order.id,
        providerTransactionId,
        label: "conflicting-provider-fact",
      });
      conflictingRefund.providerEventId =
        refundResult.providerEventId;
      conflictingRefund.idempotencyKey =
        refundResult.idempotencyKey;
      conflictingRefund.rawPayload.id =
        refundResult.providerEventId;
      conflictingRefund.normalizedPayload.providerEventId =
        refundResult.providerEventId;
      await expect(
        persistVerifiedWeChatPayRefund(conflictingRefund),
      ).rejects.toThrow("Idempotency key was already used");
      expect(firstPersist).toMatchObject({
        rechargeOrderId: order.id,
        providerStatus: "succeeded",
        reversalStatus: "pending",
        processingError: null,
      });
      const refundId = firstPersist.refundId;
      if (!refundId) {
        throw new Error("Expected a persisted recharge refund.");
      }
      await expect(
        prisma.paymentProviderEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: PaymentProvider.WECHAT_PAY,
              providerEventId: abnormalResult.providerEventId,
            },
          },
        }),
      ).resolves.toMatchObject({
        rechargeOrderId: order.id,
        rechargeRefundId: refundId,
        processingError: null,
      });
      await expect(
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            representativeId: fixture.representativeId,
            audienceIdentityId: fixture.audienceIdentityId,
            productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        }),
      ).resolves.toMatchObject({
        status: ServiceEntitlementStatus.FROZEN,
        remainingUnits: 100,
        reservedUnits: 0,
      });
      await expect(
        prisma.outboxEvent.count({
          where: {
            aggregateId: refundId,
            eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
          },
        }),
      ).resolves.toBe(1);

      await prisma.outboxEvent.updateMany({
        where: {
          aggregateId: refundId,
          eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
        },
        data: {
          availableAt: new Date(Date.now() + 60_000),
        },
      });
      await expect(
        runWeChatRefundReversalTick({ limit: 1 }),
      ).resolves.toMatchObject({
        claimed: 0,
        unresolved: 1,
      });
      await prisma.outboxEvent.updateMany({
        where: {
          aggregateId: refundId,
          eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
        },
        data: {
          availableAt: new Date(0),
        },
      });
      const tick = await runWeChatRefundReversalTick({ limit: 1 });
      expect(tick).toEqual({
        claimed: 1,
        applied: 1,
        reconciliationRequired: 0,
        retryScheduled: 0,
        unresolved: 0,
      });

      const [
        persistedOrder,
        refund,
        purchase,
        userWallet,
        userAgentWallet,
        agentWallet,
        entitlementAccount,
        creatorEarning,
        refundEvent,
        reversalOutbox,
      ] = await Promise.all([
        prisma.rechargeOrder.findUniqueOrThrow({
          where: { id: order.id },
        }),
        prisma.rechargeRefund.findUniqueOrThrow({
          where: { id: refundId },
        }),
        prisma.agentTokenPurchase.findFirstOrThrow({
          where: { rechargeOrderId: order.id },
        }),
        prisma.userWallet.findUniqueOrThrow({
          where: { externalUserId: fixture.externalUserId },
        }),
        prisma.userAgentWallet.findFirstOrThrow({
          where: {
            userWallet: {
              externalUserId: fixture.externalUserId,
            },
            agentWalletId: fixture.agentWalletId,
          },
        }),
        prisma.agentWallet.findUniqueOrThrow({
          where: { id: fixture.agentWalletId },
        }),
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            representativeId: fixture.representativeId,
            audienceIdentityId: fixture.audienceIdentityId,
            productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        }),
        prisma.creatorEarning.findFirstOrThrow({
          where: {
            tokenPurchase: { rechargeOrderId: order.id },
          },
        }),
        prisma.paymentProviderEvent.findFirstOrThrow({
          where: {
            rechargeRefundId: refundId,
            eventType: PaymentProviderEventType.REFUND_SUCCEEDED,
          },
        }),
        prisma.outboxEvent.findFirstOrThrow({
          where: {
            aggregateId: refundId,
            eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
          },
        }),
      ]);

      expect(persistedOrder).toMatchObject({
        status: RechargeOrderStatus.REFUNDED,
        providerTransactionId,
      });
      expect(refund).toMatchObject({
        reversalStatus: RechargeRefundReversalStatus.APPLIED,
        processingError: null,
      });
      expect(refund.reversalAppliedAt).not.toBeNull();
      expect(purchase).toMatchObject({
        status: "REVERSED",
        remainingTokenAmount: 0,
      });
      expect(userWallet.cashBalanceCents).toBe(0);
      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 0,
        reservedTokenAmount: 0,
        totalPurchasedTokenAmount: 0,
        totalConsumedTokenAmount: 0,
      });
      expect(agentWallet).toMatchObject({
        tokenBalance: 0,
        totalPurchasedTokens: 0,
        totalConsumedTokens: 0,
      });
      expect(entitlementAccount).toMatchObject({
        status: ServiceEntitlementStatus.EXHAUSTED,
        remainingUnits: 0,
        reservedUnits: 0,
      });
      expect(creatorEarning).toMatchObject({
        status: "REVERSED",
        pendingCents: 0,
        withdrawableCents: 0,
      });
      expect(refundEvent).toMatchObject({
        eventType: PaymentProviderEventType.REFUND_SUCCEEDED,
        processingError: null,
      });
      expect(refundEvent.processedAt).not.toBeNull();
      expect(reversalOutbox).toMatchObject({
        status: "PROCESSED",
        lastError: null,
      });

      const replayedAfterApply =
        await persistVerifiedWeChatPayRefund(refundResult);
      expect(replayedAfterApply).toMatchObject({
        refundId,
        reversalStatus: "applied",
      });
      await expect(
        runWeChatRefundReversalTick({ limit: 1 }),
      ).resolves.toMatchObject({ claimed: 0 });
      await expect(
        prisma.rechargeRefund.count({
          where: { rechargeOrderId: order.id },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.paymentProviderEvent.count({
          where: { rechargeRefundId: refundId },
        }),
      ).resolves.toBe(2);
    } finally {
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);

  it("quarantines a partial WeChat refund and freezes its unused credits", async () => {
    const fixture = await createBusinessClosureFixture();
    const adapter = createLocalWeChatPaymentProviderAdapter();
    const providerTransactionId =
      `wechat-partial-refund-transaction-${fixture.suffix}`;

    try {
      const order = await createRechargeOrder(
        {
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1_000,
          currency: "CNY",
          idempotencyKey:
            `${fixture.suffix}:wechat-partial-refund-recharge`,
        },
        adapter,
      );
      await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
        createVerifiedWeChatPaidEvent({
          orderId: order.id,
          providerEventId:
            `${fixture.suffix}:wechat-partial-refund-payment-callback`,
          providerTransactionId,
        }),
      );

      const persisted = await persistVerifiedWeChatPayRefund(
        createVerifiedWeChatRefundResult({
          fixture,
          orderId: order.id,
          providerTransactionId,
          label: "partial",
          refundAmountCents: 500,
          payerRefundAmountCents: 500,
        }),
      );

      expect(persisted).toMatchObject({
        rechargeOrderId: order.id,
        reversalStatus: "reconciliation_required",
        processingError:
          "wechat_refund_partial_or_discounted_not_supported",
      });
      const refundId = persisted.refundId;
      if (!refundId) {
        throw new Error("Expected a persisted partial recharge refund.");
      }
      const [
        persistedOrder,
        purchase,
        userWallet,
        userAgentWallet,
        entitlementAccount,
        refundEvent,
        outboxCount,
      ] = await Promise.all([
        prisma.rechargeOrder.findUniqueOrThrow({
          where: { id: order.id },
        }),
        prisma.agentTokenPurchase.findFirstOrThrow({
          where: { rechargeOrderId: order.id },
        }),
        prisma.userWallet.findUniqueOrThrow({
          where: { externalUserId: fixture.externalUserId },
        }),
        prisma.userAgentWallet.findFirstOrThrow({
          where: {
            userWallet: {
              externalUserId: fixture.externalUserId,
            },
            agentWalletId: fixture.agentWalletId,
          },
        }),
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            representativeId: fixture.representativeId,
            audienceIdentityId: fixture.audienceIdentityId,
            productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          },
        }),
        prisma.paymentProviderEvent.findFirstOrThrow({
          where: { rechargeRefundId: refundId },
        }),
        prisma.outboxEvent.count({
          where: {
            aggregateId: refundId,
            eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
          },
        }),
      ]);

      expect(persistedOrder.status).toBe(RechargeOrderStatus.PAID);
      expect(purchase).toMatchObject({
        status: "COMPLETED",
        remainingTokenAmount: 100,
      });
      expect(userWallet.cashBalanceCents).toBe(0);
      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 100,
        reservedTokenAmount: 0,
      });
      expect(entitlementAccount).toMatchObject({
        status: ServiceEntitlementStatus.FROZEN,
        remainingUnits: 100,
        reservedUnits: 0,
      });
      expect(refundEvent).toMatchObject({
        processedAt: null,
        processingError:
          "wechat_refund_partial_or_discounted_not_supported",
      });
      expect(outboxCount).toBe(0);
    } finally {
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);

  it("records a closed WeChat refund without freezing or reversing local value", async () => {
    const fixture = await createBusinessClosureFixture();
    const adapter = createLocalWeChatPaymentProviderAdapter();
    const providerTransactionId =
      `wechat-closed-refund-transaction-${fixture.suffix}`;

    try {
      const order = await createRechargeOrder(
        {
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
          amountCents: 1_000,
          currency: "CNY",
          idempotencyKey:
            `${fixture.suffix}:wechat-closed-refund-recharge`,
        },
        adapter,
      );
      await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
        createVerifiedWeChatPaidEvent({
          orderId: order.id,
          providerEventId:
            `${fixture.suffix}:wechat-closed-refund-payment-callback`,
          providerTransactionId,
        }),
      );

      const persisted = await persistVerifiedWeChatPayRefund(
        createVerifiedWeChatRefundResult({
          fixture,
          orderId: order.id,
          providerTransactionId,
          label: "closed",
          refundStatus: "CLOSED",
        }),
      );
      const refundId = persisted.refundId;
      if (!refundId) {
        throw new Error("Expected a persisted closed recharge refund.");
      }

      expect(persisted).toMatchObject({
        providerStatus: "closed",
        reversalStatus: "not_required",
        processingError: null,
      });
      const [orderState, refund, account, event, outboxCount] =
        await Promise.all([
          prisma.rechargeOrder.findUniqueOrThrow({
            where: { id: order.id },
          }),
          prisma.rechargeRefund.findUniqueOrThrow({
            where: { id: refundId },
          }),
          prisma.serviceEntitlementAccount.findFirstOrThrow({
            where: {
              representativeId: fixture.representativeId,
              audienceIdentityId: fixture.audienceIdentityId,
              productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
            },
          }),
          prisma.paymentProviderEvent.findFirstOrThrow({
            where: { rechargeRefundId: refundId },
          }),
          prisma.outboxEvent.count({
            where: {
              aggregateId: refundId,
              eventType: WECHAT_REFUND_REVERSAL_OUTBOX_EVENT_TYPE,
            },
          }),
        ]);

      expect(orderState.status).toBe(RechargeOrderStatus.PAID);
      expect(refund).toMatchObject({
        providerStatus: "CLOSED",
        reversalStatus: RechargeRefundReversalStatus.NOT_REQUIRED,
        providerSucceededAt: null,
        processingError: null,
      });
      expect(account).toMatchObject({
        status: ServiceEntitlementStatus.ACTIVE,
        remainingUnits: 100,
        reservedUnits: 0,
      });
      expect(event).toMatchObject({
        eventType: PaymentProviderEventType.REFUND_CLOSED,
        processingError: null,
      });
      expect(event.processedAt).not.toBeNull();
      expect(outboxCount).toBe(0);
      await expect(
        runWeChatRefundReversalTick({ limit: 1 }),
      ).resolves.toMatchObject({
        claimed: 0,
        unresolved: 0,
      });
    } finally {
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);

  it("retains an unmatched verified WeChat refund as a persistent reconciliation alert", async () => {
    const fixture = await createBusinessClosureFixture();
    const result = createVerifiedWeChatRefundResult({
      fixture,
      orderId:
        `missing_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      providerTransactionId:
        `missing-transaction-${fixture.suffix}`,
      label: "missing-order",
    });

    try {
      const persisted =
        await persistVerifiedWeChatPayRefund(result);

      expect(persisted).toMatchObject({
        providerEventId: result.providerEventId,
        refundId: null,
        rechargeOrderId: null,
        providerStatus: "succeeded",
        reversalStatus: "reconciliation_required",
        processingError: "wechat_refund_order_missing",
      });
      await expect(
        prisma.paymentProviderEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: PaymentProvider.WECHAT_PAY,
              providerEventId: result.providerEventId,
            },
          },
        }),
      ).resolves.toMatchObject({
        rechargeOrderId: null,
        rechargeRefundId: null,
        eventType: PaymentProviderEventType.REFUND_SUCCEEDED,
        processedAt: null,
        processingError: "wechat_refund_order_missing",
      });
      await expect(
        prisma.rechargeRefund.count({
          where: { providerRefundId: result.refundId },
        }),
      ).resolves.toBe(0);

      const tick = await runWeChatRefundReversalTick({ limit: 1 });
      expect(tick.claimed).toBe(0);
      expect(tick.unresolved).toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.paymentProviderEvent.deleteMany({
        where: {
          provider: PaymentProvider.WECHAT_PAY,
          providerEventId: result.providerEventId,
        },
      });
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);

  it("closes recharge, paid usage, creator payout, and reconciliation idempotently", async () => {
    const fixture = await createBusinessClosureFixture();
    const reconciliationInput = {
      ownerId: fixture.ownerId,
      activeRepresentativeSlug: fixture.representativeSlug,
      representative: fixture.representativeSlug,
      currency: "CNY",
    } as const;

    try {
      const rechargeInput = {
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
        amountCents: 1_000,
        currency: "CNY",
        idempotencyKey: `${fixture.suffix}:recharge`,
      } as const;
      const order = await createMockRechargeOrder(rechargeInput);
      const replayedOrder = await createMockRechargeOrder(rechargeInput);

      expect(replayedOrder.id).toBe(order.id);
      expect(order).toMatchObject({
        status: "requires_payment",
        amountCents: 1_000,
        cashBalanceCents: 0,
      });

      const completionInput = {
        rechargeOrderId: order.id,
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 1_000,
        providerEventId: `${fixture.suffix}:provider-paid`,
        purchaseIdempotencyKey: `${fixture.suffix}:purchase`,
      };
      const purchase = await completeMockRechargeAndPurchaseAgentTokens(
        completionInput,
      );
      const replayedPurchase =
        await completeMockRechargeAndPurchaseAgentTokens(completionInput);

      expect(replayedPurchase).toEqual(purchase);
      expect(purchase.rechargeOrder).toMatchObject({
        id: order.id,
        status: "paid",
        cashBalanceCents: 0,
      });
      expect(purchase.tokenPurchase).toMatchObject({
        amountCents: 1_000,
        tokenAmount: 100,
        remainingTokenAmount: 100,
        creatorPendingCents: 200,
        availableTokenAmount: 100,
        reservedTokenAmount: 0,
      });
      await expectHealthyReconciliation(reconciliationInput);

      const generationRunId = await createGenerationRun(
        fixture,
        "paid-business-closure",
      );
      const reservationInput = {
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        conversationId: fixture.conversationId,
        generationRunId,
        tokenAmount: 40,
        idempotencyKey: `${fixture.suffix}:reserve`,
      };
      const reservation = await reserveConversationWalletUsage(reservationInput);
      const replayedReservation =
        await reserveConversationWalletUsage(reservationInput);

      expect(replayedReservation).toEqual(reservation);
      expect(reservation.usageCharge).toMatchObject({
        status: "reserved",
        reservedTokenAmount: 40,
        availableTokenAmount: 60,
        walletReservedTokenAmount: 40,
      });
      await expectHealthyReconciliation(reconciliationInput);

      const settlementInput = {
        usageChargeId: reservation.usageCharge.id,
        expectedGenerationRunId: generationRunId,
        settledTokenAmount: 40,
        providerCostCents: 50,
        provider: "local-business-closure",
        idempotencyKey: `${fixture.suffix}:settle`,
      };
      const settlement = await settleConversationWalletUsage(settlementInput);
      const replayedSettlement =
        await settleConversationWalletUsage(settlementInput);

      expect(replayedSettlement).toEqual(settlement);
      expect(settlement.usageCharge).toMatchObject({
        status: "settled",
        settledTokenAmount: 40,
        releasedTokenAmount: 0,
        tokenValueCents: 400,
        providerCostCents: 50,
        platformRevenueCents: 320,
        creatorWithdrawableCents: 80,
        availableTokenAmount: 60,
        walletReservedTokenAmount: 0,
      });

      const dashboardAfterSettlement =
        await getAgentWalletDashboardSnapshot(fixture.representativeSlug);
      expect(dashboardAfterSettlement).toMatchObject({
        agentWallet: {
          currency: "CNY",
          tokenBalance: 60,
          totalPurchasedTokens: 100,
          totalConsumedTokens: 40,
        },
        creatorBalances: {
          pendingCents: 120,
          withdrawableCents: 80,
          frozenCents: 0,
          withdrawnCents: 0,
        },
      });
      await expectHealthyReconciliation(reconciliationInput);

      const withdrawalInput = {
        ownerId: fixture.ownerId,
        representativeId: fixture.representativeId,
        amountCents: 80,
        currency: "CNY",
        idempotencyKey: `${fixture.suffix}:withdraw`,
      } as const;
      const withdrawal = await createWithdrawRequest(withdrawalInput);
      const replayedWithdrawal = await createWithdrawRequest(withdrawalInput);

      expect(replayedWithdrawal).toEqual(withdrawal);
      expect(withdrawal).toMatchObject({
        status: "pending_review",
        amountCents: 80,
        frozenCents: 80,
      });
      await expectHealthyReconciliation(reconciliationInput);

      const approvalInput = {
        ownerId: fixture.ownerId,
        withdrawRequestId: withdrawal.id,
        reviewedBy: "local-business-closure",
        idempotencyKey: `${fixture.suffix}:withdraw-approve`,
      };
      const approved = await approveWithdrawRequest(approvalInput);
      const replayedApproval = await approveWithdrawRequest(approvalInput);

      expect(replayedApproval).toEqual(approved);
      expect(approved).toMatchObject({
        status: "approved",
        frozenCents: 80,
      });
      await expectHealthyReconciliation(reconciliationInput);

      const payoutInput = {
        ownerId: fixture.ownerId,
        withdrawRequestId: withdrawal.id,
        provider: PaymentProvider.MOCK,
        providerPayoutId: `mock:${withdrawal.id}:paid`,
        idempotencyKey: `${fixture.suffix}:withdraw-paid`,
      };
      const paid = await markWithdrawRequestPaid(payoutInput);
      const replayedPayout = await markWithdrawRequestPaid(payoutInput);

      expect(replayedPayout).toEqual(paid);
      expect(paid).toMatchObject({
        status: "paid",
        frozenCents: 0,
        provider: PaymentProvider.MOCK,
        providerPayoutId: payoutInput.providerPayoutId,
      });

      const finalDashboard =
        await getAgentWalletDashboardSnapshot(fixture.representativeSlug);
      expect(finalDashboard).toMatchObject({
        agentWallet: {
          currency: "CNY",
          tokenBalance: 60,
          totalPurchasedTokens: 100,
          totalConsumedTokens: 40,
        },
        creatorBalances: {
          pendingCents: 120,
          withdrawableCents: 0,
          frozenCents: 0,
          withdrawnCents: 80,
        },
        withdrawRequests: [
          expect.objectContaining({
            id: withdrawal.id,
            amountCents: 80,
            currency: "CNY",
            status: "paid",
          }),
        ],
      });
      await expectHealthyReconciliation(reconciliationInput);

      await expect(
        prisma.walletTransaction.groupBy({
          by: ["idempotencyKey"],
          where: { representativeId: fixture.representativeId },
          having: {
            idempotencyKey: {
              _count: { gt: 1 },
            },
          },
        }),
      ).resolves.toEqual([]);
    } finally {
      await cleanupBusinessClosureFixture(fixture);
    }
  }, 30_000);
});

function createLocalWeChatPaymentProviderAdapter(): PaymentProviderAdapter {
  return {
    provider: PaymentProvider.WECHAT_PAY,
    async createRechargeCheckout(input) {
      if (!input.rechargeOrderId) {
        throw new Error("Expected a local recharge order id.");
      }
      return {
        provider: PaymentProvider.WECHAT_PAY,
        providerOrderId: input.rechargeOrderId,
        checkoutUrl: "weixin://wxpay/bizpayurl?pr=postgres-e2e",
        providerPayload: {
          mode: "native",
        },
      };
    },
    async normalizeWebhookEvent() {
      throw new Error("This test supplies an already-verified provider event.");
    },
  };
}

function createVerifiedWeChatPaidEvent(input: {
  orderId: string;
  providerEventId: string;
  providerTransactionId: string;
}): NormalizedPaymentProviderEvent {
  return {
    provider: PaymentProvider.WECHAT_PAY,
    providerEventId: input.providerEventId,
    providerTransactionId: input.providerTransactionId,
    eventType: PaymentProviderEventType.RECHARGE_PAID,
    rechargeOrderId: input.orderId,
    providerOrderId: input.orderId,
    amountCents: 1_000,
    currency: "CNY",
    rawPayload: {
      source: input.providerEventId.endsWith(":wechat-query")
        ? "order_query"
        : "payment_callback",
      encrypted: true,
    },
    normalizedPayload: {
      providerTransactionId: input.providerTransactionId,
      tradeState: "SUCCESS",
    },
    idempotencyKey:
      `wechat_pay:${input.providerEventId}`,
    verifiedAt: new Date("2026-07-27T12:00:00.000Z"),
  };
}

function createVerifiedWeChatRefundResult(input: {
  fixture: BusinessClosureFixture;
  orderId: string;
  providerTransactionId: string;
  label: string;
  refundStatus?: NormalizedWeChatPayRefundResult["refundStatus"];
  refundAmountCents?: number;
  payerAmountCents?: number;
  payerRefundAmountCents?: number;
}): NormalizedWeChatPayRefundResult {
  const providerEventId =
    `${input.fixture.suffix}:wechat-refund:${input.label}`;
  const providerRefundId =
    `wechat-refund-id:${input.fixture.suffix}:${input.label}`;
  const providerRefundOrderId =
    `wechat-refund-order:${input.fixture.suffix}:${input.label}`;
  const providerOccurredAt =
    new Date("2026-07-27T12:05:00.000Z");
  const refundStatus = input.refundStatus ?? "SUCCESS";
  const eventType =
    refundStatus === "SUCCESS"
      ? "REFUND.SUCCESS"
      : refundStatus === "CLOSED"
        ? "REFUND.CLOSED"
        : "REFUND.ABNORMAL";
  const normalizedType =
    refundStatus === "SUCCESS"
      ? "RechargeRefunded"
      : refundStatus === "CLOSED"
        ? "RechargeRefundClosed"
        : "RechargeRefundAbnormal";
  const refundAmountCents = input.refundAmountCents ?? 1_000;
  const payerAmountCents = input.payerAmountCents ?? 1_000;
  const payerRefundAmountCents =
    input.payerRefundAmountCents ?? 1_000;

  return {
    provider: PaymentProvider.WECHAT_PAY,
    providerEventId,
    refundId: providerRefundId,
    outRefundNo: providerRefundOrderId,
    outTradeNo: input.orderId,
    transactionId: input.providerTransactionId,
    merchantId: "1900000109",
    refundStatus,
    originalAmountCents: 1_000,
    refundAmountCents,
    payerAmountCents,
    payerRefundAmountCents,
    idempotencyKey: `wechat_pay:refund:${providerRefundId}`,
    verifiedAt: new Date("2026-07-27T12:05:01.000Z"),
    providerOccurredAt,
    rawPayload: {
      id: providerEventId,
      createTime: "2026-07-27T20:05:00+08:00",
      resourceType: "encrypt-resource",
      eventType,
      summary:
        refundStatus === "SUCCESS"
          ? "退款成功"
          : refundStatus === "CLOSED"
            ? "退款关闭"
            : "退款异常",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        ciphertext: "verified-and-redacted",
        nonce: "verified-nonce",
        associatedData: "refund",
        originalType: "refund",
      },
    },
    normalizedPayload: {
      type: normalizedType,
      provider: "wechat_pay",
      providerEventId,
      providerRefundId,
      providerRefundOrderId,
      providerPaymentTransactionId: input.providerTransactionId,
      rechargeOrderId: input.orderId,
      merchantId: "1900000109",
      refundStatus,
      originalAmountCents: 1_000,
      refundAmountCents,
      payerAmountCents,
      payerRefundAmountCents,
      providerOccurredAt: providerOccurredAt.toISOString(),
    },
  };
}

type BusinessClosureFixture = {
  suffix: string;
  ownerId: string;
  representativeId: string;
  representativeSlug: string;
  audienceIdentityId: string;
  agentWalletId: string;
  contactId: string;
  conversationId: string;
  externalUserId: string;
};

async function createBusinessClosureFixture(): Promise<BusinessClosureFixture> {
  const suffix =
    `postgres-wallet-closure-${Date.now()}-${crypto.randomUUID()}`;
  const externalUserId = `${suffix}:user`;

  return prisma.$transaction(async (tx) => {
    const owner = await tx.owner.create({
      data: {
        displayName: "Wallet business closure owner",
        creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      },
    });
    const representative = await tx.representative.create({
      data: {
        ownerId: owner.id,
        slug: suffix,
        displayName: "Wallet business closure representative",
        roleSummary: "PostgreSQL wallet business closure test fixture.",
        tone: "neutral",
        languages: ["zh"],
        freeScope: {},
        paywalledIntents: [],
        handoffPrompt: "test",
        allowedSkills: [],
        actionGate: {},
        claimStatus: RepresentativeClaimStatus.CLAIMED,
      },
    });
    const audienceIdentity = await tx.audienceIdentity.create({
      data: {
        audienceKey: `${suffix}:audience`,
        status: AudienceIdentityStatus.REGISTERED,
      },
    });
    const agentWallet = await tx.agentWallet.create({
      data: {
        representativeId: representative.id,
        currency: "CNY",
        tokenUnitPriceCents: 10,
        creatorRevenueShareBps: 2_000,
      },
    });
    const contact = await tx.contact.create({
      data: {
        representativeId: representative.id,
        audienceIdentityId: audienceIdentity.id,
        externalUserId,
        displayName: "Wallet business closure audience",
        sourceChannel: "web",
      },
    });
    const conversation = await tx.conversation.create({
      data: {
        representativeId: representative.id,
        contactId: contact.id,
        audienceIdentityId: audienceIdentity.id,
        channel: Channel.PRIVATE_CHAT,
        sourceChannel: "web",
        externalConversationId: `${suffix}:conversation`,
      },
    });

    return {
      suffix,
      ownerId: owner.id,
      representativeId: representative.id,
      representativeSlug: representative.slug,
      audienceIdentityId: audienceIdentity.id,
      agentWalletId: agentWallet.id,
      contactId: contact.id,
      conversationId: conversation.id,
      externalUserId,
    };
  });
}

async function createGenerationRun(
  fixture: BusinessClosureFixture,
  label: string,
): Promise<string> {
  const message = await prisma.message.create({
    data: {
      conversationId: fixture.conversationId,
      senderType: MessageSenderType.AUDIENCE,
      senderId: fixture.audienceIdentityId,
      text: label,
      clientMessageId: `${fixture.suffix}:message:${label}`,
    },
  });
  const run = await prisma.generationRun.create({
    data: {
      conversationId: fixture.conversationId,
      inputMessageId: message.id,
      idempotencyKey: `${fixture.suffix}:run:${label}`,
    },
  });
  return run.id;
}

async function expectHealthyReconciliation(
  input: Parameters<typeof getWorkspaceWalletReconciliationReport>[0],
): Promise<void> {
  const report = await getWorkspaceWalletReconciliationReport(input);
  expect(report).not.toBeNull();
  expect(report).toMatchObject({
    readOnly: true,
    status: "healthy",
    summary: {
      warnings: 0,
      errors: 0,
      findings: 0,
    },
    issues: [],
  });
}

async function cleanupBusinessClosureFixture(
  fixture: BusinessClosureFixture,
): Promise<void> {
  const rechargeOrderIds = (
    await prisma.rechargeOrder.findMany({
      where: { representativeId: fixture.representativeId },
      select: { id: true },
    })
  ).map((order) => order.id);
  const rechargeRefundIds = rechargeOrderIds.length === 0
    ? []
    : (
        await prisma.rechargeRefund.findMany({
          where: { rechargeOrderId: { in: rechargeOrderIds } },
          select: { id: true },
        })
      ).map((refund) => refund.id);
  await prisma.outboxEvent.deleteMany({
    where: {
      OR: [
        {
          aggregateType: "recharge_order",
          aggregateId: { in: rechargeOrderIds },
        },
        {
          aggregateType: "recharge_refund",
          aggregateId: { in: rechargeRefundIds },
        },
      ],
    },
  });
  await prisma.walletLedgerEntry.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.walletTransaction.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.withdrawalAllocation.deleteMany({
    where: {
      withdrawRequest: { representativeId: fixture.representativeId },
    },
  });
  await prisma.agentUsageAllocation.deleteMany({
    where: {
      usageCharge: { representativeId: fixture.representativeId },
    },
  });
  await prisma.withdrawRequest.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.creatorEarning.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.agentUsageCharge.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.serviceEntitlementLedgerEntry.deleteMany({
    where: {
      entitlementAccount: {
        representativeId: fixture.representativeId,
      },
    },
  });
  await prisma.paymentProviderEvent.deleteMany({
    where: {
      rechargeOrder: { representativeId: fixture.representativeId },
    },
  });
  await prisma.rechargeRefund.deleteMany({
    where: { rechargeOrderId: { in: rechargeOrderIds } },
  });
  await prisma.agentTokenPurchase.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.userAgentWallet.deleteMany({
    where: { agentWalletId: fixture.agentWalletId },
  });
  await prisma.serviceEntitlementAccount.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.rechargeOrder.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.generationRun.deleteMany({
    where: { conversationId: fixture.conversationId },
  });
  await prisma.message.deleteMany({
    where: { conversationId: fixture.conversationId },
  });
  await prisma.conversation.delete({
    where: { id: fixture.conversationId },
  });
  await prisma.contact.delete({
    where: { id: fixture.contactId },
  });
  await prisma.userWallet.deleteMany({
    where: { audienceIdentityId: fixture.audienceIdentityId },
  });
  await prisma.agentWallet.delete({
    where: { id: fixture.agentWalletId },
  });
  await prisma.representative.delete({
    where: { id: fixture.representativeId },
  });
  await prisma.owner.delete({
    where: { id: fixture.ownerId },
  });
  await prisma.audienceIdentity.delete({
    where: { id: fixture.audienceIdentityId },
  });
}

function assertSafePostgresE2eTarget(): void {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for the PostgreSQL wallet business closure E2E.",
    );
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
  ) {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "PostgreSQL wallet business closure E2E refuses a non-local database unless "
        + "DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1 and the database name is clearly non-production.",
    );
  }
}
