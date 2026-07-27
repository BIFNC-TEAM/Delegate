import {
  AmnWalletAccountType,
  ServiceEntitlementLedgerKind,
  WithdrawRequestStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceWalletReconciliationReport,
  type WorkspaceWalletReconciliationDataset,
} from "../src/wallet-reconciliation";

const checkedAt = new Date("2026-07-27T12:00:00.000Z");
const entryTime = new Date("2026-07-27T11:00:00.000Z");

describe("workspace wallet reconciliation", () => {
  it("reports an empty, internally consistent wallet as healthy", () => {
    const report = reconcile(emptyDataset());

    expect(report).toMatchObject({
      schemaVersion: 1,
      checkedAt: checkedAt.toISOString(),
      readOnly: true,
      status: "healthy",
      scope: {
        ownerId: "owner-1",
        representative: "all",
        currency: "CNY",
      },
      summary: {
        warnings: 0,
        errors: 0,
        findings: 0,
        absoluteAmountDifferenceCents: 0,
        absoluteTokenDifference: 0,
      },
      issues: [],
      issueCount: 0,
      issuesTruncated: false,
    });
    expect(report.summary.checks).toBeGreaterThan(0);
    expect(report.summary.passed).toBe(report.summary.checks);
  });

  it("blocks when the representative projection drifts from scoped wallets", () => {
    const dataset = fundedDataset();
    dataset.representatives[0]!.agentWallet!.tokenBalance = 13;

    const report = reconcile(dataset);

    expect(report.status).toBe("blocked");
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "agent_wallet_token_balance_mismatch",
      severity: "error",
      unit: "tokens",
      expectedValue: 10,
      actualValue: 13,
      differenceValue: 3,
    }));
    expect(report.summary.absoluteTokenDifference).toBeGreaterThanOrEqual(3);
  });

  it("downgrades incomplete legacy purchase evidence to a warning", () => {
    const dataset = fundedDataset();
    dataset.purchases[0]!.remainingTokenAmount = null;

    const report = reconcile(dataset);

    expect(report.status).toBe("warning");
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "legacy_purchase_lot_coverage",
      severity: "warning",
    }));
    expect(report.summary.errors).toBe(0);
  });

  it("aggregates wallets by canonical audience before comparing entitlement", () => {
    const dataset = fundedDataset();
    const firstWallet = dataset.userAgentWallets[0]!;
    firstWallet.availableTokenAmount = 6;
    firstWallet.totalPurchasedTokenAmount = 6;
    dataset.purchases[0]!.tokenAmount = 6;
    dataset.purchases[0]!.remainingTokenAmount = 6;
    dataset.purchases[0]!.amountCents = 6;
    dataset.purchases[0]!.creatorPendingCents = 1;
    dataset.ledgerEntries[0]!.tokenBalanceAfter = 6;

    dataset.userAgentWallets.push({
      ...firstWallet,
      id: "user-agent-wallet-2",
      userWalletId: "user-wallet-2",
      availableTokenAmount: 4,
      totalPurchasedTokenAmount: 4,
      audienceIdentityId: "audience-alias",
      canonicalAudienceIdentityId: "audience-1",
    });
    dataset.purchases.push({
      ...dataset.purchases[0]!,
      id: "purchase-2",
      userWalletId: "user-wallet-2",
      userAgentWalletId: "user-agent-wallet-2",
      tokenAmount: 4,
      remainingTokenAmount: 4,
      amountCents: 4,
      creatorPendingCents: 0,
    });
    dataset.walletTransactions.push({
      id: "transaction-2",
      eventGroupId: "purchase:2",
      sourceType: "AgentTokenPurchase",
      representativeId: "representative-1",
      currency: "CNY",
      metadata: null,
    });
    dataset.ledgerEntries.push({
      ...dataset.ledgerEntries[0]!,
      id: "ledger-2",
      eventGroupId: "purchase:2",
      transactionId: "transaction-2",
      userWalletId: "user-wallet-2",
      userAgentWalletId: "user-agent-wallet-2",
      tokenBalanceAfter: 4,
      createdAt: new Date(entryTime.getTime() + 1),
    });
    dataset.representatives[0]!.agentWallet!.tokenBalance = 10;
    dataset.representatives[0]!.agentWallet!.totalPurchasedTokens = 10;
    dataset.entitlementAccounts[0]!.remainingUnits = 10;
    dataset.creatorEarnings[0]!.pendingCents = 1;
    dataset.ledgerEntries.find(
      (entry) => entry.id === "ledger-creator-1",
    )!.amountCents = 1;
    dataset.ledgerEntries.find(
      (entry) => entry.id === "ledger-platform-1",
    )!.amountCents = 9;

    const report = reconcile(dataset);

    expect(report.status).toBe("healthy");
    expect(report.issues).toEqual([]);
  });

  it("detects unbalanced amount event groups without exposing raw payloads", () => {
    const dataset = fundedDataset();
    dataset.ledgerEntries[0]!.amountCents = 125;

    const report = reconcile(dataset);
    const issue = report.issues.find(
      (candidate) => candidate.code === "ledger_event_group_amount_unbalanced",
    );

    expect(report.status).toBe("blocked");
    expect(issue).toMatchObject({
      expectedValue: 0,
      actualValue: 125,
      differenceValue: 125,
      currency: "CNY",
    });
    expect(JSON.stringify(report)).not.toContain("providerPayload");
    expect(JSON.stringify(report)).not.toContain("externalUserId");
  });

  it("allows balance-neutral withdrawal lifecycle transaction headers", () => {
    const dataset = emptyDataset();
    dataset.walletTransactions.push(
      {
        id: "withdrawal-approve",
        eventGroupId: "withdrawal:approve",
        sourceType: "WithdrawRequest",
        representativeId: "representative-1",
        currency: "CNY",
        metadata: { operation: "approve" },
      },
      {
        id: "withdrawal-retryable-failure",
        eventGroupId: "withdrawal:retryable-failure",
        sourceType: "WithdrawRequest",
        representativeId: "representative-1",
        currency: "CNY",
        metadata: { operation: "mark_failed", permanent: false },
      },
    );

    const report = reconcile(dataset);

    expect(report.status).toBe("healthy");
    expect(report.issues).toEqual([]);
  });

  it("detects a missing creator liability for a funded purchase", () => {
    const dataset = fundedDataset();
    dataset.creatorEarnings = [];

    const report = reconcile(dataset);

    expect(report.status).toBe("blocked");
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "purchase_creator_liability_mismatch",
      expectedValue: 2,
      actualValue: 0,
      differenceValue: -2,
    }));
  });

  it("uses the latest global cash-ledger projection for the user wallet", () => {
    const dataset = fundedDataset();
    dataset.userWallets[0]!.cashBalanceCents = 300;
    dataset.cashLedgerEntries[0]!.balanceAfterCents = 280;

    const report = reconcile(dataset);

    expect(report.status).toBe("blocked");
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "user_cash_ledger_projection_mismatch",
      expectedValue: 280,
      actualValue: 300,
      differenceValue: 20,
      unit: "minor_currency",
    }));
  });

  it("checks withdrawal allocation totals and terminal states", () => {
    const dataset = emptyDataset();
    dataset.creatorEarnings.push({
      id: "earning-1",
      ownerId: "owner-1",
      representativeId: "representative-1",
      agentWalletId: "agent-wallet-1",
      tokenPurchaseId: null,
      usageChargeId: null,
      pendingCents: 0,
      withdrawableCents: 0,
      frozenCents: 0,
      withdrawnCents: 90,
      currency: "CNY",
    });
    dataset.withdrawRequests.push({
      id: "withdrawal-1",
      ownerId: "owner-1",
      representativeId: "representative-1",
      status: WithdrawRequestStatus.PAID,
      amountCents: 100,
      currency: "CNY",
      allocations: [{
        id: "allocation-1",
        creatorEarningId: "earning-1",
        amountCents: 90,
        currency: "CNY",
        releasedAt: null,
        paidAt: null,
        creatorEarning: {
          ownerId: "owner-1",
          representativeId: "representative-1",
          currency: "CNY",
        },
      }],
    });

    const report = reconcile(dataset);

    expect(report.status).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "withdrawal_allocation_total_mismatch",
        "withdrawal_allocation_state_mismatch",
      ]),
    );
  });

  it("assigns unique issue ids to multiple allocations in one request", () => {
    const dataset = emptyDataset();
    for (const index of [1, 2]) {
      dataset.creatorEarnings.push({
        id: `earning-${index}`,
        ownerId: "owner-1",
        representativeId: "representative-1",
        agentWalletId: "agent-wallet-1",
        tokenPurchaseId: null,
        usageChargeId: null,
        pendingCents: 0,
        withdrawableCents: 0,
        frozenCents: 0,
        withdrawnCents: 0,
        currency: "CNY",
      });
    }
    dataset.withdrawRequests.push({
      id: "withdrawal-multi",
      ownerId: "owner-1",
      representativeId: "representative-1",
      status: WithdrawRequestStatus.PAID,
      amountCents: 100,
      currency: "CNY",
      allocations: [1, 2].map((index) => ({
        id: `allocation-${index}`,
        creatorEarningId: `earning-${index}`,
        amountCents: 50,
        currency: "CNY",
        releasedAt: null,
        paidAt: null,
        creatorEarning: {
          ownerId: "owner-1",
          representativeId: "representative-1",
          currency: "CNY",
        },
      })),
    });

    const issues = reconcile(dataset).issues.filter(
      (issue) => issue.code === "withdrawal_allocation_state_mismatch",
    );

    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(2);
  });

  it("keeps legacy creator-ledger coverage ids unique by balance bucket", () => {
    const dataset = emptyDataset();
    dataset.creatorEarnings.push({
      id: "legacy-earning",
      ownerId: "owner-1",
      representativeId: "representative-1",
      agentWalletId: "agent-wallet-1",
      tokenPurchaseId: null,
      usageChargeId: null,
      pendingCents: 5,
      withdrawableCents: 5,
      frozenCents: 5,
      withdrawnCents: 0,
      currency: "CNY",
    });

    const issues = reconcile(dataset).issues.filter(
      (issue) =>
        issue.code.startsWith("legacy_creator_")
        && issue.code.endsWith("_ledger_coverage"),
    );

    expect(issues).toHaveLength(3);
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(3);
  });

  it("sorts findings deterministically and truncates only the preview", () => {
    const dataset = fundedDataset();
    dataset.representatives[0]!.agentWallet!.tokenBalance = 20;
    dataset.representatives[0]!.agentWallet!.totalPurchasedTokens = 30;
    dataset.representatives[0]!.agentWallet!.totalConsumedTokens = 40;

    const report = reconcile(dataset, 2);

    expect(report.issueCount).toBeGreaterThan(2);
    expect(report.issues).toHaveLength(2);
    expect(report.issuesTruncated).toBe(true);
    expect(report.summary.findings).toBe(report.issueCount);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      [...report.issues.map((issue) => issue.code)].sort(),
    );
  });
});

function reconcile(
  dataset: WorkspaceWalletReconciliationDataset,
  issueLimit = 100,
) {
  return buildWorkspaceWalletReconciliationReport(dataset, {
    ownerId: "owner-1",
    representative: "all",
    currency: "CNY",
    checkedAt,
    issueLimit,
  });
}

function emptyDataset(): WorkspaceWalletReconciliationDataset {
  return {
    representatives: [{
      id: "representative-1",
      ownerId: "owner-1",
      slug: "delegate",
      displayName: "Delegate",
      agentWallet: {
        id: "agent-wallet-1",
        currency: "CNY",
        tokenBalance: 0,
        totalPurchasedTokens: 0,
        totalConsumedTokens: 0,
      },
    }],
    userAgentWallets: [],
    purchases: [],
    usageCharges: [],
    entitlementAccounts: [],
    creatorEarnings: [],
    withdrawRequests: [],
    walletTransactions: [],
    ledgerEntries: [],
    userWallets: [],
    cashLedgerEntries: [],
  };
}

function fundedDataset(): WorkspaceWalletReconciliationDataset {
  const dataset = emptyDataset();
  dataset.representatives[0]!.agentWallet = {
    id: "agent-wallet-1",
    currency: "CNY",
    tokenBalance: 10,
    totalPurchasedTokens: 10,
    totalConsumedTokens: 0,
  };
  dataset.userAgentWallets.push({
    id: "user-agent-wallet-1",
    userWalletId: "user-wallet-1",
    agentWalletId: "agent-wallet-1",
    currency: "CNY",
    availableTokenAmount: 10,
    reservedTokenAmount: 0,
    totalPurchasedTokenAmount: 10,
    totalConsumedTokenAmount: 0,
    audienceIdentityId: "audience-1",
    canonicalAudienceIdentityId: "audience-1",
    audienceResolutionFailed: false,
    userWalletCurrency: "CNY",
  });
  dataset.purchases.push({
    id: "purchase-1",
    userWalletId: "user-wallet-1",
    userAgentWalletId: "user-agent-wallet-1",
    agentWalletId: "agent-wallet-1",
    representativeId: "representative-1",
    audienceIdentityId: "audience-1",
    entitlementAccountId: "entitlement-1",
    amountCents: 10,
    currency: "CNY",
    tokenAmount: 10,
    remainingTokenAmount: 10,
    tokenUnitPriceCents: 1,
    creatorRevenueShareBps: 2_000,
    creatorPendingCents: 2,
  });
  dataset.entitlementAccounts.push({
    id: "entitlement-1",
    audienceIdentityId: "audience-1",
    representativeId: "representative-1",
    productCode: "agent-wallet:service-credit:v1",
    remainingUnits: 10,
    reservedUnits: 0,
    ledgerKinds: [ServiceEntitlementLedgerKind.GRANT],
  });
  dataset.walletTransactions.push({
    id: "transaction-1",
    eventGroupId: "purchase:1",
    sourceType: "AgentTokenPurchase",
    representativeId: "representative-1",
    currency: "CNY",
    metadata: null,
  });
  dataset.ledgerEntries.push({
    id: "ledger-1",
    eventGroupId: "purchase:1",
    transactionId: "transaction-1",
    accountType: AmnWalletAccountType.SERVICE_CREDIT_DEFERRED,
    userWalletId: "user-wallet-1",
    userAgentWalletId: "user-agent-wallet-1",
    representativeId: "representative-1",
    ownerId: null,
    amountCents: 0,
    tokenAmount: 10,
    currency: "CNY",
    balanceAfterCents: null,
    tokenBalanceAfter: 10,
    createdAt: entryTime,
  });
  dataset.ledgerEntries.push(
    {
      id: "ledger-cash-1",
      eventGroupId: "purchase:1",
      transactionId: "transaction-1",
      accountType: AmnWalletAccountType.USER_CASH,
      userWalletId: "user-wallet-1",
      userAgentWalletId: null,
      representativeId: null,
      ownerId: null,
      amountCents: -10,
      tokenAmount: 0,
      currency: "CNY",
      balanceAfterCents: 0,
      tokenBalanceAfter: null,
      createdAt: entryTime,
    },
    {
      id: "ledger-creator-1",
      eventGroupId: "purchase:1",
      transactionId: "transaction-1",
      accountType: AmnWalletAccountType.CREATOR_PENDING,
      userWalletId: null,
      userAgentWalletId: null,
      representativeId: "representative-1",
      ownerId: "owner-1",
      amountCents: 2,
      tokenAmount: 0,
      currency: "CNY",
      balanceAfterCents: null,
      tokenBalanceAfter: null,
      createdAt: entryTime,
    },
    {
      id: "ledger-platform-1",
      eventGroupId: "purchase:1",
      transactionId: "transaction-1",
      accountType: AmnWalletAccountType.PLATFORM_DEFERRED_REVENUE,
      userWalletId: null,
      userAgentWalletId: null,
      representativeId: "representative-1",
      ownerId: null,
      amountCents: 8,
      tokenAmount: 0,
      currency: "CNY",
      balanceAfterCents: null,
      tokenBalanceAfter: null,
      createdAt: entryTime,
    },
  );
  dataset.creatorEarnings.push({
    id: "earning-pending-1",
    ownerId: "owner-1",
    representativeId: "representative-1",
    agentWalletId: "agent-wallet-1",
    tokenPurchaseId: "purchase-1",
    usageChargeId: null,
    pendingCents: 2,
    withdrawableCents: 0,
    frozenCents: 0,
    withdrawnCents: 0,
    currency: "CNY",
  });
  dataset.userWallets.push({
    id: "user-wallet-1",
    currency: "CNY",
    cashBalanceCents: 0,
  });
  dataset.cashLedgerEntries.push({
    id: "ledger-cash-1",
    userWalletId: "user-wallet-1",
    currency: "CNY",
    balanceAfterCents: 0,
    createdAt: entryTime,
  });
  return dataset;
}
