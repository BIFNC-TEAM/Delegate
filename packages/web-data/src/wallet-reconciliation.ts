import {
  AgentUsageChargeStatus,
  AmnWalletAccountType,
  Prisma,
  ServiceEntitlementLedgerKind,
  WithdrawRequestStatus,
} from "@prisma/client";

import { prisma } from "./prisma";
import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
  resolveServiceEntitlementAudienceIdentityId,
  type ServiceEntitlementClient,
} from "./service-entitlements";

export type WorkspaceWalletReconciliationStatus =
  | "healthy"
  | "warning"
  | "blocked";

export type WorkspaceWalletReconciliationSeverity = "warning" | "error";

export type WorkspaceWalletReconciliationUnit =
  | "minor_currency"
  | "tokens"
  | "count";

export type WorkspaceWalletReconciliationReference = {
  kind: string;
  id: string;
};

export type WorkspaceWalletReconciliationIssue = {
  id: string;
  code: string;
  severity: WorkspaceWalletReconciliationSeverity;
  domain:
    | "wallet"
    | "purchase"
    | "usage"
    | "entitlement"
    | "earning"
    | "withdrawal"
    | "ledger";
  representativeSlug: string | null;
  representativeName: string | null;
  unit: WorkspaceWalletReconciliationUnit;
  expectedValue: number | null;
  actualValue: number | null;
  differenceValue: number | null;
  currency: string | null;
  references: WorkspaceWalletReconciliationReference[];
};

export type WorkspaceWalletReconciliationReport = {
  schemaVersion: 1;
  checkedAt: string;
  readOnly: true;
  status: WorkspaceWalletReconciliationStatus;
  scope: {
    ownerId: string;
    representative: string;
    currency: string;
  };
  summary: {
    checks: number;
    passed: number;
    warnings: number;
    errors: number;
    findings: number;
    absoluteAmountDifferenceCents: number;
    absoluteTokenDifference: number;
  };
  issues: WorkspaceWalletReconciliationIssue[];
  issueCount: number;
  issuesTruncated: boolean;
};

export type WorkspaceWalletReconciliationInput = {
  ownerId: string;
  activeRepresentativeSlug: string;
  representative?: string;
  currency?: string;
  issueLimit?: number;
};

export type AllWorkspaceWalletReconciliationInput = {
  currency?: string;
  issueLimit?: number;
};

export class WorkspaceWalletReconciliationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceWalletReconciliationInputError";
  }
}

type ReconciliationRepresentative = {
  id: string;
  ownerId: string;
  slug: string;
  displayName: string;
  agentWallet: {
    id: string;
    currency: string;
    tokenBalance: number;
    totalPurchasedTokens: number;
    totalConsumedTokens: number;
  } | null;
};

export type WorkspaceWalletReconciliationDataset = {
  representatives: ReconciliationRepresentative[];
  userAgentWallets: Array<{
    id: string;
    userWalletId: string;
    agentWalletId: string;
    currency: string;
    availableTokenAmount: number;
    reservedTokenAmount: number;
    totalPurchasedTokenAmount: number;
    totalConsumedTokenAmount: number;
    audienceIdentityId: string | null;
    canonicalAudienceIdentityId: string | null;
    audienceResolutionFailed: boolean;
    userWalletCurrency: string;
  }>;
  purchases: Array<{
    id: string;
    userWalletId: string;
    userAgentWalletId: string | null;
    agentWalletId: string;
    representativeId: string;
    audienceIdentityId: string | null;
    entitlementAccountId: string | null;
    amountCents: number;
    currency: string;
    tokenAmount: number;
    remainingTokenAmount: number | null;
    tokenUnitPriceCents: number;
    creatorRevenueShareBps: number;
    creatorPendingCents: number;
  }>;
  usageCharges: Array<{
    id: string;
    userAgentWalletId: string | null;
    agentWalletId: string;
    representativeId: string;
    entitlementAccountId: string | null;
    status: AgentUsageChargeStatus;
    tokenAmount: number;
    reservedTokenAmount: number;
    settledTokenAmount: number;
    releasedTokenAmount: number;
    platformRevenueCents: number;
    currency: string;
    allocations: Array<{
      id: string;
      tokenPurchaseId: string;
      creatorEarningId: string | null;
      tokenAmount: number;
      valueCents: number;
      creatorReleaseCents: number;
      currency: string;
    }>;
  }>;
  entitlementAccounts: Array<{
    id: string;
    audienceIdentityId: string;
    representativeId: string;
    productCode: string;
    remainingUnits: number;
    reservedUnits: number;
    ledgerKinds: ServiceEntitlementLedgerKind[];
  }>;
  creatorEarnings: Array<{
    id: string;
    ownerId: string;
    representativeId: string;
    agentWalletId: string;
    tokenPurchaseId: string | null;
    usageChargeId: string | null;
    pendingCents: number;
    withdrawableCents: number;
    frozenCents: number;
    withdrawnCents: number;
    currency: string;
  }>;
  withdrawRequests: Array<{
    id: string;
    ownerId: string;
    representativeId: string | null;
    status: WithdrawRequestStatus;
    amountCents: number;
    currency: string;
    allocations: Array<{
      id: string;
      creatorEarningId: string;
      amountCents: number;
      currency: string;
      releasedAt: Date | null;
      paidAt: Date | null;
      creatorEarning: {
        ownerId: string;
        representativeId: string;
        currency: string;
      };
    }>;
  }>;
  walletTransactions: Array<{
    id: string;
    eventGroupId: string;
    sourceType: string;
    representativeId: string | null;
    currency: string;
    metadata: Prisma.JsonValue | null;
  }>;
  ledgerEntries: Array<{
    id: string;
    eventGroupId: string;
    transactionId: string | null;
    accountType: AmnWalletAccountType;
    userWalletId: string | null;
    userAgentWalletId: string | null;
    representativeId: string | null;
    ownerId: string | null;
    amountCents: number;
    tokenAmount: number;
    currency: string;
    balanceAfterCents: number | null;
    tokenBalanceAfter: number | null;
    createdAt: Date;
  }>;
  userWallets: Array<{
    id: string;
    currency: string;
    cashBalanceCents: number;
  }>;
  cashLedgerEntries: Array<{
    id: string;
    userWalletId: string | null;
    currency: string;
    balanceAfterCents: number | null;
    createdAt: Date;
  }>;
};

type ReconciliationContext = {
  ownerId: string;
  representative: string;
  currency: string;
  checkedAt: Date;
  issueLimit: number;
};

type ReconciliationClient = Pick<
  typeof prisma,
  | "owner"
  | "representative"
  | "userAgentWallet"
  | "agentTokenPurchase"
  | "agentUsageCharge"
  | "serviceEntitlementAccount"
  | "creatorEarning"
  | "withdrawRequest"
  | "walletTransaction"
  | "walletLedgerEntry"
  | "userWallet"
>;

type ReconciliationRootClient = ReconciliationClient
  & Pick<typeof prisma, "$transaction">;

const currencyPattern = /^[A-Z][A-Z0-9]{2,7}$/;
const defaultIssueLimit = 100;
const maximumIssueLimit = 500;

export async function getWorkspaceWalletReconciliationReport(
  input: WorkspaceWalletReconciliationInput,
  client: ReconciliationRootClient = prisma,
): Promise<WorkspaceWalletReconciliationReport | null> {
  const normalized = normalizeBaseInput(input);
  return client.$transaction(
    async (tx) => loadWorkspaceWalletReconciliationReport(
      normalized,
      tx as ReconciliationClient,
    ),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
}

export async function getAllWorkspaceWalletReconciliationReports(
  input: AllWorkspaceWalletReconciliationInput = {},
  client: ReconciliationRootClient = prisma,
): Promise<WorkspaceWalletReconciliationReport[]> {
  const requestedCurrency = input.currency
    ? normalizeCurrency(input.currency)
    : null;
  const issueLimit = normalizeIssueLimit(input.issueLimit);
  const representatives = await client.representative.findMany({
    where: {
      agentWallet: { isNot: null },
    },
    orderBy: [
      { ownerId: "asc" },
      { slug: "asc" },
    ],
    select: {
      ownerId: true,
      slug: true,
      agentWallet: {
        select: { currency: true },
      },
    },
  });
  const targetMap = new Map<
    string,
    { ownerId: string; activeRepresentativeSlug: string; currency: string }
  >();
  for (const representative of representatives) {
    const currency = representative.agentWallet?.currency.toUpperCase();
    if (!currency || (requestedCurrency && currency !== requestedCurrency)) continue;
    const key = `${representative.ownerId}:${currency}`;
    if (!targetMap.has(key)) {
      targetMap.set(key, {
        ownerId: representative.ownerId,
        activeRepresentativeSlug: representative.slug,
        currency,
      });
    }
  }

  const reports: WorkspaceWalletReconciliationReport[] = [];
  for (const target of targetMap.values()) {
    const report = await getWorkspaceWalletReconciliationReport(
      {
        ...target,
        representative: "all",
        issueLimit,
      },
      client,
    );
    if (report) reports.push(report);
  }
  return reports.sort((left, right) =>
    left.scope.ownerId.localeCompare(right.scope.ownerId)
    || left.scope.currency.localeCompare(right.scope.currency)
  );
}

async function loadWorkspaceWalletReconciliationReport(
  input: ReturnType<typeof normalizeBaseInput>,
  client: ReconciliationClient,
): Promise<WorkspaceWalletReconciliationReport | null> {
  const [owner, representatives] = await Promise.all([
    client.owner.findUnique({
      where: { id: input.ownerId },
      select: { id: true },
    }),
    client.representative.findMany({
      where: { ownerId: input.ownerId },
      orderBy: [{ displayName: "asc" }, { slug: "asc" }],
      select: {
        id: true,
        ownerId: true,
        slug: true,
        displayName: true,
        agentWallet: {
          select: {
            id: true,
            currency: true,
            tokenBalance: true,
            totalPurchasedTokens: true,
            totalConsumedTokens: true,
          },
        },
      },
    }),
  ]);
  if (!owner) return null;
  const activeRepresentative = representatives.find(
    (representative) => representative.slug === input.activeRepresentativeSlug,
  );
  if (!activeRepresentative) return null;

  const selectedRepresentative =
    input.representative === "all"
      ? null
      : representatives.find(
          (representative) => representative.slug === input.representative,
        );
  if (input.representative !== "all" && !selectedRepresentative) {
    throw new WorkspaceWalletReconciliationInputError(
      "Selected representative is not available in this workspace.",
    );
  }

  const availableCurrencies = new Set(
    representatives
      .map((representative) => representative.agentWallet?.currency.toUpperCase())
      .filter((currency): currency is string => Boolean(currency)),
  );
  const currency = input.currency
    ?? activeRepresentative.agentWallet?.currency.toUpperCase()
    ?? availableCurrencies.values().next().value
    ?? "CNY";
  if (availableCurrencies.size && !availableCurrencies.has(currency)) {
    throw new WorkspaceWalletReconciliationInputError(
      "Selected currency is not available in this workspace.",
    );
  }
  if (
    selectedRepresentative
    && selectedRepresentative.agentWallet?.currency.toUpperCase() !== currency
  ) {
    throw new WorkspaceWalletReconciliationInputError(
      "Selected representative has no wallet in this currency.",
    );
  }

  const scopedRepresentatives = representatives.filter(
    (representative) =>
      (!selectedRepresentative || representative.id === selectedRepresentative.id)
      && representative.agentWallet?.currency.toUpperCase() === currency,
  );
  const representativeIds = scopedRepresentatives.map(
    (representative) => representative.id,
  );
  const agentWalletIds = scopedRepresentatives
    .map((representative) => representative.agentWallet?.id)
    .filter((id): id is string => Boolean(id));

  const [
    rawUserAgentWallets,
    purchases,
    usageCharges,
    entitlementAccounts,
    creatorEarnings,
    withdrawRequests,
    walletTransactions,
    ledgerEntries,
  ] = await Promise.all([
    client.userAgentWallet.findMany({
      where: {
        agentWalletId: { in: agentWalletIds },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        userWalletId: true,
        agentWalletId: true,
        currency: true,
        availableTokenAmount: true,
        reservedTokenAmount: true,
        totalPurchasedTokenAmount: true,
        totalConsumedTokenAmount: true,
        userWallet: {
          select: {
            audienceIdentityId: true,
            currency: true,
          },
        },
      },
    }),
    client.agentTokenPurchase.findMany({
      where: {
        representativeId: { in: representativeIds },
        currency,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        userWalletId: true,
        userAgentWalletId: true,
        agentWalletId: true,
        representativeId: true,
        audienceIdentityId: true,
        entitlementAccountId: true,
        amountCents: true,
        currency: true,
        tokenAmount: true,
        remainingTokenAmount: true,
        tokenUnitPriceCents: true,
        creatorRevenueShareBps: true,
        creatorPendingCents: true,
      },
    }),
    client.agentUsageCharge.findMany({
      where: {
        representativeId: { in: representativeIds },
        currency,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        userAgentWalletId: true,
        agentWalletId: true,
        representativeId: true,
        entitlementAccountId: true,
        status: true,
        tokenAmount: true,
        reservedTokenAmount: true,
        settledTokenAmount: true,
        releasedTokenAmount: true,
        platformRevenueCents: true,
        currency: true,
        allocations: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            tokenPurchaseId: true,
            creatorEarningId: true,
            tokenAmount: true,
            valueCents: true,
            creatorReleaseCents: true,
            currency: true,
          },
        },
      },
    }),
    client.serviceEntitlementAccount.findMany({
      where: {
        representativeId: { in: representativeIds },
        productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        audienceIdentityId: true,
        representativeId: true,
        productCode: true,
        remainingUnits: true,
        reservedUnits: true,
        ledgerEntries: {
          select: { kind: true },
        },
      },
    }),
    client.creatorEarning.findMany({
      where: {
        ownerId: input.ownerId,
        representativeId: { in: representativeIds },
        currency,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        ownerId: true,
        representativeId: true,
        agentWalletId: true,
        tokenPurchaseId: true,
        usageChargeId: true,
        pendingCents: true,
        withdrawableCents: true,
        frozenCents: true,
        withdrawnCents: true,
        currency: true,
      },
    }),
    client.withdrawRequest.findMany({
      where: {
        ownerId: input.ownerId,
        representativeId: { in: representativeIds },
        currency,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        ownerId: true,
        representativeId: true,
        status: true,
        amountCents: true,
        currency: true,
        allocations: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            creatorEarningId: true,
            amountCents: true,
            currency: true,
            releasedAt: true,
            paidAt: true,
            creatorEarning: {
              select: {
                ownerId: true,
                representativeId: true,
                currency: true,
              },
            },
          },
        },
      },
    }),
    client.walletTransaction.findMany({
      where: {
        representativeId: { in: representativeIds },
        currency,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        eventGroupId: true,
        sourceType: true,
        representativeId: true,
        currency: true,
        metadata: true,
      },
    }),
    client.walletLedgerEntry.findMany({
      where: {
        currency,
        OR: [
          { representativeId: { in: representativeIds } },
          { agentWalletId: { in: agentWalletIds } },
          { tokenPurchase: { representativeId: { in: representativeIds } } },
          { usageCharge: { representativeId: { in: representativeIds } } },
          { creatorEarning: { representativeId: { in: representativeIds } } },
          { withdrawRequest: { representativeId: { in: representativeIds } } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        eventGroupId: true,
        transactionId: true,
        accountType: true,
        userWalletId: true,
        userAgentWalletId: true,
        representativeId: true,
        ownerId: true,
        amountCents: true,
        tokenAmount: true,
        currency: true,
        balanceAfterCents: true,
        tokenBalanceAfter: true,
        createdAt: true,
      },
    }),
  ]);

  const canonicalByAudienceId = new Map<string, string | null>();
  const userAgentWallets = [];
  for (const wallet of rawUserAgentWallets) {
    const audienceIdentityId = wallet.userWallet.audienceIdentityId;
    let canonicalAudienceIdentityId: string | null = null;
    let audienceResolutionFailed = false;
    if (audienceIdentityId) {
      if (!canonicalByAudienceId.has(audienceIdentityId)) {
        try {
          canonicalByAudienceId.set(
            audienceIdentityId,
            await resolveServiceEntitlementAudienceIdentityId(
              audienceIdentityId,
              client as unknown as ServiceEntitlementClient,
            ),
          );
        } catch {
          canonicalByAudienceId.set(audienceIdentityId, null);
        }
      }
      canonicalAudienceIdentityId =
        canonicalByAudienceId.get(audienceIdentityId) ?? null;
      audienceResolutionFailed = canonicalAudienceIdentityId === null;
    }
    userAgentWallets.push({
      ...wallet,
      audienceIdentityId,
      canonicalAudienceIdentityId,
      audienceResolutionFailed,
      userWalletCurrency: wallet.userWallet.currency,
    });
  }

  const userWalletIds = [...new Set(
    userAgentWallets.map((wallet) => wallet.userWalletId),
  )];
  const [userWallets, cashLedgerEntries] = await Promise.all([
    client.userWallet.findMany({
      where: {
        id: { in: userWalletIds },
        currency,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        currency: true,
        cashBalanceCents: true,
      },
    }),
    client.walletLedgerEntry.findMany({
      where: {
        userWalletId: { in: userWalletIds },
        accountType: AmnWalletAccountType.USER_CASH,
        currency,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        userWalletId: true,
        currency: true,
        balanceAfterCents: true,
        createdAt: true,
      },
    }),
  ]);

  const dataset: WorkspaceWalletReconciliationDataset = {
    representatives: scopedRepresentatives,
    userAgentWallets,
    purchases,
    usageCharges,
    entitlementAccounts: entitlementAccounts.map((account) => ({
      ...account,
      ledgerKinds: account.ledgerEntries.map((entry) => entry.kind),
    })),
    creatorEarnings,
    withdrawRequests,
    walletTransactions,
    ledgerEntries,
    userWallets,
    cashLedgerEntries,
  };
  return buildWorkspaceWalletReconciliationReport(dataset, {
    ownerId: input.ownerId,
    representative: input.representative,
    currency,
    checkedAt: new Date(),
    issueLimit: input.issueLimit,
  });
}

export function buildWorkspaceWalletReconciliationReport(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
): WorkspaceWalletReconciliationReport {
  const findings: WorkspaceWalletReconciliationIssue[] = [];
  let checks = 0;
  const representativeById = new Map(
    dataset.representatives.map((representative) => [
      representative.id,
      representative,
    ]),
  );
  const walletById = new Map(
    dataset.userAgentWallets.map((wallet) => [wallet.id, wallet]),
  );
  const earningById = new Map(
    dataset.creatorEarnings.map((earning) => [earning.id, earning]),
  );

  const addCheck = (
    condition: boolean,
    issue: Omit<WorkspaceWalletReconciliationIssue, "id">,
  ) => {
    checks += 1;
    if (!condition) findings.push(withIssueId(issue));
  };
  const addWarning = (
    issue: Omit<WorkspaceWalletReconciliationIssue, "id">,
  ) => addCheck(false, { ...issue, severity: "warning" });

  for (const representative of dataset.representatives) {
    const agentWallet = representative.agentWallet;
    if (!agentWallet) continue;
    const scopedWallets = dataset.userAgentWallets.filter(
      (wallet) => wallet.agentWalletId === agentWallet.id,
    );
    const availableAndReserved = scopedWallets.reduce(
      (sum, wallet) =>
        sum + wallet.availableTokenAmount + wallet.reservedTokenAmount,
      0,
    );
    const totalPurchased = scopedWallets.reduce(
      (sum, wallet) => sum + wallet.totalPurchasedTokenAmount,
      0,
    );
    const totalConsumed = scopedWallets.reduce(
      (sum, wallet) => sum + wallet.totalConsumedTokenAmount,
      0,
    );
    checkNumericProjection(addCheck, {
      code: "agent_wallet_token_balance_mismatch",
      domain: "wallet",
      representative,
      unit: "tokens",
      expected: availableAndReserved,
      actual: agentWallet.tokenBalance,
      currency: context.currency,
      references: [{ kind: "AgentWallet", id: agentWallet.id }],
    });
    checkNumericProjection(addCheck, {
      code: "agent_wallet_purchased_total_mismatch",
      domain: "wallet",
      representative,
      unit: "tokens",
      expected: totalPurchased,
      actual: agentWallet.totalPurchasedTokens,
      currency: context.currency,
      references: [{ kind: "AgentWallet", id: agentWallet.id }],
    });
    checkNumericProjection(addCheck, {
      code: "agent_wallet_consumed_total_mismatch",
      domain: "wallet",
      representative,
      unit: "tokens",
      expected: totalConsumed,
      actual: agentWallet.totalConsumedTokens,
      currency: context.currency,
      references: [{ kind: "AgentWallet", id: agentWallet.id }],
    });
  }

  for (const wallet of dataset.userAgentWallets) {
    const representative = representativeForAgentWallet(
      dataset.representatives,
      wallet.agentWalletId,
    );
    const walletReferences = [{ kind: "UserAgentWallet", id: wallet.id }];
    checkNumericProjection(addCheck, {
      code: "scoped_wallet_conservation_mismatch",
      domain: "wallet",
      representative,
      unit: "tokens",
      expected: wallet.totalPurchasedTokenAmount,
      actual:
        wallet.availableTokenAmount
        + wallet.reservedTokenAmount
        + wallet.totalConsumedTokenAmount,
      currency: context.currency,
      references: walletReferences,
    });
    addCheck(
      wallet.currency === context.currency
        && wallet.userWalletCurrency === context.currency,
      issueFor({
        code: "scoped_wallet_currency_mismatch",
        domain: "wallet",
        representative,
        unit: "count",
        expected: null,
        actual: null,
        currency: context.currency,
        references: walletReferences,
      }),
    );

    const reservedUsage = dataset.usageCharges
      .filter(
        (usage) =>
          usage.userAgentWalletId === wallet.id
          && usage.status === AgentUsageChargeStatus.RESERVED,
      )
      .reduce((sum, usage) => sum + usage.reservedTokenAmount, 0);
    checkNumericProjection(addCheck, {
      code: "scoped_wallet_reserved_usage_mismatch",
      domain: "usage",
      representative,
      unit: "tokens",
      expected: reservedUsage,
      actual: wallet.reservedTokenAmount,
      currency: context.currency,
      references: walletReferences,
    });
    const consumedUsage = dataset.usageCharges
      .filter(
        (usage) =>
          usage.userAgentWalletId === wallet.id
          && (
            usage.status === AgentUsageChargeStatus.SETTLED
            || usage.status === AgentUsageChargeStatus.APPLIED
          ),
      )
      .reduce((sum, usage) => sum + usage.settledTokenAmount, 0);
    checkNumericProjection(addCheck, {
      code: "scoped_wallet_consumed_usage_mismatch",
      domain: "usage",
      representative,
      unit: "tokens",
      expected: consumedUsage,
      actual: wallet.totalConsumedTokenAmount,
      currency: context.currency,
      references: walletReferences,
    });

    const purchases = dataset.purchases.filter(
      (purchase) => purchase.userAgentWalletId === wallet.id,
    );
    if (purchases.some((purchase) => purchase.remainingTokenAmount === null)) {
      addWarning(issueFor({
        code: "legacy_purchase_lot_coverage",
        domain: "purchase",
        representative,
        unit: "count",
        expected: purchases.length,
        actual: purchases.filter(
          (purchase) => purchase.remainingTokenAmount !== null,
        ).length,
        currency: context.currency,
        references: walletReferences,
      }));
    } else {
      const remaining = purchases.reduce(
        (sum, purchase) => sum + (purchase.remainingTokenAmount ?? 0),
        0,
      );
      checkNumericProjection(addCheck, {
        code: "purchase_lot_balance_mismatch",
        domain: "purchase",
        representative,
        unit: "tokens",
        expected: remaining,
        actual: wallet.availableTokenAmount + wallet.reservedTokenAmount,
        currency: context.currency,
        references: walletReferences,
      });
    }

    const latestServiceCreditEntry = latestEntry(
      dataset.ledgerEntries.filter(
        (entry) =>
          entry.accountType === AmnWalletAccountType.SERVICE_CREDIT_DEFERRED
          && entry.userAgentWalletId === wallet.id,
      ),
    );
    if (
      !latestServiceCreditEntry
      || latestServiceCreditEntry.tokenBalanceAfter === null
    ) {
      if (wallet.availableTokenAmount + wallet.reservedTokenAmount !== 0) {
        addWarning(issueFor({
          code: "legacy_service_credit_ledger_coverage",
          domain: "ledger",
          representative,
          unit: "tokens",
          expected: wallet.availableTokenAmount + wallet.reservedTokenAmount,
          actual: null,
          currency: context.currency,
          references: walletReferences,
        }));
      } else {
        checks += 1;
      }
    } else {
      checkNumericProjection(addCheck, {
        code: "service_credit_ledger_projection_mismatch",
        domain: "ledger",
        representative,
        unit: "tokens",
        expected: latestServiceCreditEntry.tokenBalanceAfter,
        actual: wallet.availableTokenAmount + wallet.reservedTokenAmount,
        currency: context.currency,
        references: [
          ...walletReferences,
          { kind: "WalletLedgerEntry", id: latestServiceCreditEntry.id },
        ],
      });
    }

    if (wallet.audienceResolutionFailed) {
      addWarning(issueFor({
        code: "audience_identity_resolution_incomplete",
        domain: "entitlement",
        representative,
        unit: "count",
        expected: 1,
        actual: 0,
        currency: context.currency,
        references: walletReferences,
      }));
    } else if (
      !wallet.canonicalAudienceIdentityId
      && wallet.availableTokenAmount + wallet.reservedTokenAmount > 0
    ) {
      addCheck(false, issueFor({
        code: "missing_entitlement_binding",
        domain: "entitlement",
        representative,
        unit: "tokens",
        expected: wallet.availableTokenAmount + wallet.reservedTokenAmount,
        actual: 0,
        currency: context.currency,
        references: walletReferences,
      }));
    }
  }

  reconcileEntitlementAccounts(
    dataset,
    context,
    representativeById,
    addCheck,
    addWarning,
  );
  reconcilePurchases(
    dataset,
    context,
    representativeById,
    walletById,
    addCheck,
    addWarning,
  );
  reconcileUsageCharges(
    dataset,
    context,
    representativeById,
    walletById,
    earningById,
    addCheck,
  );
  reconcileCreatorEarnings(
    dataset,
    context,
    representativeById,
    earningById,
    addCheck,
    addWarning,
  );
  reconcileWithdrawals(
    dataset,
    context,
    representativeById,
    earningById,
    addCheck,
    addWarning,
  );
  reconcileTransactionsAndLedger(
    dataset,
    context,
    representativeById,
    addCheck,
    addWarning,
  );
  reconcileUserCash(dataset, context, addCheck, addWarning);

  const sorted = findings.sort(compareIssues);
  const errors = sorted.filter((issue) => issue.severity === "error").length;
  const warnings = sorted.length - errors;
  const status: WorkspaceWalletReconciliationStatus =
    errors > 0 ? "blocked" : warnings > 0 ? "warning" : "healthy";
  const amountDifference = sorted.reduce(
    (sum, issue) =>
      issue.unit === "minor_currency"
        ? sum + Math.abs(issue.differenceValue ?? 0)
        : sum,
    0,
  );
  const tokenDifference = sorted.reduce(
    (sum, issue) =>
      issue.unit === "tokens"
        ? sum + Math.abs(issue.differenceValue ?? 0)
        : sum,
    0,
  );

  return {
    schemaVersion: 1,
    checkedAt: context.checkedAt.toISOString(),
    readOnly: true,
    status,
    scope: {
      ownerId: context.ownerId,
      representative: context.representative,
      currency: context.currency,
    },
    summary: {
      checks,
      passed: Math.max(0, checks - sorted.length),
      warnings,
      errors,
      findings: sorted.length,
      absoluteAmountDifferenceCents: amountDifference,
      absoluteTokenDifference: tokenDifference,
    },
    issues: sorted.slice(0, context.issueLimit),
    issueCount: sorted.length,
    issuesTruncated: sorted.length > context.issueLimit,
  };
}

function reconcileEntitlementAccounts(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
  representativeById: Map<string, ReconciliationRepresentative>,
  addCheck: CheckFunction,
  addWarning: WarningFunction,
) {
  const walletsByCoordinate = new Map<
    string,
    WorkspaceWalletReconciliationDataset["userAgentWallets"]
  >();
  for (const wallet of dataset.userAgentWallets) {
    if (!wallet.canonicalAudienceIdentityId) continue;
    const representative = representativeForAgentWallet(
      dataset.representatives,
      wallet.agentWalletId,
    );
    if (!representative) continue;
    const key = entitlementCoordinate(
      representative.id,
      wallet.canonicalAudienceIdentityId,
    );
    const existing = walletsByCoordinate.get(key) ?? [];
    existing.push(wallet);
    walletsByCoordinate.set(key, existing);
  }
  const accountByCoordinate = new Map(
    dataset.entitlementAccounts.map((account) => [
      entitlementCoordinate(
        account.representativeId,
        account.audienceIdentityId,
      ),
      account,
    ]),
  );
  const coordinates = new Set([
    ...walletsByCoordinate.keys(),
    ...accountByCoordinate.keys(),
  ]);
  for (const coordinate of coordinates) {
    const wallets = walletsByCoordinate.get(coordinate) ?? [];
    const account = accountByCoordinate.get(coordinate);
    const representativeId =
      account?.representativeId
      ?? representativeForAgentWallet(
        dataset.representatives,
        wallets[0]?.agentWalletId ?? "",
      )?.id
      ?? "";
    const representative = representativeById.get(representativeId) ?? null;
    const available = wallets.reduce(
      (sum, wallet) => sum + wallet.availableTokenAmount,
      0,
    );
    const reserved = wallets.reduce(
      (sum, wallet) => sum + wallet.reservedTokenAmount,
      0,
    );
    const references = [
      ...wallets.map((wallet) => ({
        kind: "UserAgentWallet",
        id: wallet.id,
      })),
      ...(account
        ? [{ kind: "ServiceEntitlementAccount", id: account.id }]
        : []),
    ];
    checkNumericProjection(addCheck, {
      code: "entitlement_available_balance_mismatch",
      domain: "entitlement",
      representative,
      unit: "tokens",
      expected: available,
      actual: account?.remainingUnits ?? 0,
      currency: context.currency,
      references,
    });
    checkNumericProjection(addCheck, {
      code: "entitlement_reserved_balance_mismatch",
      domain: "entitlement",
      representative,
      unit: "tokens",
      expected: reserved,
      actual: account?.reservedUnits ?? 0,
      currency: context.currency,
      references,
    });
    if (
      account?.ledgerKinds.some(
        (kind) =>
          kind === ServiceEntitlementLedgerKind.EXPIRE
          || kind === ServiceEntitlementLedgerKind.ADJUST,
      )
    ) {
      addWarning(issueFor({
        code: "unsupported_entitlement_ledger_semantics",
        domain: "entitlement",
        representative,
        unit: "count",
        expected: null,
        actual: null,
        currency: context.currency,
        references,
      }));
    }
  }
}

function reconcilePurchases(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
  representativeById: Map<string, ReconciliationRepresentative>,
  walletById: Map<
    string,
    WorkspaceWalletReconciliationDataset["userAgentWallets"][number]
  >,
  addCheck: CheckFunction,
  addWarning: WarningFunction,
) {
  for (const purchase of dataset.purchases) {
    const representative = representativeById.get(purchase.representativeId) ?? null;
    const wallet = purchase.userAgentWalletId
      ? walletById.get(purchase.userAgentWalletId)
      : null;
    const references = [
      { kind: "AgentTokenPurchase", id: purchase.id },
      ...(wallet ? [{ kind: "UserAgentWallet", id: wallet.id }] : []),
    ];
    const validDimensions =
      Number.isInteger(purchase.amountCents)
      && purchase.amountCents > 0
      && Number.isInteger(purchase.tokenAmount)
      && purchase.tokenAmount > 0
      && Number.isInteger(purchase.tokenUnitPriceCents)
      && purchase.tokenUnitPriceCents > 0
      && Number.isInteger(purchase.creatorRevenueShareBps)
      && purchase.creatorRevenueShareBps >= 0
      && purchase.creatorRevenueShareBps <= 10_000
      && Number.isInteger(purchase.creatorPendingCents)
      && purchase.creatorPendingCents >= 0;
    addCheck(validDimensions, issueFor({
      code: "purchase_dimensions_invalid",
      domain: "purchase",
      representative,
      unit: "count",
      expected: 1,
      actual: validDimensions ? 1 : 0,
      currency: purchase.currency,
      references,
    }));
    addCheck(
      Boolean(
        wallet
        && wallet.userWalletId === purchase.userWalletId
        && wallet.agentWalletId === purchase.agentWalletId
        && purchase.currency === context.currency,
      ),
      issueFor({
        code: purchase.userAgentWalletId
          ? "purchase_scope_mismatch"
          : "legacy_purchase_scope_coverage",
        severity: purchase.userAgentWalletId ? "error" : "warning",
        domain: "purchase",
        representative,
        unit: "count",
        expected: 1,
        actual: wallet ? 1 : 0,
        currency: context.currency,
        references,
      }),
    );
    checkNumericProjection(addCheck, {
      code: "purchase_arithmetic_mismatch",
      domain: "purchase",
      representative,
      unit: "minor_currency",
      expected: purchase.tokenAmount * purchase.tokenUnitPriceCents,
      actual: purchase.amountCents,
      currency: context.currency,
      references,
    });
    checkNumericProjection(addCheck, {
      code: "purchase_creator_share_mismatch",
      domain: "purchase",
      representative,
      unit: "minor_currency",
      expected: Math.floor(
        purchase.amountCents * purchase.creatorRevenueShareBps / 10_000,
      ),
      actual: purchase.creatorPendingCents,
      currency: context.currency,
      references,
    });
    if (purchase.remainingTokenAmount !== null) {
      addCheck(
        purchase.remainingTokenAmount >= 0
          && purchase.remainingTokenAmount <= purchase.tokenAmount,
        issueFor({
          code: "purchase_remaining_out_of_range",
          domain: "purchase",
          representative,
          unit: "tokens",
          expected: purchase.tokenAmount,
          actual: purchase.remainingTokenAmount,
          currency: context.currency,
          references,
        }),
      );
    }
    const creatorEarnings = dataset.creatorEarnings.filter(
      (earning) => earning.tokenPurchaseId === purchase.id,
    );
    const releasedCreatorCents = dataset.usageCharges.reduce(
      (total, usage) =>
        total + usage.allocations
          .filter((allocation) => allocation.tokenPurchaseId === purchase.id)
          .reduce(
            (sum, allocation) => sum + allocation.creatorReleaseCents,
            0,
          ),
      0,
    );
    if (purchase.remainingTokenAmount === null) {
      if (purchase.creatorPendingCents > 0) {
        addWarning(issueFor({
          code: "legacy_creator_liability_coverage",
          domain: "earning",
          representative,
          unit: "minor_currency",
          expected: purchase.creatorPendingCents,
          actual: null,
          currency: purchase.currency,
          references,
        }));
      }
    } else if (validDimensions) {
      const pendingCreatorCents =
        purchase.remainingTokenAmount === 0
          ? 0
          : purchase.creatorPendingCents
            - Math.floor(
              purchase.creatorPendingCents
                * (purchase.tokenAmount - purchase.remainingTokenAmount)
                / purchase.tokenAmount,
            );
      const actualCreatorLiability = creatorEarnings.reduce(
        (sum, earning) =>
          sum
          + earning.pendingCents
          + earning.withdrawableCents
          + earning.frozenCents
          + earning.withdrawnCents,
        0,
      );
      checkNumericProjection(addCheck, {
        code: "purchase_creator_liability_mismatch",
        domain: "earning",
        representative,
        unit: "minor_currency",
        expected: pendingCreatorCents + releasedCreatorCents,
        actual: actualCreatorLiability,
        currency: purchase.currency,
        references: [
          ...references,
          ...creatorEarnings.map((earning) => ({
            kind: "CreatorEarning",
            id: earning.id,
          })),
        ],
      });
    }
    addCheck(
      creatorEarnings.every(
        (earning) =>
          earning.ownerId === representative?.ownerId
          && earning.representativeId === purchase.representativeId
          && earning.agentWalletId === purchase.agentWalletId
          && earning.currency === purchase.currency,
      ),
      issueFor({
        code: "creator_earning_scope_mismatch",
        domain: "earning",
        representative,
        unit: "count",
        expected: creatorEarnings.length,
        actual: creatorEarnings.filter(
          (earning) =>
            earning.ownerId === representative?.ownerId
            && earning.representativeId === purchase.representativeId
            && earning.agentWalletId === purchase.agentWalletId
            && earning.currency === purchase.currency,
        ).length,
        currency: purchase.currency,
        references: [
          ...references,
          ...creatorEarnings.map((earning) => ({
            kind: "CreatorEarning",
            id: earning.id,
          })),
        ],
      }),
    );
  }
}

function reconcileUsageCharges(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
  representativeById: Map<string, ReconciliationRepresentative>,
  walletById: Map<
    string,
    WorkspaceWalletReconciliationDataset["userAgentWallets"][number]
  >,
  earningById: Map<
    string,
    WorkspaceWalletReconciliationDataset["creatorEarnings"][number]
  >,
  addCheck: CheckFunction,
) {
  for (const usage of dataset.usageCharges) {
    const representative = representativeById.get(usage.representativeId) ?? null;
    const wallet = usage.userAgentWalletId
      ? walletById.get(usage.userAgentWalletId)
      : null;
    const references = [{ kind: "AgentUsageCharge", id: usage.id }];
    addCheck(
      Boolean(
        wallet
        && wallet.agentWalletId === usage.agentWalletId
        && usage.currency === context.currency,
      ),
      issueFor({
        code: usage.userAgentWalletId
          ? "usage_scope_mismatch"
          : "legacy_usage_scope_coverage",
        severity: usage.userAgentWalletId ? "error" : "warning",
        domain: "usage",
        representative,
        unit: "count",
        expected: 1,
        actual: wallet ? 1 : 0,
        currency: context.currency,
        references,
      }),
    );
    if (
      usage.status === AgentUsageChargeStatus.SETTLED
      || usage.status === AgentUsageChargeStatus.APPLIED
    ) {
      const allocationTokens = usage.allocations.reduce(
        (sum, allocation) => sum + allocation.tokenAmount,
        0,
      );
      const allocationValue = usage.allocations.reduce(
        (sum, allocation) => sum + allocation.valueCents,
        0,
      );
      const creatorRelease = usage.allocations.reduce(
        (sum, allocation) => sum + allocation.creatorReleaseCents,
        0,
      );
      if (
        usage.status === AgentUsageChargeStatus.APPLIED
        && usage.allocations.length === 0
      ) {
        addCheck(false, issueFor({
          code: "legacy_usage_allocation_coverage",
          severity: "warning",
          domain: "usage",
          representative,
          unit: "count",
          expected: 1,
          actual: 0,
          currency: context.currency,
          references,
        }));
      } else {
        checkNumericProjection(addCheck, {
          code: "usage_allocation_token_mismatch",
          domain: "usage",
          representative,
          unit: "tokens",
          expected: usage.settledTokenAmount,
          actual: allocationTokens,
          currency: context.currency,
          references,
        });
        checkNumericProjection(addCheck, {
          code: "usage_allocation_value_mismatch",
          domain: "usage",
          representative,
          unit: "minor_currency",
          expected: usage.platformRevenueCents + creatorRelease,
          actual: allocationValue,
          currency: context.currency,
          references,
        });
      }
    }
    for (const allocation of usage.allocations) {
      addCheck(
        allocation.currency === usage.currency,
        issueFor({
          code: "usage_allocation_currency_mismatch",
          domain: "usage",
          representative,
          unit: "count",
          expected: null,
          actual: null,
          currency: context.currency,
          references: [
            ...references,
            { kind: "AgentUsageAllocation", id: allocation.id },
          ],
        }),
      );
      const creatorEarning = allocation.creatorEarningId
        ? earningById.get(allocation.creatorEarningId)
        : null;
      const creatorLiability = creatorEarning
        ? creatorEarning.pendingCents
          + creatorEarning.withdrawableCents
          + creatorEarning.frozenCents
          + creatorEarning.withdrawnCents
        : 0;
      const creatorLinkMatches =
        allocation.creatorReleaseCents === 0
          ? allocation.creatorEarningId === null
          : Boolean(
              creatorEarning
              && creatorEarning.tokenPurchaseId === allocation.tokenPurchaseId
              && creatorEarning.usageChargeId === usage.id
              && creatorEarning.representativeId === usage.representativeId
              && creatorEarning.agentWalletId === usage.agentWalletId
              && creatorEarning.currency === usage.currency
              && creatorLiability === allocation.creatorReleaseCents,
            );
      addCheck(creatorLinkMatches, issueFor({
        code: "usage_creator_earning_mismatch",
        domain: "earning",
        representative,
        unit: "minor_currency",
        expected: allocation.creatorReleaseCents,
        actual: creatorLiability,
        currency: usage.currency,
        references: [
          ...references,
          { kind: "AgentUsageAllocation", id: allocation.id },
          ...(creatorEarning
            ? [{ kind: "CreatorEarning", id: creatorEarning.id }]
            : []),
        ],
      }));
    }
  }
}

function reconcileCreatorEarnings(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
  representativeById: Map<string, ReconciliationRepresentative>,
  earningById: Map<
    string,
    WorkspaceWalletReconciliationDataset["creatorEarnings"][number]
  >,
  addCheck: CheckFunction,
  addWarning: WarningFunction,
) {
  const activeStatuses = new Set<WithdrawRequestStatus>([
    WithdrawRequestStatus.PENDING_REVIEW,
    WithdrawRequestStatus.APPROVED,
    WithdrawRequestStatus.FAILED,
  ]);
  const activeByEarning = new Map<string, number>();
  const paidByEarning = new Map<string, number>();
  const allocationCountByEarning = new Map<string, number>();
  for (const request of dataset.withdrawRequests) {
    for (const allocation of request.allocations) {
      allocationCountByEarning.set(
        allocation.creatorEarningId,
        (allocationCountByEarning.get(allocation.creatorEarningId) ?? 0) + 1,
      );
      if (activeStatuses.has(request.status) && !allocation.releasedAt && !allocation.paidAt) {
        activeByEarning.set(
          allocation.creatorEarningId,
          (activeByEarning.get(allocation.creatorEarningId) ?? 0)
            + allocation.amountCents,
        );
      }
      if (allocation.paidAt) {
        paidByEarning.set(
          allocation.creatorEarningId,
          (paidByEarning.get(allocation.creatorEarningId) ?? 0)
            + allocation.amountCents,
        );
      }
    }
  }
  for (const earning of dataset.creatorEarnings) {
    const representative = representativeById.get(earning.representativeId) ?? null;
    const references = [{ kind: "CreatorEarning", id: earning.id }];
    const hasAllocationEvidence =
      (allocationCountByEarning.get(earning.id) ?? 0) > 0;
    if (!hasAllocationEvidence && (earning.frozenCents || earning.withdrawnCents)) {
      addWarning(issueFor({
        code: "legacy_withdrawal_allocation_coverage",
        domain: "withdrawal",
        representative,
        unit: "minor_currency",
        expected: earning.frozenCents + earning.withdrawnCents,
        actual: null,
        currency: context.currency,
        references,
      }));
    } else {
      checkNumericProjection(addCheck, {
        code: "creator_frozen_allocation_mismatch",
        domain: "earning",
        representative,
        unit: "minor_currency",
        expected: activeByEarning.get(earning.id) ?? 0,
        actual: earning.frozenCents,
        currency: context.currency,
        references,
      });
      checkNumericProjection(addCheck, {
        code: "creator_withdrawn_allocation_mismatch",
        domain: "earning",
        representative,
        unit: "minor_currency",
        expected: paidByEarning.get(earning.id) ?? 0,
        actual: earning.withdrawnCents,
        currency: context.currency,
        references,
      });
    }
  }

  const accountBuckets: Array<{
    accountType: AmnWalletAccountType;
    field: "pendingCents" | "withdrawableCents" | "frozenCents";
    code: string;
    legacyCode: string;
  }> = [
    {
      accountType: AmnWalletAccountType.CREATOR_PENDING,
      field: "pendingCents",
      code: "creator_pending_ledger_projection_mismatch",
      legacyCode: "legacy_creator_pending_ledger_coverage",
    },
    {
      accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
      field: "withdrawableCents",
      code: "creator_withdrawable_ledger_projection_mismatch",
      legacyCode: "legacy_creator_withdrawable_ledger_coverage",
    },
    {
      accountType: AmnWalletAccountType.CREATOR_FROZEN,
      field: "frozenCents",
      code: "creator_frozen_ledger_projection_mismatch",
      legacyCode: "legacy_creator_frozen_ledger_coverage",
    },
  ];
  for (const representative of dataset.representatives) {
    for (const bucket of accountBuckets) {
      const projectedBucket = dataset.creatorEarnings
        .filter((earning) => earning.representativeId === representative.id)
        .reduce((sum, earning) => sum + earning[bucket.field], 0);
      const entries = dataset.ledgerEntries.filter(
        (entry) =>
          entry.accountType === bucket.accountType
          && entry.ownerId === context.ownerId
          && entry.representativeId === representative.id,
      );
      const latest = latestEntry(entries);
      const ledgerProjection = latest?.balanceAfterCents
        ?? (entries.length && entries.every((entry) => entry.transactionId)
          ? entries.reduce((sum, entry) => sum + entry.amountCents, 0)
          : null);
      if (ledgerProjection === null) {
        if (projectedBucket !== 0) {
          addWarning(issueFor({
            code: bucket.legacyCode,
            domain: "ledger",
            representative,
            unit: "minor_currency",
            expected: projectedBucket,
            actual: null,
            currency: context.currency,
            references: dataset.creatorEarnings
              .filter((earning) => earning.representativeId === representative.id)
              .map((earning) => ({ kind: "CreatorEarning", id: earning.id })),
          }));
        } else {
          addCheck(true, issueFor({
            code: bucket.code,
            domain: "ledger",
            representative,
            unit: "minor_currency",
            expected: 0,
            actual: 0,
            currency: context.currency,
            references: [],
          }));
        }
        continue;
      }
      checkNumericProjection(addCheck, {
        code: bucket.code,
        domain: "ledger",
        representative,
        unit: "minor_currency",
        expected: ledgerProjection,
        actual: projectedBucket,
        currency: context.currency,
        references: entries.map((entry) => ({
          kind: "WalletLedgerEntry",
          id: entry.id,
        })),
      });
    }
  }
  void earningById;
}

function reconcileWithdrawals(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
  representativeById: Map<string, ReconciliationRepresentative>,
  earningById: Map<
    string,
    WorkspaceWalletReconciliationDataset["creatorEarnings"][number]
  >,
  addCheck: CheckFunction,
  addWarning: WarningFunction,
) {
  for (const request of dataset.withdrawRequests) {
    const representative = request.representativeId
      ? representativeById.get(request.representativeId) ?? null
      : null;
    const references = [{ kind: "WithdrawRequest", id: request.id }];
    if (!request.allocations.length) {
      addWarning(issueFor({
        code: "legacy_withdrawal_allocation_coverage",
        domain: "withdrawal",
        representative,
        unit: "minor_currency",
        expected: request.amountCents,
        actual: null,
        currency: context.currency,
        references,
      }));
      continue;
    }
    const allocated = request.allocations.reduce(
      (sum, allocation) => sum + allocation.amountCents,
      0,
    );
    checkNumericProjection(addCheck, {
      code: "withdrawal_allocation_total_mismatch",
      domain: "withdrawal",
      representative,
      unit: "minor_currency",
      expected: request.amountCents,
      actual: allocated,
      currency: context.currency,
      references,
    });
    for (const allocation of request.allocations) {
      const earning = earningById.get(allocation.creatorEarningId);
      addCheck(
        Boolean(
          earning
          && request.ownerId === context.ownerId
          && allocation.creatorEarning.ownerId === context.ownerId
          && request.representativeId === earning.representativeId
          && allocation.creatorEarning.representativeId === earning.representativeId
          && request.currency === allocation.currency
          && allocation.currency === earning.currency,
        ),
        issueFor({
          code: "withdrawal_scope_mismatch",
          domain: "withdrawal",
          representative,
          unit: "count",
          expected: 1,
          actual: earning ? 1 : 0,
          currency: context.currency,
          references: [
            ...references,
            { kind: "WithdrawalAllocation", id: allocation.id },
            { kind: "CreatorEarning", id: allocation.creatorEarningId },
          ],
        }),
      );
      const terminalStateValid =
        request.status === WithdrawRequestStatus.PAID
          ? allocation.paidAt !== null && allocation.releasedAt === null
          : request.status === WithdrawRequestStatus.CANCELED
              || request.status === WithdrawRequestStatus.REJECTED
            ? allocation.releasedAt !== null && allocation.paidAt === null
            : request.status === WithdrawRequestStatus.FAILED
              ? allocation.paidAt === null
            : allocation.releasedAt === null && allocation.paidAt === null;
      addCheck(terminalStateValid, issueFor({
        code: "withdrawal_allocation_state_mismatch",
        domain: "withdrawal",
        representative,
        unit: "count",
        expected: 1,
        actual: terminalStateValid ? 1 : 0,
        currency: context.currency,
        references: [
          ...references,
          { kind: "WithdrawalAllocation", id: allocation.id },
        ],
      }));
    }
  }
}

function reconcileTransactionsAndLedger(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
  representativeById: Map<string, ReconciliationRepresentative>,
  addCheck: CheckFunction,
  addWarning: WarningFunction,
) {
  const transactionByEventGroup = new Map(
    dataset.walletTransactions.map((transaction) => [
      transaction.eventGroupId,
      transaction,
    ]),
  );
  const entriesByEventGroup = new Map<
    string,
    WorkspaceWalletReconciliationDataset["ledgerEntries"]
  >();
  for (const entry of dataset.ledgerEntries) {
    const entries = entriesByEventGroup.get(entry.eventGroupId) ?? [];
    entries.push(entry);
    entriesByEventGroup.set(entry.eventGroupId, entries);
  }
  for (const [eventGroupId, entries] of entriesByEventGroup) {
    const transaction = transactionByEventGroup.get(eventGroupId);
    const representativeId =
      transaction?.representativeId
      ?? entries.find((entry) => entry.representativeId)?.representativeId
      ?? null;
    const representative = representativeId
      ? representativeById.get(representativeId) ?? null
      : null;
    const references = [
      ...(transaction
        ? [{ kind: "WalletTransaction", id: transaction.id }]
        : []),
      ...entries.map((entry) => ({ kind: "WalletLedgerEntry", id: entry.id })),
    ];
    checkNumericProjection(addCheck, {
      code: "ledger_event_group_amount_unbalanced",
      domain: "ledger",
      representative,
      unit: "minor_currency",
      expected: 0,
      actual: entries.reduce((sum, entry) => sum + entry.amountCents, 0),
      currency: context.currency,
      references,
    });
    addCheck(
      entries.every((entry) => entry.currency === context.currency)
        && (!transaction || transaction.currency === context.currency),
      issueFor({
        code: "ledger_event_group_currency_mismatch",
        domain: "ledger",
        representative,
        unit: "count",
        expected: null,
        actual: null,
        currency: context.currency,
        references,
      }),
    );
    if (!transaction) {
      addWarning(issueFor({
        code: "legacy_transaction_header_coverage",
        domain: "ledger",
        representative,
        unit: "count",
        expected: 1,
        actual: 0,
        currency: context.currency,
        references,
      }));
      continue;
    }
    addCheck(
      entries.every(
        (entry) =>
          entry.transactionId === null || entry.transactionId === transaction.id,
      ),
      issueFor({
        code: "ledger_transaction_link_mismatch",
        domain: "ledger",
        representative,
        unit: "count",
        expected: 1,
        actual: 0,
        currency: context.currency,
        references,
      }),
    );
    if (entries.some((entry) => entry.transactionId === null)) {
      addWarning(issueFor({
        code: "legacy_ledger_transaction_link_coverage",
        domain: "ledger",
        representative,
        unit: "count",
        expected: entries.length,
        actual: entries.filter((entry) => entry.transactionId !== null).length,
        currency: context.currency,
        references,
      }));
    }
  }
  for (const transaction of dataset.walletTransactions) {
    if (
      entriesByEventGroup.has(transaction.eventGroupId)
      || walletTransactionMayOmitLedger(transaction)
    ) {
      continue;
    }
    const representative = transaction.representativeId
      ? representativeById.get(transaction.representativeId) ?? null
      : null;
    addCheck(false, issueFor({
      code: "wallet_transaction_without_ledger",
      domain: "ledger",
      representative,
      unit: "count",
      expected: 1,
      actual: 0,
      currency: context.currency,
      references: [{ kind: "WalletTransaction", id: transaction.id }],
    }));
  }
}

function reconcileUserCash(
  dataset: WorkspaceWalletReconciliationDataset,
  context: ReconciliationContext,
  addCheck: CheckFunction,
  addWarning: WarningFunction,
) {
  for (const wallet of dataset.userWallets) {
    const latest = latestEntry(
      dataset.cashLedgerEntries.filter(
        (entry) => entry.userWalletId === wallet.id,
      ),
    );
    const references = [{ kind: "UserWallet", id: wallet.id }];
    if (!latest || latest.balanceAfterCents === null) {
      if (wallet.cashBalanceCents !== 0) {
        addWarning(issueFor({
          code: "legacy_user_cash_ledger_coverage",
          domain: "ledger",
          representative: null,
          unit: "minor_currency",
          expected: wallet.cashBalanceCents,
          actual: null,
          currency: context.currency,
          references,
        }));
      } else {
        addCheck(true, issueFor({
          code: "user_cash_ledger_projection_mismatch",
          domain: "ledger",
          representative: null,
          unit: "minor_currency",
          expected: 0,
          actual: 0,
          currency: context.currency,
          references,
        }));
      }
      continue;
    }
    checkNumericProjection(addCheck, {
      code: "user_cash_ledger_projection_mismatch",
      domain: "ledger",
      representative: null,
      unit: "minor_currency",
      expected: latest.balanceAfterCents,
      actual: wallet.cashBalanceCents,
      currency: context.currency,
      references: [
        ...references,
        { kind: "WalletLedgerEntry", id: latest.id },
      ],
    });
  }
}

type CheckFunction = (
  condition: boolean,
  issue: Omit<WorkspaceWalletReconciliationIssue, "id">,
) => void;

type WarningFunction = (
  issue: Omit<WorkspaceWalletReconciliationIssue, "id">,
) => void;

function checkNumericProjection(
  addCheck: CheckFunction,
  input: {
    code: string;
    domain: WorkspaceWalletReconciliationIssue["domain"];
    representative: ReconciliationRepresentative | null;
    unit: WorkspaceWalletReconciliationUnit;
    expected: number;
    actual: number;
    currency: string | null;
    references: WorkspaceWalletReconciliationReference[];
  },
) {
  addCheck(input.expected === input.actual, issueFor(input));
}

function issueFor(input: {
  code: string;
  severity?: WorkspaceWalletReconciliationSeverity;
  domain: WorkspaceWalletReconciliationIssue["domain"];
  representative: ReconciliationRepresentative | null;
  unit: WorkspaceWalletReconciliationUnit;
  expected: number | null;
  actual: number | null;
  currency: string | null;
  references: WorkspaceWalletReconciliationReference[];
}): Omit<WorkspaceWalletReconciliationIssue, "id"> {
  return {
    code: input.code,
    severity: input.severity ?? "error",
    domain: input.domain,
    representativeSlug: input.representative?.slug ?? null,
    representativeName: input.representative?.displayName ?? null,
    unit: input.unit,
    expectedValue: input.expected,
    actualValue: input.actual,
    differenceValue:
      input.expected === null || input.actual === null
        ? null
        : input.actual - input.expected,
    currency: input.currency,
    references: input.references,
  };
}

function withIssueId(
  issue: Omit<WorkspaceWalletReconciliationIssue, "id">,
): WorkspaceWalletReconciliationIssue {
  const identity = JSON.stringify([
    issue.code,
    issue.domain,
    issue.unit,
    issue.representativeSlug,
    issue.currency,
    issue.expectedValue,
    issue.actualValue,
    issue.references.map((reference) => [reference.kind, reference.id]),
  ]);
  return {
    id: `${issue.code}:${stableIdentityHash(identity)}`,
    ...issue,
  };
}

function stableIdentityHash(value: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function walletTransactionMayOmitLedger(
  transaction: WorkspaceWalletReconciliationDataset["walletTransactions"][number],
) {
  if (transaction.sourceType === "AgentUsageEntitlementTransfer") return true;
  if (transaction.sourceType !== "WithdrawRequest") return false;
  const metadata = jsonObject(transaction.metadata);
  return metadata.operation === "approve"
    || (
      metadata.operation === "mark_failed"
      && metadata.permanent !== true
    );
}

function jsonObject(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function compareIssues(
  left: WorkspaceWalletReconciliationIssue,
  right: WorkspaceWalletReconciliationIssue,
) {
  const severity =
    Number(right.severity === "error") - Number(left.severity === "error");
  if (severity) return severity;
  return left.code.localeCompare(right.code)
    || (left.representativeSlug ?? "").localeCompare(
      right.representativeSlug ?? "",
    )
    || left.id.localeCompare(right.id);
}

function representativeForAgentWallet(
  representatives: ReconciliationRepresentative[],
  agentWalletId: string,
) {
  return representatives.find(
    (representative) => representative.agentWallet?.id === agentWalletId,
  ) ?? null;
}

function entitlementCoordinate(
  representativeId: string,
  audienceIdentityId: string,
) {
  return `${representativeId}:${audienceIdentityId}`;
}

function latestEntry<T extends { createdAt: Date; id: string }>(
  entries: T[],
): T | null {
  return entries.reduce<T | null>((latest, entry) => {
    if (!latest) return entry;
    const timeDifference = entry.createdAt.getTime() - latest.createdAt.getTime();
    if (timeDifference > 0 || (timeDifference === 0 && entry.id > latest.id)) {
      return entry;
    }
    return latest;
  }, null);
}

function normalizeBaseInput(input: WorkspaceWalletReconciliationInput) {
  const ownerId = input.ownerId.trim();
  const activeRepresentativeSlug = input.activeRepresentativeSlug.trim();
  const representative = input.representative?.trim() || "all";
  if (!ownerId) {
    throw new WorkspaceWalletReconciliationInputError("ownerId is required.");
  }
  if (!activeRepresentativeSlug) {
    throw new WorkspaceWalletReconciliationInputError(
      "activeRepresentativeSlug is required.",
    );
  }
  return {
    ownerId,
    activeRepresentativeSlug,
    representative,
    currency: input.currency ? normalizeCurrency(input.currency) : null,
    issueLimit: normalizeIssueLimit(input.issueLimit),
  };
}

function normalizeCurrency(value: string) {
  const currency = value.trim().toUpperCase();
  if (!currencyPattern.test(currency)) {
    throw new WorkspaceWalletReconciliationInputError(
      "Invalid wallet currency.",
    );
  }
  return currency;
}

function normalizeIssueLimit(value: number | undefined) {
  if (value === undefined) return defaultIssueLimit;
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkspaceWalletReconciliationInputError(
      "Reconciliation issue limit must be a positive integer.",
    );
  }
  return Math.min(value, maximumIssueLimit);
}
