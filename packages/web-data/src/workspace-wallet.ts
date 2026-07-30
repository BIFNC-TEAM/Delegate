import {
  AmnLedgerEntryKind,
  CreatorPayoutProfileStatus,
  CreatorVerificationStatus,
  PayoutDestinationStatus,
  PayoutSubjectType,
  Prisma,
  WalletTransactionEventType,
  WithdrawRequestStatus,
} from "@prisma/client";

import { prisma } from "./prisma";

export type WorkspaceWalletView =
  | "overview"
  | "transactions"
  | "settlements"
  | "ledger";

export type WorkspaceWalletEvent = {
  id: string;
  eventType: string;
  status: string;
  representativeSlug: string | null;
  representativeName: string | null;
  title: string;
  description: string;
  amountCents: number;
  tokenAmount: number;
  currency: string;
  sourceType: string;
  sourceId: string | null;
  occurredAt: string;
  transactionId: string | null;
  eventGroupId: string;
};

export type WorkspaceWalletSettlement = {
  id: string;
  representativeSlug: string | null;
  representativeName: string | null;
  status: string;
  amountCents: number;
  currency: string;
  provider: string | null;
  providerPayoutId: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  paidAt: string | null;
  failureReason: string | null;
  transactionId: string | null;
  eventGroupId: string | null;
  cancelable: boolean;
};

export type WorkspaceWalletRepresentative = {
  slug: string;
  name: string;
  withdrawableCents: number;
  payoutInProgressCents: number;
  activeWithdrawRequest: {
    id: string;
    status: string;
    amountCents: number;
    currency: string;
    requestedAt: string;
    cancelable: boolean;
  } | null;
};

export type WorkspaceWalletLedgerEntry = {
  id: string;
  transactionId: string | null;
  eventGroupId: string;
  representativeSlug: string | null;
  representativeName: string | null;
  accountType: string;
  entryKind: string;
  amountCents: number;
  tokenAmount: number;
  currency: string;
  balanceAfterCents: number | null;
  tokenBalanceAfter: number | null;
  notes: string | null;
  createdAt: string;
};

export type WorkspaceWalletSnapshot = {
  workspace: {
    ownerId: string;
    representativeCount: number;
    asOf: string;
  };
  representatives: WorkspaceWalletRepresentative[];
  currencies: string[];
  filters: {
    view: WorkspaceWalletView;
    representative: string;
    currency: string;
    eventType: string;
    query: string;
    from: string;
    to: string;
  };
  metrics: {
    grossSalesCents: number;
    releasedCreatorIncomeCents: number;
    pendingEarningsCents: number;
    withdrawableCents: number;
    payoutInProgressCents: number;
  };
  primaryAction: {
    kind: "withdraw" | "verify" | "payout_profile" | "none";
    reason: string | null;
  };
  eventTypes: Array<{ id: string; count: number }>;
  page: {
    filteredTotal: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  events: WorkspaceWalletEvent[];
  settlements: WorkspaceWalletSettlement[];
  ledgerEntries: WorkspaceWalletLedgerEntry[];
};

export type WorkspaceWalletQueryInput = {
  ownerId: string;
  activeRepresentativeSlug: string;
  view?: WorkspaceWalletView;
  representative?: string;
  currency?: string;
  eventType?: string;
  query?: string;
  from?: string;
  to?: string;
  asOf?: string;
  cursor?: string;
  limit?: number;
};

export class WorkspaceWalletInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceWalletInputError";
  }
}

type WorkspaceWalletClient = Pick<
  typeof prisma,
  | "owner"
  | "representative"
  | "agentWallet"
  | "agentTokenPurchase"
  | "creatorEarning"
  | "walletTransaction"
  | "walletLedgerEntry"
  | "withdrawRequest"
> & {
  payoutDestination?: Pick<typeof prisma.payoutDestination, "findFirst">;
};

export type WorkspaceWalletCursor = {
  view: WorkspaceWalletView;
  occurredAt: Date;
  id: string;
  asOf: Date;
  scope: string;
};

type NormalizedWorkspaceWalletQuery = {
  ownerId: string;
  activeRepresentativeSlug: string;
  view: WorkspaceWalletView;
  representative: string;
  representativeId: string | null;
  representativeIds: string[];
  currency: string;
  eventType: string;
  query: string;
  from: string;
  to: string;
  periodStart: Date;
  periodEnd: Date;
  asOf: Date;
  cursor: WorkspaceWalletCursor | null;
  limit: number;
};

type EventPage = {
  filteredTotal: number;
  eventTypes: Array<{ id: string; count: number }>;
  rows: WorkspaceWalletEvent[];
  hasMore: boolean;
  nextCursor: string | null;
};

type SettlementPage = {
  filteredTotal: number;
  rows: WorkspaceWalletSettlement[];
  hasMore: boolean;
  nextCursor: string | null;
};

type LedgerPage = {
  filteredTotal: number;
  rows: WorkspaceWalletLedgerEntry[];
  hasMore: boolean;
  nextCursor: string | null;
};

const supportedViews = new Set<WorkspaceWalletView>([
  "overview",
  "transactions",
  "settlements",
  "ledger",
]);
const supportedEventTypes = new Set(
  Object.values(WalletTransactionEventType).map((value) => value.toLowerCase()),
);
const cancelableWithdrawRequestStatuses = new Set<WithdrawRequestStatus>([
  WithdrawRequestStatus.PENDING_REVIEW,
  WithdrawRequestStatus.APPROVED,
  WithdrawRequestStatus.FAILED,
]);
const maximumPageSize = 200;
const defaultPageSize = 50;
const maximumQueryLength = 200;
const currencyPattern = /^[A-Z][A-Z0-9]{2,7}$/;

const representativeSelect = Prisma.validator<Prisma.RepresentativeSelect>()({
  id: true,
  slug: true,
  displayName: true,
  agentWallet: {
    select: {
      currency: true,
    },
  },
});

const transactionSelect = Prisma.validator<Prisma.WalletTransactionSelect>()({
  id: true,
  eventGroupId: true,
  sourceType: true,
  sourceId: true,
  eventType: true,
  status: true,
  currency: true,
  occurredAt: true,
  metadata: true,
  representative: {
    select: {
      slug: true,
      displayName: true,
    },
  },
  ledgerEntries: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      accountType: true,
      entryKind: true,
      amountCents: true,
      tokenAmount: true,
    },
  },
});

const legacyLedgerSelect = Prisma.validator<Prisma.WalletLedgerEntrySelect>()({
  id: true,
  eventGroupId: true,
  entryKind: true,
  accountType: true,
  amountCents: true,
  tokenAmount: true,
  currency: true,
  notes: true,
  createdAt: true,
  rechargeOrderId: true,
  tokenPurchaseId: true,
  usageChargeId: true,
  withdrawRequestId: true,
  representative: {
    select: {
      slug: true,
      displayName: true,
    },
  },
});

const settlementSelect = Prisma.validator<Prisma.WithdrawRequestSelect>()({
  id: true,
  status: true,
  amountCents: true,
  currency: true,
  provider: true,
  providerPayoutId: true,
  requestedAt: true,
  reviewedAt: true,
  reviewedBy: true,
  paidAt: true,
  failureReason: true,
  allocations: {
    where: {
      releasedAt: null,
      paidAt: null,
    },
    take: 1,
    select: {
      id: true,
    },
  },
  ledgerEntries: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: {
      transactionId: true,
      eventGroupId: true,
    },
  },
  representative: {
    select: {
      slug: true,
      displayName: true,
    },
  },
});

const representativeWithdrawalSelect =
  Prisma.validator<Prisma.WithdrawRequestSelect>()({
    id: true,
    representativeId: true,
    status: true,
    amountCents: true,
    currency: true,
    requestedAt: true,
    allocations: {
      where: {
        releasedAt: null,
        paidAt: null,
      },
      take: 1,
      select: {
        id: true,
      },
    },
  });

const ledgerSelect = Prisma.validator<Prisma.WalletLedgerEntrySelect>()({
  id: true,
  transactionId: true,
  eventGroupId: true,
  accountType: true,
  entryKind: true,
  amountCents: true,
  tokenAmount: true,
  currency: true,
  balanceAfterCents: true,
  tokenBalanceAfter: true,
  notes: true,
  createdAt: true,
  representative: {
    select: {
      slug: true,
      displayName: true,
    },
  },
});

type TransactionRecord = Prisma.WalletTransactionGetPayload<{
  select: typeof transactionSelect;
}>;
type LegacyLedgerRecord = Prisma.WalletLedgerEntryGetPayload<{
  select: typeof legacyLedgerSelect;
}>;
type SettlementRecord = Prisma.WithdrawRequestGetPayload<{
  select: typeof settlementSelect;
}>;
type RepresentativeWithdrawalRecord = Prisma.WithdrawRequestGetPayload<{
  select: typeof representativeWithdrawalSelect;
}>;
type LedgerRecord = Prisma.WalletLedgerEntryGetPayload<{
  select: typeof ledgerSelect;
}>;

export async function getWorkspaceWalletSnapshot(
  input: WorkspaceWalletQueryInput,
  client: WorkspaceWalletClient = prisma,
): Promise<WorkspaceWalletSnapshot | null> {
  const ownerId = input.ownerId.trim();
  const activeRepresentativeSlug = input.activeRepresentativeSlug.trim();
  if (!ownerId) throw new WorkspaceWalletInputError("ownerId is required.");
  if (!activeRepresentativeSlug) {
    throw new WorkspaceWalletInputError("activeRepresentativeSlug is required.");
  }
  const [owner, representatives] = await Promise.all([
    client.owner.findUnique({
      where: { id: ownerId },
      select: { id: true, creatorVerificationStatus: true },
    }),
    client.representative.findMany({
      where: { ownerId },
      orderBy: [{ displayName: "asc" }, { slug: "asc" }],
      select: representativeSelect,
    }),
  ]);
  if (!owner) return null;

  const activeRepresentative = representatives.find(
    (representative) => representative.slug === activeRepresentativeSlug,
  );
  if (!activeRepresentative) return null;

  const representativeIds = representatives.map((representative) => representative.id);
  const currencies = await findWorkspaceWalletCurrencies(
    ownerId,
    representativeIds,
    representatives
      .map((representative) => representative.agentWallet?.currency)
      .filter((currency): currency is string => Boolean(currency)),
    client,
  );
  const normalized = normalizeWorkspaceWalletQuery(
    input,
    {
      ownerId,
      activeRepresentativeSlug,
      representatives,
      representativeIds,
      currencies,
      preferredCurrency: activeRepresentative.agentWallet?.currency ?? null,
    },
  );

  const [
    activePayoutDestination,
    metricResult,
    eventPage,
    settlementPage,
    ledgerPage,
  ] = await Promise.all([
    client.payoutDestination
      ? client.payoutDestination.findFirst({
          where: {
            currency: normalized.currency,
            status: PayoutDestinationStatus.ACTIVE,
            OR: [
              { coolingOffUntil: null },
              { coolingOffUntil: { lte: new Date() } },
            ],
            profile: {
              status: CreatorPayoutProfileStatus.VERIFIED,
              OR: [
                {
                  ownerId,
                  subjectType: PayoutSubjectType.OWNER,
                },
                {
                  subjectType: PayoutSubjectType.ORGANIZATION,
                  organization: {
                    members: {
                      some: {
                        ownerId,
                        canManageBilling: true,
                      },
                    },
                  },
                },
              ],
            },
          },
          select: { id: true },
        })
      : Promise.resolve({ id: "embedded-client-payout-destination" }),
    loadWorkspaceWalletMetrics(normalized, client),
    normalized.view === "overview" || normalized.view === "transactions"
      ? loadWorkspaceWalletEvents(normalized, client)
      : emptyEventPage(),
    normalized.view === "overview" || normalized.view === "settlements"
      ? loadWorkspaceWalletSettlements(normalized, client)
      : emptySettlementPage(),
    normalized.view === "ledger"
      ? loadWorkspaceWalletLedger(normalized, client)
      : emptyLedgerPage(),
  ]);
  const representativeWithdrawalStates =
    await loadWorkspaceRepresentativeWithdrawalStates(
      normalized,
      representatives,
      client,
    );

  const activePage = normalized.view === "settlements"
    ? settlementPage
    : normalized.view === "ledger"
      ? ledgerPage
      : eventPage;
  const metrics = metricResult.metrics;
  const actionScope = normalized.representativeId
    ? representativeWithdrawalStates.filter(
        (representative) =>
          representative.slug === normalized.representative,
      )
    : representativeWithdrawalStates;
  const eligibleWithdrawableCents = actionScope.reduce(
    (sum, representative) =>
      sum
      + (representative.activeWithdrawRequest
        ? 0
        : representative.withdrawableCents),
    0,
  );
  const hasBlockingPayout = eligibleWithdrawableCents === 0
    && actionScope.some(
      (representative) => representative.activeWithdrawRequest !== null,
    );
  const primaryAction = resolveWorkspaceWalletPrimaryAction({
    creatorVerificationStatus: owner.creatorVerificationStatus,
    hasVerifiedPayoutDestination: Boolean(activePayoutDestination),
    withdrawableCents: eligibleWithdrawableCents,
    hasPayoutInProgress: hasBlockingPayout,
  });

  return {
    workspace: {
      ownerId,
      representativeCount: representatives.length,
      asOf: normalized.asOf.toISOString(),
    },
    representatives: representativeWithdrawalStates,
    currencies,
    filters: {
      view: normalized.view,
      representative: normalized.representative,
      currency: normalized.currency,
      eventType: normalized.eventType,
      query: normalized.query,
      from: normalized.from,
      to: normalized.to,
    },
    metrics,
    primaryAction,
    eventTypes: eventPage.eventTypes,
    page: {
      filteredTotal: activePage.filteredTotal,
      limit: normalized.limit,
      hasMore: activePage.hasMore,
      nextCursor: activePage.nextCursor,
    },
    events: eventPage.rows,
    settlements: settlementPage.rows,
    ledgerEntries: ledgerPage.rows,
  };
}

async function findWorkspaceWalletCurrencies(
  ownerId: string,
  representativeIds: string[],
  walletCurrencies: string[],
  client: WorkspaceWalletClient,
): Promise<string[]> {
  const ledgerScope = walletLedgerOwnerScope(ownerId, representativeIds);
  const [earningCurrencies, transactionCurrencies, ledgerCurrencies] = await Promise.all([
    client.creatorEarning.groupBy({
      by: ["currency"],
      where: { ownerId },
    }),
    client.walletTransaction.groupBy({
      by: ["currency"],
      where: walletTransactionOwnerScope(ownerId, representativeIds),
    }),
    representativeIds.length
      ? client.walletLedgerEntry.groupBy({
          by: ["currency"],
          where: ledgerScope,
        })
      : Promise.resolve([]),
  ]);
  const currencies = new Set([
    ...walletCurrencies,
    ...earningCurrencies.map((entry) => entry.currency),
    ...transactionCurrencies.map((entry) => entry.currency),
    ...ledgerCurrencies.map((entry) => entry.currency),
  ]);
  if (!currencies.size) currencies.add("CNY");
  return [...currencies].sort();
}

function normalizeWorkspaceWalletQuery(
  input: WorkspaceWalletQueryInput,
  context: {
    ownerId: string;
    activeRepresentativeSlug: string;
    representatives: Array<{
      id: string;
      slug: string;
      displayName: string;
      agentWallet: { currency: string } | null;
    }>;
    representativeIds: string[];
    currencies: string[];
    preferredCurrency: string | null;
  },
): NormalizedWorkspaceWalletQuery {
  const view = input.view ?? "overview";
  if (!supportedViews.has(view)) {
    throw new WorkspaceWalletInputError("Invalid wallet view.");
  }

  const cursor = decodeWorkspaceWalletCursor(input.cursor);
  if (cursor && cursor.view !== view) {
    throw new WorkspaceWalletInputError("Wallet cursor does not match the selected view.");
  }
  const requestedAsOf = input.asOf ? parseIsoTimestamp(input.asOf, "asOf") : null;
  if (
    cursor
    && requestedAsOf
    && cursor.asOf.getTime() !== requestedAsOf.getTime()
  ) {
    throw new WorkspaceWalletInputError("Wallet cursor does not match the requested snapshot.");
  }
  const asOf = cursor?.asOf ?? requestedAsOf ?? new Date();

  const representative = input.representative?.trim() || "all";
  const selectedRepresentative = representative === "all"
    ? null
    : context.representatives.find((item) => item.slug === representative);
  if (representative !== "all" && !selectedRepresentative) {
    throw new WorkspaceWalletInputError(
      "Selected representative does not belong to this workspace.",
    );
  }

  const rawCurrency = input.currency?.trim().toUpperCase()
    || context.preferredCurrency
    || context.currencies[0]
    || "CNY";
  const currency = normalizeWorkspaceWalletCurrency(rawCurrency, context.currencies);
  const eventType = input.eventType?.trim().toLowerCase() || "all";
  if (eventType !== "all" && !supportedEventTypes.has(eventType)) {
    throw new WorkspaceWalletInputError("Invalid wallet event type.");
  }

  const query = input.query?.trim() ?? "";
  if (query.length > maximumQueryLength) {
    throw new WorkspaceWalletInputError(
      `Wallet search query cannot exceed ${maximumQueryLength} characters.`,
    );
  }

  const defaultFrom = `${asOf.getUTCFullYear()}-${padDate(asOf.getUTCMonth() + 1)}-01`;
  const defaultTo = formatUtcDate(asOf);
  const from = input.from?.trim() || defaultFrom;
  const to = input.to?.trim() || defaultTo;
  const periodStart = parseUtcDate(from, "from");
  const periodEndByDate = addUtcDays(parseUtcDate(to, "to"), 1);
  if (periodStart >= periodEndByDate) {
    throw new WorkspaceWalletInputError("from must be on or before to.");
  }
  if (periodStart > asOf) {
    throw new WorkspaceWalletInputError("from cannot be after the wallet snapshot.");
  }
  const periodEnd = periodEndByDate < asOf ? periodEndByDate : asOf;
  const cursorScope = buildWorkspaceWalletCursorScope({
    representative,
    currency,
    eventType,
    query,
    from,
    to,
  });
  if (cursor && cursor.scope !== cursorScope) {
    throw new WorkspaceWalletInputError(
      "Wallet cursor does not match the selected filters.",
    );
  }

  return {
    ownerId: context.ownerId,
    activeRepresentativeSlug: context.activeRepresentativeSlug,
    view,
    representative,
    representativeId: selectedRepresentative?.id ?? null,
    representativeIds: context.representativeIds,
    currency,
    eventType,
    query,
    from,
    to,
    periodStart,
    periodEnd,
    asOf,
    cursor,
    limit: normalizeWorkspaceWalletLimit(input.limit),
  };
}

export function normalizeWorkspaceWalletCurrency(
  value: string,
  availableCurrencies: readonly string[],
): string {
  const currency = value.trim().toUpperCase();
  if (!currencyPattern.test(currency)) {
    throw new WorkspaceWalletInputError("Invalid wallet currency.");
  }
  const available = new Set(availableCurrencies.map((item) => item.toUpperCase()));
  if (available.size && !available.has(currency)) {
    throw new WorkspaceWalletInputError(
      "Selected currency is not available in this workspace.",
    );
  }
  return currency;
}

function buildWorkspaceWalletCursorScope(input: {
  representative: string;
  currency: string;
  eventType: string;
  query: string;
  from: string;
  to: string;
}): string {
  return JSON.stringify([
    input.representative,
    input.currency,
    input.eventType,
    input.query,
    input.from,
    input.to,
  ]);
}

function workspaceWalletCursorScope(
  query: NormalizedWorkspaceWalletQuery,
): string {
  return buildWorkspaceWalletCursorScope(query);
}

function normalizeWorkspaceWalletLimit(value: number | undefined): number {
  if (value === undefined) return defaultPageSize;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new WorkspaceWalletInputError("Wallet page limit must be a positive integer.");
  }
  return Math.min(value, maximumPageSize);
}

async function loadWorkspaceRepresentativeWithdrawalStates(
  query: NormalizedWorkspaceWalletQuery,
  representatives: Array<{
    id: string;
    slug: string;
    displayName: string;
  }>,
  client: WorkspaceWalletClient,
): Promise<WorkspaceWalletRepresentative[]> {
  const representativeIds = representatives.map(
    (representative) => representative.id,
  );
  const [earningBalances, activeRequests] = await Promise.all([
    client.creatorEarning.groupBy({
      by: ["representativeId"],
      where: {
        ownerId: query.ownerId,
        representativeId: { in: representativeIds },
        currency: query.currency,
      },
      _sum: {
        withdrawableCents: true,
        frozenCents: true,
      },
    }),
    client.withdrawRequest.findMany({
      where: {
        ownerId: query.ownerId,
        representativeId: { in: representativeIds },
        currency: query.currency,
        status: {
          in: [
            WithdrawRequestStatus.PENDING_REVIEW,
            WithdrawRequestStatus.APPROVED,
            WithdrawRequestStatus.FAILED,
          ],
        },
        allocations: {
          some: {
            releasedAt: null,
            paidAt: null,
          },
        },
      },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      select: representativeWithdrawalSelect,
    }),
  ]);
  const balancesByRepresentative = new Map(
    earningBalances.map((balance) => [
      balance.representativeId,
      {
        withdrawableCents: balance._sum.withdrawableCents ?? 0,
        payoutInProgressCents: balance._sum.frozenCents ?? 0,
      },
    ]),
  );
  const activeRequestByRepresentative = new Map<
    string,
    RepresentativeWithdrawalRecord
  >();
  for (const request of activeRequests) {
    if (
      request.representativeId
      && !activeRequestByRepresentative.has(request.representativeId)
    ) {
      activeRequestByRepresentative.set(request.representativeId, request);
    }
  }

  return representatives.map((representative) => {
    const balances = balancesByRepresentative.get(representative.id);
    const activeRequest = activeRequestByRepresentative.get(representative.id);
    return {
      slug: representative.slug,
      name: representative.displayName,
      withdrawableCents: balances?.withdrawableCents ?? 0,
      payoutInProgressCents: balances?.payoutInProgressCents ?? 0,
      activeWithdrawRequest: activeRequest
        ? {
            id: activeRequest.id,
            status: activeRequest.status.toLowerCase(),
            amountCents: activeRequest.amountCents,
            currency: activeRequest.currency,
            requestedAt: activeRequest.requestedAt.toISOString(),
            cancelable: activeRequest.allocations.length > 0,
          }
        : null,
    };
  });
}

async function loadWorkspaceWalletMetrics(
  query: NormalizedWorkspaceWalletQuery,
  client: WorkspaceWalletClient,
): Promise<{
  metrics: WorkspaceWalletSnapshot["metrics"];
  hasPayoutInProgress: boolean;
}> {
  const earningWhere: Prisma.CreatorEarningWhereInput = {
    ownerId: query.ownerId,
    currency: query.currency,
    ...(query.representativeId
      ? { representativeId: query.representativeId }
      : query.representativeIds.length
        ? { representativeId: { in: query.representativeIds } }
        : {}),
  };
  const releasedWhere: Prisma.WalletLedgerEntryWhereInput = {
    AND: [
      walletLedgerOwnerScope(query.ownerId, query.representativeIds),
      {
        currency: query.currency,
        entryKind: AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
        createdAt: {
          gte: query.periodStart,
          lt: query.periodEnd,
        },
      },
      {
        OR: [
          {
            transaction: {
              is: {
                eventType: {
                  in: [
                    WalletTransactionEventType.USAGE_SETTLEMENT,
                    WalletTransactionEventType.CREATOR_EARNING_RELEASE,
                  ],
                },
              },
            },
          },
          {
            transactionId: null,
            usageChargeId: { not: null },
            withdrawRequestId: null,
          },
        ],
      },
      ...(query.representativeId
        ? [{ representativeId: query.representativeId }]
        : []),
    ],
  };
  const grossSalesWhere: Prisma.WalletLedgerEntryWhereInput = {
    AND: [
      walletLedgerOwnerScope(query.ownerId, query.representativeIds),
      {
        currency: query.currency,
        entryKind: AmnLedgerEntryKind.USER_CASH_DEBIT,
        createdAt: {
          gte: query.periodStart,
          lt: query.periodEnd,
        },
      },
      {
        OR: [
          {
            transaction: {
              is: {
                eventType: WalletTransactionEventType.AGENT_TOKEN_PURCHASE,
              },
            },
          },
          {
            transactionId: null,
            tokenPurchaseId: { not: null },
          },
        ],
      },
      ...(query.representativeId
        ? [{
            tokenPurchase: {
              is: { representativeId: query.representativeId },
            },
          }]
        : []),
    ],
  };

  const [grossSales, releasedIncome, earningBalances, payoutInProgressCount] = await Promise.all([
    client.walletLedgerEntry.aggregate({
      where: grossSalesWhere,
      _sum: { amountCents: true },
    }),
    client.walletLedgerEntry.aggregate({
      where: releasedWhere,
      _sum: { amountCents: true },
    }),
    client.creatorEarning.aggregate({
      where: earningWhere,
      _sum: {
        pendingCents: true,
        withdrawableCents: true,
        frozenCents: true,
      },
    }),
    client.withdrawRequest.count({
      where: {
        ownerId: query.ownerId,
        currency: query.currency,
        status: {
          in: [
            WithdrawRequestStatus.PENDING_REVIEW,
            WithdrawRequestStatus.APPROVED,
          ],
        },
        ...(query.representativeId
          ? { representativeId: query.representativeId }
          : {}),
      },
    }),
  ]);

  const balances = summarizeWorkspaceWalletEarningAggregate(earningBalances._sum);
  return {
    metrics: {
      grossSalesCents: Math.abs(grossSales._sum.amountCents ?? 0),
      releasedCreatorIncomeCents: releasedIncome._sum.amountCents ?? 0,
      pendingEarningsCents: balances.pendingCents,
      withdrawableCents: balances.withdrawableCents,
      payoutInProgressCents: balances.frozenCents,
    },
    hasPayoutInProgress: payoutInProgressCount > 0,
  };
}

export function summarizeWorkspaceWalletEarningAggregate(input: {
  pendingCents?: number | null;
  withdrawableCents?: number | null;
  frozenCents?: number | null;
}): {
  pendingCents: number;
  withdrawableCents: number;
  frozenCents: number;
} {
  return {
    pendingCents: input.pendingCents ?? 0,
    withdrawableCents: input.withdrawableCents ?? 0,
    frozenCents: input.frozenCents ?? 0,
  };
}

export function resolveWorkspaceWalletPrimaryAction(input: {
  creatorVerificationStatus: CreatorVerificationStatus;
  hasVerifiedPayoutDestination?: boolean;
  withdrawableCents: number;
  payoutInProgressCents?: number;
  hasPayoutInProgress?: boolean;
}): WorkspaceWalletSnapshot["primaryAction"] {
  if (input.hasPayoutInProgress || (input.payoutInProgressCents ?? 0) > 0) {
    return { kind: "none", reason: "payout_in_progress" };
  }
  if (input.withdrawableCents <= 0) {
    return { kind: "none", reason: null };
  }
  if (input.creatorVerificationStatus !== CreatorVerificationStatus.VERIFIED) {
    return { kind: "verify", reason: "creator_verification_required" };
  }
  if (input.hasVerifiedPayoutDestination === false) {
    return {
      kind: "payout_profile",
      reason: "verified_payout_destination_required",
    };
  }
  return { kind: "withdraw", reason: null };
}

async function loadWorkspaceWalletEvents(
  query: NormalizedWorkspaceWalletQuery,
  client: WorkspaceWalletClient,
): Promise<EventPage> {
  const transactionWhere = buildTransactionWhere(query, true, false);
  const legacyWhere = buildLegacyLedgerWhere(query, true, false);
  const transactionPageWhere = buildTransactionWhere(query, true, true);
  const legacyPageWhere = buildLegacyLedgerWhere(query, true, true);
  const facetTransactionWhere = buildTransactionWhere(query, false, false);
  const facetLegacyWhere = buildLegacyLedgerWhere(query, false, false);
  const candidateTake = Math.min((query.limit + 1) * 3, 603);

  const [
    transactions,
    rawLegacyLeaders,
    transactionCount,
    legacyGroups,
    transactionTypeCounts,
    legacyTypeGroups,
  ] = await Promise.all([
    client.walletTransaction.findMany({
      where: transactionPageWhere,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: candidateTake,
      select: transactionSelect,
    }),
    client.walletLedgerEntry.findMany({
      where: legacyPageWhere,
      distinct: ["eventGroupId"],
      orderBy: [{ createdAt: "desc" }, { eventGroupId: "desc" }, { id: "desc" }],
      take: candidateTake,
      select: legacyLedgerSelect,
    }),
    client.walletTransaction.count({ where: transactionWhere }),
    client.walletLedgerEntry.groupBy({
      by: ["eventGroupId"],
      where: legacyWhere,
    }),
    client.walletTransaction.groupBy({
      by: ["eventType"],
      where: facetTransactionWhere,
      _count: { _all: true },
    }),
    client.walletLedgerEntry.groupBy({
      by: ["eventGroupId", "entryKind"],
      where: facetLegacyWhere,
    }),
  ]);

  const legacyLeaders = dedupeLegacyWalletEventLeaders(rawLegacyLeaders);
  const legacyIds = legacyLeaders.map((entry) => entry.eventGroupId);
  const legacyDetails = legacyIds.length
    ? await client.walletLedgerEntry.findMany({
        where: {
          AND: [
            walletLedgerOwnerScope(query.ownerId, query.representativeIds),
            {
              transactionId: null,
              currency: query.currency,
              eventGroupId: { in: legacyIds },
              createdAt: {
                gte: query.periodStart,
                lt: query.periodEnd,
              },
            },
            ...(query.representativeId
              ? [{ representativeId: query.representativeId }]
              : []),
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: legacyLedgerSelect,
      })
    : [];
  const detailsByGroup = groupLegacyLedgerRecords(legacyDetails);

  const candidates = [
    ...transactions.map(serializeWorkspaceWalletTransaction),
    ...legacyLeaders.map((leader) => serializeLegacyWalletEvent(
      leader,
      detailsByGroup.get(leader.eventGroupId) ?? [leader],
    )),
  ];
  const {
    rows: pageRows,
    hasMore,
  } = paginateWorkspaceWalletEventCandidates(
    candidates,
    query.cursor,
    query.limit,
  );
  const eventTypes = summarizeWorkspaceWalletEventTypeCounts(
    transactionTypeCounts.map((entry) => ({
      eventType: entry.eventType.toLowerCase(),
      count: entry._count._all,
    })),
    legacyTypeGroups.map((entry) => ({
      eventGroupId: entry.eventGroupId,
      entryKind: entry.entryKind,
    })),
  );

  return {
    filteredTotal: transactionCount + legacyGroups.length,
    eventTypes,
    rows: pageRows,
    hasMore,
    nextCursor: hasMore && pageRows.length
      ? encodeWorkspaceWalletCursor({
          view: query.view,
          occurredAt: pageRows[pageRows.length - 1]!.occurredAt,
          id: pageRows[pageRows.length - 1]!.id,
          asOf: query.asOf.toISOString(),
          scope: workspaceWalletCursorScope(query),
        })
      : null,
  };
}

function buildTransactionWhere(
  query: NormalizedWorkspaceWalletQuery,
  includeEventType: boolean,
  includeCursor: boolean,
): Prisma.WalletTransactionWhereInput {
  return {
    AND: [
      walletTransactionOwnerScope(query.ownerId, query.representativeIds),
      {
        currency: query.currency,
        occurredAt: {
          gte: query.periodStart,
          lt: query.periodEnd,
        },
      },
      ...(includeCursor && query.cursor
        ? [walletTransactionCursorWhere(query.cursor)]
        : []),
      ...(query.representativeId
        ? [{ representativeId: query.representativeId }]
        : []),
      ...(includeEventType && query.eventType !== "all"
        ? [{
            eventType: query.eventType.toUpperCase() as WalletTransactionEventType,
          }]
        : []),
      ...(query.query
        ? [{
            OR: [
              { eventGroupId: { contains: query.query, mode: "insensitive" as const } },
              { sourceType: { contains: query.query, mode: "insensitive" as const } },
              { sourceId: { contains: query.query, mode: "insensitive" as const } },
              {
                representative: {
                  is: {
                    OR: [
                      { slug: { contains: query.query, mode: "insensitive" as const } },
                      { displayName: { contains: query.query, mode: "insensitive" as const } },
                    ],
                  },
                },
              },
            ],
          }]
        : []),
    ],
  };
}

function buildLegacyLedgerWhere(
  query: NormalizedWorkspaceWalletQuery,
  includeEventType: boolean,
  includeCursor: boolean,
): Prisma.WalletLedgerEntryWhereInput {
  return {
    AND: [
      walletLedgerOwnerScope(query.ownerId, query.representativeIds),
      {
        transactionId: null,
        currency: query.currency,
        createdAt: {
          gte: query.periodStart,
          lt: query.periodEnd,
        },
      },
      ...(includeCursor && query.cursor
        ? [legacyWalletCursorWhere(query.cursor)]
        : []),
      ...(query.representativeId
        ? [{ representativeId: query.representativeId }]
        : []),
      ...(includeEventType && query.eventType !== "all"
        ? [legacyEventTypeWhere(query.eventType)]
        : []),
      ...(query.query
        ? [{
            OR: [
              { eventGroupId: { contains: query.query, mode: "insensitive" as const } },
              { notes: { contains: query.query, mode: "insensitive" as const } },
              { rechargeOrderId: { contains: query.query, mode: "insensitive" as const } },
              { tokenPurchaseId: { contains: query.query, mode: "insensitive" as const } },
              { usageChargeId: { contains: query.query, mode: "insensitive" as const } },
              { withdrawRequestId: { contains: query.query, mode: "insensitive" as const } },
              {
                representative: {
                  is: {
                    OR: [
                      { slug: { contains: query.query, mode: "insensitive" as const } },
                      { displayName: { contains: query.query, mode: "insensitive" as const } },
                    ],
                  },
                },
              },
            ],
          }]
        : []),
    ],
  };
}

function walletTransactionCursorWhere(
  cursor: WorkspaceWalletCursor,
): Prisma.WalletTransactionWhereInput {
  if (cursor.id.startsWith("transaction:")) {
    const rawId = cursor.id.slice("transaction:".length);
    return {
      OR: [
        { occurredAt: { lt: cursor.occurredAt } },
        {
          occurredAt: cursor.occurredAt,
          id: { lt: rawId },
        },
      ],
    };
  }
  if (cursor.id.startsWith("legacy:")) {
    return { occurredAt: { lt: cursor.occurredAt } };
  }
  throw new WorkspaceWalletInputError("Invalid transaction cursor source.");
}

function legacyWalletCursorWhere(
  cursor: WorkspaceWalletCursor,
): Prisma.WalletLedgerEntryWhereInput {
  if (cursor.id.startsWith("legacy:")) {
    const rawEventGroupId = cursor.id.slice("legacy:".length);
    return {
      OR: [
        { createdAt: { lt: cursor.occurredAt } },
        {
          createdAt: cursor.occurredAt,
          eventGroupId: { lt: rawEventGroupId },
        },
      ],
    };
  }
  if (cursor.id.startsWith("transaction:")) {
    return { createdAt: { lte: cursor.occurredAt } };
  }
  throw new WorkspaceWalletInputError("Invalid legacy wallet cursor source.");
}

function legacyEventTypeWhere(eventType: string): Prisma.WalletLedgerEntryWhereInput {
  const entryKindsByType: Record<string, AmnLedgerEntryKind[]> = {
    user_recharge: [AmnLedgerEntryKind.USER_RECHARGE],
    agent_token_purchase: [
      AmnLedgerEntryKind.USER_CASH_DEBIT,
      AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
      AmnLedgerEntryKind.CREATOR_PENDING_CREDIT,
      AmnLedgerEntryKind.PLATFORM_REVENUE_CREDIT,
      AmnLedgerEntryKind.PLATFORM_DEFERRED_REVENUE_CREDIT,
    ],
    usage_reservation: [AmnLedgerEntryKind.SERVICE_CREDIT_RESERVE],
    usage_settlement: [
      AmnLedgerEntryKind.SERVICE_CREDIT_SETTLE,
      AmnLedgerEntryKind.AGENT_TOKEN_DEBIT,
    ],
    usage_release: [AmnLedgerEntryKind.SERVICE_CREDIT_RELEASE],
    creator_earning_release: [
      AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
    ],
    withdrawal_request: [
      AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
      AmnLedgerEntryKind.CREATOR_FROZEN_CREDIT,
    ],
    withdrawal_payout: [
      AmnLedgerEntryKind.WITHDRAWAL_PAYOUT,
      AmnLedgerEntryKind.PAYOUT_CLEARING_CREDIT,
      AmnLedgerEntryKind.PAYOUT_CLEARING_DEBIT,
    ],
    refund: [AmnLedgerEntryKind.REFUND_REVERSAL],
    reversal: [AmnLedgerEntryKind.REFUND_REVERSAL],
    adjustment: [],
  };
  const kinds = entryKindsByType[eventType] ?? [];
  if (eventType === "adjustment") {
    return {
      entryKind: {
        notIn: Object.values(entryKindsByType).flat(),
      },
    };
  }
  return { entryKind: { in: kinds } };
}

function serializeWorkspaceWalletTransaction(
  transaction: TransactionRecord,
): WorkspaceWalletEvent {
  const eventType = transaction.eventType.toLowerCase();
  const amountCents = resolveOwnerReadableAmount(
    eventType,
    transaction.ledgerEntries,
    transaction.metadata,
  );
  const tokenAmount = resolveOwnerReadableTokenAmount(
    eventType,
    transaction.ledgerEntries,
    transaction.metadata,
  );
  return {
    id: `transaction:${transaction.id}`,
    eventType,
    status: transaction.status.toLowerCase(),
    representativeSlug: transaction.representative?.slug ?? null,
    representativeName: transaction.representative?.displayName ?? null,
    title: humanizeWalletCode(eventType),
    description: buildWalletEventDescription({
      sourceType: transaction.sourceType,
      sourceId: transaction.sourceId,
      representativeName: transaction.representative?.displayName ?? null,
    }),
    amountCents,
    tokenAmount,
    currency: transaction.currency,
    sourceType: transaction.sourceType,
    sourceId: transaction.sourceId,
    occurredAt: transaction.occurredAt.toISOString(),
    transactionId: transaction.id,
    eventGroupId: transaction.eventGroupId,
  };
}

function serializeLegacyWalletEvent(
  leader: LegacyLedgerRecord,
  entries: LegacyLedgerRecord[],
): WorkspaceWalletEvent {
  const eventType = classifyLegacyWalletEvent(
    leader.eventGroupId,
    entries.map((entry) => entry.entryKind),
  );
  const source = resolveLegacyWalletSource(entries);
  const representative = entries.find((entry) => entry.representative)?.representative
    ?? leader.representative;
  return {
    id: `legacy:${leader.eventGroupId}`,
    eventType,
    status: legacyWalletEventStatus(eventType),
    representativeSlug: representative?.slug ?? null,
    representativeName: representative?.displayName ?? null,
    title: humanizeWalletCode(eventType),
    description: buildWalletEventDescription({
      sourceType: source.type,
      sourceId: source.id,
      representativeName: representative?.displayName ?? null,
    }),
    amountCents: resolveOwnerReadableAmount(eventType, entries, null),
    tokenAmount: resolveOwnerReadableTokenAmount(eventType, entries, null),
    currency: leader.currency,
    sourceType: source.type,
    sourceId: source.id,
    occurredAt: maxCreatedAt(entries).toISOString(),
    transactionId: null,
    eventGroupId: leader.eventGroupId,
  };
}

export function classifyLegacyWalletEvent(
  eventGroupId: string,
  entryKinds: readonly AmnLedgerEntryKind[],
): string {
  const normalizedGroup = eventGroupId.toLowerCase();
  if (normalizedGroup.includes("recharge_refund")) return "refund";
  if (normalizedGroup.includes("refund")) return "refund";
  if (normalizedGroup.includes("reversal") || normalizedGroup.includes("reverse")) {
    return "reversal";
  }
  if (normalizedGroup.startsWith("recharge:")) return "user_recharge";
  if (normalizedGroup.includes("token_purchase")) return "agent_token_purchase";
  if (normalizedGroup.includes("withdraw") && normalizedGroup.includes("payout")) {
    return "withdrawal_payout";
  }
  if (normalizedGroup.includes("withdraw")) return "withdrawal_request";
  if (entryKinds.includes(AmnLedgerEntryKind.SERVICE_CREDIT_RESERVE)) {
    return "usage_reservation";
  }
  if (entryKinds.includes(AmnLedgerEntryKind.SERVICE_CREDIT_RELEASE)) {
    return "usage_release";
  }
  if (
    entryKinds.includes(AmnLedgerEntryKind.SERVICE_CREDIT_SETTLE)
    || entryKinds.includes(AmnLedgerEntryKind.AGENT_TOKEN_DEBIT)
  ) {
    return entryKinds.includes(AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT)
      ? "creator_earning_release"
      : "usage_settlement";
  }
  if (entryKinds.includes(AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT)) {
    return "creator_earning_release";
  }
  if (entryKinds.includes(AmnLedgerEntryKind.WITHDRAWAL_PAYOUT)) {
    return "withdrawal_payout";
  }
  if (entryKinds.includes(AmnLedgerEntryKind.WITHDRAWAL_FREEZE)) {
    return "withdrawal_request";
  }
  if (entryKinds.includes(AmnLedgerEntryKind.REFUND_REVERSAL)) return "refund";
  if (entryKinds.includes(AmnLedgerEntryKind.USER_RECHARGE)) return "user_recharge";
  if (entryKinds.includes(AmnLedgerEntryKind.AGENT_TOKEN_CREDIT)) {
    return "agent_token_purchase";
  }
  return "adjustment";
}

function legacyWalletEventStatus(eventType: string): string {
  if (eventType === "withdrawal_request") return "pending_review";
  if (eventType === "refund") return "refunded";
  return "succeeded";
}

function resolveOwnerReadableAmount(
  eventType: string,
  entries: ReadonlyArray<{
    entryKind: AmnLedgerEntryKind;
    amountCents: number;
    tokenAmount: number;
  }>,
  metadata: Prisma.JsonValue | null,
): number {
  const metadataAmount = readJsonInteger(metadata, "amountCents");
  const amountByKind = (kind: AmnLedgerEntryKind) =>
    entries.find((entry) => entry.entryKind === kind)?.amountCents ?? 0;
  if (eventType === "agent_token_purchase") {
    return Math.abs(
      amountByKind(AmnLedgerEntryKind.USER_CASH_DEBIT)
      || metadataAmount
      || entries.reduce((sum, entry) => sum + Math.max(entry.amountCents, 0), 0),
    );
  }
  if (eventType === "user_recharge") {
    return Math.abs(amountByKind(AmnLedgerEntryKind.USER_RECHARGE) || metadataAmount);
  }
  if (eventType === "refund" || eventType === "reversal") {
    return -Math.abs(
      amountByKind(AmnLedgerEntryKind.REFUND_REVERSAL)
      || metadataAmount
      || entries.find((entry) => entry.amountCents !== 0)?.amountCents
      || 0,
    );
  }
  if (eventType === "withdrawal_request" || eventType === "withdrawal_payout") {
    return -Math.abs(
      amountByKind(AmnLedgerEntryKind.WITHDRAWAL_FREEZE)
      || amountByKind(AmnLedgerEntryKind.WITHDRAWAL_PAYOUT)
      || metadataAmount
      || entries.find((entry) => entry.amountCents !== 0)?.amountCents
      || 0,
    );
  }
  if (eventType === "creator_earning_release") {
    return Math.abs(
      amountByKind(AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT)
      || metadataAmount,
    );
  }
  return metadataAmount;
}

function resolveOwnerReadableTokenAmount(
  eventType: string,
  entries: ReadonlyArray<{
    entryKind: AmnLedgerEntryKind;
    amountCents: number;
    tokenAmount: number;
  }>,
  metadata: Prisma.JsonValue | null,
): number {
  const metadataTokens = readJsonInteger(metadata, "tokenAmount");
  const tokenEntry = entries.find((entry) => entry.tokenAmount !== 0)?.tokenAmount ?? 0;
  const absoluteTokens = Math.abs(tokenEntry || metadataTokens);
  if (
    eventType === "usage_reservation"
    || eventType === "usage_settlement"
  ) {
    return -absoluteTokens;
  }
  if (eventType === "refund" || eventType === "reversal") return -absoluteTokens;
  return absoluteTokens;
}

function readJsonInteger(value: Prisma.JsonValue | null, key: string): number {
  if (!value || Array.isArray(value) || typeof value !== "object") return 0;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : 0;
}

function resolveLegacyWalletSource(entries: LegacyLedgerRecord[]): {
  type: string;
  id: string | null;
} {
  const withdrawalId = entries.find((entry) => entry.withdrawRequestId)?.withdrawRequestId;
  if (withdrawalId) return { type: "withdraw_request", id: withdrawalId };
  const usageChargeId = entries.find((entry) => entry.usageChargeId)?.usageChargeId;
  if (usageChargeId) return { type: "usage_charge", id: usageChargeId };
  const tokenPurchaseId = entries.find((entry) => entry.tokenPurchaseId)?.tokenPurchaseId;
  if (tokenPurchaseId) return { type: "token_purchase", id: tokenPurchaseId };
  const rechargeOrderId = entries.find((entry) => entry.rechargeOrderId)?.rechargeOrderId;
  if (rechargeOrderId) return { type: "recharge_order", id: rechargeOrderId };
  return { type: "ledger_group", id: entries[0]?.eventGroupId ?? null };
}

function buildWalletEventDescription(input: {
  sourceType: string;
  sourceId: string | null;
  representativeName: string | null;
}): string {
  const parts = [humanizeWalletCode(input.sourceType)];
  if (input.representativeName) parts.push(input.representativeName);
  if (input.sourceId) parts.push(shortIdentifier(input.sourceId));
  return parts.join(" · ");
}

function shortIdentifier(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function humanizeWalletCode(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function groupLegacyLedgerRecords(
  records: LegacyLedgerRecord[],
): Map<string, LegacyLedgerRecord[]> {
  const grouped = new Map<string, LegacyLedgerRecord[]>();
  for (const record of records) {
    const group = grouped.get(record.eventGroupId) ?? [];
    group.push(record);
    grouped.set(record.eventGroupId, group);
  }
  return grouped;
}

export function dedupeLegacyWalletEventLeaders<
  T extends { id: string; eventGroupId: string; createdAt: Date },
>(records: T[]): T[] {
  const ordered = [...records].sort((left, right) => {
    const dateComparison = right.createdAt.getTime() - left.createdAt.getTime();
    return dateComparison
      || compareTextDescending(left.eventGroupId, right.eventGroupId)
      || compareTextDescending(left.id, right.id);
  });
  const seen = new Set<string>();
  return ordered.filter((record) => {
    if (seen.has(record.eventGroupId)) return false;
    seen.add(record.eventGroupId);
    return true;
  });
}

function maxCreatedAt(records: Array<{ createdAt: Date }>): Date {
  return records.reduce(
    (latest, record) => record.createdAt > latest ? record.createdAt : latest,
    records[0]?.createdAt ?? new Date(0),
  );
}

export function summarizeWorkspaceWalletEventTypeCounts(
  transactionCounts: Array<{ eventType: string; count: number }>,
  legacyEntries: Array<{
    eventGroupId: string;
    entryKind: AmnLedgerEntryKind;
  }>,
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of transactionCounts) {
    counts.set(entry.eventType, (counts.get(entry.eventType) ?? 0) + entry.count);
  }
  const legacyGroups = new Map<string, AmnLedgerEntryKind[]>();
  for (const entry of legacyEntries) {
    const kinds = legacyGroups.get(entry.eventGroupId) ?? [];
    kinds.push(entry.entryKind);
    legacyGroups.set(entry.eventGroupId, kinds);
  }
  for (const [eventGroupId, entryKinds] of legacyGroups) {
    const eventType = classifyLegacyWalletEvent(eventGroupId, entryKinds);
    counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
  }
  return [...counts]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

async function loadWorkspaceWalletSettlements(
  query: NormalizedWorkspaceWalletQuery,
  client: WorkspaceWalletClient,
): Promise<SettlementPage> {
  const where: Prisma.WithdrawRequestWhereInput = {
    ownerId: query.ownerId,
    currency: query.currency,
    requestedAt: {
      gte: query.periodStart,
      lt: query.periodEnd,
    },
    ...(query.representativeId ? { representativeId: query.representativeId } : {}),
    ...(query.query
      ? {
          OR: [
            { id: { contains: query.query, mode: "insensitive" } },
            { providerPayoutId: { contains: query.query, mode: "insensitive" } },
            { failureReason: { contains: query.query, mode: "insensitive" } },
            {
              representative: {
                is: {
                  OR: [
                    { slug: { contains: query.query, mode: "insensitive" } },
                    { displayName: { contains: query.query, mode: "insensitive" } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };
  const [filteredTotal, records] = await Promise.all([
    client.withdrawRequest.count({ where }),
    client.withdrawRequest.findMany({
      where: query.cursor
        ? {
            AND: [
              where,
              {
                OR: [
                  { requestedAt: { lt: query.cursor.occurredAt } },
                  {
                    requestedAt: query.cursor.occurredAt,
                    id: { lt: query.cursor.id },
                  },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: settlementSelect,
    }),
  ]);
  const serialized = records
    .map(serializeWorkspaceWalletSettlement)
    .filter((record) => isWalletRowBeforeCursor(
      record.requestedAt,
      record.id,
      query.cursor,
    ));
  const hasMore = serialized.length > query.limit;
  const rows = serialized.slice(0, query.limit);
  return {
    filteredTotal,
    rows,
    hasMore,
    nextCursor: hasMore && rows.length
      ? encodeWorkspaceWalletCursor({
          view: query.view,
          occurredAt: rows[rows.length - 1]!.requestedAt,
          id: rows[rows.length - 1]!.id,
          asOf: query.asOf.toISOString(),
          scope: workspaceWalletCursorScope(query),
        })
      : null,
  };
}

function serializeWorkspaceWalletSettlement(
  record: SettlementRecord,
): WorkspaceWalletSettlement {
  const latestLedgerEntry = record.ledgerEntries[0] ?? null;
  return {
    id: record.id,
    representativeSlug: record.representative?.slug ?? null,
    representativeName: record.representative?.displayName ?? null,
    status: record.status.toLowerCase(),
    amountCents: record.amountCents,
    currency: record.currency,
    provider: record.provider?.toLowerCase() ?? null,
    providerPayoutId: record.providerPayoutId,
    requestedAt: record.requestedAt.toISOString(),
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    reviewedBy: record.reviewedBy,
    paidAt: record.paidAt?.toISOString() ?? null,
    failureReason: record.failureReason
      ? record.failureReason.slice(0, 300)
      : null,
    transactionId: latestLedgerEntry?.transactionId ?? null,
    eventGroupId: latestLedgerEntry?.eventGroupId ?? null,
    cancelable: record.allocations.length > 0
      && cancelableWithdrawRequestStatuses.has(record.status),
  };
}

async function loadWorkspaceWalletLedger(
  query: NormalizedWorkspaceWalletQuery,
  client: WorkspaceWalletClient,
): Promise<LedgerPage> {
  const where: Prisma.WalletLedgerEntryWhereInput = {
    AND: [
      walletLedgerOwnerScope(query.ownerId, query.representativeIds),
      {
        currency: query.currency,
        createdAt: {
          gte: query.periodStart,
          lt: query.periodEnd,
        },
      },
      ...(query.representativeId
        ? [{ representativeId: query.representativeId }]
        : []),
      ...(query.query
        ? [{
            OR: [
              { id: { contains: query.query, mode: "insensitive" as const } },
              { eventGroupId: { contains: query.query, mode: "insensitive" as const } },
              { notes: { contains: query.query, mode: "insensitive" as const } },
              {
                representative: {
                  is: {
                    OR: [
                      { slug: { contains: query.query, mode: "insensitive" as const } },
                      { displayName: { contains: query.query, mode: "insensitive" as const } },
                    ],
                  },
                },
              },
            ],
          }]
        : []),
    ],
  };
  const [filteredTotal, records] = await Promise.all([
    client.walletLedgerEntry.count({ where }),
    client.walletLedgerEntry.findMany({
      where: query.cursor
        ? {
            AND: [
              where,
              {
                OR: [
                  { createdAt: { lt: query.cursor.occurredAt } },
                  {
                    createdAt: query.cursor.occurredAt,
                    id: { lt: query.cursor.id },
                  },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: ledgerSelect,
    }),
  ]);
  const serialized = records
    .map(serializeWorkspaceWalletLedgerEntry)
    .filter((record) => isWalletRowBeforeCursor(
      record.createdAt,
      record.id,
      query.cursor,
    ));
  const hasMore = serialized.length > query.limit;
  const rows = serialized.slice(0, query.limit);
  return {
    filteredTotal,
    rows,
    hasMore,
    nextCursor: hasMore && rows.length
      ? encodeWorkspaceWalletCursor({
          view: query.view,
          occurredAt: rows[rows.length - 1]!.createdAt,
          id: rows[rows.length - 1]!.id,
          asOf: query.asOf.toISOString(),
          scope: workspaceWalletCursorScope(query),
        })
      : null,
  };
}

function serializeWorkspaceWalletLedgerEntry(
  record: LedgerRecord,
): WorkspaceWalletLedgerEntry {
  return {
    id: record.id,
    transactionId: record.transactionId,
    eventGroupId: record.eventGroupId,
    representativeSlug: record.representative?.slug ?? null,
    representativeName: record.representative?.displayName ?? null,
    accountType: record.accountType.toLowerCase(),
    entryKind: record.entryKind.toLowerCase(),
    amountCents: record.amountCents,
    tokenAmount: record.tokenAmount,
    currency: record.currency,
    balanceAfterCents: record.balanceAfterCents,
    tokenBalanceAfter: record.tokenBalanceAfter,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
  };
}

function walletTransactionOwnerScope(
  ownerId: string,
  representativeIds: string[],
): Prisma.WalletTransactionWhereInput {
  return representativeIds.length
    ? {
        OR: [
          { ownerId },
          { representativeId: { in: representativeIds } },
        ],
      }
    : { ownerId };
}

function walletLedgerOwnerScope(
  ownerId: string,
  representativeIds: string[],
): Prisma.WalletLedgerEntryWhereInput {
  return representativeIds.length
    ? {
        OR: [
          { ownerId },
          { representativeId: { in: representativeIds } },
        ],
      }
    : { ownerId };
}

function compareWalletEventDescending(
  left: WorkspaceWalletEvent,
  right: WorkspaceWalletEvent,
): number {
  const dateComparison = right.occurredAt.localeCompare(left.occurredAt);
  return dateComparison || compareTextDescending(left.id, right.id);
}

function compareTextDescending(left: string, right: string): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

export function paginateWorkspaceWalletEventCandidates(
  candidates: WorkspaceWalletEvent[],
  cursor: WorkspaceWalletCursor | null,
  limit: number,
): {
  rows: WorkspaceWalletEvent[];
  hasMore: boolean;
} {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new WorkspaceWalletInputError("Wallet page limit must be a positive integer.");
  }
  const ordered = [...candidates]
    .sort(compareWalletEventDescending)
    .filter((event) => isWalletRowBeforeCursor(
      event.occurredAt,
      event.id,
      cursor,
    ));
  return {
    rows: ordered.slice(0, limit),
    hasMore: ordered.length > limit,
  };
}

function isWalletRowBeforeCursor(
  occurredAt: string,
  id: string,
  cursor: WorkspaceWalletCursor | null,
): boolean {
  if (!cursor) return true;
  const timestamp = new Date(occurredAt).getTime();
  const cursorTimestamp = cursor.occurredAt.getTime();
  return timestamp < cursorTimestamp
    || (timestamp === cursorTimestamp && id < cursor.id);
}

export function encodeWorkspaceWalletCursor(input: {
  view: WorkspaceWalletView;
  occurredAt: string;
  id: string;
  asOf: string;
  scope: string;
}): string {
  const occurredAt = parseIsoTimestamp(input.occurredAt, "cursor occurredAt");
  const asOf = parseIsoTimestamp(input.asOf, "cursor asOf");
  if (
    !supportedViews.has(input.view)
    || !input.id.trim()
    || !input.scope.trim()
  ) {
    throw new WorkspaceWalletInputError("Invalid wallet cursor.");
  }
  return Buffer.from(JSON.stringify({
    v: 2,
    view: input.view,
    occurredAt: occurredAt.toISOString(),
    id: input.id,
    asOf: asOf.toISOString(),
    scope: input.scope,
  })).toString("base64url");
}

export function decodeWorkspaceWalletCursor(
  value: string | null | undefined,
): WorkspaceWalletCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      view?: unknown;
      occurredAt?: unknown;
      id?: unknown;
      asOf?: unknown;
      scope?: unknown;
    };
    if (
      parsed.v !== 2
      || typeof parsed.view !== "string"
      || !supportedViews.has(parsed.view as WorkspaceWalletView)
      || typeof parsed.occurredAt !== "string"
      || typeof parsed.asOf !== "string"
      || typeof parsed.id !== "string"
      || !parsed.id.trim()
      || typeof parsed.scope !== "string"
      || !parsed.scope.trim()
    ) {
      throw new Error("shape");
    }
    return {
      view: parsed.view as WorkspaceWalletView,
      occurredAt: parseIsoTimestamp(parsed.occurredAt, "cursor occurredAt"),
      id: parsed.id,
      asOf: parseIsoTimestamp(parsed.asOf, "cursor asOf"),
      scope: parsed.scope,
    };
  } catch (error) {
    if (error instanceof WorkspaceWalletInputError) throw error;
    throw new WorkspaceWalletInputError("Invalid wallet cursor.");
  }
}

function parseIsoTimestamp(value: string, label: string): Date {
  const timestamp = new Date(value);
  if (
    !Number.isFinite(timestamp.getTime())
    || timestamp.toISOString() !== value
  ) {
    throw new WorkspaceWalletInputError(`${label} must be an ISO timestamp.`);
  }
  return timestamp;
}

function parseUtcDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new WorkspaceWalletInputError(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || formatUtcDate(parsed) !== value) {
    throw new WorkspaceWalletInputError(`${label} is not a valid UTC date.`);
  }
  return parsed;
}

export function parseWorkspaceWalletUtcDate(value: string): Date {
  return parseUtcDate(value, "date");
}

function formatUtcDate(value: Date): string {
  return [
    value.getUTCFullYear(),
    padDate(value.getUTCMonth() + 1),
    padDate(value.getUTCDate()),
  ].join("-");
}

function padDate(value: number): string {
  return String(value).padStart(2, "0");
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function emptyEventPage(): EventPage {
  return {
    filteredTotal: 0,
    eventTypes: [],
    rows: [],
    hasMore: false,
    nextCursor: null,
  };
}

function emptySettlementPage(): SettlementPage {
  return {
    filteredTotal: 0,
    rows: [],
    hasMore: false,
    nextCursor: null,
  };
}

function emptyLedgerPage(): LedgerPage {
  return {
    filteredTotal: 0,
    rows: [],
    hasMore: false,
    nextCursor: null,
  };
}
