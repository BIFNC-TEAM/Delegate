import {
  AgentUsageChargeStatus,
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  AudienceIdentityStatus,
  Channel,
  CreatorEarningStatus,
  CreatorVerificationStatus,
  MessageSenderType,
  PaymentProvider,
  RechargeOrderStatus,
  RepresentativeClaimStatus,
  WithdrawRequestStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  completeMockRechargeOrder,
  createRechargeOrder,
} from "../src/agent-wallet-recharge";
import type { PaymentProviderAdapter } from "../src/agent-wallet-payment-providers";
import { getAgentWalletDashboardSnapshot } from "../src/agent-wallet-dashboard";
import {
  WeChatPayReconciliationLeaseLostError,
  claimNextWeChatPayOrderReconciliation,
  enqueueWeChatPayOrderReconciliation,
  reconcileClaimedWeChatPayOrder,
} from "../src/agent-wallet-payment-reconciliation";
import { purchaseAgentTokens } from "../src/agent-wallet-token-purchase";
import {
  releaseConversationWalletUsage,
  reserveConversationWalletUsage,
  settleConversationWalletUsage,
  transferAgentUsageEntitlementReservation,
  verifyAgentUsageEntitlementReservation,
} from "../src/agent-wallet-usage-charge";
import {
  cancelWithdrawRequest,
  createWithdrawRequest,
} from "../src/agent-wallet-withdrawals";
import {
  claimPaymentProviderOperation,
  createPaymentProviderOperationScopeKey,
  releasePaymentProviderOperation,
} from "../src/payment-provider-operation-gate";
import { prisma } from "../src/prisma";
import {
  getWorkspaceWalletReconciliationReport,
  WalletReconciliationRequiredError,
} from "../src/wallet-reconciliation";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("agent wallet PostgreSQL concurrency", () => {
  it("atomically preserves and query-first recovers a real CREATED WeChat order after an ambiguous create result", async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const idempotencyKey =
      `postgres-wechat-created-${suffix}`;
    const adapter: PaymentProviderAdapter = {
      provider: PaymentProvider.WECHAT_PAY,
      async prepareRechargeCheckout(input) {
        return {
          provider: "wechat_pay",
          appId: "wx-postgres-test",
          merchantId: "1900000109",
          rawPayload: {
            version: 1,
            mode: "native",
            appId: "wx-postgres-test",
            merchantId: "1900000109",
            description: "Postgres recovery test",
            outTradeNo: input.rechargeOrderId!,
            expiresAt: "2026-07-28T12:00:00.000Z",
            notifyUrl:
              "https://delegate.example/api/payments/wechat/notify",
            amountCents: input.amountCents,
            currency: input.currency,
          },
        };
      },
      async createRechargeCheckout() {
        throw Object.assign(
          new Error("simulated ambiguous create result"),
          { code: "WECHAT_PAY_PROTOCOL_ERROR" },
        );
      },
      async normalizeWebhookEvent() {
        throw new Error("not used");
      },
    };
    let orderId: string | undefined;
    let walletId: string | undefined;

    try {
      await expect(
        createRechargeOrder({
          externalUserId:
            `postgres-wechat-created-${suffix}`,
          amountCents: 1_000,
          currency: "CNY",
          idempotencyKey,
        }, adapter),
      ).rejects.toThrow("ambiguous create result");
      const created =
        await prisma.rechargeOrder.findUniqueOrThrow({
          where: { idempotencyKey },
        });
      orderId = created.id;
      walletId = created.userWalletId;
      expect(created).toMatchObject({
        status: RechargeOrderStatus.CREATED,
        provider: PaymentProvider.WECHAT_PAY,
        providerOrderId: null,
        checkoutUrl: null,
      });
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({
          where: {
            idempotencyKey:
              `wechat_pay:reconcile:${created.id}`,
          },
        }),
      ).resolves.toMatchObject({
        aggregateId: created.id,
        eventType: "wechat_pay.order.reconcile",
        status: "PENDING",
      });

      await prisma.outboxEvent.update({
        where: {
          idempotencyKey:
            `wechat_pay:reconcile:${created.id}`,
        },
        data: { availableAt: new Date(Date.now() - 1_000) },
      });
      const result = await reconcileClaimedWeChatPayOrder(
        (await claimNextWeChatPayOrderReconciliation({
          rechargeOrderId: created.id,
        }))!,
        {
          now: () =>
            new Date(created.createdAt.getTime() + 76_000),
          queryOrder: async () => ({
            status: "not_found",
            tradeState: null,
            event: null,
          }),
          createCheckout: async () => ({
            provider: PaymentProvider.WECHAT_PAY,
            providerOrderId: created.id,
            checkoutUrl:
              "weixin://wxpay/postgres-created-recovered",
            providerPayload: {
              provider: "wechat_pay",
              rawPayload: {
                mode: "native",
                outTradeNo: created.id,
                expiresAt:
                  "2026-07-28T12:00:00.000Z",
              },
            },
          }),
          closeOrder: async () => undefined,
        },
      );

      expect(result).toEqual({
        status: "pending",
        queried: true,
      });
      await expect(
        prisma.rechargeOrder.findUniqueOrThrow({
          where: { id: created.id },
        }),
      ).resolves.toMatchObject({
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        providerOrderId: created.id,
        checkoutUrl:
          "weixin://wxpay/postgres-created-recovered",
      });
    } finally {
      if (orderId) {
        await prisma.outboxEvent.deleteMany({
          where: {
            aggregateType: "recharge_order",
            aggregateId: orderId,
          },
        });
        await prisma.rechargeOrder.delete({
          where: { id: orderId },
        }).catch(() => undefined);
      }
      if (walletId) {
        await prisma.userWallet.delete({
          where: { id: walletId },
        }).catch(() => undefined);
      }
    }
  }, 30_000);

  it("serializes provider-call claims and fences stale release tokens in PostgreSQL", async () => {
    const scopeKey = createPaymentProviderOperationScopeKey([
      "wechat_pay",
      "recharge_create",
      crypto.randomUUID(),
    ]);

    try {
      const claims = await Promise.all([
        claimPaymentProviderOperation({
          scopeKey,
          leaseToken: "postgres-gate-a",
          leaseDurationMs: 30_000,
          cooldownMs: 20_000,
        }),
        claimPaymentProviderOperation({
          scopeKey,
          leaseToken: "postgres-gate-b",
          leaseDurationMs: 30_000,
          cooldownMs: 20_000,
        }),
      ]);
      const winners = claims.filter((claim) => claim.claimed);
      const deferred = claims.filter((claim) => !claim.claimed);

      expect(winners).toHaveLength(1);
      expect(deferred).toHaveLength(1);
      const winner = winners[0];
      if (!winner?.claimed) {
        throw new Error("Expected one provider operation gate winner.");
      }
      await expect(
        releasePaymentProviderOperation({
          scopeKey,
          leaseToken:
            winner.leaseToken === "postgres-gate-a"
              ? "postgres-gate-b"
              : "postgres-gate-a",
        }),
      ).resolves.toBe(false);
      await expect(
        releasePaymentProviderOperation({
          scopeKey,
          leaseToken: winner.leaseToken,
        }),
      ).resolves.toBe(true);
      await expect(
        claimPaymentProviderOperation({
          scopeKey,
          leaseToken: "postgres-gate-c",
          leaseDurationMs: 30_000,
          cooldownMs: 20_000,
        }),
      ).resolves.toMatchObject({
        claimed: false,
        retryAfterSeconds: expect.any(Number),
      });
    } finally {
      await prisma.paymentProviderOperationGate.deleteMany({
        where: { scopeKey },
      });
    }
  }, 30_000);

  it("allows one real Outbox claim and fences its stale reconciliation attempt", async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const wallet = await prisma.userWallet.create({
      data: {
        externalUserId: `postgres-wechat-outbox-${suffix}`,
        currency: "CNY",
      },
    });
    const order = await prisma.rechargeOrder.create({
      data: {
        userWalletId: wallet.id,
        provider: PaymentProvider.WECHAT_PAY,
        providerOrderId: `wechat-outbox-${suffix}`,
        amountCents: 1_000,
        currency: "CNY",
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        idempotencyKey: `wechat-outbox-${suffix}`,
        checkoutUrl: "weixin://wxpay/postgres-outbox",
        providerPayload: {
          provider: "wechat_pay",
          rawPayload: { mode: "native" },
        },
      },
    });

    try {
      await enqueueWeChatPayOrderReconciliation(
        order.id,
        prisma,
        {
          initialDelayMs: 0,
          now: () => new Date(Date.now() - 1_000),
        },
      );
      const firstClaims = await Promise.all([
        claimNextWeChatPayOrderReconciliation({
          rechargeOrderId: order.id,
        }),
        claimNextWeChatPayOrderReconciliation({
          rechargeOrderId: order.id,
        }),
      ]);
      const first = firstClaims.find(
        (claim): claim is NonNullable<typeof claim> =>
          claim !== null,
      );
      expect(firstClaims.filter(Boolean)).toHaveLength(1);
      if (!first) {
        throw new Error("Expected one reconciliation claim.");
      }

      await prisma.outboxEvent.update({
        where: { id: first.outboxId },
        data: { availableAt: new Date(Date.now() - 1_000) },
      });
      const reclaimed =
        await claimNextWeChatPayOrderReconciliation({
          rechargeOrderId: order.id,
        });
      expect(reclaimed).toMatchObject({
        outboxId: first.outboxId,
        rechargeOrderId: order.id,
        attempt: 2,
      });
      if (!reclaimed) {
        throw new Error("Expected the expired lease to be reclaimed.");
      }

      await expect(
        reconcileClaimedWeChatPayOrder(first, {
          queryOrder: async () => ({
            status: "pending",
            tradeState: "NOTPAY",
            event: null,
          }),
        }),
      ).rejects.toBeInstanceOf(
        WeChatPayReconciliationLeaseLostError,
      );
      await expect(
        reconcileClaimedWeChatPayOrder(reclaimed, {
          queryOrder: async () => ({
            status: "pending",
            tradeState: "NOTPAY",
            event: null,
          }),
          pendingBackoffMs: 1_000,
        }),
      ).resolves.toEqual({
        status: "pending",
        queried: true,
      });
      await expect(
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: first.outboxId },
        }),
      ).resolves.toMatchObject({
        status: "PENDING",
        attemptCount: 2,
        lastError: null,
      });
    } finally {
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateType: "recharge_order",
          aggregateId: order.id,
        },
      });
      await prisma.rechargeOrder.delete({
        where: { id: order.id },
      }).catch(() => undefined);
      await prisma.userWallet.delete({
        where: { id: wallet.id },
      }).catch(() => undefined);
    }
  }, 30_000);

  it("credits a recharge exactly once when the same provider event arrives concurrently", async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const wallet = await prisma.userWallet.create({
      data: {
        externalUserId: `postgres-wallet-concurrency-${suffix}`,
        currency: "CNY",
      },
    });
    const order = await prisma.rechargeOrder.create({
      data: {
        userWalletId: wallet.id,
        provider: PaymentProvider.MOCK,
        providerOrderId: `postgres-wallet-provider-order-${suffix}`,
        amountCents: 1_200,
        currency: "CNY",
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        idempotencyKey: `postgres-wallet-recharge-${suffix}`,
      },
    });
    const providerEventId = `postgres-wallet-paid-${suffix}`;
    const concurrentClient = createReadBarrierClient<
      NonNullable<Parameters<typeof completeMockRechargeOrder>[2]>
    >("rechargeOrder", "findUnique");

    try {
      const results = await Promise.all([
        completeMockRechargeOrder(
          order.id,
          { providerEventId },
          concurrentClient,
        ),
        completeMockRechargeOrder(
          order.id,
          { providerEventId },
          concurrentClient,
        ),
      ]);

      expect(results[0].cashBalanceCents).toBe(1_200);
      expect(results[1].cashBalanceCents).toBe(1_200);
      await expect(
        prisma.userWallet.findUniqueOrThrow({
          where: { id: wallet.id },
          select: { cashBalanceCents: true },
        }),
      ).resolves.toEqual({ cashBalanceCents: 1_200 });
      await expect(
        prisma.paymentProviderEvent.count({
          where: {
            provider: PaymentProvider.MOCK,
            providerEventId,
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.walletLedgerEntry.count({
          where: { rechargeOrderId: order.id },
        }),
      ).resolves.toBe(2);
      await expect(
        prisma.walletTransaction.count({
          where: {
            sourceType: "RechargeOrder",
            sourceId: order.id,
          },
        }),
      ).resolves.toBe(1);
    } finally {
      await prisma.walletLedgerEntry.deleteMany({
        where: { rechargeOrderId: order.id },
      });
      await prisma.walletTransaction.deleteMany({
        where: {
          sourceType: "RechargeOrder",
          sourceId: order.id,
        },
      });
      await prisma.paymentProviderEvent.deleteMany({
        where: { rechargeOrderId: order.id },
      });
      await prisma.rechargeOrder.delete({
        where: { id: order.id },
      }).catch(() => undefined);
      await prisma.userWallet.delete({
        where: { id: wallet.id },
      }).catch(() => undefined);
    }
  });

  it("allows only one concurrent purchase to spend the same cash balance", async () => {
    const fixture = await createWalletFixture("cash-overspend", 1_200);
    const concurrentClient = createReadBarrierClient<
      NonNullable<Parameters<typeof purchaseAgentTokens>[1]>
    >("userWallet", "findUnique");

    try {
      const results = await Promise.allSettled([
        purchaseAgentTokens({
          externalUserId: fixture.externalUserId,
          representativeId: fixture.representativeId,
          amountCents: 800,
          idempotencyKey: `${fixture.suffix}:purchase-a`,
        }, concurrentClient),
        purchaseAgentTokens({
          externalUserId: fixture.externalUserId,
          representativeId: fixture.representativeId,
          amountCents: 800,
          idempotencyKey: `${fixture.suffix}:purchase-b`,
        }, concurrentClient),
      ]);

      expectNoBarrierTimeout(results);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const [userWallet, userAgentWallet, agentWallet, entitlementAccount] =
        await Promise.all([
          prisma.userWallet.findUniqueOrThrow({
            where: { id: fixture.userWalletId },
          }),
          prisma.userAgentWallet.findFirstOrThrow({
            where: {
              userWalletId: fixture.userWalletId,
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
            },
          }),
        ]);

      expect(userWallet.cashBalanceCents).toBe(400);
      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 800,
        reservedTokenAmount: 0,
        totalPurchasedTokenAmount: 800,
        totalConsumedTokenAmount: 0,
      });
      expect(agentWallet).toMatchObject({
        tokenBalance: 800,
        totalPurchasedTokens: 800,
        totalConsumedTokens: 0,
      });
      expect(entitlementAccount).toMatchObject({
        remainingUnits: 800,
        reservedUnits: 0,
      });
      await expect(
        prisma.agentTokenPurchase.count({
          where: { representativeId: fixture.representativeId },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.creatorEarning.count({
          where: { representativeId: fixture.representativeId },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.walletTransaction.count({
          where: {
            representativeId: fixture.representativeId,
            sourceType: "AgentTokenPurchase",
          },
        }),
      ).resolves.toBe(1);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("allows only one generation run to reserve the final service credit", async () => {
    const fixture = await createWalletFixture("last-credit", 1);
    const concurrentClient = createReadBarrierClient<
      NonNullable<Parameters<typeof reserveConversationWalletUsage>[1]>
    >("userAgentWallet", "findUnique");

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 1,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });
      const [firstRunId, secondRunId] = await Promise.all([
        createGenerationRun(fixture, "reserve-a"),
        createGenerationRun(fixture, "reserve-b"),
      ]);

      const results = await Promise.allSettled([
        reserveConversationWalletUsage({
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          conversationId: fixture.conversationId,
          generationRunId: firstRunId,
          tokenAmount: 1,
          idempotencyKey: `${fixture.suffix}:reserve-a`,
        }, concurrentClient),
        reserveConversationWalletUsage({
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          conversationId: fixture.conversationId,
          generationRunId: secondRunId,
          tokenAmount: 1,
          idempotencyKey: `${fixture.suffix}:reserve-b`,
        }, concurrentClient),
      ]);

      expectNoBarrierTimeout(results);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const [userAgentWallet, entitlementAccount, usageCharges, reserveEntries] =
        await Promise.all([
          prisma.userAgentWallet.findFirstOrThrow({
            where: {
              userWalletId: fixture.userWalletId,
              agentWalletId: fixture.agentWalletId,
            },
          }),
          prisma.serviceEntitlementAccount.findFirstOrThrow({
            where: {
              audienceIdentityId: fixture.audienceIdentityId,
              representativeId: fixture.representativeId,
            },
          }),
          prisma.agentUsageCharge.findMany({
            where: { representativeId: fixture.representativeId },
          }),
          prisma.serviceEntitlementLedgerEntry.findMany({
            where: {
              entitlementAccount: {
                audienceIdentityId: fixture.audienceIdentityId,
                representativeId: fixture.representativeId,
              },
              kind: "RESERVE",
            },
          }),
        ]);

      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 0,
        reservedTokenAmount: 1,
      });
      expect(entitlementAccount).toMatchObject({
        remainingUnits: 0,
        reservedUnits: 1,
      });
      expect(usageCharges).toHaveLength(1);
      expect(usageCharges[0]).toMatchObject({
        status: AgentUsageChargeStatus.RESERVED,
        reservedTokenAmount: 1,
      });
      expect(reserveEntries).toHaveLength(1);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("rolls back the entitlement side when one generation run already owns an active reservation", async () => {
    const fixture = await createWalletFixture("single-run-reservation", 2);

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 2,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });
      const generationRunId = await createGenerationRun(
        fixture,
        "single-reservation-owner",
      );

      const first = await reserveConversationWalletUsage({
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        conversationId: fixture.conversationId,
        generationRunId,
        tokenAmount: 1,
        idempotencyKey: `${fixture.suffix}:reserve-a`,
      });
      await expect(
        reserveConversationWalletUsage({
          externalUserId: fixture.externalUserId,
          audienceIdentityId: fixture.audienceIdentityId,
          representativeId: fixture.representativeId,
          conversationId: fixture.conversationId,
          generationRunId,
          tokenAmount: 1,
          idempotencyKey: `${fixture.suffix}:reserve-b`,
        }),
      ).rejects.toBeInstanceOf(Error);

      const [
        usageCharges,
        reserveEntries,
        userAgentWallet,
        entitlementAccount,
        report,
      ] = await Promise.all([
        prisma.agentUsageCharge.findMany({
          where: { representativeId: fixture.representativeId },
        }),
        prisma.serviceEntitlementLedgerEntry.findMany({
          where: {
            entitlementAccount: {
              audienceIdentityId: fixture.audienceIdentityId,
              representativeId: fixture.representativeId,
            },
            kind: "RESERVE",
          },
        }),
        prisma.userAgentWallet.findFirstOrThrow({
          where: {
            userWalletId: fixture.userWalletId,
            agentWalletId: fixture.agentWalletId,
          },
        }),
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            audienceIdentityId: fixture.audienceIdentityId,
            representativeId: fixture.representativeId,
          },
        }),
        getWorkspaceWalletReconciliationReport({
          ownerId: fixture.ownerId,
          activeRepresentativeSlug: fixture.suffix,
          representative: fixture.suffix,
          currency: "CNY",
        }),
      ]);

      expect(usageCharges).toHaveLength(1);
      expect(usageCharges[0]).toMatchObject({
        id: first.usageCharge.id,
        status: AgentUsageChargeStatus.RESERVED,
        generationRunId,
        reservedTokenAmount: 1,
      });
      expect(reserveEntries).toHaveLength(1);
      expect(reserveEntries[0]).toMatchObject({
        entitlementAccountId: entitlementAccount.id,
        generationRunId,
        units: 1,
      });
      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 1,
        reservedTokenAmount: 1,
        totalConsumedTokenAmount: 0,
      });
      expect(entitlementAccount).toMatchObject({
        remainingUnits: 1,
        reservedUnits: 1,
      });
      expect(report?.status).toBe("healthy");
      expect(report?.issues).toHaveLength(0);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("serializes settlement against release so only one terminal usage mutation wins", async () => {
    const fixture = await createWalletFixture("settle-release", 10);
    const concurrentClient = createReadBarrierClient<
      NonNullable<Parameters<typeof settleConversationWalletUsage>[1]>
    >("agentUsageCharge", "findUnique");

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 10,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });
      const generationRunId = await createGenerationRun(fixture, "terminal-race");
      const reservation = await reserveConversationWalletUsage({
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        conversationId: fixture.conversationId,
        generationRunId,
        tokenAmount: 10,
        idempotencyKey: `${fixture.suffix}:reserve`,
      });

      const results = await Promise.allSettled([
        settleConversationWalletUsage({
          usageChargeId: reservation.usageCharge.id,
          expectedGenerationRunId: generationRunId,
          settledTokenAmount: 10,
          providerCostCents: 1,
          provider: "postgres-concurrency-test",
          idempotencyKey: `${fixture.suffix}:settle`,
        }, concurrentClient),
        releaseConversationWalletUsage({
          usageChargeId: reservation.usageCharge.id,
          expectedGenerationRunId: generationRunId,
          reason: "postgres_concurrency_test",
          idempotencyKey: `${fixture.suffix}:release`,
        }, concurrentClient),
      ]);

      expectNoBarrierTimeout(results);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const [usageCharge, userAgentWallet, entitlementAccount, terminalEntries] =
        await Promise.all([
          prisma.agentUsageCharge.findUniqueOrThrow({
            where: { id: reservation.usageCharge.id },
          }),
          prisma.userAgentWallet.findFirstOrThrow({
            where: {
              userWalletId: fixture.userWalletId,
              agentWalletId: fixture.agentWalletId,
            },
          }),
          prisma.serviceEntitlementAccount.findFirstOrThrow({
            where: {
              audienceIdentityId: fixture.audienceIdentityId,
              representativeId: fixture.representativeId,
            },
          }),
          prisma.serviceEntitlementLedgerEntry.findMany({
            where: {
              entitlementAccount: {
                audienceIdentityId: fixture.audienceIdentityId,
                representativeId: fixture.representativeId,
              },
              kind: { in: ["CONSUME", "RELEASE"] },
            },
          }),
        ]);

      expect([
        AgentUsageChargeStatus.SETTLED,
        AgentUsageChargeStatus.RELEASED,
      ]).toContain(usageCharge.status);
      expect(usageCharge.settledTokenAmount + usageCharge.releasedTokenAmount).toBe(10);
      expect(userAgentWallet.reservedTokenAmount).toBe(0);
      expect(entitlementAccount.reservedUnits).toBe(0);
      expect(userAgentWallet.availableTokenAmount).toBe(
        entitlementAccount.remainingUnits,
      );
      expect(terminalEntries).toHaveLength(1);
      expect(terminalEntries[0]?.units).toBe(10);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("supports an audited A-to-B-to-C reservation transfer and fences stale terminal owners", async () => {
    const fixture = await createWalletFixture("multi-hop-owner", 10);

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 10,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });
      const [firstRunId, secondRunId, thirdRunId] = await Promise.all([
        createGenerationRun(fixture, "owner-a"),
        createGenerationRun(fixture, "owner-b"),
        createGenerationRun(fixture, "owner-c"),
      ]);
      const reservation = await reserveConversationWalletUsage({
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        conversationId: fixture.conversationId,
        generationRunId: firstRunId,
        tokenAmount: 10,
        idempotencyKey: `${fixture.suffix}:reserve`,
      });

      await transferAgentUsageEntitlementReservation({
        usageChargeId: reservation.usageCharge.id,
        fromGenerationRunId: firstRunId,
        toGenerationRunId: secondRunId,
        conversationId: fixture.conversationId,
      });
      const secondHop = {
        usageChargeId: reservation.usageCharge.id,
        fromGenerationRunId: secondRunId,
        toGenerationRunId: thirdRunId,
        conversationId: fixture.conversationId,
      };
      await transferAgentUsageEntitlementReservation(secondHop);
      await transferAgentUsageEntitlementReservation(secondHop);

      const transferAudits = await prisma.walletTransaction.findMany({
        where: {
          sourceType: "AgentUsageEntitlementTransfer",
          sourceId: reservation.usageCharge.id,
        },
        select: {
          eventGroupId: true,
          idempotencyKey: true,
        },
      });
      expect(transferAudits).toHaveLength(2);
      expect(
        new Set(transferAudits.map((transaction) => transaction.eventGroupId))
          .size,
      ).toBe(2);
      expect(
        new Set(transferAudits.map((transaction) => transaction.idempotencyKey))
          .size,
      ).toBe(2);

      await expect(
        settleConversationWalletUsage({
          usageChargeId: reservation.usageCharge.id,
          expectedGenerationRunId: firstRunId,
          settledTokenAmount: 10,
          idempotencyKey: `${fixture.suffix}:stale-a-settle`,
        }),
      ).rejects.toThrow("generationRunId does not match");
      await expect(
        releaseConversationWalletUsage({
          usageChargeId: reservation.usageCharge.id,
          expectedGenerationRunId: secondRunId,
          idempotencyKey: `${fixture.suffix}:stale-b-release`,
        }),
      ).rejects.toThrow("generationRunId does not match");

      await expect(
        prisma.serviceEntitlementLedgerEntry.count({
          where: {
            entitlementAccount: {
              audienceIdentityId: fixture.audienceIdentityId,
              representativeId: fixture.representativeId,
            },
            kind: { in: ["CONSUME", "RELEASE"] },
          },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.agentUsageCharge.findUniqueOrThrow({
          where: { id: reservation.usageCharge.id },
          select: {
            status: true,
            generationRunId: true,
          },
        }),
      ).resolves.toEqual({
        status: AgentUsageChargeStatus.RESERVED,
        generationRunId: thirdRunId,
      });

      const settled = await settleConversationWalletUsage({
        usageChargeId: reservation.usageCharge.id,
        expectedGenerationRunId: thirdRunId,
        settledTokenAmount: 8,
        providerCostCents: 1,
        provider: "postgres-multi-hop-test",
        idempotencyKey: `${fixture.suffix}:current-c-settle`,
      });
      expect(settled.usageCharge).toMatchObject({
        status: "settled",
        generationRunId: thirdRunId,
        settledTokenAmount: 8,
        releasedTokenAmount: 2,
      });

      const [userAgentWallet, entitlementAccount, report] = await Promise.all([
        prisma.userAgentWallet.findFirstOrThrow({
          where: {
            userWalletId: fixture.userWalletId,
            agentWalletId: fixture.agentWalletId,
          },
        }),
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            audienceIdentityId: fixture.audienceIdentityId,
            representativeId: fixture.representativeId,
          },
        }),
        getWorkspaceWalletReconciliationReport({
          ownerId: fixture.ownerId,
          activeRepresentativeSlug: fixture.suffix,
          representative: fixture.suffix,
          currency: "CNY",
        }),
      ]);
      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 2,
        reservedTokenAmount: 0,
        totalConsumedTokenAmount: 8,
      });
      expect(entitlementAccount).toMatchObject({
        remainingUnits: 2,
        reservedUnits: 0,
      });
      expect(report?.status).toBe("healthy");
      expect(report?.issues).toHaveLength(0);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("blocks terminal writes when the persisted reservation owner is tampered without an audit", async () => {
    const fixture = await createWalletFixture("tampered-owner", 10);

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 10,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });
      const [reserveRunId, forgedOwnerRunId] = await Promise.all([
        createGenerationRun(fixture, "tamper-reserve-owner"),
        createGenerationRun(fixture, "tamper-forged-owner"),
      ]);
      const reservation = await reserveConversationWalletUsage({
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        conversationId: fixture.conversationId,
        generationRunId: reserveRunId,
        tokenAmount: 10,
        idempotencyKey: `${fixture.suffix}:reserve`,
      });

      await expect(
        getWorkspaceWalletReconciliationReport({
          ownerId: fixture.ownerId,
          activeRepresentativeSlug: fixture.suffix,
          representative: fixture.suffix,
          currency: "CNY",
        }),
      ).resolves.toMatchObject({
        status: "healthy",
        issues: [],
      });

      await prisma.agentUsageCharge.update({
        where: { id: reservation.usageCharge.id },
        data: { generationRunId: forgedOwnerRunId },
      });

      await expect(
        verifyAgentUsageEntitlementReservation({
          usageChargeId: reservation.usageCharge.id,
          representativeId: fixture.representativeId,
          generationRunId: forgedOwnerRunId,
          audienceIdentityId: fixture.audienceIdentityId,
          tokenAmount: 10,
        }),
      ).rejects.toMatchObject({
        code: "AGENT_USAGE_TRANSFER_CHAIN_INVALID",
        reason: "BROKEN_CHAIN",
      });
      await expect(
        settleConversationWalletUsage({
          usageChargeId: reservation.usageCharge.id,
          expectedGenerationRunId: forgedOwnerRunId,
          settledTokenAmount: 10,
          providerCostCents: 1,
          provider: "postgres-tamper-test",
          idempotencyKey: `${fixture.suffix}:tampered-settle`,
        }),
      ).rejects.toMatchObject({
        code: "AGENT_USAGE_TRANSFER_CHAIN_INVALID",
        reason: "BROKEN_CHAIN",
      });

      const [
        usageCharge,
        userAgentWallet,
        entitlementAccount,
        terminalEntries,
        terminalTransactions,
        report,
      ] = await Promise.all([
        prisma.agentUsageCharge.findUniqueOrThrow({
          where: { id: reservation.usageCharge.id },
        }),
        prisma.userAgentWallet.findFirstOrThrow({
          where: {
            userWalletId: fixture.userWalletId,
            agentWalletId: fixture.agentWalletId,
          },
        }),
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            audienceIdentityId: fixture.audienceIdentityId,
            representativeId: fixture.representativeId,
          },
        }),
        prisma.serviceEntitlementLedgerEntry.findMany({
          where: {
            entitlementAccount: {
              audienceIdentityId: fixture.audienceIdentityId,
              representativeId: fixture.representativeId,
            },
            kind: { in: ["CONSUME", "RELEASE"] },
          },
        }),
        prisma.walletTransaction.findMany({
          where: {
            sourceType: "AgentUsageCharge",
            sourceId: reservation.usageCharge.id,
            eventType: { in: ["USAGE_SETTLEMENT", "USAGE_RELEASE"] },
          },
        }),
        getWorkspaceWalletReconciliationReport({
          ownerId: fixture.ownerId,
          activeRepresentativeSlug: fixture.suffix,
          representative: fixture.suffix,
          currency: "CNY",
        }),
      ]);

      expect(usageCharge).toMatchObject({
        status: AgentUsageChargeStatus.RESERVED,
        generationRunId: forgedOwnerRunId,
        settledTokenAmount: 0,
        releasedTokenAmount: 0,
      });
      expect(userAgentWallet).toMatchObject({
        availableTokenAmount: 0,
        reservedTokenAmount: 10,
        totalConsumedTokenAmount: 0,
      });
      expect(entitlementAccount).toMatchObject({
        remainingUnits: 0,
        reservedUnits: 10,
      });
      expect(terminalEntries).toHaveLength(0);
      expect(terminalTransactions).toHaveLength(0);
      expect(report?.status).toBe("blocked");
      expect(report?.issues).toContainEqual(expect.objectContaining({
        code: "usage_entitlement_transfer_chain_invalid",
        severity: "error",
      }));
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("serializes owner transfer against terminal settlement so exactly one transition wins", async () => {
    const fixture = await createWalletFixture("transfer-terminal", 10);
    const concurrentClient = createReadBarrierClient<
      NonNullable<Parameters<typeof settleConversationWalletUsage>[1]>
    >("agentUsageCharge", "findUnique");

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 10,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });
      const [firstRunId, secondRunId] = await Promise.all([
        createGenerationRun(fixture, "transfer-owner-a"),
        createGenerationRun(fixture, "transfer-owner-b"),
      ]);
      const reservation = await reserveConversationWalletUsage({
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        conversationId: fixture.conversationId,
        generationRunId: firstRunId,
        tokenAmount: 10,
        idempotencyKey: `${fixture.suffix}:reserve`,
      });

      const results = await Promise.allSettled([
        transferAgentUsageEntitlementReservation({
          usageChargeId: reservation.usageCharge.id,
          fromGenerationRunId: firstRunId,
          toGenerationRunId: secondRunId,
          conversationId: fixture.conversationId,
        }, concurrentClient),
        settleConversationWalletUsage({
          usageChargeId: reservation.usageCharge.id,
          expectedGenerationRunId: firstRunId,
          settledTokenAmount: 10,
          providerCostCents: 1,
          provider: "postgres-transfer-terminal-test",
          idempotencyKey: `${fixture.suffix}:settle`,
        }, concurrentClient),
      ]);

      expectNoBarrierTimeout(results);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const [
        usageCharge,
        userAgentWallet,
        entitlementAccount,
        terminalEntries,
        transferAudits,
        report,
      ] = await Promise.all([
        prisma.agentUsageCharge.findUniqueOrThrow({
          where: { id: reservation.usageCharge.id },
        }),
        prisma.userAgentWallet.findFirstOrThrow({
          where: {
            userWalletId: fixture.userWalletId,
            agentWalletId: fixture.agentWalletId,
          },
        }),
        prisma.serviceEntitlementAccount.findFirstOrThrow({
          where: {
            audienceIdentityId: fixture.audienceIdentityId,
            representativeId: fixture.representativeId,
          },
        }),
        prisma.serviceEntitlementLedgerEntry.findMany({
          where: {
            entitlementAccount: {
              audienceIdentityId: fixture.audienceIdentityId,
              representativeId: fixture.representativeId,
            },
            kind: { in: ["CONSUME", "RELEASE"] },
          },
        }),
        prisma.walletTransaction.findMany({
          where: {
            sourceType: "AgentUsageEntitlementTransfer",
            sourceId: reservation.usageCharge.id,
          },
        }),
        getWorkspaceWalletReconciliationReport({
          ownerId: fixture.ownerId,
          activeRepresentativeSlug: fixture.suffix,
          representative: fixture.suffix,
          currency: "CNY",
        }),
      ]);

      if (usageCharge.status === AgentUsageChargeStatus.RESERVED) {
        expect(usageCharge.generationRunId).toBe(secondRunId);
        expect(userAgentWallet).toMatchObject({
          availableTokenAmount: 0,
          reservedTokenAmount: 10,
          totalConsumedTokenAmount: 0,
        });
        expect(entitlementAccount).toMatchObject({
          remainingUnits: 0,
          reservedUnits: 10,
        });
        expect(terminalEntries).toHaveLength(0);
        expect(transferAudits).toHaveLength(1);
      } else {
        expect(usageCharge).toMatchObject({
          status: AgentUsageChargeStatus.SETTLED,
          generationRunId: firstRunId,
          settledTokenAmount: 10,
          releasedTokenAmount: 0,
        });
        expect(userAgentWallet).toMatchObject({
          availableTokenAmount: 0,
          reservedTokenAmount: 0,
          totalConsumedTokenAmount: 10,
        });
        expect(entitlementAccount).toMatchObject({
          remainingUnits: 0,
          reservedUnits: 0,
        });
        expect(terminalEntries).toHaveLength(1);
        expect(transferAudits).toHaveLength(0);
      }
      expect(report?.status).toBe("healthy");
      expect(report?.issues).toHaveLength(0);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("allows only one concurrent withdrawal to freeze the same creator earning", async () => {
    const fixture = await createWalletFixture("withdraw-freeze", 0);
    const concurrentClient = createReadBarrierClient<
      NonNullable<Parameters<typeof createWithdrawRequest>[1]>
    >("creatorEarning", "findMany");

    try {
      const earning = await prisma.creatorEarning.create({
        data: {
          ownerId: fixture.ownerId,
          representativeId: fixture.representativeId,
          agentWalletId: fixture.agentWalletId,
          status: CreatorEarningStatus.WITHDRAWABLE,
          pendingCents: 0,
          withdrawableCents: 100,
          frozenCents: 0,
          withdrawnCents: 0,
          currency: "CNY",
          revenueShareBps: 2_000,
          idempotencyKey: `${fixture.suffix}:earning`,
        },
      });
      const results = await Promise.allSettled([
        createWithdrawRequest({
          ownerId: fixture.ownerId,
          representativeId: fixture.representativeId,
          amountCents: 100,
          idempotencyKey: `${fixture.suffix}:withdraw-a`,
        }, concurrentClient),
        createWithdrawRequest({
          ownerId: fixture.ownerId,
          representativeId: fixture.representativeId,
          amountCents: 100,
          idempotencyKey: `${fixture.suffix}:withdraw-b`,
        }, concurrentClient),
      ]);

      expectNoBarrierTimeout(results);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const [currentEarning, requests, allocations, ledgerEntries] =
        await Promise.all([
          prisma.creatorEarning.findUniqueOrThrow({
            where: { id: earning.id },
          }),
          prisma.withdrawRequest.findMany({
            where: { representativeId: fixture.representativeId },
          }),
          prisma.withdrawalAllocation.findMany({
            where: {
              creatorEarningId: earning.id,
            },
          }),
          prisma.walletLedgerEntry.findMany({
            where: {
              representativeId: fixture.representativeId,
              withdrawRequestId: { not: null },
            },
          }),
        ]);

      expect(currentEarning).toMatchObject({
        status: CreatorEarningStatus.FROZEN,
        pendingCents: 0,
        withdrawableCents: 0,
        frozenCents: 100,
        withdrawnCents: 0,
      });
      expect(requests).toHaveLength(1);
      expect(allocations).toHaveLength(1);
      expect(allocations[0]?.amountCents).toBe(100);
      expect(ledgerEntries).toHaveLength(2);
      expect(
        ledgerEntries.map((entry) => ({
          accountType: entry.accountType,
          entryKind: entry.entryKind,
          amountCents: entry.amountCents,
        })),
      ).toEqual(expect.arrayContaining([
        {
          accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
          entryKind: AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
          amountCents: -100,
        },
        {
          accountType: AmnWalletAccountType.CREATOR_FROZEN,
          entryKind: AmnLedgerEntryKind.CREATOR_FROZEN_CREDIT,
          amountCents: 100,
        },
      ]));
      expect(ledgerEntries.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(0);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("blocks withdrawal creation and progression while scoped reconciliation has errors", async () => {
    const fixture = await createWalletFixture("withdraw-reconciliation-gate", 10);

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 10,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });
      const earning = await prisma.creatorEarning.create({
        data: {
          ownerId: fixture.ownerId,
          representativeId: fixture.representativeId,
          agentWalletId: fixture.agentWalletId,
          status: CreatorEarningStatus.WITHDRAWABLE,
          pendingCents: 0,
          withdrawableCents: 100,
          frozenCents: 0,
          withdrawnCents: 0,
          currency: "CNY",
          revenueShareBps: 2_000,
          idempotencyKey: `${fixture.suffix}:withdrawable`,
        },
      });

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: {
          tokenBalance: { increment: 1 },
          totalPurchasedTokens: { increment: 1 },
        },
      });
      await expect(
        createWithdrawRequest({
          ownerId: fixture.ownerId,
          representativeId: fixture.representativeId,
          amountCents: 100,
          idempotencyKey: `${fixture.suffix}:withdraw-blocked`,
        }),
      ).rejects.toMatchObject({
        code: "wallet_reconciliation_required",
      });
      expect(
        await prisma.withdrawRequest.count({
          where: { representativeId: fixture.representativeId },
        }),
      ).toBe(0);
      expect(
        await prisma.creatorEarning.findUniqueOrThrow({
          where: { id: earning.id },
        }),
      ).toMatchObject({
        withdrawableCents: 100,
        frozenCents: 0,
      });

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: {
          tokenBalance: { decrement: 1 },
          totalPurchasedTokens: { decrement: 1 },
        },
      });
      const request = await createWithdrawRequest({
        ownerId: fixture.ownerId,
        representativeId: fixture.representativeId,
        amountCents: 100,
        idempotencyKey: `${fixture.suffix}:withdraw-allowed`,
      });

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: {
          tokenBalance: { increment: 1 },
          totalPurchasedTokens: { increment: 1 },
        },
      });
      await expect(
        cancelWithdrawRequest({
          ownerId: fixture.ownerId,
          withdrawRequestId: request.id,
          idempotencyKey: `${fixture.suffix}:cancel-blocked`,
        }),
      ).rejects.toBeInstanceOf(WalletReconciliationRequiredError);
      expect(
        await prisma.withdrawRequest.findUniqueOrThrow({
          where: { id: request.id },
        }),
      ).toMatchObject({
        status: WithdrawRequestStatus.PENDING_REVIEW,
      });
      expect(
        await prisma.creatorEarning.findUniqueOrThrow({
          where: { id: earning.id },
        }),
      ).toMatchObject({
        withdrawableCents: 0,
        frozenCents: 100,
      });

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: {
          tokenBalance: { decrement: 1 },
          totalPurchasedTokens: { decrement: 1 },
        },
      });
      await expect(
        cancelWithdrawRequest({
          ownerId: fixture.ownerId,
          withdrawRequestId: request.id,
          idempotencyKey: `${fixture.suffix}:cancel-restored`,
        }),
      ).resolves.toMatchObject({
        status: "canceled",
        frozenCents: 0,
      });
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("detects projection drift without mutating wallet accounting state", async () => {
    const fixture = await createWalletFixture("reconciliation-drift", 10);
    const reconciliationInput = {
      ownerId: fixture.ownerId,
      activeRepresentativeSlug: fixture.suffix,
      representative: fixture.suffix,
      currency: "CNY",
    } as const;

    try {
      await purchaseAgentTokens({
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 10,
        idempotencyKey: `${fixture.suffix}:purchase`,
      });

      const beforeHealthyReport = await readWalletAccountingFingerprint(fixture);
      const healthyReport =
        await getWorkspaceWalletReconciliationReport(reconciliationInput);
      const afterHealthyReport = await readWalletAccountingFingerprint(fixture);

      expect(healthyReport).not.toBeNull();
      expect(healthyReport?.status).toBe("healthy");
      expect(healthyReport?.summary.errors).toBe(0);
      expect(healthyReport?.issues).toHaveLength(0);
      expect(afterHealthyReport).toEqual(beforeHealthyReport);

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: {
          tokenBalance: { increment: 1 },
          totalPurchasedTokens: { increment: 1 },
        },
      });
      const beforeDriftReport = await readWalletAccountingFingerprint(fixture);
      const driftReport =
        await getWorkspaceWalletReconciliationReport(reconciliationInput);
      const afterDriftReport = await readWalletAccountingFingerprint(fixture);

      expect(driftReport).not.toBeNull();
      expect(driftReport?.status).toBe("blocked");
      expect(driftReport?.summary.errors).toBeGreaterThan(0);
      expect(driftReport?.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "agent_wallet_token_balance_mismatch",
          severity: "error",
          expectedValue: 10,
          actualValue: 11,
          differenceValue: 1,
        }),
      ]));
      expect(afterDriftReport).toEqual(beforeDriftReport);

      await prisma.agentWallet.update({
        where: { id: fixture.agentWalletId },
        data: {
          tokenBalance: { decrement: 1 },
          totalPurchasedTokens: { decrement: 1 },
        },
      });
      const restoredReport =
        await getWorkspaceWalletReconciliationReport(reconciliationInput);

      expect(restoredReport?.status).toBe("healthy");
      expect(
        restoredReport?.issues.some(
          (issue) => issue.code === "agent_wallet_token_balance_mismatch",
        ),
      ).toBe(false);
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);

  it("aggregates creator balances beyond the former 100-row dashboard limit", async () => {
    const fixture = await createWalletFixture("dashboard-aggregate", 0);

    try {
      await prisma.creatorEarning.createMany({
        data: Array.from({ length: 101 }, (_, index) => ({
          ownerId: fixture.ownerId,
          representativeId: fixture.representativeId,
          agentWalletId: fixture.agentWalletId,
          status: CreatorEarningStatus.WITHDRAWABLE,
          pendingCents: 0,
          withdrawableCents: index + 1,
          frozenCents: 0,
          withdrawnCents: 0,
          currency: "CNY",
          revenueShareBps: 2_000,
          idempotencyKey: `${fixture.suffix}:dashboard-earning:${index}`,
        })),
      });

      const snapshot = await getAgentWalletDashboardSnapshot(
        fixture.suffix,
      );

      expect(snapshot?.creatorBalances).toEqual({
        pendingCents: 0,
        withdrawableCents: 5_151,
        frozenCents: 0,
        withdrawnCents: 0,
      });
    } finally {
      await cleanupWalletFixture(fixture);
    }
  }, 30_000);
});

type WalletFixture = {
  suffix: string;
  ownerId: string;
  representativeId: string;
  audienceIdentityId: string;
  userWalletId: string;
  agentWalletId: string;
  contactId: string;
  conversationId: string;
  externalUserId: string;
};

type WalletTransactionOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

/**
 * Makes both serializable transactions observe the same pre-mutation row.
 * Without this barrier Promise.allSettled can execute effectively in series,
 * allowing a race test to pass without exercising write-conflict retry.
 */
function createReadBarrierClient<TClient>(
  delegateName: keyof Prisma.TransactionClient,
  methodName: string,
): TClient {
  const waitForParticipants = createParticipantBarrier(2);

  return new Proxy(prisma, {
    get(target, property) {
      if (property !== "$transaction") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return async <T>(
        operation: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: WalletTransactionOptions,
      ): Promise<T> =>
        prisma.$transaction(async (tx) => {
          let pausedInThisTransaction = false;
          const transactionClient = new Proxy(tx, {
            get(transactionTarget, transactionProperty) {
              const transactionValue = Reflect.get(
                transactionTarget,
                transactionProperty,
                transactionTarget,
              );
              if (transactionProperty !== delegateName) {
                return typeof transactionValue === "function"
                  ? transactionValue.bind(transactionTarget)
                  : transactionValue;
              }

              const delegate = transactionValue as object;
              return new Proxy(delegate, {
                get(delegateTarget, delegateProperty) {
                  const delegateValue = Reflect.get(
                    delegateTarget,
                    delegateProperty,
                    delegateTarget,
                  );
                  if (typeof delegateValue !== "function") {
                    return delegateValue;
                  }
                  const boundDelegate = delegateValue.bind(delegateTarget);
                  if (delegateProperty !== methodName) {
                    return boundDelegate;
                  }

                  return async (...args: unknown[]) => {
                    const result = await boundDelegate(...args);
                    if (!pausedInThisTransaction) {
                      pausedInThisTransaction = true;
                      await waitForParticipants();
                    }
                    return result;
                  };
                },
              });
            },
          }) as Prisma.TransactionClient;

          return operation(transactionClient);
        }, options);
    },
  }) as unknown as TClient;
}

function createParticipantBarrier(participantCount: number): () => Promise<void> {
  let arrived = 0;
  let releaseParticipants: (() => void) | undefined;
  let rejectParticipants: ((error: Error) => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const allParticipantsArrived = new Promise<void>((resolve, reject) => {
    releaseParticipants = resolve;
    rejectParticipants = reject;
  });

  return async () => {
    arrived += 1;
    if (arrived === 1) {
      timeout = setTimeout(
        () => rejectParticipants?.(
          new Error("Timed out waiting for concurrent wallet transaction."),
        ),
        5_000,
      );
    }
    if (arrived >= participantCount) {
      if (timeout) {
        clearTimeout(timeout);
      }
      releaseParticipants?.();
    }

    await allParticipantsArrived;
  };
}

function expectNoBarrierTimeout(
  results: PromiseSettledResult<unknown>[],
): void {
  expect(
    results.some(
      (result) =>
        result.status === "rejected"
        && result.reason instanceof Error
        && result.reason.message ===
          "Timed out waiting for concurrent wallet transaction.",
    ),
  ).toBe(false);
}

async function createWalletFixture(
  scenario: string,
  cashBalanceCents: number,
): Promise<WalletFixture> {
  const suffix = `postgres-wallet-${scenario}-${Date.now()}-${crypto.randomUUID()}`;
  const externalUserId = `${suffix}:user`;
  return prisma.$transaction(async (tx) => {
    const owner = await tx.owner.create({
      data: {
        displayName: `Wallet concurrency owner ${scenario}`,
        creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      },
    });
    const representative = await tx.representative.create({
      data: {
        ownerId: owner.id,
        slug: suffix,
        displayName: `Wallet concurrency representative ${scenario}`,
        roleSummary: "PostgreSQL wallet concurrency test fixture.",
        tone: "neutral",
        languages: ["en"],
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
    const userWallet = await tx.userWallet.create({
      data: {
        audienceIdentityId: audienceIdentity.id,
        externalUserId,
        currency: "CNY",
        cashBalanceCents,
      },
    });
    const agentWallet = await tx.agentWallet.create({
      data: {
        representativeId: representative.id,
        currency: "CNY",
        tokenUnitPriceCents: 1,
        creatorRevenueShareBps: 2_000,
      },
    });
    const contact = await tx.contact.create({
      data: {
        representativeId: representative.id,
        audienceIdentityId: audienceIdentity.id,
        externalUserId,
        displayName: "Wallet concurrency audience",
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
      audienceIdentityId: audienceIdentity.id,
      userWalletId: userWallet.id,
      agentWalletId: agentWallet.id,
      contactId: contact.id,
      conversationId: conversation.id,
      externalUserId,
    };
  });
}

async function createGenerationRun(
  fixture: WalletFixture,
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

async function readWalletAccountingFingerprint(fixture: WalletFixture) {
  const [
    walletLedgerEntryCount,
    walletTransactionCount,
    tokenPurchaseCount,
    creatorEarningCount,
    entitlementLedgerEntryCount,
    userWallet,
    agentWallet,
    userAgentWallet,
    tokenPurchase,
    entitlementAccount,
    creatorEarning,
  ] = await Promise.all([
    prisma.walletLedgerEntry.count({
      where: { representativeId: fixture.representativeId },
    }),
    prisma.walletTransaction.count({
      where: { representativeId: fixture.representativeId },
    }),
    prisma.agentTokenPurchase.count({
      where: { representativeId: fixture.representativeId },
    }),
    prisma.creatorEarning.count({
      where: { representativeId: fixture.representativeId },
    }),
    prisma.serviceEntitlementLedgerEntry.count({
      where: {
        entitlementAccount: {
          representativeId: fixture.representativeId,
        },
      },
    }),
    prisma.userWallet.findUniqueOrThrow({
      where: { id: fixture.userWalletId },
      select: {
        cashBalanceCents: true,
        updatedAt: true,
      },
    }),
    prisma.agentWallet.findUniqueOrThrow({
      where: { id: fixture.agentWalletId },
      select: {
        tokenBalance: true,
        totalPurchasedTokens: true,
        totalConsumedTokens: true,
        updatedAt: true,
      },
    }),
    prisma.userAgentWallet.findFirstOrThrow({
      where: {
        userWalletId: fixture.userWalletId,
        agentWalletId: fixture.agentWalletId,
        currency: "CNY",
      },
      select: {
        availableTokenAmount: true,
        reservedTokenAmount: true,
        totalPurchasedTokenAmount: true,
        totalConsumedTokenAmount: true,
        updatedAt: true,
      },
    }),
    prisma.agentTokenPurchase.findFirstOrThrow({
      where: { representativeId: fixture.representativeId },
      select: {
        remainingTokenAmount: true,
        updatedAt: true,
      },
    }),
    prisma.serviceEntitlementAccount.findFirstOrThrow({
      where: {
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
      },
      select: {
        remainingUnits: true,
        reservedUnits: true,
        updatedAt: true,
      },
    }),
    prisma.creatorEarning.findFirstOrThrow({
      where: { representativeId: fixture.representativeId },
      select: {
        pendingCents: true,
        withdrawableCents: true,
        frozenCents: true,
        withdrawnCents: true,
        updatedAt: true,
      },
    }),
  ]);

  return {
    counts: {
      walletLedgerEntryCount,
      walletTransactionCount,
      tokenPurchaseCount,
      creatorEarningCount,
      entitlementLedgerEntryCount,
    },
    rows: {
      userWallet,
      agentWallet,
      userAgentWallet,
      tokenPurchase,
      entitlementAccount,
      creatorEarning,
    },
  };
}

async function cleanupWalletFixture(fixture: WalletFixture): Promise<void> {
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
  await prisma.agentTokenPurchase.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.userAgentWallet.deleteMany({
    where: { agentWalletId: fixture.agentWalletId },
  });
  await prisma.serviceEntitlementAccount.deleteMany({
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
  await prisma.userWallet.delete({
    where: { id: fixture.userWalletId },
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

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the PostgreSQL wallet concurrency E2E.");
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "PostgreSQL wallet concurrency E2E refuses a non-local database unless "
        + "DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1 and the database name is clearly non-production.",
    );
  }
}
