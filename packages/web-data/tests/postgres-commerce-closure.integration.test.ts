import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  AmnWalletAccountType,
  AudienceIdentityStatus,
  BillingEntitlementExpiryPolicy,
  BillingHandoffAllowance,
  BillingHandoffServiceLevel,
  BillingPriceVersionStatus,
  BillingProductKind,
  BillingProductStatus,
  BillingRefundPolicy,
  Channel,
  CreatorEarningStatus,
  CreatorPayoutProfileStatus,
  CreatorVerificationStatus,
  HandoffEntitlementGrantStatus,
  HandoffEntitlementLedgerKind,
  HandoffStatus,
  PaymentProvider,
  PaymentProviderEventType,
  PayoutDestinationKind,
  PayoutDestinationStatus,
  PayoutSubjectType,
  RechargeRefundProviderStatus,
  RechargeRefundReversalStatus,
  RechargeRefundSubmissionStatus,
  RepresentativeClaimStatus,
  RepresentativeHandoffAccessMode,
  TipContributionStatus,
  WithdrawRequestStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  NormalizedPaymentProviderEvent,
  PaymentProviderAdapter,
} from "../src/agent-wallet-payment-providers";
import {
  AGENT_WALLET_TIP_PRODUCT_CODE,
  completeMockRechargeAndPurchaseAgentTokens,
  completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent,
  createMockRechargeOrder,
  createRechargeOrder,
} from "../src/agent-wallet-recharge";
import {
  refundRechargeOrder,
  reverseAgentTokenPurchase,
} from "../src/agent-wallet-refunds";
import {
  reserveConversationWalletUsage,
  settleConversationWalletUsage,
} from "../src/agent-wallet-usage-charge";
import {
  approveWithdrawRequest,
  createWithdrawRequest,
  markWithdrawRequestFailed,
  markWithdrawRequestPaid,
} from "../src/agent-wallet-withdrawals";
import {
  applyVerifiedWeChatPayRefund,
  persistVerifiedWeChatPayRefund,
} from "../src/agent-wallet-wechat-refunds";
import {
  freezeHandoffGrantForRefund,
  refundHandoffGrant,
  restoreHandoffGrantAfterFailedRefund,
} from "../src/commercial-refund-entitlements";
import {
  acceptHandoffRequestInTransaction,
  createOrReuseHandoffRequestInTransaction,
  grantPurchasedHandoffEntitlement,
  resolveHandoffRequestInTransaction,
} from "../src/handoff-entitlements";
import { prisma } from "../src/prisma";
import { AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE } from "../src/service-entitlements";
import { mergeAudienceIdentity } from "../src/web-audience";
import type { NormalizedWeChatPayRefundResult } from "../src/wechat-pay-api-v3";

const describePostgres =
  process.env.DELEGATE_POSTGRES_E2E === "1" ? describe : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertIsolatedCommerceAuditDatabase();
}

describePostgres("representative commerce PostgreSQL closure", () => {
  beforeAll(async () => {
    const [database] = await prisma.$queryRaw<
      Array<{ database_name: string; server_version_num: string }>
    >`
      SELECT
        current_database() AS database_name,
        current_setting('server_version_num') AS server_version_num
    `;
    expect(database?.database_name).toMatch(
      /^delegate_commerce_migration_audit_/u,
    );
    expect(Number(database?.server_version_num)).toBeGreaterThanOrEqual(160_000);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("fulfills one paid service package with credits and one handoff grant under replay", async () => {
    const fixture = await createCommerceFixture("service-dispatcher");
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 17,
      entitlementUnits: 101,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: 3,
      handoffServiceLevel: BillingHandoffServiceLevel.PRIORITY,
      handoffValidityDays: 45,
    });
    const order = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "service-dispatcher"),
    );
    const completionInput = {
      rechargeOrderId: order.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: commercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:mock-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:service-purchase`,
    };

    const first = await completeMockRechargeAndPurchaseAgentTokens(
      completionInput,
    );
    const replay = await completeMockRechargeAndPurchaseAgentTokens(
      completionInput,
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      productKind: "SERVICE_PACKAGE",
      rechargeOrder: {
        id: order.id,
        productKindSnapshot: "SERVICE_PACKAGE",
        status: "paid",
        cashBalanceCents: 0,
      },
      tokenPurchase: {
        amountCents: 17,
        tokenAmount: 101,
        remainingTokenAmount: 101,
        availableTokenAmount: 101,
      },
      fulfillment: {
        kind: "SERVICE_PACKAGE",
        handoffEntitlement: {
          allowance: BillingHandoffAllowance.LIMITED,
          serviceLevel: BillingHandoffServiceLevel.PRIORITY,
          grantedUses: 3,
          remainingUses: 3,
          reservedUses: 0,
          consumedUses: 0,
          status: HandoffEntitlementGrantStatus.ACTIVE,
        },
      },
    });

    const [purchaseCount, grant, grantLedger, userWallet] = await Promise.all([
      prisma.agentTokenPurchase.count({
        where: { rechargeOrderId: order.id },
      }),
      prisma.handoffEntitlementGrant.findUniqueOrThrow({
        where: { rechargeOrderId: order.id },
      }),
      prisma.handoffEntitlementLedgerEntry.findMany({
        where: {
          grant: { rechargeOrderId: order.id },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.userWallet.findUniqueOrThrow({
        where: { externalUserId: fixture.externalUserId },
      }),
    ]);
    expect(purchaseCount).toBe(1);
    expect(grant).toMatchObject({
      rechargeOrderId: order.id,
      audienceIdentityId: fixture.audienceIdentityId,
      representativeId: fixture.representativeId,
      billingPriceVersionId: commercial.price.id,
      grantedUses: 3,
      remainingUses: 3,
      reservedUses: 0,
      consumedUses: 0,
    });
    if (!grant.expiresAt) throw new Error("expected finite grant expiry");
    expect(grant.expiresAt.getTime() - grant.startsAt.getTime()).toBe(
      45 * 86_400_000,
    );
    expect(grantLedger).toEqual([
      expect.objectContaining({
        grantId: grant.id,
        handoffRequestId: null,
        kind: HandoffEntitlementLedgerKind.GRANT,
        uses: 3,
        remainingAfter: 3,
        reservedAfter: 0,
        consumedAfter: 0,
        idempotencyKey: `handoff-grant:${order.id}`,
      }),
    ]);
    expect(userWallet.cashBalanceCents).toBe(0);
  }, 30_000);

  it("closes ACTIVE and EXPIRED handoff refund transitions with deferred ledger evidence", async () => {
    const fixture = await createCommerceFixture("handoff-refund");
    const activeCommercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 19,
      entitlementUnits: 37,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: 2,
      handoffServiceLevel: BillingHandoffServiceLevel.STANDARD,
      handoffValidityDays: 30,
    });
    const activeOrder = await createMockRechargeOrder(
      commercialRechargeInput(fixture, activeCommercial, "active-refund"),
    );
    await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: activeOrder.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: activeCommercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:active-refund-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:active-refund-purchase`,
    });
    const failedRefund = await createSyntheticRefund({
      fixture,
      rechargeOrderId: activeOrder.id,
      amountCents: activeCommercial.price.amountMinor,
      label: "active-failed",
      submissionStatus: RechargeRefundSubmissionStatus.EXTERNAL,
      providerStatus: RechargeRefundProviderStatus.CLOSED,
      reversalStatus: RechargeRefundReversalStatus.NOT_REQUIRED,
    });

    await prisma.$transaction(async (tx) => {
      const frozen = await freezeHandoffGrantForRefund(tx, activeOrder.id);
      expect(frozen?.status).toBe(HandoffEntitlementGrantStatus.FROZEN);
    });
    await expect(
      prisma.handoffEntitlementGrant.findUniqueOrThrow({
        where: { rechargeOrderId: activeOrder.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: HandoffEntitlementGrantStatus.FROZEN });

    await prisma.$transaction((tx) =>
      restoreHandoffGrantAfterFailedRefund(tx, failedRefund.id, new Date()),
    );
    await expect(
      prisma.handoffEntitlementGrant.findUniqueOrThrow({
        where: { rechargeOrderId: activeOrder.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: HandoffEntitlementGrantStatus.ACTIVE });

    const succeededRefund = await createSyntheticRefund({
      fixture,
      rechargeOrderId: activeOrder.id,
      amountCents: activeCommercial.price.amountMinor,
      label: "active-succeeded",
      submissionStatus: RechargeRefundSubmissionStatus.EXTERNAL,
      providerStatus: RechargeRefundProviderStatus.SUCCEEDED,
      reversalStatus: RechargeRefundReversalStatus.APPLIED,
    });
    await prisma.$transaction(async (tx) => {
      await freezeHandoffGrantForRefund(tx, activeOrder.id);
    });
    await prisma.$transaction((tx) =>
      refundHandoffGrant(tx, activeOrder.id, succeededRefund.id),
    );
    await prisma.$transaction((tx) =>
      refundHandoffGrant(tx, activeOrder.id, succeededRefund.id),
    );

    const activeGrant = await prisma.handoffEntitlementGrant.findUniqueOrThrow({
      where: { rechargeOrderId: activeOrder.id },
    });
    const activeTerminalLedger =
      await prisma.handoffEntitlementLedgerEntry.findMany({
        where: {
          grantId: activeGrant.id,
          kind: HandoffEntitlementLedgerKind.REFUND,
        },
      });
    expect(activeGrant.status).toBe(HandoffEntitlementGrantStatus.REFUNDED);
    expect(activeTerminalLedger).toEqual([
      expect.objectContaining({
        uses: 2,
        remainingAfter: 2,
        reservedAfter: 0,
        consumedAfter: 0,
        idempotencyKey:
          `handoff-grant:${activeGrant.id}:refund:${succeededRefund.id}`,
      }),
    ]);

    const expiredCommercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 23,
      entitlementUnits: 41,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: 4,
      handoffServiceLevel: BillingHandoffServiceLevel.PRIORITY,
      handoffValidityDays: 10,
    });
    const expiredOrder = await createHistoricalPaidHandoffOrder(
      fixture,
      expiredCommercial,
      40,
    );
    const expiredGrant = await prisma.$transaction(async (tx) => {
      const granted = await grantPurchasedHandoffEntitlement(
        { rechargeOrderId: expiredOrder.id },
        tx as never,
      );
      if (!granted) throw new Error("expected historical handoff grant");
      const updated = await tx.handoffEntitlementGrant.update({
        where: { id: granted.id },
        data: { status: HandoffEntitlementGrantStatus.EXPIRED },
      });
      await tx.handoffEntitlementLedgerEntry.create({
        data: {
          grantId: updated.id,
          kind: HandoffEntitlementLedgerKind.EXPIRE,
          uses: updated.grantedUses ?? 1,
          remainingAfter: updated.remainingUses,
          reservedAfter: updated.reservedUses,
          consumedAfter: updated.consumedUses,
          idempotencyKey: `handoff-grant:${updated.id}:expire`,
        },
      });
      return updated;
    });
    expect(expiredGrant.expiresAt?.getTime()).toBeLessThan(Date.now());

    const expiredFailedRefund = await createSyntheticRefund({
      fixture,
      rechargeOrderId: expiredOrder.id,
      amountCents: expiredCommercial.price.amountMinor,
      label: "expired-failed",
      submissionStatus: RechargeRefundSubmissionStatus.EXTERNAL,
      providerStatus: RechargeRefundProviderStatus.CLOSED,
      reversalStatus: RechargeRefundReversalStatus.NOT_REQUIRED,
    });
    await prisma.$transaction(async (tx) => {
      const frozen = await freezeHandoffGrantForRefund(tx, expiredOrder.id);
      expect(frozen?.status).toBe(HandoffEntitlementGrantStatus.FROZEN);
    });
    await prisma.$transaction((tx) =>
      restoreHandoffGrantAfterFailedRefund(
        tx,
        expiredFailedRefund.id,
        new Date(),
      ),
    );

    const [restoredExpiredGrant, expiryReceipts] = await Promise.all([
      prisma.handoffEntitlementGrant.findUniqueOrThrow({
        where: { id: expiredGrant.id },
      }),
      prisma.handoffEntitlementLedgerEntry.findMany({
        where: {
          grantId: expiredGrant.id,
          kind: HandoffEntitlementLedgerKind.EXPIRE,
        },
      }),
    ]);
    expect(restoredExpiredGrant.status).toBe(
      HandoffEntitlementGrantStatus.EXPIRED,
    );
    expect(expiryReceipts).toHaveLength(1);
    expect(expiryReceipts[0]).toMatchObject({
      remainingAfter: 4,
      reservedAfter: 0,
      consumedAfter: 0,
    });
  }, 30_000);

  it("fulfills one tip with no token purchase and one balanced three-party ledger", async () => {
    const fixture = await createCommerceFixture("tip-dispatcher");
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.TIP,
      amountMinor: 13,
      entitlementUnits: 0,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    });
    const order = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "tip-dispatcher"),
    );
    const completionInput = {
      rechargeOrderId: order.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: commercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:tip-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:tip-no-purchase`,
    };

    const first = await completeMockRechargeAndPurchaseAgentTokens(
      completionInput,
    );
    const replay = await completeMockRechargeAndPurchaseAgentTokens(
      completionInput,
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      productKind: "TIP",
      tokenPurchase: null,
      rechargeOrder: {
        id: order.id,
        productKindSnapshot: "TIP",
        cashBalanceCents: 0,
      },
      fulfillment: {
        kind: "TIP",
        tipContribution: {
          amountMinor: 13,
          creatorRevenueShareBps: 3_333,
          platformRevenueShareBps: 6_667,
          creatorAmountMinor: 4,
          platformAmountMinor: 9,
          status: "completed",
        },
        creatorEarning: {
          status: "withdrawable",
          withdrawableCents: 4,
        },
      },
    });

    const contribution = await prisma.tipContribution.findUniqueOrThrow({
      where: { rechargeOrderId: order.id },
      include: { creatorEarning: true },
    });
    const ledger = await prisma.walletLedgerEntry.findMany({
      where: { eventGroupId: `tip:${contribution.id}` },
      orderBy: { id: "asc" },
    });
    expect(contribution.creatorEarning).toMatchObject({
      ownerId: fixture.ownerId,
      representativeId: fixture.representativeId,
      status: CreatorEarningStatus.WITHDRAWABLE,
      pendingCents: 0,
      withdrawableCents: 4,
      frozenCents: 0,
      withdrawnCents: 0,
    });
    expect(ledger).toHaveLength(3);
    expect(ledger.map((entry) => entry.accountType).sort()).toEqual([
      AmnWalletAccountType.CREATOR_WITHDRAWABLE,
      AmnWalletAccountType.PLATFORM_EARNED_REVENUE,
      AmnWalletAccountType.USER_CASH,
    ].sort());
    expect(ledger.map((entry) => entry.amountCents).sort((a, b) => a - b))
      .toEqual([-13, 4, 9]);
    expect(ledger.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(0);
    await expect(
      prisma.agentTokenPurchase.count({
        where: { rechargeOrderId: order.id },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.tipContribution.count({
        where: { rechargeOrderId: order.id },
      }),
    ).resolves.toBe(1);
  }, 30_000);

  it("applies and replays a forced WeChat tip refund with balanced creator, platform, cash, and settlement reversals", async () => {
    const fixture = await createCommerceFixture("tip-forced-refund");
    await createVerifiedPayoutDestination(fixture);
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.TIP,
      amountMinor: 13,
      entitlementUnits: 0,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    });
    const order = await createRechargeOrder(
      commercialRechargeInput(fixture, commercial, "tip-wechat"),
      localWeChatAdapter,
    );
    const providerTransactionId =
      `420${Date.now()}${randomUUID().replaceAll("-", "").slice(0, 13)}`;
    await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
      verifiedPaidEvent({
        orderId: order.id,
        amountCents: commercial.price.amountMinor,
        providerEventId: `${fixture.suffix}:tip-wechat-paid`,
        providerTransactionId,
      }),
    );

    const persisted = await persistVerifiedWeChatPayRefund(
      verifiedRefundResult({
        suffix: fixture.suffix,
        orderId: order.id,
        providerTransactionId,
        amountCents: commercial.price.amountMinor,
      }),
    );
    expect(persisted).toMatchObject({
      rechargeOrderId: order.id,
      providerStatus: "succeeded",
      reversalStatus: "pending",
      processingError: null,
    });
    const refund = await prisma.rechargeRefund.findUniqueOrThrow({
      where: {
        provider_providerRefundOrderId: {
          provider: PaymentProvider.WECHAT_PAY,
          providerRefundOrderId:
            `wechat-refund-order:${fixture.suffix}`,
        },
      },
    });
    expect(refund).toMatchObject({
      rechargeOrderId: order.id,
      tokenPurchaseId: null,
      providerStatus: RechargeRefundProviderStatus.SUCCEEDED,
      reversalStatus: RechargeRefundReversalStatus.PENDING,
    });

    const firstApply = await applyVerifiedWeChatPayRefund(refund.id);
    const replay = await applyVerifiedWeChatPayRefund(refund.id);
    expect(firstApply).toMatchObject({
      rechargeOrderId: order.id,
      providerStatus: "succeeded",
      reversalStatus: "applied",
      processingError: null,
    });
    expect(replay).toEqual(firstApply);

    await expect(
      createWithdrawRequest({
        ownerId: fixture.ownerId,
        representativeId: fixture.representativeId,
        amountCents: 1,
        currency: "CNY",
        idempotencyKey: `${fixture.suffix}:blocked-withdrawal`,
      }),
    ).rejects.toThrow("Insufficient withdrawable creator balance.");
    await expect(
      prisma.withdrawRequest.count({
        where: { representativeId: fixture.representativeId },
      }),
    ).resolves.toBe(0);
    const [contribution, reversedRefund, reversedOrder, payerWallet] =
      await Promise.all([
        prisma.tipContribution.findUniqueOrThrow({
          where: { rechargeOrderId: order.id },
          include: { creatorEarning: true },
        }),
        prisma.rechargeRefund.findUniqueOrThrow({ where: { id: refund.id } }),
        prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.id } }),
        prisma.userWallet.findUniqueOrThrow({
          where: { id: order.userWalletId },
        }),
      ]);
    expect(contribution).toMatchObject({
      status: TipContributionStatus.REFUNDED,
      refundedAt: expect.any(Date),
    });
    expect(contribution.creatorEarning).toMatchObject({
      status: CreatorEarningStatus.REVERSED,
      pendingCents: 0,
      withdrawableCents: 0,
      frozenCents: 0,
      withdrawnCents: 0,
    });
    expect(reversedRefund).toMatchObject({
      reversalStatus: RechargeRefundReversalStatus.APPLIED,
      processingError: null,
      reversalAppliedAt: expect.any(Date),
    });
    expect(reversedOrder.status).toBe("REFUNDED");
    expect(payerWallet.cashBalanceCents).toBe(0);

    const [tipReversalLedger, settlementLedger] = await Promise.all([
      prisma.walletLedgerEntry.findMany({
        where: {
          eventGroupId: `tip_refund:${contribution.id}:${refund.id}`,
        },
      }),
      prisma.walletLedgerEntry.findMany({
        where: { eventGroupId: `recharge_refund:${order.id}` },
      }),
    ]);
    expect(tipReversalLedger).toHaveLength(3);
    expect(tipReversalLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
        amountCents: -4,
        balanceAfterCents: null,
      }),
      expect.objectContaining({
        accountType: AmnWalletAccountType.PLATFORM_EARNED_REVENUE,
        amountCents: -9,
        balanceAfterCents: null,
      }),
      expect.objectContaining({
        accountType: AmnWalletAccountType.USER_CASH,
        amountCents: 13,
      }),
    ]));
    expect(tipReversalLedger.reduce((sum, row) => sum + row.amountCents, 0))
      .toBe(0);
    expect(settlementLedger).toHaveLength(2);
    expect(settlementLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountType: AmnWalletAccountType.USER_CASH,
        amountCents: -13,
      }),
      expect.objectContaining({
        accountType: AmnWalletAccountType.EXTERNAL_SETTLEMENT,
        amountCents: 13,
      }),
    ]));
    expect(settlementLedger.reduce((sum, row) => sum + row.amountCents, 0))
      .toBe(0);
  }, 30_000);

  it("cancels a single reversible frozen tip withdrawal before applying the forced refund", async () => {
    const paidTip = await createPaidWeChatTip("tip-frozen-refund");
    await createVerifiedPayoutDestination(paidTip.fixture);
    const request = await createWithdrawRequest({
      ownerId: paidTip.fixture.ownerId,
      representativeId: paidTip.fixture.representativeId,
      amountCents: paidTip.contribution.creatorAmountMinor,
      currency: "CNY",
      idempotencyKey: `${paidTip.fixture.suffix}:tip-frozen-withdrawal`,
    });
    expect(request.status).toBe("pending_review");

    const persisted = await persistVerifiedWeChatPayRefund(
      verifiedRefundResult({
        suffix: paidTip.fixture.suffix,
        orderId: paidTip.order.id,
        providerTransactionId: paidTip.providerTransactionId,
        amountCents: paidTip.commercial.price.amountMinor,
      }),
    );
    const applied = await applyVerifiedWeChatPayRefund(persisted.refundId!);
    expect(applied).toMatchObject({
      reversalStatus: "applied",
      processingError: null,
    });

    const [currentRequest, allocation, contribution, cancellationLedger] =
      await Promise.all([
        prisma.withdrawRequest.findUniqueOrThrow({
          where: { id: request.id },
        }),
        prisma.withdrawalAllocation.findFirstOrThrow({
          where: { withdrawRequestId: request.id },
        }),
        prisma.tipContribution.findUniqueOrThrow({
          where: { id: paidTip.contribution.id },
          include: { creatorEarning: true },
        }),
        prisma.walletLedgerEntry.findMany({
          where: {
            withdrawRequestId: request.id,
            eventGroupId: {
              startsWith: `withdraw_transition:${request.id}:forced_tip_refund:`,
            },
          },
        }),
      ]);
    expect(currentRequest.status).toBe(WithdrawRequestStatus.CANCELED);
    expect(allocation).toMatchObject({
      releasedAt: expect.any(Date),
      paidAt: null,
    });
    expect(contribution).toMatchObject({
      status: TipContributionStatus.REFUNDED,
      creatorEarning: {
        status: CreatorEarningStatus.REVERSED,
        withdrawableCents: 0,
        frozenCents: 0,
        withdrawnCents: 0,
      },
    });
    expect(cancellationLedger).toHaveLength(2);
    expect(cancellationLedger.reduce((sum, row) => sum + row.amountCents, 0))
      .toBe(0);
  }, 30_000);

  it("atomically cancels a reversible mixed-earning withdrawal before refunding only the tip", async () => {
    const paidTip = await createPaidWeChatTip("tip-mixed-refund");
    await createVerifiedPayoutDestination(paidTip.fixture);
    const secondOrder = await createRechargeOrder(
      commercialRechargeInput(
        paidTip.fixture,
        paidTip.commercial,
        "tip-mixed-second",
      ),
      localWeChatAdapter,
    );
    const secondProviderTransactionId =
      `420${Date.now()}${randomUUID().replaceAll("-", "").slice(0, 13)}`;
    await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
      verifiedPaidEvent({
        orderId: secondOrder.id,
        amountCents: paidTip.commercial.price.amountMinor,
        providerEventId: `${paidTip.fixture.suffix}:tip-mixed-second-paid`,
        providerTransactionId: secondProviderTransactionId,
      }),
    );
    const secondContribution = await prisma.tipContribution.findUniqueOrThrow({
      where: { rechargeOrderId: secondOrder.id },
      include: { creatorEarning: true },
    });
    const request = await createWithdrawRequest({
      ownerId: paidTip.fixture.ownerId,
      representativeId: paidTip.fixture.representativeId,
      amountCents:
        paidTip.contribution.creatorAmountMinor
        + secondContribution.creatorAmountMinor,
      currency: "CNY",
      idempotencyKey: `${paidTip.fixture.suffix}:mixed-withdrawal`,
    });
    const persisted = await persistVerifiedWeChatPayRefund(
      verifiedRefundResult({
        suffix: paidTip.fixture.suffix,
        orderId: paidTip.order.id,
        providerTransactionId: paidTip.providerTransactionId,
        amountCents: paidTip.commercial.price.amountMinor,
      }),
    );
    const applied = await applyVerifiedWeChatPayRefund(persisted.refundId!);
    expect(applied).toMatchObject({
      reversalStatus: "applied",
      processingError: null,
    });

    const [currentRequest, allocations, contribution, currentOther] =
      await Promise.all([
        prisma.withdrawRequest.findUniqueOrThrow({ where: { id: request.id } }),
        prisma.withdrawalAllocation.findMany({
          where: { withdrawRequestId: request.id },
        }),
        prisma.tipContribution.findUniqueOrThrow({
          where: { id: paidTip.contribution.id },
          include: { creatorEarning: true },
        }),
        prisma.creatorEarning.findUniqueOrThrow({
          where: { id: secondContribution.creatorEarningId },
        }),
      ]);
    expect(currentRequest.status).toBe(WithdrawRequestStatus.CANCELED);
    expect(allocations).toHaveLength(2);
    expect(allocations.every(
      (allocation) => allocation.releasedAt !== null && allocation.paidAt === null,
    )).toBe(true);
    expect(contribution).toMatchObject({
      status: TipContributionStatus.REFUNDED,
      creatorEarning: {
        status: CreatorEarningStatus.REVERSED,
        withdrawableCents: 0,
        frozenCents: 0,
      },
    });
    expect(currentOther).toMatchObject({
      status: CreatorEarningStatus.WITHDRAWABLE,
      withdrawableCents: secondContribution.creatorAmountMinor,
      frozenCents: 0,
    });
    const [releaseLedger, tipReversalLedger] = await Promise.all([
      prisma.walletLedgerEntry.findMany({
        where: { withdrawRequestId: request.id },
      }),
      prisma.walletLedgerEntry.findMany({
        where: {
          eventGroupId: `tip_refund:${paidTip.contribution.id}:${persisted.refundId}`,
          accountType: {
            in: [
              AmnWalletAccountType.CREATOR_WITHDRAWABLE,
              AmnWalletAccountType.PLATFORM_EARNED_REVENUE,
            ],
          },
        },
      }),
    ]);
    expect(releaseLedger).toHaveLength(8);
    expect(releaseLedger.reduce((sum, row) => sum + row.amountCents, 0))
      .toBe(0);
    expect(tipReversalLedger).toHaveLength(2);
    expect(tipReversalLedger.every((row) => row.balanceAfterCents === null))
      .toBe(true);
  }, 30_000);

  it("never acknowledges a forced tip refund after creator proceeds were paid out", async () => {
    const paidTip = await createPaidWeChatTip("tip-withdrawn-refund");
    await createVerifiedPayoutDestination(paidTip.fixture);
    const request = await createWithdrawRequest({
      ownerId: paidTip.fixture.ownerId,
      representativeId: paidTip.fixture.representativeId,
      amountCents: paidTip.contribution.creatorAmountMinor,
      currency: "CNY",
      idempotencyKey: `${paidTip.fixture.suffix}:paid-withdrawal`,
    });
    await approveWithdrawRequest({
      ownerId: paidTip.fixture.ownerId,
      withdrawRequestId: request.id,
      reviewedBy: "postgres-commerce-test",
      idempotencyKey: `${paidTip.fixture.suffix}:approve-paid-withdrawal`,
    });
    await markWithdrawRequestPaid({
      ownerId: paidTip.fixture.ownerId,
      withdrawRequestId: request.id,
      provider: PaymentProvider.WECHAT_PAY,
      providerPayoutId: `${paidTip.fixture.suffix}:provider-payout`,
      idempotencyKey: `${paidTip.fixture.suffix}:mark-paid-withdrawal`,
    });

    const persisted = await persistVerifiedWeChatPayRefund(
      verifiedRefundResult({
        suffix: paidTip.fixture.suffix,
        orderId: paidTip.order.id,
        providerTransactionId: paidTip.providerTransactionId,
        amountCents: paidTip.commercial.price.amountMinor,
      }),
    );
    const quarantined = await applyVerifiedWeChatPayRefund(persisted.refundId!);
    expect(quarantined).toMatchObject({
      reversalStatus: "reconciliation_required",
      processingError:
        "wechat_refund_tip_creator_proceeds_already_withdrawn_manual_recovery_required",
    });

    const [currentRequest, contribution, currentOrder, reversalLedger] =
      await Promise.all([
        prisma.withdrawRequest.findUniqueOrThrow({ where: { id: request.id } }),
        prisma.tipContribution.findUniqueOrThrow({
          where: { id: paidTip.contribution.id },
          include: { creatorEarning: true },
        }),
        prisma.rechargeOrder.findUniqueOrThrow({
          where: { id: paidTip.order.id },
        }),
        prisma.walletLedgerEntry.findMany({
          where: {
            eventGroupId: {
              startsWith: `tip_refund:${paidTip.contribution.id}:`,
            },
          },
        }),
      ]);
    expect(currentRequest.status).toBe(WithdrawRequestStatus.PAID);
    expect(contribution).toMatchObject({
      status: TipContributionStatus.COMPLETED,
      creatorEarning: {
        status: CreatorEarningStatus.WITHDRAWN,
        withdrawableCents: 0,
        frozenCents: 0,
        withdrawnCents: paidTip.contribution.creatorAmountMinor,
      },
    });
    expect(currentOrder.status).toBe("PAID");
    expect(reversalLedger).toHaveLength(0);
  }, 30_000);

  it.each(["approved", "failed"] as const)(
    "quarantines an %s tip payout because provider submission may already be in flight",
    async (state) => {
      const paidTip = await createPaidWeChatTip(`tip-${state}-refund`);
      await createVerifiedPayoutDestination(paidTip.fixture);
      const request = await createWithdrawRequest({
        ownerId: paidTip.fixture.ownerId,
        representativeId: paidTip.fixture.representativeId,
        amountCents: paidTip.contribution.creatorAmountMinor,
        currency: "CNY",
        idempotencyKey: `${paidTip.fixture.suffix}:${state}-withdrawal`,
      });
      await approveWithdrawRequest({
        ownerId: paidTip.fixture.ownerId,
        withdrawRequestId: request.id,
        reviewedBy: "postgres-commerce-test",
        idempotencyKey: `${paidTip.fixture.suffix}:${state}-approve`,
      });
      if (state === "failed") {
        await markWithdrawRequestFailed({
          ownerId: paidTip.fixture.ownerId,
          withdrawRequestId: request.id,
          reason: "provider_result_unknown",
          permanent: false,
          idempotencyKey: `${paidTip.fixture.suffix}:transient-failure`,
        });
      }

      const persisted = await persistVerifiedWeChatPayRefund(
        verifiedRefundResult({
          suffix: paidTip.fixture.suffix,
          orderId: paidTip.order.id,
          providerTransactionId: paidTip.providerTransactionId,
          amountCents: paidTip.commercial.price.amountMinor,
        }),
      );
      const quarantined = await applyVerifiedWeChatPayRefund(
        persisted.refundId!,
      );
      expect(quarantined).toMatchObject({
        reversalStatus: "reconciliation_required",
        processingError:
          "wechat_refund_tip_creator_payout_status_unknown_manual_recovery_required",
      });

      const [currentRequest, allocation, contribution, order, reversalLedger] =
        await Promise.all([
          prisma.withdrawRequest.findUniqueOrThrow({ where: { id: request.id } }),
          prisma.withdrawalAllocation.findFirstOrThrow({
            where: { withdrawRequestId: request.id },
          }),
          prisma.tipContribution.findUniqueOrThrow({
            where: { id: paidTip.contribution.id },
            include: { creatorEarning: true },
          }),
          prisma.rechargeOrder.findUniqueOrThrow({
            where: { id: paidTip.order.id },
          }),
          prisma.walletLedgerEntry.findMany({
            where: {
              eventGroupId: {
                startsWith: `tip_refund:${paidTip.contribution.id}:`,
              },
            },
          }),
        ]);
      expect(currentRequest.status).toBe(
        state === "approved"
          ? WithdrawRequestStatus.APPROVED
          : WithdrawRequestStatus.FAILED,
      );
      expect(allocation).toMatchObject({ releasedAt: null, paidAt: null });
      expect(contribution).toMatchObject({
        status: TipContributionStatus.COMPLETED,
        creatorEarning: {
          status: CreatorEarningStatus.FROZEN,
          withdrawableCents: 0,
          frozenCents: paidTip.contribution.creatorAmountMinor,
          withdrawnCents: 0,
        },
      });
      expect(order.status).toBe("PAID");
      expect(reversalLedger).toHaveLength(0);
    },
    30_000,
  );

  it.each(["create", "approve", "pay"] as const)(
    "serializes a forced tip refund against concurrent withdrawal %s",
    async (phase) => {
      const paidTip = await createPaidWeChatTip(`tip-race-${phase}`);
      await createVerifiedPayoutDestination(paidTip.fixture);
      let requestId: string | null = null;
      if (phase !== "create") {
        const request = await createWithdrawRequest({
          ownerId: paidTip.fixture.ownerId,
          representativeId: paidTip.fixture.representativeId,
          amountCents: paidTip.contribution.creatorAmountMinor,
          currency: "CNY",
          idempotencyKey: `${paidTip.fixture.suffix}:race-request`,
        });
        requestId = request.id;
        if (phase === "pay") {
          await approveWithdrawRequest({
            ownerId: paidTip.fixture.ownerId,
            withdrawRequestId: request.id,
            reviewedBy: "postgres-commerce-test",
            idempotencyKey: `${paidTip.fixture.suffix}:race-preapprove`,
          });
        }
      }
      const refundResult = verifiedRefundResult({
        suffix: paidTip.fixture.suffix,
        orderId: paidTip.order.id,
        providerTransactionId: paidTip.providerTransactionId,
        amountCents: paidTip.commercial.price.amountMinor,
      });
      const withdrawalOperation = phase === "create"
        ? createWithdrawRequest({
            ownerId: paidTip.fixture.ownerId,
            representativeId: paidTip.fixture.representativeId,
            amountCents: paidTip.contribution.creatorAmountMinor,
            currency: "CNY",
            idempotencyKey: `${paidTip.fixture.suffix}:race-create`,
          })
        : phase === "approve"
          ? approveWithdrawRequest({
              ownerId: paidTip.fixture.ownerId,
              withdrawRequestId: requestId!,
              reviewedBy: "postgres-commerce-test",
              idempotencyKey: `${paidTip.fixture.suffix}:race-approve`,
            })
          : markWithdrawRequestPaid({
              ownerId: paidTip.fixture.ownerId,
              withdrawRequestId: requestId!,
              provider: PaymentProvider.WECHAT_PAY,
              providerPayoutId: `${paidTip.fixture.suffix}:race-payout`,
              idempotencyKey: `${paidTip.fixture.suffix}:race-pay`,
            });
      const [refundOutcome, withdrawalOutcome] = await Promise.allSettled([
        persistVerifiedWeChatPayRefund(refundResult),
        withdrawalOperation,
      ]);
      expect(refundOutcome.status).toBe("fulfilled");
      if (refundOutcome.status !== "fulfilled" || !refundOutcome.value.refundId) {
        throw new Error("Expected the forced refund fact to persist.");
      }
      if (phase === "create" && withdrawalOutcome.status === "fulfilled") {
        requestId = withdrawalOutcome.value.id;
      }

      const reversal = await applyVerifiedWeChatPayRefund(
        refundOutcome.value.refundId,
      );
      const [contribution, order, request] = await Promise.all([
        prisma.tipContribution.findUniqueOrThrow({
          where: { id: paidTip.contribution.id },
          include: { creatorEarning: true },
        }),
        prisma.rechargeOrder.findUniqueOrThrow({
          where: { id: paidTip.order.id },
        }),
        requestId
          ? prisma.withdrawRequest.findUnique({ where: { id: requestId } })
          : Promise.resolve(null),
      ]);
      const impossibleDoubleSettlement =
        reversal.reversalStatus === "applied"
        && (
          request?.status === WithdrawRequestStatus.PAID
          || contribution.creatorEarning.withdrawnCents > 0
        );
      expect(impossibleDoubleSettlement).toBe(false);
      if (reversal.reversalStatus === "applied") {
        expect(order.status).toBe("REFUNDED");
        expect(contribution).toMatchObject({
          status: TipContributionStatus.REFUNDED,
          creatorEarning: {
            status: CreatorEarningStatus.REVERSED,
            withdrawnCents: 0,
          },
        });
        expect(request?.status).not.toBe(WithdrawRequestStatus.PAID);
      } else {
        expect(["approve", "pay"]).toContain(phase);
        expect(reversal.reversalStatus).toBe("reconciliation_required");
        expect(order.status).toBe("PAID");
        if (request?.status === WithdrawRequestStatus.PAID) {
          expect(reversal.processingError).toBe(
            "wechat_refund_tip_creator_proceeds_already_withdrawn_manual_recovery_required",
          );
          expect(contribution.creatorEarning.status).toBe(
            CreatorEarningStatus.WITHDRAWN,
          );
        } else {
          expect(request?.status).toBe(WithdrawRequestStatus.APPROVED);
          expect(reversal.processingError).toBe(
            "wechat_refund_tip_creator_payout_status_unknown_manual_recovery_required",
          );
          expect(contribution.creatorEarning.status).toBe(
            CreatorEarningStatus.FROZEN,
          );
        }
      }
    },
    45_000,
  );

  it("conserves five cents across 100 credits for full consumption and an unused whole-order refund", async () => {
    const fixture = await createCommerceFixture("tiny-ratio");
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 5,
      entitlementUnits: 100,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    });
    const consumedOrder = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "tiny-consumed"),
    );
    const consumedCompletion =
      await completeMockRechargeAndPurchaseAgentTokens({
        rechargeOrderId: consumedOrder.id,
        externalUserId: fixture.externalUserId,
        representativeId: fixture.representativeId,
        amountCents: 5,
        providerEventId: `${fixture.suffix}:tiny-consumed-paid`,
        purchaseIdempotencyKey: `${fixture.suffix}:tiny-consumed-purchase`,
      });
    if (!consumedCompletion.tokenPurchase) {
      throw new Error("expected tiny service-credit purchase");
    }

    const settledSnapshots = [];
    for (const [index, units] of [1, 33, 66].entries()) {
      const generationRunId = await createGenerationRun(
        fixture,
        `tiny-consumption-${index + 1}`,
      );
      const reservation = await reserveConversationWalletUsage({
        externalUserId: fixture.externalUserId,
        audienceIdentityId: fixture.audienceIdentityId,
        representativeId: fixture.representativeId,
        conversationId: fixture.conversationId,
        generationRunId,
        tokenAmount: units,
        idempotencyKey: `${fixture.suffix}:tiny-reserve:${index + 1}`,
      });
      settledSnapshots.push(
        await settleConversationWalletUsage({
          usageChargeId: reservation.usageCharge.id,
          expectedGenerationRunId: generationRunId,
          settledTokenAmount: units,
          providerCostCents: 0,
          provider: "postgres-commerce-ratio",
          idempotencyKey: `${fixture.suffix}:tiny-settle:${index + 1}`,
        }),
      );
    }

    expect(
      settledSnapshots.map((snapshot) => ({
        tokens: snapshot.usageCharge.settledTokenAmount,
        gross: snapshot.usageCharge.tokenValueCents,
        creator: snapshot.usageCharge.creatorWithdrawableCents,
        platform: snapshot.usageCharge.platformRevenueCents,
      })),
    ).toEqual([
      { tokens: 1, gross: 0, creator: 0, platform: 0 },
      { tokens: 33, gross: 1, creator: 0, platform: 1 },
      { tokens: 66, gross: 4, creator: 1, platform: 3 },
    ]);
    const allocations = await prisma.agentUsageAllocation.findMany({
      where: { tokenPurchaseId: consumedCompletion.tokenPurchase.id },
    });
    expect(allocations.reduce((sum, row) => sum + row.tokenAmount, 0)).toBe(100);
    expect(allocations.reduce((sum, row) => sum + row.valueCents, 0)).toBe(5);
    expect(
      allocations.reduce((sum, row) => sum + row.creatorReleaseCents, 0),
    ).toBe(1);
    await expect(
      prisma.agentTokenPurchase.findUniqueOrThrow({
        where: { id: consumedCompletion.tokenPurchase.id },
        select: { remainingTokenAmount: true },
      }),
    ).resolves.toEqual({ remainingTokenAmount: 0 });

    const refundOrder = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "tiny-refund"),
    );
    const refundCompletion = await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: refundOrder.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: 5,
      providerEventId: `${fixture.suffix}:tiny-refund-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:tiny-refund-purchase`,
    });
    if (!refundCompletion.tokenPurchase) {
      throw new Error("expected refundable tiny service-credit purchase");
    }
    const reversed = await reverseAgentTokenPurchase(
      refundCompletion.tokenPurchase.id,
      {
        idempotencyKey: `${fixture.suffix}:tiny-full-reversal`,
        reason: "postgres_commerce_whole_unused_refund",
      },
    );
    expect(reversed).toMatchObject({
      tokenAmount: 100,
      remainingTokenAmount: 0,
      reversedAmountCents: 5,
      creatorReversedCents: 1,
      cashBalanceCents: 5,
    });
    const refunded = await refundRechargeOrder(refundOrder.id, {
      providerEventId: `${fixture.suffix}:tiny-refunded`,
      reason: "postgres_commerce_whole_unused_refund",
    });
    expect(refunded).toMatchObject({
      status: "refunded",
      amountCents: 5,
      cashBalanceCents: 0,
    });

    const [wallet, refundLedger, reversedPurchase] = await Promise.all([
      prisma.userWallet.findUniqueOrThrow({
        where: { externalUserId: fixture.externalUserId },
      }),
      prisma.walletLedgerEntry.findMany({
        where: { eventGroupId: `recharge_refund:${refundOrder.id}` },
      }),
      prisma.agentTokenPurchase.findUniqueOrThrow({
        where: { id: refundCompletion.tokenPurchase.id },
      }),
    ]);
    expect(wallet.cashBalanceCents).toBe(0);
    expect(refundLedger.map((entry) => entry.amountCents).sort((a, b) => a - b))
      .toEqual([-5, 5]);
    expect(refundLedger.reduce((sum, entry) => sum + entry.amountCents, 0))
      .toBe(0);
    expect(reversedPurchase).toMatchObject({
      status: "REVERSED",
      remainingTokenAmount: 0,
    });
  }, 45_000);

  it("moves an unused LIMITED grant only through a proof-gated identity merge", async () => {
    const fixture = await createCommerceFixture("identity-unused-grant");
    const targetAudienceIdentityId = await prepareIdentityMergeTarget(fixture);
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 11,
      entitlementUnits: 31,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: 1,
      handoffServiceLevel: BillingHandoffServiceLevel.PRIORITY,
      handoffValidityDays: 30,
    });
    const order = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "identity-unused-grant"),
    );
    await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: order.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: commercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:identity-unused-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:identity-unused-purchase`,
    });
    const grant = await prisma.handoffEntitlementGrant.findUniqueOrThrow({
      where: { rechargeOrderId: order.id },
    });

    await expect(
      prisma.handoffEntitlementGrant.update({
        where: { id: grant.id },
        data: { audienceIdentityId: targetAudienceIdentityId },
      }),
    ).rejects.toThrow(/merged source identity/i);
    await expect(
      mergeAudienceIdentity({
        sourceAudienceIdentityId: fixture.audienceIdentityId,
        targetAudienceIdentityId,
      }),
    ).rejects.toThrow(/financial conflict/i);

    await mergeAudienceIdentity({
      sourceAudienceIdentityId: fixture.audienceIdentityId,
      targetAudienceIdentityId,
      transferVerifiedProvisionalAssets: true,
    });
    await expect(prisma.handoffEntitlementGrant.count({
      where: { audienceIdentityId: fixture.audienceIdentityId },
    })).resolves.toBe(0);
    await expect(prisma.handoffEntitlementGrant.count({
      where: { audienceIdentityId: targetAudienceIdentityId },
    })).resolves.toBe(1);

    const scope = await loadHandoffScope(fixture.conversationId);
    const created = await prisma.$transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(
        handoffDraft(fixture, scope, "identity-unused-target-reserve"),
        tx,
      )
    );
    expect(created).toMatchObject({ outcome: "created", access: "package" });
    if (!created.request) throw new Error("expected target handoff request");
    await prisma.$transaction((tx) =>
      acceptHandoffRequestInTransaction({
        handoffRequestId: created.request!.id,
      }, tx)
    );
    await expect(prisma.handoffEntitlementGrant.findUniqueOrThrow({
      where: { id: grant.id },
      select: {
        audienceIdentityId: true,
        remainingUses: true,
        reservedUses: true,
        consumedUses: true,
        status: true,
      },
    })).resolves.toEqual({
      audienceIdentityId: targetAudienceIdentityId,
      remainingUses: 0,
      reservedUses: 0,
      consumedUses: 1,
      status: HandoffEntitlementGrantStatus.EXHAUSTED,
    });
  }, 30_000);

  it("keeps a RESERVED paid handoff operable after identity merge", async () => {
    const fixture = await createCommerceFixture("identity-reserved-request");
    const targetAudienceIdentityId = await prepareIdentityMergeTarget(fixture);
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 15,
      entitlementUnits: 41,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: 2,
      handoffServiceLevel: BillingHandoffServiceLevel.STANDARD,
      handoffValidityDays: 30,
    });
    const order = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "identity-reserved-request"),
    );
    await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: order.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: commercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:identity-reserved-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:identity-reserved-purchase`,
    });
    const scope = await loadHandoffScope(fixture.conversationId);
    const reserved = await prisma.$transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(
        handoffDraft(fixture, scope, "identity-source-reserve"),
        tx,
      )
    );
    if (!reserved.request) throw new Error("expected source reserved request");

    await expect(
      prisma.handoffRequest.update({
        where: { id: reserved.request.id },
        data: { audienceIdentityId: targetAudienceIdentityId },
      }),
    ).rejects.toThrow(/merged source identity/i);
    await mergeAudienceIdentity({
      sourceAudienceIdentityId: fixture.audienceIdentityId,
      targetAudienceIdentityId,
      transferVerifiedProvisionalAssets: true,
    });
    await prisma.$transaction((tx) =>
      resolveHandoffRequestInTransaction({
        handoffRequestId: reserved.request!.id,
        status: HandoffStatus.DECLINED,
        reason: "identity_merge_release_probe",
      }, tx)
    );

    const next = await prisma.$transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(
        handoffDraft(fixture, scope, "identity-target-consume"),
        tx,
      )
    );
    if (!next.request) throw new Error("expected target reserved request");
    await prisma.$transaction((tx) =>
      acceptHandoffRequestInTransaction({ handoffRequestId: next.request!.id }, tx)
    );
    const requests = await prisma.handoffRequest.findMany({
      where: { id: { in: [reserved.request.id, next.request.id] } },
      orderBy: { createdAt: "asc" },
    });
    expect(requests.map((request) => ({
      audienceIdentityId: request.audienceIdentityId,
      state: request.entitlementReservationState,
      status: request.status,
    }))).toEqual([
      {
        audienceIdentityId: targetAudienceIdentityId,
        state: "RELEASED",
        status: HandoffStatus.DECLINED,
      },
      {
        audienceIdentityId: targetAudienceIdentityId,
        state: "CONSUMED",
        status: HandoffStatus.ACCEPTED,
      },
    ]);
  }, 30_000);

  it("rolls back identity merge when target has an active handoff for the same representative", async () => {
    const fixture = await createCommerceFixture("identity-handoff-conflict");
    const targetAudienceIdentityId = await prepareIdentityMergeTarget(fixture);
    const sourceScope = await loadHandoffScope(fixture.conversationId);
    const targetScope = await createTargetConversation(
      fixture,
      targetAudienceIdentityId,
      "active-conflict",
    );
    const [sourceRequest, targetRequest] = await Promise.all([
      prisma.handoffRequest.create({
        data: directFreeHandoffData(fixture, sourceScope, "source-active"),
      }),
      prisma.handoffRequest.create({
        data: directFreeHandoffData(fixture, targetScope, "target-active"),
      }),
    ]);

    await expect(
      mergeAudienceIdentity({
        sourceAudienceIdentityId: fixture.audienceIdentityId,
        targetAudienceIdentityId,
      }),
    ).rejects.toThrow(/handoff conflict/i);
    await expect(prisma.audienceIdentity.findUniqueOrThrow({
      where: { id: fixture.audienceIdentityId },
      select: { status: true, mergedIntoId: true },
    })).resolves.toEqual({
      status: AudienceIdentityStatus.ANONYMOUS,
      mergedIntoId: null,
    });
    const unchangedRequests = await prisma.handoffRequest.findMany({
      where: { id: { in: [sourceRequest.id, targetRequest.id] } },
      select: { audienceIdentityId: true },
    });
    expect(new Set(unchangedRequests.map((row) => row.audienceIdentityId)))
      .toEqual(new Set([
        fixture.audienceIdentityId,
        targetAudienceIdentityId,
      ]));
  }, 30_000);

  it("proof-gates a TIP-only merge without changing its earning or amounts", async () => {
    const fixture = await createCommerceFixture("identity-tip-only");
    const targetAudienceIdentityId = await prepareIdentityMergeTarget(fixture);
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.TIP,
      amountMinor: 23,
      entitlementUnits: 0,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    });
    const order = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "identity-tip-only"),
    );
    await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: order.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: commercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:identity-tip-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:identity-tip-purchase`,
    });
    const before = await prisma.tipContribution.findUniqueOrThrow({
      where: { rechargeOrderId: order.id },
      include: { creatorEarning: true },
    });

    await expect(
      prisma.tipContribution.update({
        where: { id: before.id },
        data: { audienceIdentityId: targetAudienceIdentityId },
      }),
    ).rejects.toThrow(/merged source identity/i);
    await expect(
      mergeAudienceIdentity({
        sourceAudienceIdentityId: fixture.audienceIdentityId,
        targetAudienceIdentityId,
      }),
    ).rejects.toThrow(/financial conflict/i);
    await mergeAudienceIdentity({
      sourceAudienceIdentityId: fixture.audienceIdentityId,
      targetAudienceIdentityId,
      transferVerifiedProvisionalAssets: true,
    });

    const after = await prisma.tipContribution.findUniqueOrThrow({
      where: { id: before.id },
      include: { creatorEarning: true },
    });
    expect(after).toMatchObject({
      audienceIdentityId: targetAudienceIdentityId,
      amountMinor: before.amountMinor,
      creatorAmountMinor: before.creatorAmountMinor,
      platformAmountMinor: before.platformAmountMinor,
      creatorEarningId: before.creatorEarningId,
      creatorEarning: {
        id: before.creatorEarning.id,
        status: before.creatorEarning.status,
        pendingCents: before.creatorEarning.pendingCents,
        withdrawableCents: before.creatorEarning.withdrawableCents,
        frozenCents: before.creatorEarning.frozenCents,
        withdrawnCents: before.creatorEarning.withdrawnCents,
      },
    });
    await expect(prisma.tipContribution.count({
      where: { audienceIdentityId: fixture.audienceIdentityId },
    })).resolves.toBe(0);
  }, 30_000);

  it("rekeys frozen and terminal tip receipts without rewriting earning state", async () => {
    const frozenFixture = await createCommerceFixture("identity-tip-frozen");
    const frozenTarget = await prepareIdentityMergeTarget(frozenFixture);
    const frozenCommercial = await createCommercialProduct(frozenFixture, {
      kind: BillingProductKind.TIP,
      amountMinor: 29,
      entitlementUnits: 0,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    });
    const frozenOrder = await createMockRechargeOrder(
      commercialRechargeInput(
        frozenFixture,
        frozenCommercial,
        "identity-tip-frozen",
      ),
    );
    await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: frozenOrder.id,
      externalUserId: frozenFixture.externalUserId,
      representativeId: frozenFixture.representativeId,
      amountCents: frozenCommercial.price.amountMinor,
      providerEventId: `${frozenFixture.suffix}:tip-frozen-paid`,
      purchaseIdempotencyKey: `${frozenFixture.suffix}:tip-frozen-purchase`,
    });
    const frozenTip = await prisma.tipContribution.findUniqueOrThrow({
      where: { rechargeOrderId: frozenOrder.id },
    });
    await prisma.creatorEarning.update({
      where: { id: frozenTip.creatorEarningId },
      data: {
        status: CreatorEarningStatus.FROZEN,
        withdrawableCents: 0,
        frozenCents: frozenTip.creatorAmountMinor,
      },
    });
    await mergeAudienceIdentity({
      sourceAudienceIdentityId: frozenFixture.audienceIdentityId,
      targetAudienceIdentityId: frozenTarget,
      transferVerifiedProvisionalAssets: true,
    });
    await expect(prisma.tipContribution.findUniqueOrThrow({
      where: { id: frozenTip.id },
      include: { creatorEarning: true },
    })).resolves.toMatchObject({
      audienceIdentityId: frozenTarget,
      creatorEarning: {
        status: CreatorEarningStatus.FROZEN,
        pendingCents: 0,
        withdrawableCents: 0,
        frozenCents: frozenTip.creatorAmountMinor,
        withdrawnCents: 0,
      },
    });

    const terminal = await createPaidWeChatTip("identity-tip-terminal");
    const persisted = await persistVerifiedWeChatPayRefund(
      verifiedRefundResult({
        suffix: terminal.fixture.suffix,
        orderId: terminal.order.id,
        providerTransactionId: terminal.providerTransactionId,
        amountCents: terminal.commercial.price.amountMinor,
      }),
    );
    await applyVerifiedWeChatPayRefund(persisted.refundId!);
    const terminalTarget = await prepareIdentityMergeTarget(terminal.fixture);
    const beforeTerminal = await prisma.tipContribution.findUniqueOrThrow({
      where: { id: terminal.contribution.id },
      include: { creatorEarning: true },
    });
    expect(beforeTerminal).toMatchObject({
      status: TipContributionStatus.REFUNDED,
      creatorEarning: { status: CreatorEarningStatus.REVERSED },
    });
    await mergeAudienceIdentity({
      sourceAudienceIdentityId: terminal.fixture.audienceIdentityId,
      targetAudienceIdentityId: terminalTarget,
      transferVerifiedProvisionalAssets: true,
    });
    await expect(prisma.tipContribution.findUniqueOrThrow({
      where: { id: terminal.contribution.id },
      include: { creatorEarning: true },
    })).resolves.toMatchObject({
      audienceIdentityId: terminalTarget,
      amountMinor: beforeTerminal.amountMinor,
      creatorAmountMinor: beforeTerminal.creatorAmountMinor,
      platformAmountMinor: beforeTerminal.platformAmountMinor,
      creatorEarning: {
        id: beforeTerminal.creatorEarning.id,
        status: CreatorEarningStatus.REVERSED,
        pendingCents: 0,
        withdrawableCents: 0,
        frozenCents: 0,
        withdrawnCents: 0,
      },
    });
  }, 45_000);

  it("bridges only the previous plain-package writer and rejects incomplete new products", async () => {
    const fixture = await createCommerceFixture("rolling-writer-bridge");
    const plain = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 9,
      entitlementUnits: 27,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    });
    const bridged = await createLegacyShapeRechargeOrder(
      fixture,
      plain,
      "plain",
    );
    expect(bridged).toMatchObject({
      productKindSnapshot: BillingProductKind.SERVICE_PACKAGE,
      handoffAllowanceSnapshot: BillingHandoffAllowance.NONE,
      handoffUnitsSnapshot: null,
      handoffServiceLevelSnapshot: null,
      handoffValidityDaysSnapshot: null,
    });
    await expect(createLegacyShapeRechargeOrder(
      fixture,
      plain,
      "partial",
      { productKindSnapshot: BillingProductKind.SERVICE_PACKAGE },
    )).rejects.toThrow(/commercial snapshot/i);

    const tip = await createCommercialProduct(fixture, {
      kind: BillingProductKind.TIP,
      amountMinor: 7,
      entitlementUnits: 0,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    });
    await expect(
      createLegacyShapeRechargeOrder(fixture, tip, "tip"),
    ).rejects.toThrow(/commercial snapshot/i);

    const paidHandoff = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 12,
      entitlementUnits: 40,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: 2,
      handoffServiceLevel: BillingHandoffServiceLevel.PRIORITY,
      handoffValidityDays: 45,
    });
    await expect(
      createLegacyShapeRechargeOrder(fixture, paidHandoff, "paid-handoff"),
    ).rejects.toThrow(/commercial snapshot/i);
  }, 30_000);

  it("canonicalizes old handoff inserts before enforcing audience uniqueness", async () => {
    const fixture = await createCommerceFixture("old-handoff-writer");
    const scope = await loadHandoffScope(fixture.conversationId);
    const first = await prisma.handoffRequest.create({
      data: directLegacyFreeHandoffData(fixture, scope, "old-writer-first"),
    });
    expect(first.audienceIdentityId).toBe(fixture.audienceIdentityId);

    const secondScope = await createTargetConversation(
      fixture,
      fixture.audienceIdentityId,
      "old-writer-second-contact",
    );
    await expect(prisma.handoffRequest.create({
      data: directLegacyFreeHandoffData(
        fixture,
        secondScope,
        "old-writer-second",
      ),
    })).rejects.toThrow();
    await expect(prisma.handoffRequest.count({
      where: {
        representativeId: fixture.representativeId,
        audienceIdentityId: fixture.audienceIdentityId,
        status: { in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING, HandoffStatus.ACCEPTED] },
      },
    })).resolves.toBe(1);
  }, 30_000);

  it("deterministically closes and audits legacy duplicate active handoffs", async () => {
    const fixture = await createCommerceFixture("migration-handoff-dedupe");
    const scope = await loadHandoffScope(fixture.conversationId);
    const statements = loadCommerceHandoffDedupeStatements();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'DROP INDEX "HandoffRequest_one_active_per_audience_key"',
      );
      await tx.$executeRawUnsafe(
        'DROP INDEX "HandoffRequest_one_active_per_contact_key"',
      );
      const open = await tx.handoffRequest.create({
        data: directFreeHandoffData(fixture, scope, "migration-open-loser"),
      });
      const accepted = await tx.handoffRequest.create({
        data: {
          ...directFreeHandoffData(fixture, scope, "migration-accepted-keeper"),
          status: HandoffStatus.ACCEPTED,
        },
      });
      for (const statement of statements) {
        await tx.$executeRawUnsafe(statement);
      }
      const [rows, audit] = await Promise.all([
        tx.handoffRequest.findMany({
          where: { id: { in: [open.id, accepted.id] } },
          select: { id: true, status: true },
        }),
        tx.eventAudit.findUnique({
          where: { id: `commerce-handoff-dedupe:${open.id}` },
        }),
      ]);
      expect(rows).toEqual(expect.arrayContaining([
        { id: accepted.id, status: HandoffStatus.ACCEPTED },
        { id: open.id, status: HandoffStatus.CLOSED },
      ]));
      expect(audit).toMatchObject({
        ownerId: fixture.ownerId,
        representativeId: fixture.representativeId,
        idempotencyKey: `commerce-handoff-dedupe:${open.id}`,
        type: "REPRESENTATIVE_COMMERCE_UPDATED",
        payload: expect.objectContaining({
          handoffRequestId: open.id,
          keeperHandoffRequestId: accepted.id,
          originalStatus: HandoffStatus.OPEN,
          reason: "migration_duplicate_active_handoff_closed",
        }),
      });
      throw new ExpectedMigrationRollback();
    })).rejects.toBeInstanceOf(ExpectedMigrationRollback);
  }, 30_000);

  it("converges identity merge racing a paid handoff reservation", async () => {
    const fixture = await createCommerceFixture("identity-reserve-race");
    const targetAudienceIdentityId = await prepareIdentityMergeTarget(fixture);
    const commercial = await createCommercialProduct(fixture, {
      kind: BillingProductKind.SERVICE_PACKAGE,
      amountMinor: 14,
      entitlementUnits: 35,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: 1,
      handoffServiceLevel: BillingHandoffServiceLevel.PRIORITY,
      handoffValidityDays: 30,
    });
    const order = await createMockRechargeOrder(
      commercialRechargeInput(fixture, commercial, "identity-reserve-race"),
    );
    await completeMockRechargeAndPurchaseAgentTokens({
      rechargeOrderId: order.id,
      externalUserId: fixture.externalUserId,
      representativeId: fixture.representativeId,
      amountCents: commercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:identity-race-paid`,
      purchaseIdempotencyKey: `${fixture.suffix}:identity-race-purchase`,
    });
    const scope = await loadHandoffScope(fixture.conversationId);
    const mergeInput = {
      sourceAudienceIdentityId: fixture.audienceIdentityId,
      targetAudienceIdentityId,
      transferVerifiedProvisionalAssets: true,
    } as const;
    const reserve = () => prisma.$transaction((tx) =>
      createOrReuseHandoffRequestInTransaction(
        handoffDraft(fixture, scope, "identity-reserve-race"),
        tx,
      )
    );
    const [mergeResult, reserveResult] = await Promise.allSettled([
      mergeAudienceIdentity(mergeInput),
      reserve(),
    ]);
    if (mergeResult.status === "rejected") {
      await mergeAudienceIdentity(mergeInput);
    }
    if (reserveResult.status === "rejected") {
      await reserve();
    }

    const [grant, sourceGrantCount, sourceRequestCount, targetRequests] =
      await Promise.all([
        prisma.handoffEntitlementGrant.findUniqueOrThrow({
          where: { rechargeOrderId: order.id },
        }),
        prisma.handoffEntitlementGrant.count({
          where: { audienceIdentityId: fixture.audienceIdentityId },
        }),
        prisma.handoffRequest.count({
          where: { audienceIdentityId: fixture.audienceIdentityId },
        }),
        prisma.handoffRequest.findMany({
          where: {
            audienceIdentityId: targetAudienceIdentityId,
            representativeId: fixture.representativeId,
            status: { in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING] },
          },
        }),
      ]);
    expect(sourceGrantCount).toBe(0);
    expect(sourceRequestCount).toBe(0);
    expect(targetRequests).toHaveLength(1);
    expect(grant).toMatchObject({
      audienceIdentityId: targetAudienceIdentityId,
      remainingUses: 0,
      reservedUses: 1,
      consumedUses: 0,
      status: HandoffEntitlementGrantStatus.ACTIVE,
    });
  }, 30_000);
});

type CommerceFixture = {
  suffix: string;
  ownerId: string;
  representativeId: string;
  audienceIdentityId: string;
  conversationId: string;
  externalUserId: string;
};

type CommercialProduct = {
  product: {
    id: string;
    name: string;
    kind: BillingProductKind;
  };
  price: {
    id: string;
    amountMinor: number;
    entitlementUnits: number;
    creatorRevenueShareBps: number;
    platformRevenueShareBps: number;
    refundPolicy: BillingRefundPolicy;
    expiryPolicy: BillingEntitlementExpiryPolicy;
    entitlementValidityDays: null;
    handoffAllowance: BillingHandoffAllowance;
    handoffUnits: number | null;
    handoffServiceLevel: BillingHandoffServiceLevel | null;
    handoffValidityDays: number | null;
  };
};

type HandoffScope = {
  contactId: string;
  conversationId: string;
  audienceIdentityId: string;
};

async function prepareIdentityMergeTarget(
  fixture: CommerceFixture,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.audienceIdentity.update({
      where: { id: fixture.audienceIdentityId },
      data: {
        status: AudienceIdentityStatus.ANONYMOUS,
        mergedIntoId: null,
      },
    });
    const target = await tx.audienceIdentity.create({
      data: {
        audienceKey: `${fixture.suffix}:registered-target`,
        status: AudienceIdentityStatus.REGISTERED,
      },
    });
    return target.id;
  });
}

async function loadHandoffScope(conversationId: string): Promise<HandoffScope> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { id: true, contactId: true, audienceIdentityId: true },
  });
  if (!conversation.audienceIdentityId) {
    throw new Error("expected canonical handoff audience");
  }
  return {
    contactId: conversation.contactId,
    conversationId: conversation.id,
    audienceIdentityId: conversation.audienceIdentityId,
  };
}

async function createTargetConversation(
  fixture: CommerceFixture,
  audienceIdentityId: string,
  label: string,
): Promise<HandoffScope> {
  return prisma.$transaction(async (tx) => {
    const externalUserId = `${fixture.suffix}:${label}:target`;
    const contact = await tx.contact.create({
      data: {
        representativeId: fixture.representativeId,
        audienceIdentityId,
        externalUserId,
        channelUserId: externalUserId,
        displayName: "Identity merge target",
        sourceChannel: "web",
      },
    });
    const conversation = await tx.conversation.create({
      data: {
        representativeId: fixture.representativeId,
        contactId: contact.id,
        audienceIdentityId,
        channel: Channel.PRIVATE_CHAT,
        sourceChannel: "web",
        externalConversationId: `${fixture.suffix}:${label}:conversation`,
      },
    });
    return {
      contactId: contact.id,
      conversationId: conversation.id,
      audienceIdentityId,
    };
  });
}

function handoffDraft(
  fixture: CommerceFixture,
  scope: HandoffScope,
  label: string,
) {
  return {
    representativeId: fixture.representativeId,
    contactId: scope.contactId,
    conversationId: scope.conversationId,
    reason: label,
    summary: `PostgreSQL ${label}`,
    recommendedPriority: 50,
    recommendedOwnerAction: "Review the paid handoff.",
  };
}

function directFreeHandoffData(
  fixture: CommerceFixture,
  scope: HandoffScope,
  label: string,
) {
  return {
    representativeId: fixture.representativeId,
    contactId: scope.contactId,
    audienceIdentityId: scope.audienceIdentityId,
    conversationId: scope.conversationId,
    reason: label,
    summary: `PostgreSQL ${label}`,
    recommendedPriority: 10,
    recommendedOwnerAction: "Review the handoff.",
    status: HandoffStatus.OPEN,
  };
}

function directLegacyFreeHandoffData(
  fixture: CommerceFixture,
  scope: HandoffScope,
  label: string,
) {
  const {
    audienceIdentityId: _audienceIdentityId,
    ...legacyData
  } = directFreeHandoffData(fixture, scope, label);
  return legacyData;
}

type LegacyNewSnapshotOverrides = {
  productKindSnapshot?: BillingProductKind;
  handoffAllowanceSnapshot?: BillingHandoffAllowance;
  handoffUnitsSnapshot?: number | null;
  handoffServiceLevelSnapshot?: BillingHandoffServiceLevel | null;
  handoffValidityDaysSnapshot?: number | null;
};

async function createLegacyShapeRechargeOrder(
  fixture: CommerceFixture,
  commercial: CommercialProduct,
  label: string,
  overrides: LegacyNewSnapshotOverrides = {},
) {
  const wallet = await prisma.userWallet.create({
    data: {
      audienceIdentityId: fixture.audienceIdentityId,
      externalUserId: `${fixture.suffix}:legacy-writer:${label}:${randomUUID()}`,
    },
  });
  const isTip = commercial.product.kind === BillingProductKind.TIP;
  return prisma.rechargeOrder.create({
    data: {
      userWalletId: wallet.id,
      representativeId: fixture.representativeId,
      productCode: isTip
        ? AGENT_WALLET_TIP_PRODUCT_CODE
        : AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      billingProductId: commercial.product.id,
      billingPriceVersionId: commercial.price.id,
      productNameSnapshot: commercial.product.name,
      unitNameSnapshot: isTip ? "tip" : "credit",
      entitlementUnitsSnapshot: commercial.price.entitlementUnits,
      creatorRevenueShareBpsSnapshot:
        commercial.price.creatorRevenueShareBps,
      platformRevenueShareBpsSnapshot:
        commercial.price.platformRevenueShareBps,
      refundPolicySnapshot: commercial.price.refundPolicy,
      expiryPolicySnapshot: commercial.price.expiryPolicy,
      entitlementValidityDaysSnapshot:
        commercial.price.entitlementValidityDays,
      provider: PaymentProvider.MOCK,
      amountCents: commercial.price.amountMinor,
      currency: "CNY",
      idempotencyKey: `${fixture.suffix}:legacy-writer:${label}:order`,
      ...overrides,
    },
  });
}

class ExpectedMigrationRollback extends Error {}

function loadCommerceHandoffDedupeStatements(): string[] {
  const migrationSql = readFileSync(
    new URL(
      "../../../prisma/migrations/20260811103000_representative_commerce_entitlements/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const start = migrationSql.indexOf(
    'CREATE TEMPORARY TABLE "commerce_handoff_duplicate_losers"',
  );
  const insert = migrationSql.indexOf('INSERT INTO "EventAudit"', start);
  const update = migrationSql.indexOf('UPDATE "HandoffRequest" AS "handoff"', insert);
  const assertion = migrationSql.indexOf("DO $$", update);
  const end = migrationSql.indexOf(
    'CREATE UNIQUE INDEX "HandoffRequest_one_active_per_audience_key"',
    assertion,
  );
  if ([start, insert, update, assertion, end].some((offset) => offset < 0)) {
    throw new Error("Could not locate commerce handoff dedupe migration block.");
  }
  return [
    migrationSql.slice(start, insert),
    migrationSql.slice(insert, update),
    migrationSql.slice(update, assertion),
    migrationSql.slice(assertion, end),
  ].map((statement) => statement.trim()).filter(Boolean);
}

async function createPaidWeChatTip(label: string) {
  const fixture = await createCommerceFixture(label);
  const commercial = await createCommercialProduct(fixture, {
    kind: BillingProductKind.TIP,
    amountMinor: 13,
    entitlementUnits: 0,
    handoffAllowance: BillingHandoffAllowance.NONE,
    handoffUnits: null,
    handoffServiceLevel: null,
    handoffValidityDays: null,
  });
  const order = await createRechargeOrder(
    commercialRechargeInput(fixture, commercial, label),
    localWeChatAdapter,
  );
  const providerTransactionId =
    `420${Date.now()}${randomUUID().replaceAll("-", "").slice(0, 13)}`;
  await completeRechargeAndPurchaseAgentTokensFromVerifiedProviderEvent(
    verifiedPaidEvent({
      orderId: order.id,
      amountCents: commercial.price.amountMinor,
      providerEventId: `${fixture.suffix}:tip-wechat-paid`,
      providerTransactionId,
    }),
  );
  const contribution = await prisma.tipContribution.findUniqueOrThrow({
    where: { rechargeOrderId: order.id },
    include: { creatorEarning: true },
  });
  return {
    fixture,
    commercial,
    order,
    providerTransactionId,
    contribution,
  };
}

async function createCommerceFixture(label: string): Promise<CommerceFixture> {
  const suffix = `postgres-commerce-${label}-${Date.now()}-${randomUUID()}`;
  const externalUserId = `${suffix}:user`;
  return prisma.$transaction(async (tx) => {
    const owner = await tx.owner.create({
      data: {
        displayName: `Commerce ${label}`,
        creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      },
    });
    const representative = await tx.representative.create({
      data: {
        ownerId: owner.id,
        slug: suffix,
        displayName: `Commerce ${label}`,
        roleSummary: "PostgreSQL representative commerce closure fixture.",
        tone: "neutral",
        languages: ["zh"],
        freeScope: {},
        paywalledIntents: [],
        handoffPrompt: "Escalate to the owner.",
        allowedSkills: [],
        actionGate: {},
        claimStatus: RepresentativeClaimStatus.CLAIMED,
        handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
        tipsEnabled: true,
      },
    });
    const audience = await tx.audienceIdentity.create({
      data: {
        audienceKey: `${suffix}:audience`,
        status: AudienceIdentityStatus.REGISTERED,
      },
    });
    const contact = await tx.contact.create({
      data: {
        representativeId: representative.id,
        audienceIdentityId: audience.id,
        externalUserId,
        channelUserId: externalUserId,
        displayName: "Commerce PostgreSQL audience",
        sourceChannel: "web",
      },
    });
    const conversation = await tx.conversation.create({
      data: {
        representativeId: representative.id,
        contactId: contact.id,
        audienceIdentityId: audience.id,
        channel: Channel.PRIVATE_CHAT,
        sourceChannel: "web",
        externalConversationId: `${suffix}:conversation`,
      },
    });
    await tx.agentWallet.create({
      data: {
        representativeId: representative.id,
        currency: "CNY",
        tokenUnitPriceCents: 10,
        creatorRevenueShareBps: 3_333,
      },
    });
    return {
      suffix,
      ownerId: owner.id,
      representativeId: representative.id,
      audienceIdentityId: audience.id,
      conversationId: conversation.id,
      externalUserId,
    };
  });
}

async function createCommercialProduct(
  fixture: CommerceFixture,
  input: {
    kind: BillingProductKind;
    amountMinor: number;
    entitlementUnits: number;
    handoffAllowance: BillingHandoffAllowance;
    handoffUnits: number | null;
    handoffServiceLevel: BillingHandoffServiceLevel | null;
    handoffValidityDays: number | null;
  },
): Promise<CommercialProduct> {
  const label = `${input.kind.toLowerCase()}-${randomUUID()}`;
  const refundPolicy = input.kind === BillingProductKind.TIP
    ? BillingRefundPolicy.NON_REFUNDABLE
    : BillingRefundPolicy.FULL_WHEN_UNUSED;
  const product = await prisma.billingProduct.create({
    data: {
      representativeId: fixture.representativeId,
      code: label,
      name: input.kind === BillingProductKind.TIP
        ? "PostgreSQL tip"
        : "PostgreSQL service package",
      kind: input.kind,
      status: BillingProductStatus.ACTIVE,
    },
  });
  const price = await prisma.billingPriceVersion.create({
    data: {
      billingProductId: product.id,
      version: 1,
      status: BillingPriceVersionStatus.ACTIVE,
      currency: "CNY",
      amountMinor: input.amountMinor,
      unitName: input.kind === BillingProductKind.TIP ? "tip" : "credit",
      entitlementUnits: input.entitlementUnits,
      creatorRevenueShareBps: 3_333,
      platformRevenueShareBps: 6_667,
      refundPolicy,
      expiryPolicy: BillingEntitlementExpiryPolicy.NEVER_EXPIRES,
      entitlementValidityDays: null,
      handoffAllowance: input.handoffAllowance,
      handoffUnits: input.handoffUnits,
      handoffServiceLevel: input.handoffServiceLevel,
      handoffValidityDays: input.handoffValidityDays,
      publishedAt: new Date(),
    },
  });
  return {
    product: {
      id: product.id,
      name: product.name,
      kind: product.kind,
    },
    price: {
      id: price.id,
      amountMinor: price.amountMinor,
      entitlementUnits: price.entitlementUnits,
      creatorRevenueShareBps: price.creatorRevenueShareBps,
      platformRevenueShareBps: price.platformRevenueShareBps,
      refundPolicy: price.refundPolicy,
      expiryPolicy: price.expiryPolicy,
      entitlementValidityDays: null,
      handoffAllowance: price.handoffAllowance,
      handoffUnits: price.handoffUnits,
      handoffServiceLevel: price.handoffServiceLevel,
      handoffValidityDays: price.handoffValidityDays,
    },
  };
}

function commercialRechargeInput(
  fixture: CommerceFixture,
  commercial: CommercialProduct,
  label: string,
) {
  const isTip = commercial.product.kind === BillingProductKind.TIP;
  return {
    externalUserId: fixture.externalUserId,
    audienceIdentityId: fixture.audienceIdentityId,
    representativeId: fixture.representativeId,
    productCode: isTip
      ? AGENT_WALLET_TIP_PRODUCT_CODE
      : AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
    billingProductId: commercial.product.id,
    billingPriceVersionId: commercial.price.id,
    productNameSnapshot: commercial.product.name,
    productKindSnapshot: commercial.product.kind,
    unitNameSnapshot: isTip ? "tip" as const : "credit" as const,
    entitlementUnitsSnapshot: commercial.price.entitlementUnits,
    handoffAllowanceSnapshot: commercial.price.handoffAllowance,
    handoffUnitsSnapshot: commercial.price.handoffUnits,
    handoffServiceLevelSnapshot: commercial.price.handoffServiceLevel,
    handoffValidityDaysSnapshot: commercial.price.handoffValidityDays,
    creatorRevenueShareBpsSnapshot:
      commercial.price.creatorRevenueShareBps,
    platformRevenueShareBpsSnapshot:
      commercial.price.platformRevenueShareBps,
    refundPolicySnapshot: commercial.price.refundPolicy,
    expiryPolicySnapshot: commercial.price.expiryPolicy,
    entitlementValidityDaysSnapshot:
      commercial.price.entitlementValidityDays,
    amountCents: commercial.price.amountMinor,
    currency: "CNY",
    idempotencyKey: `${fixture.suffix}:${label}:order`,
  };
}

async function createSyntheticRefund(input: {
  fixture: CommerceFixture;
  rechargeOrderId: string;
  amountCents: number;
  label: string;
  submissionStatus: RechargeRefundSubmissionStatus;
  providerStatus: RechargeRefundProviderStatus;
  reversalStatus: RechargeRefundReversalStatus;
}) {
  return prisma.rechargeRefund.create({
    data: {
      rechargeOrderId: input.rechargeOrderId,
      requestedByOwnerId: input.fixture.ownerId,
      provider: PaymentProvider.MOCK,
      providerRefundOrderId:
        `${input.fixture.suffix}:${input.label}:refund-order`,
      providerRefundId:
        `${input.fixture.suffix}:${input.label}:refund-id`,
      paymentTransactionId:
        `${input.fixture.suffix}:${input.label}:payment-transaction`,
      originalAmountCents: input.amountCents,
      refundAmountCents: input.amountCents,
      payerOriginalAmountCents: input.amountCents,
      payerRefundAmountCents: input.amountCents,
      currency: "CNY",
      submissionStatus: input.submissionStatus,
      providerStatus: input.providerStatus,
      reversalStatus: input.reversalStatus,
      ...(input.providerStatus === RechargeRefundProviderStatus.SUCCEEDED
        ? { providerSucceededAt: new Date() }
        : {}),
      ...(input.reversalStatus === RechargeRefundReversalStatus.APPLIED
        ? { reversalAppliedAt: new Date() }
        : {}),
    },
  });
}

async function createHistoricalPaidHandoffOrder(
  fixture: CommerceFixture,
  commercial: CommercialProduct,
  ageDays: number,
) {
  const wallet = await prisma.userWallet.create({
    data: {
      audienceIdentityId: fixture.audienceIdentityId,
      externalUserId: `${fixture.suffix}:historical:${randomUUID()}`,
    },
  });
  const paidAt = new Date(Date.now() - ageDays * 86_400_000);
  return prisma.rechargeOrder.create({
    data: {
      userWalletId: wallet.id,
      representativeId: fixture.representativeId,
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      billingProductId: commercial.product.id,
      billingPriceVersionId: commercial.price.id,
      productNameSnapshot: commercial.product.name,
      productKindSnapshot: BillingProductKind.SERVICE_PACKAGE,
      unitNameSnapshot: "credit",
      entitlementUnitsSnapshot: commercial.price.entitlementUnits,
      handoffAllowanceSnapshot: commercial.price.handoffAllowance,
      handoffUnitsSnapshot: commercial.price.handoffUnits,
      handoffServiceLevelSnapshot: commercial.price.handoffServiceLevel,
      handoffValidityDaysSnapshot: commercial.price.handoffValidityDays,
      creatorRevenueShareBpsSnapshot:
        commercial.price.creatorRevenueShareBps,
      platformRevenueShareBpsSnapshot:
        commercial.price.platformRevenueShareBps,
      refundPolicySnapshot: commercial.price.refundPolicy,
      expiryPolicySnapshot: commercial.price.expiryPolicy,
      entitlementValidityDaysSnapshot:
        commercial.price.entitlementValidityDays,
      provider: PaymentProvider.MOCK,
      providerOrderId: `${fixture.suffix}:historical:${randomUUID()}`,
      providerTransactionId:
        `${fixture.suffix}:historical-transaction:${randomUUID()}`,
      amountCents: commercial.price.amountMinor,
      status: "PAID",
      idempotencyKey: `${fixture.suffix}:historical-order:${randomUUID()}`,
      paidAt,
    },
  });
}

async function createGenerationRun(
  fixture: CommerceFixture,
  label: string,
): Promise<string> {
  const message = await prisma.message.create({
    data: {
      conversationId: fixture.conversationId,
      senderType: "AUDIENCE",
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

async function createVerifiedPayoutDestination(
  fixture: CommerceFixture,
): Promise<void> {
  const profile = await prisma.creatorPayoutProfile.create({
    data: {
      subjectType: PayoutSubjectType.OWNER,
      ownerId: fixture.ownerId,
      status: CreatorPayoutProfileStatus.VERIFIED,
      version: 1,
      verifiedAt: new Date(),
      verifiedBy: "postgres-commerce-test",
      createdByOwnerId: fixture.ownerId,
    },
  });
  await prisma.payoutDestination.create({
    data: {
      profileId: profile.id,
      kind: PayoutDestinationKind.WECHAT_PAY,
      status: PayoutDestinationStatus.ACTIVE,
      currency: "CNY",
      maskedLabel: "WeChat Pay ···· 0811",
      credentialCiphertext: new Uint8Array([1]),
      credentialIv: new Uint8Array(12).fill(2),
      credentialAuthTag: new Uint8Array(16).fill(3),
      credentialKeyVersion: "postgres-commerce-test-v1",
      credentialAlgorithm: "aes-256-gcm",
      credentialFingerprint: "c".repeat(64),
      credentialVersion: 1,
      verifiedAt: new Date(),
      verifiedBy: "postgres-commerce-test",
      activatedAt: new Date(),
      createdByOwnerId: fixture.ownerId,
      idempotencyKey: `${fixture.suffix}:payout-destination`,
    },
  });
}

const localWeChatAdapter: PaymentProviderAdapter = {
  provider: PaymentProvider.WECHAT_PAY,
  async createRechargeCheckout(input) {
    if (!input.rechargeOrderId) {
      throw new Error("Expected a local recharge order id.");
    }
    return {
      provider: PaymentProvider.WECHAT_PAY,
      providerOrderId: input.rechargeOrderId,
      checkoutUrl: "weixin://wxpay/bizpayurl?pr=postgres-commerce-e2e",
      providerPayload: { mode: "native" },
    };
  },
  async normalizeWebhookEvent() {
    throw new Error("This test supplies an already-verified provider event.");
  },
};

function verifiedPaidEvent(input: {
  orderId: string;
  amountCents: number;
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
    amountCents: input.amountCents,
    currency: "CNY",
    rawPayload: { source: "payment_callback", encrypted: true },
    normalizedPayload: {
      providerTransactionId: input.providerTransactionId,
      tradeState: "SUCCESS",
    },
    idempotencyKey: `wechat_pay:${input.providerEventId}`,
    verifiedAt: new Date(),
  };
}

function verifiedRefundResult(input: {
  suffix: string;
  orderId: string;
  providerTransactionId: string;
  amountCents: number;
}): NormalizedWeChatPayRefundResult {
  const providerEventId = `${input.suffix}:wechat-refund:success`;
  const providerRefundId = `wechat-refund-id:${input.suffix}`;
  const providerRefundOrderId = `wechat-refund-order:${input.suffix}`;
  const providerOccurredAt = new Date();
  return {
    provider: PaymentProvider.WECHAT_PAY,
    providerEventId,
    refundId: providerRefundId,
    outRefundNo: providerRefundOrderId,
    outTradeNo: input.orderId,
    transactionId: input.providerTransactionId,
    merchantId: "1900000109",
    refundStatus: "SUCCESS",
    originalAmountCents: input.amountCents,
    refundAmountCents: input.amountCents,
    payerAmountCents: input.amountCents,
    payerRefundAmountCents: input.amountCents,
    idempotencyKey: `wechat_pay:refund:${providerRefundId}`,
    verifiedAt: providerOccurredAt,
    providerOccurredAt,
    rawPayload: {
      id: providerEventId,
      createTime: providerOccurredAt.toISOString(),
      resourceType: "encrypt-resource",
      eventType: "REFUND.SUCCESS",
      summary: "退款成功",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        ciphertext: "verified-and-redacted",
        nonce: "verified-nonce",
        associatedData: "refund",
        originalType: "refund",
      },
    },
    normalizedPayload: {
      type: "RechargeRefunded",
      provider: "wechat_pay",
      providerEventId,
      providerRefundId,
      providerRefundOrderId,
      providerPaymentTransactionId: input.providerTransactionId,
      rechargeOrderId: input.orderId,
      merchantId: "1900000109",
      refundStatus: "SUCCESS",
      originalAmountCents: input.amountCents,
      refundAmountCents: input.amountCents,
      payerAmountCents: input.amountCents,
      payerRefundAmountCents: input.amountCents,
      providerOccurredAt: providerOccurredAt.toISOString(),
    },
  };
}

function assertIsolatedCommerceAuditDatabase(): void {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for representative commerce PostgreSQL tests.",
    );
  }
  const url = new URL(rawUrl);
  const databaseName = url.pathname.replace(/^\/+|\/+$/gu, "");
  if (
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())
    || !/^delegate_commerce_migration_audit_/u.test(databaseName)
  ) {
    throw new Error(
      "Representative commerce PostgreSQL tests require the isolated local "
        + "delegate_commerce_migration_audit_* database.",
    );
  }
}
