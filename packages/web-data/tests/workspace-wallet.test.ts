import {
  AmnLedgerEntryKind,
  CreatorVerificationStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  classifyLegacyWalletEvent,
  dedupeLegacyWalletEventLeaders,
  decodeWorkspaceWalletCursor,
  encodeWorkspaceWalletCursor,
  getWorkspaceWalletSnapshot,
  normalizeWorkspaceWalletCurrency,
  paginateWorkspaceWalletEventCandidates,
  parseWorkspaceWalletUtcDate,
  resolveWorkspaceWalletPrimaryAction,
  summarizeWorkspaceWalletEarningAggregate,
  summarizeWorkspaceWalletEventTypeCounts,
  WorkspaceWalletInputError,
} from "../src/workspace-wallet";

describe("workspace wallet read model", () => {
  it("scopes every financial aggregate to one selected currency", async () => {
    const earningAggregate = vi.fn().mockResolvedValue({
      _sum: {
        pendingCents: 3_000,
        withdrawableCents: 4_000,
        frozenCents: 500,
      },
    });
    const ledgerAggregate = vi.fn().mockImplementation(
      (args: { where: unknown }) => Promise.resolve({
        _sum: {
          amountCents: JSON.stringify(args.where).includes("USER_CASH_DEBIT")
            ? -12_000
            : 2_500,
        },
      }),
    );
    const client = {
      owner: {
        findUnique: vi.fn().mockResolvedValue({
          id: "owner-1",
          creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
        }),
      },
      representative: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "rep-1",
            slug: "delegate",
            displayName: "Delegate",
            agentWallet: { currency: "CNY" },
          },
          {
            id: "rep-2",
            slug: "support",
            displayName: "Support",
            agentWallet: { currency: "CNY" },
          },
        ]),
      },
      agentWallet: {},
      agentTokenPurchase: {
        aggregate: vi.fn(),
      },
      creatorEarning: {
        groupBy: vi.fn().mockImplementation(
          (args: { by: string[] }) => Promise.resolve(
            args.by.includes("representativeId")
              ? [{
                  representativeId: "rep-1",
                  _sum: {
                    withdrawableCents: 1_500,
                    frozenCents: 500,
                  },
                }, {
                  representativeId: "rep-2",
                  _sum: {
                    withdrawableCents: 2_500,
                    frozenCents: 0,
                  },
                }]
              : [
                  { currency: "CNY" },
                  { currency: "USD" },
                ],
          ),
        ),
        aggregate: earningAggregate,
      },
      walletTransaction: {
        groupBy: vi.fn().mockImplementation((args: { by: string[] }) =>
          Promise.resolve(args.by.includes("currency")
            ? [{ currency: "CNY" }, { currency: "USD" }]
            : [])),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      walletLedgerEntry: {
        groupBy: vi.fn().mockImplementation((args: { by: string[] }) =>
          Promise.resolve(args.by.includes("currency")
            ? [{ currency: "CNY" }, { currency: "USD" }]
            : [])),
        aggregate: ledgerAggregate,
        findMany: vi.fn().mockResolvedValue([]),
      },
      withdrawRequest: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockImplementation(
          (args: { where: unknown }) => Promise.resolve(
            JSON.stringify(args.where).includes('"allocations"')
              ? [{
                  id: "withdraw-active",
                  representativeId: "rep-1",
                  status: "PENDING_REVIEW",
                  amountCents: 500,
                  currency: "CNY",
                  requestedAt: new Date("2026-07-23T12:00:00.000Z"),
                  allocations: [{ id: "allocation-1" }],
                }]
              : [{
                  id: "withdraw-active",
                  status: "PENDING_REVIEW",
                  amountCents: 500,
                  currency: "CNY",
                  provider: null,
                  providerPayoutId: null,
                  requestedAt: new Date("2026-07-23T12:00:00.000Z"),
                  reviewedAt: null,
                  reviewedBy: null,
                  paidAt: null,
                  failureReason: null,
                  allocations: [{ id: "allocation-1" }],
                  ledgerEntries: [{
                    transactionId: "transaction-withdraw-active",
                    eventGroupId: "withdraw_request:withdraw-active",
                  }],
                  representative: {
                    slug: "delegate",
                    displayName: "Delegate",
                  },
                }],
          ),
        ),
      },
    };

    const snapshot = await getWorkspaceWalletSnapshot({
      ownerId: "owner-1",
      activeRepresentativeSlug: "delegate",
      currency: "CNY",
      asOf: "2026-07-23T16:00:00.000Z",
    }, client as never);

    expect(snapshot?.currencies).toEqual(["CNY", "USD"]);
    expect(snapshot?.metrics).toEqual({
      grossSalesCents: 12_000,
      releasedCreatorIncomeCents: 2_500,
      pendingEarningsCents: 3_000,
      withdrawableCents: 4_000,
      payoutInProgressCents: 500,
    });
    expect(snapshot?.representatives).toEqual([
      {
        slug: "delegate",
        name: "Delegate",
        withdrawableCents: 1_500,
        payoutInProgressCents: 500,
        activeWithdrawRequest: {
          id: "withdraw-active",
          status: "pending_review",
          amountCents: 500,
          currency: "CNY",
          requestedAt: "2026-07-23T12:00:00.000Z",
          cancelable: true,
        },
      },
      {
        slug: "support",
        name: "Support",
        withdrawableCents: 2_500,
        payoutInProgressCents: 0,
        activeWithdrawRequest: null,
      },
    ]);
    expect(snapshot?.primaryAction).toEqual({ kind: "withdraw", reason: null });
    expect(snapshot?.settlements[0]).toMatchObject({
      id: "withdraw-active",
      reviewedBy: null,
      transactionId: "transaction-withdraw-active",
      eventGroupId: "withdraw_request:withdraw-active",
      cancelable: true,
    });
    expect(earningAggregate.mock.calls[0]?.[0].where.currency).toBe("CNY");
    const grossWhere = ledgerAggregate.mock.calls
      .map((call) => call[0].where)
      .find((where) => JSON.stringify(where).includes("USER_CASH_DEBIT"));
    const releasedWhere = ledgerAggregate.mock.calls
      .map((call) => call[0].where)
      .find((where) => JSON.stringify(where).includes("CREATOR_WITHDRAWABLE_CREDIT"));
    expect(JSON.stringify(grossWhere)).toContain('"currency":"CNY"');
    expect(JSON.stringify(grossWhere)).toContain("AGENT_TOKEN_PURCHASE");
    expect(JSON.stringify(grossWhere)).toContain('"tokenPurchaseId":{"not":null}');
    expect(JSON.stringify(releasedWhere)).toContain("USAGE_SETTLEMENT");
    expect(JSON.stringify(releasedWhere)).toContain("CREATOR_EARNING_RELEASE");
    expect(JSON.stringify(releasedWhere)).toContain('"usageChargeId":{"not":null}');
    expect(JSON.stringify(releasedWhere)).toContain('"withdrawRequestId":null');
  });

  it("keeps the selected currency explicit and rejects cross-currency fallback", () => {
    expect(normalizeWorkspaceWalletCurrency("cny", ["CNY", "USD"])).toBe("CNY");
    expect(() => normalizeWorkspaceWalletCurrency("EUR", ["CNY", "USD"]))
      .toThrow(WorkspaceWalletInputError);
    expect(() => normalizeWorkspaceWalletCurrency("not-money", ["CNY"]))
      .toThrow("Invalid wallet currency.");
  });

  it("round-trips a view-bound createdAt/id cursor and snapshot anchor", () => {
    const cursor = encodeWorkspaceWalletCursor({
      view: "transactions",
      occurredAt: "2026-07-23T16:00:00.000Z",
      id: "transaction:txn_same_timestamp_b",
      asOf: "2026-07-23T16:01:02.003Z",
      scope: "wallet-scope",
    });

    expect(decodeWorkspaceWalletCursor(cursor)).toEqual({
      view: "transactions",
      occurredAt: new Date("2026-07-23T16:00:00.000Z"),
      id: "transaction:txn_same_timestamp_b",
      asOf: new Date("2026-07-23T16:01:02.003Z"),
      scope: "wallet-scope",
    });
    expect(() => decodeWorkspaceWalletCursor("not-json"))
      .toThrow(WorkspaceWalletInputError);
    expect(() => encodeWorkspaceWalletCursor({
      view: "ledger",
      occurredAt: "2026-07-23",
      id: "entry-1",
      asOf: "2026-07-23T16:01:02.003Z",
      scope: "wallet-scope",
    })).toThrow("cursor occurredAt must be an ISO timestamp.");
  });

  it("rejects impossible or non-canonical UTC dates", () => {
    expect(parseWorkspaceWalletUtcDate("2026-07-23")).toEqual(
      new Date("2026-07-23T00:00:00.000Z"),
    );
    expect(() => parseWorkspaceWalletUtcDate("2026-02-30"))
      .toThrow("date is not a valid UTC date.");
    expect(() => parseWorkspaceWalletUtcDate("07/23/2026"))
      .toThrow("date must use YYYY-MM-DD.");
  });

  it("keeps new transactions and legacy groups stable at a shared cursor timestamp", () => {
    const shared = "2026-07-23T16:00:00.000Z";
    const rows = [
      walletEvent("legacy:token_purchase:old", shared),
      walletEvent("transaction:txn-new", shared),
      walletEvent("legacy:token_purchase:older", "2026-07-23T15:59:59.000Z"),
    ];
    const firstPage = paginateWorkspaceWalletEventCandidates(rows, null, 1);
    expect(firstPage.rows.map((row) => row.id)).toEqual(["transaction:txn-new"]);
    expect(firstPage.hasMore).toBe(true);

    const cursor = decodeWorkspaceWalletCursor(encodeWorkspaceWalletCursor({
      view: "transactions",
      occurredAt: firstPage.rows[0]!.occurredAt,
      id: firstPage.rows[0]!.id,
      asOf: "2026-07-23T16:01:00.000Z",
      scope: "wallet-scope",
    }));
    const secondPage = paginateWorkspaceWalletEventCandidates(rows, cursor, 2);
    expect(secondPage.rows.map((row) => row.id)).toEqual([
      "legacy:token_purchase:old",
      "legacy:token_purchase:older",
    ]);
    expect(new Set([
      ...firstPage.rows.map((row) => row.id),
      ...secondPage.rows.map((row) => row.id),
    ]).size).toBe(3);
  });

  it("uses the newest ledger movement as the stable leader of each legacy group", () => {
    expect(dedupeLegacyWalletEventLeaders([
      {
        id: "entry-a-old",
        eventGroupId: "group-a",
        createdAt: new Date("2026-07-23T15:00:00.000Z"),
      },
      {
        id: "entry-b",
        eventGroupId: "group-b",
        createdAt: new Date("2026-07-23T16:00:00.000Z"),
      },
      {
        id: "entry-a-new",
        eventGroupId: "group-a",
        createdAt: new Date("2026-07-23T17:00:00.000Z"),
      },
    ])).toEqual([
      {
        id: "entry-a-new",
        eventGroupId: "group-a",
        createdAt: new Date("2026-07-23T17:00:00.000Z"),
      },
      {
        id: "entry-b",
        eventGroupId: "group-b",
        createdAt: new Date("2026-07-23T16:00:00.000Z"),
      },
    ]);
  });

  it("uses aggregate totals instead of truncating creator earnings to 100 rows", () => {
    const moreThanOnePage = Array.from({ length: 150 }, (_, index) => ({
      pendingCents: index + 1,
      withdrawableCents: 2,
      frozenCents: index % 3,
    }));
    const aggregate = moreThanOnePage.reduce(
      (total, earning) => ({
        pendingCents: total.pendingCents + earning.pendingCents,
        withdrawableCents: total.withdrawableCents + earning.withdrawableCents,
        frozenCents: total.frozenCents + earning.frozenCents,
      }),
      { pendingCents: 0, withdrawableCents: 0, frozenCents: 0 },
    );

    expect(summarizeWorkspaceWalletEarningAggregate(aggregate)).toEqual({
      pendingCents: 11_325,
      withdrawableCents: 300,
      frozenCents: 150,
    });
  });

  it("classifies legacy ledger groups without counting every movement as a sale", () => {
    expect(classifyLegacyWalletEvent(
      "token_purchase:purchase-1",
      [
        AmnLedgerEntryKind.USER_CASH_DEBIT,
        AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
        AmnLedgerEntryKind.CREATOR_PENDING_CREDIT,
      ],
    )).toBe("agent_token_purchase");
    expect(classifyLegacyWalletEvent(
      "usage:charge-1",
      [
        AmnLedgerEntryKind.AGENT_TOKEN_DEBIT,
        AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
      ],
    )).toBe("creator_earning_release");
    expect(classifyLegacyWalletEvent(
      "recharge_refund:order-1",
      [AmnLedgerEntryKind.REFUND_REVERSAL],
    )).toBe("refund");

    expect(summarizeWorkspaceWalletEventTypeCounts(
      [{ eventType: "agent_token_purchase", count: 2 }],
      [
        {
          eventGroupId: "token_purchase:legacy-1",
          entryKind: AmnLedgerEntryKind.USER_CASH_DEBIT,
        },
        {
          eventGroupId: "token_purchase:legacy-1",
          entryKind: AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
        },
        {
          eventGroupId: "withdraw_request:legacy-2",
          entryKind: AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
        },
      ],
    )).toEqual([
      { id: "agent_token_purchase", count: 3 },
      { id: "withdrawal_request", count: 1 },
    ]);
  });

  it("only exposes a withdrawal action for verified owners with available funds", () => {
    expect(resolveWorkspaceWalletPrimaryAction({
      creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      withdrawableCents: 500,
      hasPayoutInProgress: true,
    })).toEqual({
      kind: "none",
      reason: "payout_in_progress",
    });
    expect(resolveWorkspaceWalletPrimaryAction({
      creatorVerificationStatus: CreatorVerificationStatus.UNVERIFIED,
      withdrawableCents: 500,
    })).toEqual({
      kind: "verify",
      reason: "creator_verification_required",
    });
    expect(resolveWorkspaceWalletPrimaryAction({
      creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      withdrawableCents: 500,
    })).toEqual({ kind: "withdraw", reason: null });
    expect(resolveWorkspaceWalletPrimaryAction({
      creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      withdrawableCents: 0,
    })).toEqual({ kind: "none", reason: null });
  });
});

function walletEvent(id: string, occurredAt: string) {
  return {
    id,
    eventType: "agent_token_purchase",
    status: "succeeded",
    representativeSlug: "delegate",
    representativeName: "Delegate",
    title: "Service credits purchased",
    description: "Token purchase",
    amountCents: 100,
    tokenAmount: 100,
    currency: "CNY",
    sourceType: id.startsWith("legacy:") ? "ledger_group" : "token_purchase",
    sourceId: id,
    occurredAt,
    transactionId: id.startsWith("transaction:") ? id.slice(12) : null,
    eventGroupId: id,
  };
}
