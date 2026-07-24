"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import type { Locale } from "@delegate/web-ui";

type WalletView = "overview" | "transactions" | "settlements" | "ledger";
type MockWithdrawalAction =
  | "approve"
  | "reject"
  | "mark_paid"
  | "mark_failed";

type WalletRepresentative = {
  slug: string;
  name: string;
  withdrawableCents?: number;
  payoutInProgressCents?: number;
  activeWithdrawRequest?: {
    id: string;
    status: string;
    amountCents: number;
    currency: string;
    requestedAt: string;
    cancelable: boolean;
  } | null;
};

type WorkspaceWalletEvent = {
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

type WorkspaceWalletSettlement = {
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

type WorkspaceWalletLedgerEntry = {
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

type WorkspaceWalletSnapshot = {
  capabilities?: {
    mockWithdrawalOperations: boolean;
  };
  workspace: {
    ownerId: string;
    representativeCount: number;
    asOf: string;
  };
  representatives: WalletRepresentative[];
  currencies: string[];
  filters: {
    view: WalletView;
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
    kind: "withdraw" | "verify" | "none";
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

type SelectedWalletRow =
  | { kind: "event"; id: string }
  | { kind: "settlement"; id: string }
  | { kind: "ledger"; id: string };

const walletPageSize = 50;
const walletViews: WalletView[] = [
  "overview",
  "transactions",
  "settlements",
  "ledger",
];

export function DashboardWallet({
  activeSlug,
  locale,
  representatives: initialRepresentatives,
}: {
  activeSlug: string;
  locale: Locale;
  representatives: WalletRepresentative[];
}) {
  const zh = locale === "zh";
  const [activeView, setActiveView] = useState<WalletView>("overview");
  const [representative, setRepresentative] = useState("all");
  const [currency, setCurrency] = useState("");
  const [eventType, setEventType] = useState("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [snapshot, setSnapshot] = useState<WorkspaceWalletSnapshot | null>(null);
  const [events, setEvents] = useState<WorkspaceWalletEvent[]>([]);
  const [settlements, setSettlements] = useState<WorkspaceWalletSettlement[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<WorkspaceWalletLedgerEntry[]>([]);
  const [selected, setSelected] = useState<SelectedWalletRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [settledFilterKey, setSettledFilterKey] = useState<string | null>(null);
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [cancelingWithdrawalId, setCancelingWithdrawalId] = useState<string | null>(null);
  const [mockWithdrawalAction, setMockWithdrawalAction] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const mockActionIdempotencyKeysRef = useRef(new Map<string, string>());
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const resolvedCurrency = currency || snapshot?.filters.currency || "";
  const filterKey = [
    activeSlug,
    activeView,
    representative,
    resolvedCurrency,
    eventType,
    debouncedQuery,
    from,
    to,
  ].join("\u0000");
  const activeFilterKeyRef = useRef(filterKey);
  activeFilterKeyRef.current = filterKey;

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const loadWallet = useCallback(async (
    mode: "replace" | "append",
    cursor?: string | null,
    signal?: AbortSignal,
  ) => {
    const requestId = ++requestSequenceRef.current;
    const requestedFilterKey = [
      activeSlug,
      activeView,
      representative,
      resolvedCurrency,
      eventType,
      debouncedQuery,
      from,
      to,
    ].join("\u0000");
    setError(null);
    if (mode === "replace") setLoading(true);
    else setLoadingMore(true);

    try {
      const parameters = new URLSearchParams({
        rep: activeSlug,
        view: activeView,
        representative,
        eventType,
        limit: String(walletPageSize),
      });
      if (resolvedCurrency) parameters.set("currency", resolvedCurrency);
      if (debouncedQuery) parameters.set("query", debouncedQuery);
      if (from) parameters.set("from", from);
      if (to) parameters.set("to", to);
      if (cursor) parameters.set("cursor", cursor);

      const response = await fetch(`/api/dashboard/wallet?${parameters.toString()}`, {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(await extractError(response));
      const nextSnapshot = (await response.json()) as WorkspaceWalletSnapshot;
      if (
        signal?.aborted
        || activeFilterKeyRef.current !== requestedFilterKey
        || requestSequenceRef.current !== requestId
      ) return;

      if (!currency && nextSnapshot.filters.currency) {
        setCurrency(nextSnapshot.filters.currency);
      }
      setSnapshot((current) => mode === "append" && current
        ? {
            ...nextSnapshot,
            workspace: current.workspace,
            representatives: current.representatives,
            currencies: current.currencies,
            metrics: current.metrics,
            primaryAction: current.primaryAction,
            eventTypes: current.eventTypes,
          }
        : nextSnapshot);
      setEvents((current) => mergeRows(current, nextSnapshot.events, mode));
      setSettlements((current) => mergeRows(current, nextSnapshot.settlements, mode));
      setLedgerEntries((current) => mergeRows(current, nextSnapshot.ledgerEntries, mode));
      setSettledFilterKey(requestedFilterKey);
      setSelected((current) => resolveSelection(
        current,
        nextSnapshot,
        mode,
      ));
    } catch (nextError) {
      if (
        signal?.aborted
        || activeFilterKeyRef.current !== requestedFilterKey
        || requestSequenceRef.current !== requestId
      ) return;
      throw nextError;
    } finally {
      if (
        activeFilterKeyRef.current === requestedFilterKey
        && requestSequenceRef.current === requestId
      ) {
        if (mode === "replace") setLoading(false);
        else setLoadingMore(false);
      }
    }
  }, [
    activeSlug,
    activeView,
    currency,
    debouncedQuery,
    eventType,
    from,
    representative,
    resolvedCurrency,
    to,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setEvents([]);
    setSettlements([]);
    setLedgerEntries([]);
    setSelected(null);
    setLoadingMore(false);
    void loadWallet("replace", null, controller.signal).catch((nextError: unknown) => {
      if (controller.signal.aborted || activeFilterKeyRef.current !== filterKey) return;
      setSettledFilterKey(filterKey);
      setError(nextError instanceof Error
        ? nextError.message
        : zh
        ? "钱包与账单加载失败。"
        : "Failed to load wallet and billing.");
    });
    return () => controller.abort();
  }, [filterKey, loadWallet, zh]);

  useEffect(() => {
    if (!selected) return;
    const previousFocus = previousFocusRef.current;
    const timeout = window.setTimeout(() => {
      if (window.matchMedia("(max-width: 760px)").matches) {
        closeButtonRef.current?.focus();
      }
    }, 0);
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        setSelected(null);
        return;
      }
      if (
        keyboardEvent.key !== "Tab"
        || !window.matchMedia("(max-width: 760px)").matches
      ) return;
      const detail = closeButtonRef.current?.closest<HTMLElement>(".wallet-detail-panel");
      const focusable = detail
        ? [...detail.querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
          )]
        : [];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (keyboardEvent.shiftKey && document.activeElement === first) {
        keyboardEvent.preventDefault();
        last.focus();
      } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
        keyboardEvent.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [selected]);

  const initialLoading = settledFilterKey !== filterKey;
  const showInitialLoading = initialLoading || (loading && !snapshot);
  const showInitialFailure = Boolean(error && !snapshot && !showInitialLoading);
  const representatives = snapshot?.representatives.length
    ? snapshot.representatives
    : initialRepresentatives;
  const eligibleWithdrawalRepresentatives = representatives.filter(
    (item) =>
      (item.withdrawableCents ?? 0) > 0
      && !item.activeWithdrawRequest,
  );
  const defaultWithdrawalRepresentative = representative !== "all"
    && eligibleWithdrawalRepresentatives.some(
      (item) => item.slug === representative,
    )
    ? representative
    : eligibleWithdrawalRepresentatives[0]?.slug ?? "";
  const eventTypeOptions = snapshot?.eventTypes ?? [];
  const selectedDetail = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === "event") {
      const row = events.find((event) => event.id === selected.id);
      return row ? { kind: selected.kind, row } as const : null;
    }
    if (selected.kind === "settlement") {
      const row = settlements.find((settlement) => settlement.id === selected.id);
      return row ? { kind: selected.kind, row } as const : null;
    }
    const row = ledgerEntries.find((entry) => entry.id === selected.id);
    return row ? { kind: selected.kind, row } as const : null;
  }, [events, ledgerEntries, selected, settlements]);

  function chooseRow(
    next: SelectedWalletRow,
    target: HTMLElement,
  ) {
    previousFocusRef.current = target;
    setSelected(next);
  }

  function resetFilters() {
    setRepresentative("all");
    setCurrency("");
    setEventType("all");
    setQuery("");
    setDebouncedQuery("");
    setFrom("");
    setTo("");
  }

  async function handleWithdrawalCreated() {
    setWithdrawDialogOpen(false);
    setMutationNotice(
      zh
        ? "提现申请已提交，可在“提现与结算”中查看审核状态。"
        : "Withdrawal requested. Track its review status in Settlements.",
    );
    setSelected(null);
    if (activeView === "settlements") {
      await loadWallet("replace").catch((nextError: unknown) => {
        setError(nextError instanceof Error
          ? nextError.message
          : "Failed to refresh settlements.");
      });
      return;
    }
    setActiveView("settlements");
  }

  async function cancelWithdrawal(settlement: WorkspaceWalletSettlement) {
    const confirmed = window.confirm(
      zh
        ? `确认取消 ${formatMoney(settlement.amountCents, settlement.currency, locale)} 的提现申请？冻结收益会退回可提现余额。`
        : `Cancel this ${formatMoney(settlement.amountCents, settlement.currency, locale)} withdrawal? Frozen earnings will return to the withdrawable balance.`,
    );
    if (!confirmed) return;

    setCancelingWithdrawalId(settlement.id);
    setError(null);
    setMutationNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/wallet/withdrawals/${encodeURIComponent(settlement.id)}/cancel?rep=${encodeURIComponent(activeSlug)}`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `dashboard-cancel:${settlement.id}`,
          }),
        },
      );
      if (!response.ok) throw new Error(await extractError(response));
      setSelected(null);
      setMutationNotice(
        zh
          ? "提现申请已取消，冻结收益已退回可提现余额。"
          : "Withdrawal canceled. Frozen earnings are withdrawable again.",
      );
      await loadWallet("replace");
    } catch (nextError) {
      setError(nextError instanceof Error
        ? nextError.message
        : zh
          ? "取消提现失败。"
          : "Failed to cancel the withdrawal.");
    } finally {
      setCancelingWithdrawalId(null);
    }
  }

  async function applyMockWithdrawalAction(
    settlement: WorkspaceWalletSettlement,
    action: MockWithdrawalAction,
  ) {
    let reason: string | null = null;
    if (action === "reject" || action === "mark_failed") {
      const input = window.prompt(
        action === "reject"
          ? zh ? "请输入本地模拟拒绝原因" : "Enter a local mock rejection reason"
          : zh ? "请输入本地模拟打款失败原因" : "Enter a local mock payout failure reason",
      );
      if (input === null) return;
      reason = input.trim();
      if (!reason) {
        setError(zh ? "请输入原因。" : "A reason is required.");
        return;
      }
    }

    const operation = `${settlement.id}:${action}`;
    const idempotencyKey = mockActionIdempotencyKeysRef.current.get(operation)
      ?? `dashboard-mock:${action}:${crypto.randomUUID()}`;
    mockActionIdempotencyKeysRef.current.set(operation, idempotencyKey);
    setMockWithdrawalAction(operation);
    setError(null);
    setMutationNotice(null);
    try {
      const response = await fetch(
        `/api/dashboard/wallet/withdrawals/${encodeURIComponent(settlement.id)}/mock-action`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            idempotencyKey,
            ...(reason ? { reason } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await extractError(response));
      mockActionIdempotencyKeysRef.current.delete(operation);
      setMutationNotice(
        zh
          ? `本地模拟运营已完成：${mockWithdrawalActionLabel(action, locale)}。`
          : `Local mock operation completed: ${mockWithdrawalActionLabel(action, locale)}.`,
      );
      await loadWallet("replace");
    } catch (nextError) {
      setError(nextError instanceof Error
        ? nextError.message
        : zh
          ? "本地模拟运营失败。"
          : "Local mock operation failed.");
    } finally {
      setMockWithdrawalAction(null);
    }
  }

  return (
    <>
      <header className="dashboard-v2-page-header wallet-page-header">
        <div>
          <p>WALLET &amp; BILLING / 06</p>
          <h1>
            {zh
              ? "看清楚钱从哪里来、花到哪里、何时可以提现。"
              : "See where money comes from, where it goes, and when it becomes withdrawable."}
          </h1>
          <span>
            {zh
              ? "按工作区、数字代表和币种追踪购买、使用扣费、收益释放、退款与提现；业务事件可以继续下钻到账本分录。"
              : "Trace purchases, usage, earning release, refunds, and payouts by workspace, representative, and currency, then drill into the underlying ledger."}
          </span>
        </div>
        <div className="dashboard-v2-page-actions">
          <button
            className="dashboard-v2-button-secondary"
            disabled={showInitialLoading || loading || loadingMore}
            onClick={() => void loadWallet("replace").catch((nextError: unknown) => {
              setError(nextError instanceof Error ? nextError.message : "Refresh failed.");
            })}
            type="button"
          >
            {loading && !initialLoading
              ? zh ? "刷新中…" : "Refreshing…"
              : zh ? "刷新" : "Refresh"}
          </button>
          {snapshot?.primaryAction.kind === "verify" ? (
            <span className="wallet-primary-guidance" role="status">
              {zh ? "完成创作者验证后可提现" : "Complete creator verification to withdraw"}
            </span>
          ) : snapshot?.primaryAction.kind === "withdraw" ? (
            <button
              className="dashboard-v2-button-primary"
              disabled={!eligibleWithdrawalRepresentatives.length || loading || loadingMore}
              onClick={() => {
                setMutationNotice(null);
                setWithdrawDialogOpen(true);
              }}
              type="button"
            >
              {zh ? "申请提现" : "Request withdrawal"}
            </button>
          ) : null}
        </div>
      </header>

      <nav
        aria-label={zh ? "钱包与账单视图" : "Wallet and billing views"}
        className="dashboard-v2-subnav wallet-subnav"
        role="tablist"
      >
        {walletViews.map((view) => (
          <button
            aria-selected={activeView === view}
            className={activeView === view ? "is-active" : undefined}
            key={view}
            onClick={() => setActiveView(view)}
            role="tab"
            type="button"
          >
            {walletViewLabel(view, locale)}
          </button>
        ))}
      </nav>

      <div
        aria-busy={showInitialLoading || loading || loadingMore}
        className="dashboard-module-content wallet-module-content"
      >
        {mutationNotice ? (
          <div className="skills-banner is-success" role="status">
            <span>{mutationNotice}</span>
            <button
              aria-label={zh ? "关闭提示" : "Dismiss notice"}
              className="dashboard-v2-button-secondary"
              onClick={() => setMutationNotice(null)}
              type="button"
            >
              ×
            </button>
          </div>
        ) : null}
        {error && snapshot && !showInitialLoading ? (
          <div className="skills-banner is-error" role="alert">
            <span>{error}</span>
            <button
              className="dashboard-v2-button-secondary"
              disabled={loading || loadingMore}
              onClick={() => void loadWallet("replace").catch((nextError: unknown) => {
                setError(nextError instanceof Error ? nextError.message : "Retry failed.");
              })}
              type="button"
            >
              {zh ? "重试" : "Retry"}
            </button>
          </div>
        ) : null}

        {showInitialLoading ? (
          <section aria-live="polite" className="dashboard-v2-panel skills-loading" role="status">
            <p>{zh ? "正在核对工作区资金链路…" : "Loading the workspace money trail…"}</p>
          </section>
        ) : showInitialFailure ? (
          <section className="dashboard-v2-panel skills-loading" role="alert">
            <div className="skills-banner is-error">
              <span>
                <strong>{zh ? "钱包与账单暂时无法加载" : "Wallet and billing could not load"}</strong>
                {" · "}
                {error}
              </span>
              <button
                className="dashboard-v2-button-secondary"
                disabled={loading || loadingMore}
                onClick={() => void loadWallet("replace").catch((nextError: unknown) => {
                  setError(nextError instanceof Error ? nextError.message : "Retry failed.");
                })}
                type="button"
              >
                {zh ? "重试" : "Retry"}
              </button>
            </div>
          </section>
        ) : (
          <>
            <WalletFilters
              currency={resolvedCurrency}
              currencies={snapshot?.currencies ?? []}
              eventType={eventType}
              eventTypes={eventTypeOptions}
              from={from}
              locale={locale}
              onCurrency={setCurrency}
              onEventType={setEventType}
              onFrom={setFrom}
              onQuery={setQuery}
              onRepresentative={setRepresentative}
              onReset={resetFilters}
              onTo={setTo}
              query={query}
              representative={representative}
              representatives={representatives}
              showEventType={activeView === "transactions" || activeView === "overview"}
              to={to}
            />

            {activeView === "overview" ? (
              <div className={selectedDetail
                ? "wallet-overview-detail-layout is-open"
                : "wallet-overview-detail-layout"}
              >
                <div>
                  <WalletOverview
                    currency={resolvedCurrency || "CNY"}
                    events={events}
                    locale={locale}
                    metrics={snapshot?.metrics}
                    onSelect={chooseRow}
                    settlements={settlements}
                  />
                </div>
                {selectedDetail ? (
                  <WalletDetailPanel
                    cancelingWithdrawalId={cancelingWithdrawalId}
                    closeButtonRef={closeButtonRef}
                    detail={selectedDetail}
                    locale={locale}
                    mockWithdrawalAction={mockWithdrawalAction}
                    mockWithdrawalOperations={Boolean(
                      snapshot?.capabilities?.mockWithdrawalOperations,
                    )}
                    onCancelWithdrawal={(settlement) => void cancelWithdrawal(settlement)}
                    onClose={() => setSelected(null)}
                    onMockWithdrawalAction={(settlement, action) =>
                      void applyMockWithdrawalAction(settlement, action)}
                  />
                ) : null}
              </div>
            ) : (
              <div className="wallet-table-detail-layout">
                <section className="dashboard-v2-panel wallet-table-panel">
                  <header>
                    <div>
                      <p>{walletViewEyebrow(activeView)}</p>
                      <h2>{walletViewHeading(activeView, locale)}</h2>
                    </div>
                    <span>
                      {currentRowCount(activeView, events, settlements, ledgerEntries)}
                      {" / "}
                      {snapshot?.page.filteredTotal ?? 0}
                    </span>
                  </header>
                  {activeView === "transactions" ? (
                    <WalletEventTable
                      events={events}
                      locale={locale}
                      onSelect={chooseRow}
                      selected={selected}
                    />
                  ) : activeView === "settlements" ? (
                    <WalletSettlementTable
                      locale={locale}
                      onSelect={chooseRow}
                      selected={selected}
                      settlements={settlements}
                    />
                  ) : (
                    <WalletLedgerTable
                      entries={ledgerEntries}
                      locale={locale}
                      onSelect={chooseRow}
                      selected={selected}
                    />
                  )}
                  <WalletTableFooter
                    count={currentRowCount(activeView, events, settlements, ledgerEntries)}
                    hasMore={Boolean(snapshot?.page.hasMore && snapshot.page.nextCursor)}
                    loading={loading || loadingMore}
                    loadingMore={loadingMore}
                    locale={locale}
                    onLoadMore={() => void loadWallet(
                      "append",
                      snapshot?.page.nextCursor,
                    ).catch((nextError: unknown) => {
                      setError(nextError instanceof Error
                        ? nextError.message
                        : "Load more failed.");
                    })}
                    total={snapshot?.page.filteredTotal ?? 0}
                  />
                </section>
                <WalletDetailPanel
                  cancelingWithdrawalId={cancelingWithdrawalId}
                  closeButtonRef={closeButtonRef}
                  detail={selectedDetail}
                  locale={locale}
                  mockWithdrawalAction={mockWithdrawalAction}
                  mockWithdrawalOperations={Boolean(
                    snapshot?.capabilities?.mockWithdrawalOperations,
                  )}
                  onCancelWithdrawal={(settlement) => void cancelWithdrawal(settlement)}
                  onClose={() => setSelected(null)}
                  onMockWithdrawalAction={(settlement, action) =>
                    void applyMockWithdrawalAction(settlement, action)}
                />
              </div>
            )}

            <footer className="wallet-as-of">
              <span>
                {zh ? "账目事件截止" : "Event cutoff"}
                {" · "}
                {snapshot ? formatTimestamp(snapshot.workspace.asOf, locale, true) : "—"}
                {" · "}
                {resolvedCurrency || "—"}
              </span>
              <span>
                {zh
                  ? "事件列表按该时间分页；汇总卡为首屏请求时计算的当前余额与周期汇总。所有汇总均限定在当前币种，不执行跨币种相加。"
                  : "Event rows are paged against this cutoff; summary cards are current balances and period totals calculated with the first page. Every total is scoped to the selected currency; currencies are never combined."}
              </span>
            </footer>
          </>
        )}
      </div>
      {withdrawDialogOpen && snapshot ? (
        <WalletWithdrawalDialog
          activeSlug={activeSlug}
          currency={resolvedCurrency || snapshot.filters.currency}
          initialRepresentativeSlug={defaultWithdrawalRepresentative}
          locale={locale}
          onClose={() => setWithdrawDialogOpen(false)}
          onCreated={() => void handleWithdrawalCreated()}
          representatives={eligibleWithdrawalRepresentatives}
        />
      ) : null}
    </>
  );
}

function WalletWithdrawalDialog({
  activeSlug,
  currency,
  initialRepresentativeSlug,
  locale,
  onClose,
  onCreated,
  representatives,
}: {
  activeSlug: string;
  currency: string;
  initialRepresentativeSlug: string;
  locale: Locale;
  onClose: () => void;
  onCreated: () => void;
  representatives: WalletRepresentative[];
}) {
  const zh = locale === "zh";
  const dialogRef = useRef<HTMLElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const submittingRef = useRef(false);
  const [representativeSlug, setRepresentativeSlug] = useState(
    initialRepresentativeSlug,
  );
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  submittingRef.current = submitting;
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(
    () => `dashboard-withdraw:${crypto.randomUUID()}`,
  );
  const selectedRepresentative = representatives.find(
    (item) => item.slug === representativeSlug,
  ) ?? representatives[0] ?? null;
  const amountCents = parseMoneyInputToCents(amount);
  const availableCents = selectedRepresentative?.withdrawableCents ?? 0;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const timeout = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current
        ? [...dialogRef.current.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
          )]
        : [];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!confirming) return;
    const timeout = window.setTimeout(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(
          ".wallet-withdrawal-confirmation footer button:not([disabled])",
        )
        ?.focus();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [confirming]);

  function reviewWithdrawal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!selectedRepresentative) {
      setError(zh ? "请选择数字代表。" : "Choose a representative.");
      return;
    }
    if (!amountCents || amountCents <= 0) {
      setError(
        zh
          ? "请输入最多两位小数的有效提现金额。"
          : "Enter a valid withdrawal amount with at most two decimal places.",
      );
      return;
    }
    if (amountCents > availableCents) {
      setError(
        zh
          ? "提现金额不能超过该数字代表的可提现余额。"
          : "The amount exceeds this representative's withdrawable balance.",
      );
      return;
    }
    setConfirming(true);
  }

  async function submitWithdrawal() {
    if (!selectedRepresentative || !amountCents) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dashboard/wallet/withdrawals?rep=${encodeURIComponent(activeSlug)}`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            representativeSlug: selectedRepresentative.slug,
            amountCents,
            currency,
            idempotencyKey,
          }),
        },
      );
      if (!response.ok) throw new Error(await extractError(response));
      onCreated();
    } catch (nextError) {
      setError(nextError instanceof Error
        ? nextError.message
        : zh
          ? "提现申请提交失败。"
          : "Failed to request the withdrawal.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="wallet-withdrawal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !submitting) onClose();
      }}
      role="presentation"
    >
      <section
        aria-labelledby="wallet-withdrawal-heading"
        aria-modal="true"
        className="wallet-withdrawal-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <p>CREATOR WITHDRAWAL</p>
            <h2 id="wallet-withdrawal-heading">
              {confirming
                ? zh ? "确认提现申请" : "Confirm withdrawal"
                : zh ? "申请提现" : "Request withdrawal"}
            </h2>
            <span>
              {zh
                ? "提现按数字代表和币种分别提交；提交后对应收益会冻结并进入人工审核。"
                : "Withdrawals are submitted per representative and currency. The amount is frozen for manual review."}
            </span>
          </div>
          <button
            aria-label={zh ? "关闭提现申请" : "Close withdrawal request"}
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>

        {confirming && selectedRepresentative && amountCents ? (
          <div className="wallet-withdrawal-confirmation">
            <dl>
              <Fact
                label={zh ? "数字代表" : "Representative"}
                value={selectedRepresentative.name}
              />
              <Fact label={zh ? "币种" : "Currency"} value={currency} mono />
              <Fact
                label={zh ? "提现金额" : "Amount"}
                value={formatMoney(amountCents, currency, locale)}
              />
              <Fact
                label={zh ? "提交后可提现" : "Withdrawable after request"}
                value={formatMoney(
                  availableCents - amountCents,
                  currency,
                  locale,
                )}
              />
            </dl>
            <div className="skills-trust-note">
              <strong>{zh ? "人工审核" : "Manual review"}</strong>
              <span>
                {zh
                  ? "这一步不会自动打款。你可以在打款前取消申请，冻结金额会退回可提现余额。"
                  : "This does not trigger an automatic payout. You can cancel before payout and return the frozen amount to your balance."}
              </span>
            </div>
            {error ? <div className="skills-banner is-error" role="alert">{error}</div> : null}
            <footer>
              <button
                className="dashboard-v2-button-secondary"
                disabled={submitting}
                onClick={() => setConfirming(false)}
                type="button"
              >
                {zh ? "返回修改" : "Back"}
              </button>
              <button
                className="dashboard-v2-button-primary"
                disabled={submitting}
                onClick={() => void submitWithdrawal()}
                type="button"
              >
                {submitting
                  ? zh ? "提交中…" : "Submitting…"
                  : zh ? "确认并冻结收益" : "Confirm and freeze earnings"}
              </button>
            </footer>
          </div>
        ) : (
          <form onSubmit={reviewWithdrawal}>
            <label>
              <span>{zh ? "数字代表" : "Representative"}</span>
              <select
                onChange={(event) => {
                  setRepresentativeSlug(event.target.value);
                  setAmount("");
                  setError(null);
                }}
                ref={firstFieldRef}
                value={selectedRepresentative?.slug ?? ""}
              >
                {representatives.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="wallet-withdrawal-available">
              <span>{zh ? "当前可提现" : "Currently withdrawable"}</span>
              <strong>{formatMoney(availableCents, currency, locale)}</strong>
              <small>
                {selectedRepresentative?.activeWithdrawRequest
                  ? zh ? "该代表已有处理中提现" : "This representative has an active withdrawal"
                  : zh ? "尚未进入提现审核的已释放收益" : "Released earnings not yet in payout review"}
              </small>
            </div>
            <label>
              <span>{zh ? "提现金额" : "Withdrawal amount"}</span>
              <div className="wallet-withdrawal-amount">
                <b>{currency}</b>
                <input
                  autoComplete="off"
                  inputMode="decimal"
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setError(null);
                  }}
                  placeholder="0.00"
                  value={amount}
                />
                <button
                  onClick={() => setAmount((availableCents / 100).toFixed(2))}
                  type="button"
                >
                  {zh ? "全部" : "Max"}
                </button>
              </div>
              <small>
                {zh
                  ? "金额以最小货币单位入账；不支持跨币种合并提现。"
                  : "The amount is recorded in minor units. Currencies cannot be combined."}
              </small>
            </label>
            {error ? <div className="skills-banner is-error" role="alert">{error}</div> : null}
            <footer>
              <button
                className="dashboard-v2-button-secondary"
                onClick={onClose}
                type="button"
              >
                {zh ? "取消" : "Cancel"}
              </button>
              <button className="dashboard-v2-button-primary" type="submit">
                {zh ? "核对申请" : "Review request"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function WalletFilters({
  currency,
  currencies,
  eventType,
  eventTypes,
  from,
  locale,
  onCurrency,
  onEventType,
  onFrom,
  onQuery,
  onRepresentative,
  onReset,
  onTo,
  query,
  representative,
  representatives,
  showEventType,
  to,
}: {
  currency: string;
  currencies: string[];
  eventType: string;
  eventTypes: Array<{ id: string; count: number }>;
  from: string;
  locale: Locale;
  onCurrency: (value: string) => void;
  onEventType: (value: string) => void;
  onFrom: (value: string) => void;
  onQuery: (value: string) => void;
  onRepresentative: (value: string) => void;
  onReset: () => void;
  onTo: (value: string) => void;
  query: string;
  representative: string;
  representatives: WalletRepresentative[];
  showEventType: boolean;
  to: string;
}) {
  const zh = locale === "zh";
  return (
    <section aria-label={zh ? "钱包筛选" : "Wallet filters"} className="wallet-filter-bar">
      <label>
        <span>{zh ? "数字代表" : "Representative"}</span>
        <select
          onChange={(event) => onRepresentative(event.target.value)}
          value={representative}
        >
          <option value="all">{zh ? "全部代表" : "All representatives"}</option>
          {representatives.map((item) => (
            <option key={item.slug} value={item.slug}>{item.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{zh ? "币种" : "Currency"}</span>
        <select onChange={(event) => onCurrency(event.target.value)} value={currency}>
          {currencies.length
            ? currencies.map((item) => <option key={item} value={item}>{item}</option>)
            : <option value={currency || "CNY"}>{currency || "CNY"}</option>}
        </select>
      </label>
      {showEventType ? (
        <label>
          <span>{zh ? "事件类型" : "Event type"}</span>
          <select onChange={(event) => onEventType(event.target.value)} value={eventType}>
            <option value="all">{zh ? "全部事件" : "All events"}</option>
            {eventTypes.map((item) => (
              <option key={item.id} value={item.id}>
                {walletEventTypeLabel(item.id, locale)} · {item.count}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        <span>{zh ? "开始日期" : "From"}</span>
        <input
          max={to || undefined}
          onChange={(event) => onFrom(event.target.value)}
          type="date"
          value={from}
        />
      </label>
      <label>
        <span>{zh ? "结束日期" : "To"}</span>
        <input
          min={from || undefined}
          onChange={(event) => onTo(event.target.value)}
          type="date"
          value={to}
        />
      </label>
      <label className="wallet-filter-search">
        <span>{zh ? "搜索" : "Search"}</span>
        <input
          onChange={(event) => onQuery(event.target.value)}
          placeholder={zh ? "事件、来源或代表" : "Event, source, or representative"}
          type="search"
          value={query}
        />
      </label>
      <button className="dashboard-v2-button-secondary" onClick={onReset} type="button">
        {zh ? "重置" : "Reset"}
      </button>
    </section>
  );
}

function WalletOverview({
  currency,
  events,
  locale,
  metrics,
  onSelect,
  settlements,
}: {
  currency: string;
  events: WorkspaceWalletEvent[];
  locale: Locale;
  metrics: WorkspaceWalletSnapshot["metrics"] | undefined;
  onSelect: (row: SelectedWalletRow, target: HTMLElement) => void;
  settlements: WorkspaceWalletSettlement[];
}) {
  const zh = locale === "zh";
  const cards = [
    {
      detail: zh ? "筛选周期内已完成的服务额度销售" : "Completed service-credit sales in this period",
      label: zh ? "销售额" : "Gross sales",
      tone: "teal",
      value: metrics?.grossSalesCents ?? 0,
    },
    {
      detail: zh ? "筛选周期内随服务履约释放" : "Released as service was fulfilled in this period",
      label: zh ? "已释放收益" : "Released income",
      tone: "indigo",
      value: metrics?.releasedCreatorIncomeCents ?? 0,
    },
    {
      detail: zh ? "已购买但尚未完成履约" : "Purchased, but service is not yet fulfilled",
      label: zh ? "待释放收益" : "Pending earnings",
      tone: "neutral",
      value: metrics?.pendingEarningsCents ?? 0,
    },
    {
      detail: zh ? "已释放且尚未进入提现审核" : "Released and not yet in payout review",
      label: zh ? "可提现" : "Withdrawable",
      tone: "teal",
      value: metrics?.withdrawableCents ?? 0,
    },
    {
      detail: zh ? "正在审核或打款中的冻结金额" : "Frozen while review or payout is in progress",
      label: zh ? "提现处理中" : "Payout in progress",
      tone: "warning",
      value: metrics?.payoutInProgressCents ?? 0,
    },
  ] as const;

  return (
    <>
      <section className="dashboard-v2-metric-grid wallet-metrics">
        {cards.map((card) => (
          <article className={`dashboard-v2-metric-card is-${card.tone}`} key={card.label}>
            <div><span>{card.label}</span><i /></div>
            <strong>{formatMoney(card.value, currency, locale)}</strong>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>

      <div className="wallet-overview-layout">
        <section className="dashboard-v2-panel wallet-overview-events">
          <header>
            <div>
              <p>RECENT TRANSACTIONS</p>
              <h2>{zh ? "最近资金事件" : "Recent money events"}</h2>
            </div>
            <span>{events.length}</span>
          </header>
          <WalletEventTable
            events={events.slice(0, 8)}
            locale={locale}
            onSelect={onSelect}
            selected={null}
          />
        </section>
        <section className="dashboard-v2-panel wallet-overview-settlements">
          <header>
            <div>
              <p>SETTLEMENTS</p>
              <h2>{zh ? "提现与结算状态" : "Withdrawal and payout status"}</h2>
            </div>
            <span>{settlements.length}</span>
          </header>
          <div className="wallet-settlement-list">
            {settlements.slice(0, 6).map((settlement) => (
              <button
                key={settlement.id}
                onClick={(event) => onSelect(
                  { kind: "settlement", id: settlement.id },
                  event.currentTarget,
                )}
                type="button"
              >
                <span className={`wallet-status is-${statusTone(settlement.status)}`}>
                  {walletStatusLabel(settlement.status, locale)}
                </span>
                <strong>{formatMoney(settlement.amountCents, settlement.currency, locale)}</strong>
                <small>
                  {settlement.representativeName ?? (zh ? "全部代表" : "All representatives")}
                  {" · "}
                  {formatTimestamp(settlement.requestedAt, locale)}
                </small>
              </button>
            ))}
            {!settlements.length ? (
              <div className="wallet-empty-state">
                <strong>{zh ? "暂无提现请求" : "No withdrawal requests"}</strong>
                <span>{zh ? "可提现收益会先冻结，再进入人工审核。" : "Withdrawable earnings are frozen before human review."}</span>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}

function WalletEventTable({
  events,
  locale,
  onSelect,
  selected,
}: {
  events: WorkspaceWalletEvent[];
  locale: Locale;
  onSelect: (row: SelectedWalletRow, target: HTMLElement) => void;
  selected: SelectedWalletRow | null;
}) {
  const zh = locale === "zh";
  return (
    <div className="dashboard-v2-table-scroll">
      <table className="dashboard-v2-table wallet-table">
        <thead>
          <tr>
            <th>{zh ? "时间" : "Time"}</th>
            <th>{zh ? "事件" : "Event"}</th>
            <th>{zh ? "数字代表" : "Representative"}</th>
            <th>{zh ? "金额 / 数量" : "Amount / quantity"}</th>
            <th>{zh ? "状态" : "Status"}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr
              aria-selected={selected?.kind === "event" && selected.id === event.id}
              className={selected?.kind === "event" && selected.id === event.id
                ? "is-selected"
                : undefined}
              key={event.id}
              onClick={(clickEvent) => onSelect(
                { kind: "event", id: event.id },
                clickEvent.currentTarget,
              )}
              onKeyDown={(keyboardEvent) => activateTableRow(
                keyboardEvent,
                () => onSelect(
                  { kind: "event", id: event.id },
                  keyboardEvent.currentTarget,
                ),
              )}
              tabIndex={0}
            >
              <td><time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt, locale)}</time></td>
              <td><strong>{walletEventTypeLabel(event.eventType, locale)}</strong><small>{event.description}</small></td>
              <td>{event.representativeName ?? "—"}</td>
              <td>
                <strong className={event.amountCents > 0 ? "is-positive" : undefined}>
                  {event.amountCents
                    ? formatSignedMoney(event.amountCents, event.currency, locale)
                    : `${formatSignedNumber(event.tokenAmount)} ${zh ? "额度" : "credits"}`}
                </strong>
              </td>
              <td><span className={`wallet-status is-${statusTone(event.status)}`}>{walletStatusLabel(event.status, locale)}</span></td>
            </tr>
          ))}
          {!events.length ? (
            <tr><td className="wallet-empty-cell" colSpan={5}>{zh ? "当前筛选下没有资金事件。" : "No money events match these filters."}</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function WalletSettlementTable({
  locale,
  onSelect,
  selected,
  settlements,
}: {
  locale: Locale;
  onSelect: (row: SelectedWalletRow, target: HTMLElement) => void;
  selected: SelectedWalletRow | null;
  settlements: WorkspaceWalletSettlement[];
}) {
  const zh = locale === "zh";
  return (
    <div className="dashboard-v2-table-scroll">
      <table className="dashboard-v2-table wallet-table">
        <thead>
          <tr>
            <th>{zh ? "申请时间" : "Requested"}</th>
            <th>{zh ? "数字代表" : "Representative"}</th>
            <th>{zh ? "金额" : "Amount"}</th>
            <th>{zh ? "状态" : "Status"}</th>
            <th>{zh ? "打款渠道" : "Provider"}</th>
          </tr>
        </thead>
        <tbody>
          {settlements.map((settlement) => (
            <tr
              aria-selected={selected?.kind === "settlement" && selected.id === settlement.id}
              className={selected?.kind === "settlement" && selected.id === settlement.id
                ? "is-selected"
                : undefined}
              key={settlement.id}
              onClick={(clickEvent) => onSelect(
                { kind: "settlement", id: settlement.id },
                clickEvent.currentTarget,
              )}
              onKeyDown={(keyboardEvent) => activateTableRow(
                keyboardEvent,
                () => onSelect(
                  { kind: "settlement", id: settlement.id },
                  keyboardEvent.currentTarget,
                ),
              )}
              tabIndex={0}
            >
              <td><time dateTime={settlement.requestedAt}>{formatTimestamp(settlement.requestedAt, locale)}</time></td>
              <td>{settlement.representativeName ?? (zh ? "工作区" : "Workspace")}</td>
              <td><strong>{formatMoney(settlement.amountCents, settlement.currency, locale)}</strong></td>
              <td><span className={`wallet-status is-${statusTone(settlement.status)}`}>{walletStatusLabel(settlement.status, locale)}</span></td>
              <td>{settlement.provider ?? "—"}</td>
            </tr>
          ))}
          {!settlements.length ? (
            <tr><td className="wallet-empty-cell" colSpan={5}>{zh ? "当前筛选下没有提现或结算记录。" : "No settlements match these filters."}</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function WalletLedgerTable({
  entries,
  locale,
  onSelect,
  selected,
}: {
  entries: WorkspaceWalletLedgerEntry[];
  locale: Locale;
  onSelect: (row: SelectedWalletRow, target: HTMLElement) => void;
  selected: SelectedWalletRow | null;
}) {
  const zh = locale === "zh";
  return (
    <div className="dashboard-v2-table-scroll">
      <table className="dashboard-v2-table wallet-table wallet-ledger-table">
        <thead>
          <tr>
            <th>{zh ? "时间" : "Time"}</th>
            <th>{zh ? "账户" : "Account"}</th>
            <th>{zh ? "分录" : "Entry"}</th>
            <th>{zh ? "金额 / 数量" : "Amount / quantity"}</th>
            <th>{zh ? "交易组" : "Transaction group"}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              aria-selected={selected?.kind === "ledger" && selected.id === entry.id}
              className={selected?.kind === "ledger" && selected.id === entry.id
                ? "is-selected"
                : undefined}
              key={entry.id}
              onClick={(clickEvent) => onSelect(
                { kind: "ledger", id: entry.id },
                clickEvent.currentTarget,
              )}
              onKeyDown={(keyboardEvent) => activateTableRow(
                keyboardEvent,
                () => onSelect(
                  { kind: "ledger", id: entry.id },
                  keyboardEvent.currentTarget,
                ),
              )}
              tabIndex={0}
            >
              <td><time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt, locale)}</time></td>
              <td><strong>{humanizeCode(entry.accountType)}</strong><small>{entry.representativeName ?? "—"}</small></td>
              <td>{humanizeCode(entry.entryKind)}</td>
              <td>
                <strong className={entry.amountCents > 0 || entry.tokenAmount > 0 ? "is-positive" : undefined}>
                  {entry.amountCents
                    ? formatSignedMoney(entry.amountCents, entry.currency, locale)
                    : `${formatSignedNumber(entry.tokenAmount)} ${zh ? "额度" : "credits"}`}
                </strong>
              </td>
              <td><code title={entry.eventGroupId}>{shortId(entry.eventGroupId)}</code></td>
            </tr>
          ))}
          {!entries.length ? (
            <tr><td className="wallet-empty-cell" colSpan={5}>{zh ? "当前筛选下没有账本分录。" : "No ledger entries match these filters."}</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function WalletTableFooter({
  count,
  hasMore,
  loading,
  loadingMore,
  locale,
  onLoadMore,
  total,
}: {
  count: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  locale: Locale;
  onLoadMore: () => void;
  total: number;
}) {
  const zh = locale === "zh";
  return (
    <footer className="dashboard-v2-table-footer">
      <span>{zh ? `已加载 ${count} / ${total}` : `Loaded ${count} / ${total}`}</span>
      <div>
        <button
          className="dashboard-v2-button-secondary"
          disabled={loading || !hasMore}
          onClick={onLoadMore}
          type="button"
        >
          {loadingMore ? zh ? "加载中…" : "Loading…" : zh ? "加载更多" : "Load more"}
        </button>
      </div>
    </footer>
  );
}

function WalletDetailPanel({
  cancelingWithdrawalId,
  closeButtonRef,
  detail,
  locale,
  mockWithdrawalAction,
  mockWithdrawalOperations,
  onCancelWithdrawal,
  onClose,
  onMockWithdrawalAction,
}: {
  cancelingWithdrawalId: string | null;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  detail:
    | { kind: "event"; row: WorkspaceWalletEvent }
    | { kind: "settlement"; row: WorkspaceWalletSettlement }
    | { kind: "ledger"; row: WorkspaceWalletLedgerEntry }
    | null;
  locale: Locale;
  mockWithdrawalAction: string | null;
  mockWithdrawalOperations: boolean;
  onCancelWithdrawal: (settlement: WorkspaceWalletSettlement) => void;
  onClose: () => void;
  onMockWithdrawalAction: (
    settlement: WorkspaceWalletSettlement,
    action: MockWithdrawalAction,
  ) => void;
}) {
  const zh = locale === "zh";
  const [isMobileSheet, setIsMobileSheet] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobileSheet(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return (
    <>
      {detail ? (
        <button
          aria-label={zh ? "关闭详情" : "Close details"}
          className="wallet-detail-backdrop"
          onClick={onClose}
          type="button"
        />
      ) : null}
      <aside
        aria-labelledby="wallet-detail-heading"
        aria-modal={detail && isMobileSheet ? true : undefined}
        className={detail
          ? "dashboard-v2-panel wallet-detail-panel is-open"
          : "dashboard-v2-panel wallet-detail-panel"}
        role={detail && isMobileSheet ? "dialog" : "region"}
      >
        <header>
          <div>
            <p>TRACEABLE DETAIL</p>
            <h2 id="wallet-detail-heading">{detail ? detailHeading(detail, locale) : zh ? "选择一条记录" : "Select a record"}</h2>
          </div>
          {detail ? (
            <button
              aria-label={zh ? "关闭详情" : "Close details"}
              className="wallet-detail-close"
              onClick={onClose}
              ref={closeButtonRef}
              type="button"
            >
              ×
            </button>
          ) : null}
        </header>
        {!detail ? (
          <p className="dashboard-v2-panel-description">
            {zh
              ? "从左侧列表选择业务事件、提现记录或账本分录，查看关联标识和资金状态。"
              : "Choose a business event, withdrawal, or ledger entry to inspect its linked identifiers and money state."}
          </p>
        ) : detail.kind === "event" ? (
          <EventDetail event={detail.row} locale={locale} />
        ) : detail.kind === "settlement" ? (
          <SettlementDetail
            canceling={cancelingWithdrawalId === detail.row.id}
            locale={locale}
            mockAction={mockWithdrawalAction}
            mockOperations={mockWithdrawalOperations}
            onCancel={onCancelWithdrawal}
            onMockAction={onMockWithdrawalAction}
            settlement={detail.row}
          />
        ) : (
          <LedgerDetail entry={detail.row} locale={locale} />
        )}
        <div className="skills-trust-note">
          <strong>{zh ? "账本边界" : "Ledger boundary"}</strong>
          <span>
            {zh
              ? "业务事件用于解释发生了什么；不可变分录用于证明金额如何移动。任何敏感支付 payload 都不会在这里展示。"
              : "Business events explain what happened; immutable entries prove how value moved. Sensitive payment payloads are never shown here."}
          </span>
        </div>
      </aside>
    </>
  );
}

function EventDetail({ event, locale }: { event: WorkspaceWalletEvent; locale: Locale }) {
  const zh = locale === "zh";
  return (
    <dl className="skills-detail-facts wallet-detail-facts">
      <Fact label={zh ? "状态" : "Status"} value={walletStatusLabel(event.status, locale)} />
      <Fact label={zh ? "发生时间" : "Occurred"} value={formatTimestamp(event.occurredAt, locale, true)} />
      <Fact label={zh ? "数字代表" : "Representative"} value={event.representativeName ?? "—"} />
      <Fact label={zh ? "金额" : "Amount"} value={event.amountCents ? formatSignedMoney(event.amountCents, event.currency, locale) : "—"} />
      <Fact label={zh ? "服务额度" : "Service credits"} value={event.tokenAmount ? formatSignedNumber(event.tokenAmount) : "—"} />
      <Fact label="Source" value={`${event.sourceType}${event.sourceId ? ` · ${event.sourceId}` : ""}`} />
      <Fact label="Transaction ID" value={event.transactionId ?? "—"} mono />
      <Fact label="Event group" value={event.eventGroupId} mono />
    </dl>
  );
}

function SettlementDetail({
  canceling,
  locale,
  mockAction,
  mockOperations,
  onCancel,
  onMockAction,
  settlement,
}: {
  canceling: boolean;
  locale: Locale;
  mockAction: string | null;
  mockOperations: boolean;
  onCancel: (settlement: WorkspaceWalletSettlement) => void;
  onMockAction: (
    settlement: WorkspaceWalletSettlement,
    action: MockWithdrawalAction,
  ) => void;
  settlement: WorkspaceWalletSettlement;
}) {
  const zh = locale === "zh";
  const availableMockActions = mockWithdrawalActionsForStatus(
    settlement.status,
  );
  return (
    <>
      <dl className="skills-detail-facts wallet-detail-facts">
        <Fact label={zh ? "申请 ID" : "Request ID"} value={settlement.id} mono />
        <Fact label={zh ? "状态" : "Status"} value={walletStatusLabel(settlement.status, locale)} />
        <Fact label={zh ? "金额" : "Amount"} value={formatMoney(settlement.amountCents, settlement.currency, locale)} />
        <Fact label={zh ? "数字代表" : "Representative"} value={settlement.representativeName ?? (zh ? "工作区" : "Workspace")} />
        <Fact label={zh ? "申请时间" : "Requested"} value={formatTimestamp(settlement.requestedAt, locale, true)} />
        <Fact label={zh ? "审核时间" : "Reviewed"} value={settlement.reviewedAt ? formatTimestamp(settlement.reviewedAt, locale, true) : "—"} />
        <Fact label={zh ? "审核人" : "Reviewer"} value={settlement.reviewedBy ?? "—"} />
        <Fact label={zh ? "打款时间" : "Paid"} value={settlement.paidAt ? formatTimestamp(settlement.paidAt, locale, true) : "—"} />
        <Fact label={zh ? "打款渠道" : "Provider"} value={settlement.provider ?? "—"} />
        <Fact label="Payout ID" value={settlement.providerPayoutId ?? "—"} mono />
        <Fact label="Transaction ID" value={settlement.transactionId ?? "—"} mono />
        <Fact label="Event group" value={settlement.eventGroupId ?? "—"} mono />
        {settlement.failureReason ? <Fact label={zh ? "失败原因" : "Failure"} value={settlement.failureReason} /> : null}
      </dl>
      {mockOperations && availableMockActions.length ? (
        <section className="wallet-mock-operations">
          <header>
            <strong>{zh ? "本地模拟运营" : "Local mock operations"}</strong>
            <span>
              {zh
                ? "仅非生产环境可用，用于演练人工审核与模拟打款，不代表创作者拥有正式自审权限。"
                : "Non-production only. This simulates operations review and payout; it is not creator self-approval."}
            </span>
          </header>
          <div>
            {availableMockActions.map((action) => (
              <button
                className="dashboard-v2-button-secondary"
                disabled={mockAction !== null || canceling}
                key={action}
                onClick={() => onMockAction(settlement, action)}
                type="button"
              >
                {mockAction === `${settlement.id}:${action}`
                  ? zh ? "处理中…" : "Working…"
                  : mockWithdrawalActionLabel(action, locale)}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {settlement.cancelable ? (
        <div className="wallet-settlement-actions">
          <button
            className="dashboard-v2-button-secondary"
            disabled={canceling || mockAction !== null}
            onClick={() => onCancel(settlement)}
            type="button"
          >
            {canceling
              ? zh ? "取消中…" : "Canceling…"
              : zh ? "取消提现申请" : "Cancel withdrawal"}
          </button>
          <span>
            {zh
              ? "取消后冻结收益会退回可提现余额。"
              : "Canceling returns frozen earnings to the withdrawable balance."}
          </span>
        </div>
      ) : null}
    </>
  );
}

function LedgerDetail({
  entry,
  locale,
}: {
  entry: WorkspaceWalletLedgerEntry;
  locale: Locale;
}) {
  const zh = locale === "zh";
  return (
    <dl className="skills-detail-facts wallet-detail-facts">
      <Fact label={zh ? "账户" : "Account"} value={humanizeCode(entry.accountType)} />
      <Fact label={zh ? "分录类型" : "Entry kind"} value={humanizeCode(entry.entryKind)} />
      <Fact label={zh ? "金额" : "Amount"} value={entry.amountCents ? formatSignedMoney(entry.amountCents, entry.currency, locale) : "—"} />
      <Fact label={zh ? "服务额度" : "Service credits"} value={entry.tokenAmount ? formatSignedNumber(entry.tokenAmount) : "—"} />
      <Fact label={zh ? "金额余额" : "Amount balance"} value={entry.balanceAfterCents === null ? "—" : formatMoney(entry.balanceAfterCents, entry.currency, locale)} />
      <Fact label={zh ? "额度余额" : "Credit balance"} value={entry.tokenBalanceAfter === null ? "—" : String(entry.tokenBalanceAfter)} />
      <Fact label="Transaction ID" value={entry.transactionId ?? "—"} mono />
      <Fact label="Event group" value={entry.eventGroupId} mono />
      <Fact label={zh ? "记录时间" : "Recorded"} value={formatTimestamp(entry.createdAt, locale, true)} />
      {entry.notes ? <Fact label={zh ? "说明" : "Notes"} value={entry.notes} /> : null}
    </dl>
  );
}

function Fact({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return <div><dt>{label}</dt><dd className={mono ? "is-mono" : undefined} title={value}>{value}</dd></div>;
}

function mergeRows<T extends { id: string }>(
  current: T[],
  incoming: T[],
  mode: "replace" | "append",
) {
  if (mode === "replace") return incoming;
  const merged = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) merged.set(row.id, row);
  return [...merged.values()];
}

function resolveSelection(
  current: SelectedWalletRow | null,
  snapshot: WorkspaceWalletSnapshot,
  mode: "replace" | "append",
): SelectedWalletRow | null {
  if (mode === "append" && current) return current;
  if (snapshot.filters.view === "transactions") {
    return snapshot.events[0] ? { kind: "event", id: snapshot.events[0].id } : null;
  }
  if (snapshot.filters.view === "settlements") {
    return snapshot.settlements[0]
      ? { kind: "settlement", id: snapshot.settlements[0].id }
      : null;
  }
  if (snapshot.filters.view === "ledger") {
    return snapshot.ledgerEntries[0]
      ? { kind: "ledger", id: snapshot.ledgerEntries[0].id }
      : null;
  }
  return null;
}

function activateTableRow(
  event: ReactKeyboardEvent<HTMLTableRowElement>,
  action: () => void,
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function currentRowCount(
  view: WalletView,
  events: WorkspaceWalletEvent[],
  settlements: WorkspaceWalletSettlement[],
  ledgerEntries: WorkspaceWalletLedgerEntry[],
) {
  if (view === "transactions") return events.length;
  if (view === "settlements") return settlements.length;
  if (view === "ledger") return ledgerEntries.length;
  return events.length;
}

function detailHeading(
  detail:
    | { kind: "event"; row: WorkspaceWalletEvent }
    | { kind: "settlement"; row: WorkspaceWalletSettlement }
    | { kind: "ledger"; row: WorkspaceWalletLedgerEntry },
  locale: Locale,
) {
  if (detail.kind === "event") return walletEventTypeLabel(detail.row.eventType, locale);
  if (detail.kind === "settlement") {
    return locale === "zh" ? "提现与结算记录" : "Withdrawal and settlement";
  }
  return locale === "zh" ? "账本分录" : "Ledger entry";
}

function walletViewLabel(view: WalletView, locale: Locale) {
  const labels: Record<WalletView, [string, string]> = {
    overview: ["钱包概览", "Overview"],
    transactions: ["资金事件", "Transactions"],
    settlements: ["提现与结算", "Settlements"],
    ledger: ["账本明细", "Ledger"],
  };
  return labels[view][locale === "zh" ? 0 : 1];
}

function walletViewHeading(view: WalletView, locale: Locale) {
  const labels: Record<Exclude<WalletView, "overview">, [string, string]> = {
    transactions: ["可解释的资金事件", "Explainable money events"],
    settlements: ["提现审核与打款状态", "Withdrawal review and payout state"],
    ledger: ["不可变资金分录", "Immutable money movements"],
  };
  if (view === "overview") return walletViewLabel(view, locale);
  return labels[view][locale === "zh" ? 0 : 1];
}

function walletViewEyebrow(view: WalletView) {
  if (view === "transactions") return "MONEY EVENTS";
  if (view === "settlements") return "SETTLEMENT QUEUE";
  if (view === "ledger") return "DOUBLE-ENTRY TRACE";
  return "WALLET OVERVIEW";
}

function walletEventTypeLabel(type: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    user_recharge: ["用户充值", "User recharge"],
    agent_token_purchase: ["购买服务额度", "Service credits purchased"],
    usage_reservation: ["预留服务额度", "Service credits reserved"],
    usage_settlement: ["结算服务使用", "Usage settled"],
    usage_release: ["释放预留额度", "Reservation released"],
    creator_earning_release: ["释放创作者收益", "Creator earnings released"],
    withdrawal_request: ["申请提现", "Withdrawal requested"],
    withdrawal_payout: ["提现打款", "Withdrawal paid"],
    refund: ["退款", "Refund"],
    reversal: ["冲正", "Reversal"],
    adjustment: ["账务调整", "Adjustment"],
  };
  const key = type.toLowerCase();
  return labels[key]?.[locale === "zh" ? 0 : 1] ?? humanizeCode(type);
}

function walletStatusLabel(status: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    pending: ["待处理", "Pending"],
    pending_review: ["待审核", "Pending review"],
    processing: ["处理中", "Processing"],
    approved: ["已批准", "Approved"],
    succeeded: ["已完成", "Succeeded"],
    completed: ["已完成", "Completed"],
    paid: ["已打款", "Paid"],
    failed: ["失败", "Failed"],
    rejected: ["已拒绝", "Rejected"],
    reversed: ["已冲正", "Reversed"],
    refunded: ["已退款", "Refunded"],
    canceled: ["已取消", "Canceled"],
    cancelled: ["已取消", "Cancelled"],
  };
  const key = status.toLowerCase();
  return labels[key]?.[locale === "zh" ? 0 : 1] ?? humanizeCode(status);
}

function mockWithdrawalActionsForStatus(
  status: string,
): MockWithdrawalAction[] {
  if (status === "pending_review") return ["approve", "reject"];
  if (status === "approved") return ["mark_paid", "mark_failed"];
  if (status === "failed") return ["approve", "mark_paid"];
  return [];
}

function mockWithdrawalActionLabel(
  action: MockWithdrawalAction,
  locale: Locale,
) {
  const labels: Record<MockWithdrawalAction, [string, string]> = {
    approve: ["模拟批准", "Mock approve"],
    reject: ["模拟拒绝", "Mock reject"],
    mark_paid: ["模拟打款成功", "Mock paid"],
    mark_failed: ["模拟打款失败", "Mock failed"],
  };
  return labels[action][locale === "zh" ? 0 : 1];
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (["succeeded", "completed", "paid", "approved"].includes(normalized)) return "success";
  if (["failed", "rejected"].includes(normalized)) return "error";
  if (["pending", "pending_review", "processing"].includes(normalized)) return "warning";
  if (["reversed", "refunded", "canceled", "cancelled"].includes(normalized)) return "neutral";
  return "neutral";
}

function parseMoneyInputToCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function formatMoney(cents: number, currency: string, locale: Locale) {
  try {
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function formatSignedMoney(cents: number, currency: string, locale: Locale) {
  if (!cents) return formatMoney(0, currency, locale);
  const absolute = formatMoney(Math.abs(cents), currency, locale);
  return `${cents > 0 ? "+" : "−"}${absolute}`;
}

function formatSignedNumber(value: number) {
  if (!value) return "0";
  return `${value > 0 ? "+" : "−"}${new Intl.NumberFormat("en-US").format(Math.abs(value))}`;
}

function formatTimestamp(value: string, locale: Locale, includeYear = false) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    ...(includeYear ? { year: "numeric" } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function humanizeCode(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

async function extractError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}
