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

import { DashboardPayoutProfile } from "./dashboard-payout-profile";

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

type WorkspaceWalletReconciliationIssue = {
  id: string;
  code: string;
  severity: "warning" | "error";
  domain: string;
  representativeSlug: string | null;
  representativeName: string | null;
  unit: "minor_currency" | "tokens" | "count";
  expectedValue: number | null;
  actualValue: number | null;
  differenceValue: number | null;
  currency: string | null;
  references: Array<{
    kind: string;
    id: string;
  }>;
};

type WorkspaceWalletReconciliationReport = {
  status: "healthy" | "warning" | "blocked";
  checkedAt: string;
  readOnly: true;
  scope: {
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

type WalletExceptionCase = {
  id: string;
  kind: string;
  reasonCode: string;
  severity: "warning" | "error" | "critical";
  status: "open" | "claimed" | "acknowledged" | "resolved";
  version: number;
  representativeSlug: string;
  representativeName: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
  claimedByCurrentOwner: boolean;
};

type WalletExceptionAction = "claim" | "retry" | "acknowledge";

type WalletExceptionFeedback = {
  tone: "success" | "warning" | "error";
  message: string;
};

type SelectedWalletRow =
  | { kind: "event"; id: string }
  | { kind: "settlement"; id: string }
  | { kind: "ledger"; id: string };

type WalletRefundFeedback = {
  tone: "pending" | "queued" | "error";
  message: string;
};

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
  const [refundingTokenPurchaseId, setRefundingTokenPurchaseId] =
    useState<string | null>(null);
  const [refundFeedback, setRefundFeedback] =
    useState<Record<string, WalletRefundFeedback>>({});
  const [reconciliationReport, setReconciliationReport] =
    useState<WorkspaceWalletReconciliationReport | null>(null);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const requestSequenceRef = useRef(0);
  const reconciliationRequestSequenceRef = useRef(0);
  const mockActionIdempotencyKeysRef = useRef(new Map<string, string>());
  const refundIdempotencyKeysRef = useRef(new Map<string, string>());
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
  const reconciliationScopeKey = [
    activeSlug,
    representative,
    resolvedCurrency,
  ].join("\u0000");
  const activeReconciliationScopeKeyRef = useRef(reconciliationScopeKey);
  activeReconciliationScopeKeyRef.current = reconciliationScopeKey;

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

  const loadReconciliation = useCallback(async (signal?: AbortSignal) => {
    if (!resolvedCurrency) return;
    const requestId = ++reconciliationRequestSequenceRef.current;
    const requestedScopeKey = [
      activeSlug,
      representative,
      resolvedCurrency,
    ].join("\u0000");
    setReconciliationError(null);
    setReconciliationLoading(true);

    try {
      const parameters = new URLSearchParams({
        rep: activeSlug,
        representative,
        currency: resolvedCurrency,
      });
      const response = await fetch(
        `/api/dashboard/wallet/reconciliation?${parameters.toString()}`,
        {
          cache: "no-store",
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) throw new Error(await extractError(response));
      const report = (await response.json()) as WorkspaceWalletReconciliationReport;
      if (
        signal?.aborted
        || activeReconciliationScopeKeyRef.current !== requestedScopeKey
        || reconciliationRequestSequenceRef.current !== requestId
      ) return;
      setReconciliationReport(report);
    } catch (nextError) {
      if (
        signal?.aborted
        || activeReconciliationScopeKeyRef.current !== requestedScopeKey
        || reconciliationRequestSequenceRef.current !== requestId
      ) return;
      throw nextError;
    } finally {
      if (
        activeReconciliationScopeKeyRef.current === requestedScopeKey
        && reconciliationRequestSequenceRef.current === requestId
      ) {
        setReconciliationLoading(false);
      }
    }
  }, [activeSlug, representative, resolvedCurrency]);

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
    if (!resolvedCurrency) {
      reconciliationRequestSequenceRef.current += 1;
      setReconciliationReport(null);
      setReconciliationError(null);
      setReconciliationLoading(false);
      return;
    }

    const controller = new AbortController();
    setReconciliationReport(null);
    setReconciliationError(null);
    void loadReconciliation(controller.signal).catch((nextError: unknown) => {
      if (
        controller.signal.aborted
        || activeReconciliationScopeKeyRef.current !== reconciliationScopeKey
      ) return;
      setReconciliationError(nextError instanceof Error
        ? nextError.message
        : zh
          ? "资金核对暂时无法完成。"
          : "The funds reconciliation could not be completed.");
    });
    return () => controller.abort();
  }, [loadReconciliation, reconciliationScopeKey, resolvedCurrency, zh]);

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
    refreshReconciliationAfterMutation();
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
      refreshReconciliationAfterMutation();
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
      refreshReconciliationAfterMutation();
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

  async function requestFullWeChatRefund(event: WorkspaceWalletEvent) {
    const tokenPurchaseId =
      event.sourceType === "AgentTokenPurchase"
        ? event.sourceId?.trim()
        : null;
    if (!tokenPurchaseId) return;

    const confirmed = window.confirm(
      zh
        ? "确认发起这笔微信支付的全额退款？仅当购买额度完全未使用、未预留时才能进入退款队列。退款由后台异步处理，不会在本页面直接改余额。"
        : "Queue a full WeChat Pay refund? Only completely unused and unreserved credits are eligible. Processing is asynchronous and this page never changes balances directly.",
    );
    if (!confirmed) return;
    const reasonInput = window.prompt(
      zh
        ? "可选：填写退款原因（最多 80 个 UTF-8 字节）；取消则不提交。"
        : "Optional refund reason (up to 80 UTF-8 bytes). Choose Cancel to stop.",
      "",
    );
    if (reasonInput === null) return;
    const reason = reasonInput.trim();
    if (new TextEncoder().encode(reason).byteLength > 80) {
      setRefundFeedback((current) => ({
        ...current,
        [tokenPurchaseId]: {
          tone: "error",
          message: zh
            ? "退款原因超过 80 个 UTF-8 字节，请缩短后重试。"
            : "The refund reason exceeds 80 UTF-8 bytes. Shorten it and retry.",
        },
      }));
      return;
    }

    const idempotencyKey =
      refundIdempotencyKeysRef.current.get(tokenPurchaseId)
      ?? `refund:${crypto.randomUUID()}`;
    refundIdempotencyKeysRef.current.set(
      tokenPurchaseId,
      idempotencyKey,
    );
    setRefundingTokenPurchaseId(tokenPurchaseId);
    setMutationNotice(null);
    setRefundFeedback((current) => ({
      ...current,
      [tokenPurchaseId]: {
        tone: "pending",
        message: zh
          ? "正在校验可退条件并写入退款队列…"
          : "Checking eligibility and writing the refund intent…",
      },
    }));

    try {
      const response = await fetch(
        `/api/dashboard/wallet/refunds?rep=${encodeURIComponent(activeSlug)}`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenPurchaseId,
            idempotencyKey,
            ...(reason ? { reason } : {}),
          }),
        },
      );
      if (!response.ok) {
        const failure = await readWalletRefundFailure(response, locale);
        if (failure.code === "refund_already_queued") {
          refundIdempotencyKeysRef.current.delete(tokenPurchaseId);
          setRefundFeedback((current) => ({
            ...current,
            [tokenPurchaseId]: {
              tone: "queued",
              message: failure.message,
            },
          }));
          setMutationNotice(failure.message);
          await refreshAfterRefundQueued();
          return;
        }
        if (failure.code === "refund_idempotency_conflict") {
          refundIdempotencyKeysRef.current.delete(tokenPurchaseId);
        }
        setRefundFeedback((current) => ({
          ...current,
          [tokenPurchaseId]: {
            tone: "error",
            message: failure.message,
          },
        }));
        return;
      }

      refundIdempotencyKeysRef.current.delete(tokenPurchaseId);
      const queuedMessage = zh
        ? "全额退款已排队。后台将向微信提交并持续查询最终结果，余额会在验真成功后自动冲正。"
        : "Full refund queued. The worker will submit it to WeChat Pay and reconcile the final result before balances are reversed.";
      setRefundFeedback((current) => ({
        ...current,
        [tokenPurchaseId]: {
          tone: "queued",
          message: queuedMessage,
        },
      }));
      setMutationNotice(queuedMessage);
      await refreshAfterRefundQueued();
    } catch {
      setRefundFeedback((current) => ({
        ...current,
        [tokenPurchaseId]: {
          tone: "error",
          message: zh
            ? "退款请求未确认写入，请使用同一页面重试；系统会复用幂等键，避免重复退款。"
            : "The refund request was not confirmed. Retry here; the same idempotency key is reused to prevent duplicate refunds.",
        },
      }));
    } finally {
      setRefundingTokenPurchaseId((current) =>
        current === tokenPurchaseId ? null : current);
    }

    async function refreshAfterRefundQueued() {
      const [walletResult, reconciliationResult] =
        await Promise.allSettled([
          loadWallet("replace"),
          loadReconciliation(),
        ]);
      if (walletResult.status === "rejected") {
        setError(
          zh
            ? "退款已排队，但钱包明细刷新失败，请手动刷新。"
            : "The refund is queued, but wallet details did not refresh. Refresh manually.",
        );
      }
      if (reconciliationResult.status === "rejected") {
        setReconciliationError(
          zh
            ? "退款已排队，但资金核对刷新失败，请稍后重试。"
            : "The refund is queued, but funds reconciliation did not refresh. Retry shortly.",
        );
      }
    }
  }

  function refreshReconciliationAfterMutation() {
    void loadReconciliation().catch((nextError: unknown) => {
      setReconciliationError(nextError instanceof Error
        ? nextError.message
        : zh
          ? "资金变更已完成，但资金核对刷新失败。"
          : "The money change completed, but funds reconciliation did not refresh.");
    });
  }

  function refreshWalletAndReconciliation() {
    void loadWallet("replace").catch((nextError: unknown) => {
      setError(nextError instanceof Error ? nextError.message : "Refresh failed.");
    });
    void loadReconciliation().catch((nextError: unknown) => {
      setReconciliationError(nextError instanceof Error
        ? nextError.message
        : zh
          ? "资金核对刷新失败。"
          : "Failed to refresh funds reconciliation.");
    });
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
            disabled={
              showInitialLoading
              || loading
              || loadingMore
              || reconciliationLoading
            }
            onClick={refreshWalletAndReconciliation}
            type="button"
          >
            {(loading && !initialLoading) || reconciliationLoading
              ? zh ? "刷新中…" : "Refreshing…"
              : zh ? "刷新" : "Refresh"}
          </button>
          {snapshot?.primaryAction.kind === "verify" ? (
            <span className="wallet-primary-guidance" role="status">
              {zh ? "完成创作者验证后可提现" : "Complete creator verification to withdraw"}
            </span>
          ) : snapshot?.primaryAction.kind === "payout_profile" ? (
            <button
              className="dashboard-v2-button-primary"
              onClick={() => {
                setActiveView("settlements");
                window.setTimeout(() => {
                  document
                    .getElementById("wallet-payout-profile")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 0);
              }}
              type="button"
            >
              {zh ? "设置收款账户" : "Set up payout account"}
            </button>
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
                    activeSlug={activeSlug}
                    currency={resolvedCurrency || "CNY"}
                    events={events}
                    locale={locale}
                    metrics={snapshot?.metrics}
                    onWalletChanged={refreshWalletAndReconciliation}
                    onSelect={chooseRow}
                    onRetryReconciliation={() => {
                      void loadReconciliation().catch((nextError: unknown) => {
                        setReconciliationError(nextError instanceof Error
                          ? nextError.message
                          : zh
                            ? "资金核对刷新失败。"
                            : "Failed to refresh funds reconciliation.");
                      });
                    }}
                    reconciliationError={reconciliationError}
                    reconciliationLoading={reconciliationLoading}
                    reconciliationReport={reconciliationReport}
                    settlements={settlements}
                    onRefreshReconciliation={async () => {
                      try {
                        await loadReconciliation();
                      } catch (nextError) {
                        const message = nextError instanceof Error
                          ? nextError.message
                          : zh
                            ? "资金核对刷新失败。"
                            : "Failed to refresh funds reconciliation.";
                        setReconciliationError(message);
                        throw nextError;
                      }
                    }}
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
                    onRequestWeChatRefund={(event) =>
                      void requestFullWeChatRefund(event)}
                    refundFeedback={
                      selectedDetail.kind === "event"
                      && selectedDetail.row.sourceId
                        ? refundFeedback[selectedDetail.row.sourceId] ?? null
                        : null
                    }
                    refundSubmitting={
                      selectedDetail.kind === "event"
                      && selectedDetail.row.sourceId
                        === refundingTokenPurchaseId
                    }
                  />
                ) : null}
              </div>
            ) : (
              <div className="wallet-table-detail-layout">
                <div className={activeView === "settlements"
                  ? "wallet-settlements-stack"
                  : "wallet-table-stack"}
                >
                  {activeView === "settlements" ? (
                    <DashboardPayoutProfile
                      locale={locale}
                      onChanged={refreshWalletAndReconciliation}
                    />
                  ) : null}
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
                </div>
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
                  onRequestWeChatRefund={(event) =>
                    void requestFullWeChatRefund(event)}
                  refundFeedback={
                    selectedDetail?.kind === "event"
                    && selectedDetail.row.sourceId
                      ? refundFeedback[selectedDetail.row.sourceId] ?? null
                      : null
                  }
                  refundSubmitting={
                    selectedDetail?.kind === "event"
                    && selectedDetail.row.sourceId
                      === refundingTokenPurchaseId
                  }
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
  activeSlug,
  currency,
  events,
  locale,
  metrics,
  onWalletChanged,
  onRefreshReconciliation,
  onSelect,
  onRetryReconciliation,
  reconciliationError,
  reconciliationLoading,
  reconciliationReport,
  settlements,
}: {
  activeSlug: string;
  currency: string;
  events: WorkspaceWalletEvent[];
  locale: Locale;
  metrics: WorkspaceWalletSnapshot["metrics"] | undefined;
  onWalletChanged: () => void;
  onRefreshReconciliation: () => Promise<void>;
  onSelect: (row: SelectedWalletRow, target: HTMLElement) => void;
  onRetryReconciliation: () => void;
  reconciliationError: string | null;
  reconciliationLoading: boolean;
  reconciliationReport: WorkspaceWalletReconciliationReport | null;
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

      <DashboardPayoutProfile
        locale={locale}
        onChanged={onWalletChanged}
      />

      <WalletReconciliationPanel
        error={reconciliationError}
        loading={reconciliationLoading}
        locale={locale}
        onRetry={onRetryReconciliation}
        report={reconciliationReport}
      />

      <WalletExceptionQueue
        activeSlug={activeSlug}
        locale={locale}
        onRefreshReconciliation={onRefreshReconciliation}
      />

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

function WalletExceptionQueue({
  activeSlug,
  locale,
  onRefreshReconciliation,
}: {
  activeSlug: string;
  locale: Locale;
  onRefreshReconciliation: () => Promise<void>;
}) {
  const zh = locale === "zh";
  const [cases, setCases] = useState<WalletExceptionCase[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] =
    useState<Record<string, WalletExceptionFeedback>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const actionIdempotencyKeysRef = useRef(new Map<string, string>());

  const loadCases = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestSequenceRef.current;
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(
        `/api/dashboard/wallet/exceptions?rep=${encodeURIComponent(activeSlug)}`,
        {
          cache: "no-store",
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) throw new Error(`wallet_exception_load_${response.status}`);
      const payload = (await response.json()) as { cases?: WalletExceptionCase[] };
      if (signal?.aborted || requestSequenceRef.current !== requestId) return;
      setCases(Array.isArray(payload.cases) ? payload.cases : []);
    } catch (nextError) {
      if (signal?.aborted || requestSequenceRef.current !== requestId) return;
      setError(
        zh
          ? "异常队列暂时无法加载。资金状态未被修改，请重试。"
          : "The exception queue could not load. No funds were changed; retry.",
      );
    } finally {
      if (requestSequenceRef.current === requestId) setLoading(false);
    }
  }, [activeSlug, zh]);

  useEffect(() => {
    const controller = new AbortController();
    setCases([]);
    setFeedback({});
    setSubmitting(null);
    actionIdempotencyKeysRef.current.clear();
    void loadCases(controller.signal);
    return () => controller.abort();
  }, [loadCases]);

  async function applyAction(
    exceptionCase: WalletExceptionCase,
    action: WalletExceptionAction,
  ) {
    let note: string | undefined;
    if (action === "acknowledge") {
      const input = window.prompt(
        zh
          ? "请输入不包含账号、订单号、退款号或个人信息的处理说明（必填）。确认只记录说明，不会修改资金。"
          : "Enter a required handling note without account, order, refund, or personal information. Acknowledging records context only and never changes funds.",
        "",
      );
      if (input === null) return;
      note = input.trim();
      if (!note) {
        setFeedback((current) => ({
          ...current,
          [exceptionCase.id]: {
            tone: "error",
            message: zh
              ? "确认异常前必须填写非敏感处理说明。"
              : "A non-sensitive handling note is required before acknowledging.",
          },
        }));
        return;
      }
    }

    const actionKey =
      `${exceptionCase.id}:${action}:${exceptionCase.version}`;
    const idempotencyKey =
      actionIdempotencyKeysRef.current.get(actionKey)
      ?? `wallet-exception:${action}:${crypto.randomUUID()}`;
    actionIdempotencyKeysRef.current.set(actionKey, idempotencyKey);
    setSubmitting(actionKey);
    setFeedback((current) => ({
      ...current,
      [exceptionCase.id]: {
        tone: "warning",
        message: walletExceptionActionPendingLabel(action, locale),
      },
    }));

    try {
      const response = await fetch(
        `/api/dashboard/wallet/exceptions/${encodeURIComponent(exceptionCase.id)}/actions?rep=${encodeURIComponent(activeSlug)}`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            expectedVersion: exceptionCase.version,
            idempotencyKey,
            ...(note ? { note } : {}),
          }),
        },
      );

      if (response.status === 409) {
        actionIdempotencyKeysRef.current.delete(actionKey);
        setFeedback((current) => ({
          ...current,
          [exceptionCase.id]: {
            tone: "warning",
            message: zh
              ? "异常状态已由其他操作更新，正在刷新最新版本。"
              : "Another action updated this exception. Refreshing the latest version.",
          },
        }));
        await loadCases();
        return;
      }
      if (!response.ok) {
        throw new Error(`wallet_exception_action_${response.status}`);
      }

      actionIdempotencyKeysRef.current.delete(actionKey);
      setFeedback((current) => ({
        ...current,
        [exceptionCase.id]: {
          tone: "success",
          message: walletExceptionActionSuccessLabel(action, locale),
        },
      }));
      const [casesResult, reconciliationResult] = await Promise.allSettled([
        loadCases(),
        onRefreshReconciliation(),
      ]);
      if (casesResult.status === "rejected") {
        setError(
          zh
            ? "动作已记录，但异常队列刷新失败，请重试加载。"
            : "The action was recorded, but the queue did not refresh. Retry loading it.",
        );
      }
      if (reconciliationResult.status === "rejected") {
        setFeedback((current) => ({
          ...current,
          [exceptionCase.id]: {
            tone: "warning",
            message: zh
              ? "动作已记录，但资金核对刷新失败；请稍后重新核对。"
              : "The action was recorded, but reconciliation did not refresh. Check again shortly.",
          },
        }));
      }
    } catch {
      setFeedback((current) => ({
        ...current,
        [exceptionCase.id]: {
          tone: "error",
          message: zh
            ? "动作结果尚未确认。请在当前页面重试，系统会复用同一幂等键。"
            : "The action result is unconfirmed. Retry here; the same idempotency key will be reused.",
        },
      }));
    } finally {
      setSubmitting((current) => current === actionKey ? null : current);
    }
  }

  return (
    <section
      aria-busy={loading}
      aria-labelledby="wallet-exception-queue-heading"
      className="dashboard-v2-panel wallet-exception-queue"
    >
      <header className="wallet-exception-header">
        <div>
          <p>OPERATIONS EXCEPTIONS</p>
          <h2 id="wallet-exception-queue-heading">
            {zh ? "待处理资金异常" : "Funds exceptions"}
          </h2>
        </div>
        <span className="wallet-exception-count">
          {cases.length}
          {" "}
          {zh ? "项" : cases.length === 1 ? "case" : "cases"}
        </span>
      </header>
      <p className="dashboard-v2-panel-description wallet-exception-description">
        {zh
          ? "这里只展示已确认归属当前 Owner 的异常。认领和确认用于记录处置过程，不会直接修改余额；重试只恢复该异常对应的精确后台任务。"
          : "Only exceptions proven to belong to the current Owner appear here. Claiming and acknowledging record handling without changing balances; retry restores only the exact background job for this case."}
      </p>

      {error ? (
        <div className="wallet-exception-state is-error" role="alert">
          <div>
            <strong>{zh ? "异常队列加载失败" : "Exception queue unavailable"}</strong>
            <span>{error}</span>
          </div>
          <button
            className="dashboard-v2-button-secondary"
            disabled={loading}
            onClick={() => void loadCases()}
            type="button"
          >
            {loading ? zh ? "重试中…" : "Retrying…" : zh ? "重试" : "Retry"}
          </button>
        </div>
      ) : loading && !cases.length ? (
        <div
          aria-live="polite"
          className="wallet-exception-state"
          role="status"
        >
          <strong>{zh ? "正在加载异常队列…" : "Loading the exception queue…"}</strong>
          <span>
            {zh
              ? "正在读取当前 Owner 可处理的资金异常。"
              : "Reading funds exceptions available to the current Owner."}
          </span>
        </div>
      ) : !cases.length ? (
        <div className="wallet-exception-state is-empty" role="status">
          <strong>{zh ? "当前没有待处理资金异常" : "No funds exceptions need attention"}</strong>
          <span>
            {zh
              ? "支付、退款和资金冲正任务目前没有需要 Owner 介入的事项。"
              : "Payment, refund, and reversal jobs currently need no Owner intervention."}
          </span>
        </div>
      ) : (
        <ol className="wallet-exception-list">
          {cases.map((exceptionCase) => {
            const rowBusy = submitting?.startsWith(`${exceptionCase.id}:`) ?? false;
            const itemFeedback = feedback[exceptionCase.id];
            const canOperate =
              exceptionCase.status === "claimed"
              && exceptionCase.claimedByCurrentOwner;
            return (
              <li
                aria-busy={rowBusy}
                className={`is-${exceptionCase.severity}`}
                key={exceptionCase.id}
              >
                <header>
                  <div className="wallet-exception-labels">
                    <span className={`wallet-exception-severity is-${exceptionCase.severity}`}>
                      {walletExceptionSeverityLabel(exceptionCase.severity, locale)}
                    </span>
                    <span className={`wallet-status is-${walletExceptionStatusTone(exceptionCase.status)}`}>
                      {walletExceptionStatusLabel(
                        exceptionCase.status,
                        exceptionCase.claimedByCurrentOwner,
                        locale,
                      )}
                    </span>
                  </div>
                  <div>
                    <strong>
                      {walletExceptionReasonLabel(exceptionCase.reasonCode, locale)}
                    </strong>
                    <small>{walletExceptionKindLabel(exceptionCase.kind, locale)}</small>
                  </div>
                </header>
                <dl className="wallet-exception-facts">
                  <div>
                    <dt>{zh ? "数字代表" : "Representative"}</dt>
                    <dd>
                      {exceptionCase.representativeName
                        || (zh ? "当前数字代表" : "Current representative")}
                    </dd>
                  </div>
                  <div>
                    <dt>{zh ? "币种" : "Currency"}</dt>
                    <dd>{exceptionCase.currency}</dd>
                  </div>
                  <div>
                    <dt>{zh ? "最近更新" : "Last updated"}</dt>
                    <dd>{formatTimestamp(exceptionCase.updatedAt, locale, true)}</dd>
                  </div>
                </dl>
                {itemFeedback ? (
                  <div
                    aria-live="polite"
                    className={`wallet-exception-feedback is-${itemFeedback.tone}`}
                    role={itemFeedback.tone === "error" ? "alert" : "status"}
                  >
                    {itemFeedback.message}
                  </div>
                ) : null}
                {exceptionCase.status === "open" ? (
                  <div className="wallet-exception-actions">
                    <button
                      aria-label={`${zh ? "认领资金异常" : "Claim funds exception"}：${walletExceptionReasonLabel(exceptionCase.reasonCode, locale)}`}
                      className="dashboard-v2-button-primary"
                      disabled={rowBusy}
                      onClick={() => void applyAction(exceptionCase, "claim")}
                      type="button"
                    >
                      {rowBusy ? zh ? "认领中…" : "Claiming…" : zh ? "认领处理" : "Claim case"}
                    </button>
                  </div>
                ) : canOperate ? (
                  <div className="wallet-exception-actions">
                    {exceptionCase.retryable ? (
                      <button
                        aria-label={`${zh ? "重试精确后台任务" : "Retry exact background job"}：${walletExceptionReasonLabel(exceptionCase.reasonCode, locale)}`}
                        className="dashboard-v2-button-primary"
                        disabled={rowBusy}
                        onClick={() => void applyAction(exceptionCase, "retry")}
                        type="button"
                      >
                        {submitting === `${exceptionCase.id}:retry:${exceptionCase.version}`
                          ? zh ? "重试中…" : "Retrying…"
                          : zh ? "重试精确任务" : "Retry exact job"}
                      </button>
                    ) : null}
                    <button
                      aria-label={`${zh ? "确认并记录处理说明" : "Acknowledge with a handling note"}：${walletExceptionReasonLabel(exceptionCase.reasonCode, locale)}`}
                      className="dashboard-v2-button-secondary"
                      disabled={rowBusy}
                      onClick={() => void applyAction(exceptionCase, "acknowledge")}
                      type="button"
                    >
                      {submitting === `${exceptionCase.id}:acknowledge:${exceptionCase.version}`
                        ? zh ? "确认中…" : "Acknowledging…"
                        : zh ? "确认并记录说明" : "Acknowledge with note"}
                    </button>
                    <span>
                      {zh
                        ? "确认只记录说明，不会修改资金。"
                        : "Acknowledging records context only; it does not change funds."}
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function WalletReconciliationPanel({
  error,
  loading,
  locale,
  onRetry,
  report,
}: {
  error: string | null;
  loading: boolean;
  locale: Locale;
  onRetry: () => void;
  report: WorkspaceWalletReconciliationReport | null;
}) {
  const zh = locale === "zh";
  const [expanded, setExpanded] = useState(false);
  const previewLimit = 3;
  const visibleIssues = report
    ? expanded
      ? report.issues
      : report.issues.slice(0, previewLimit)
    : [];
  const canToggleIssues = Boolean(report && report.issues.length > previewLimit);
  const tone = report
    ? report.status === "healthy"
      ? "success"
      : report.status === "warning"
        ? "warning"
        : "error"
    : "neutral";

  useEffect(() => {
    setExpanded(false);
  }, [report?.checkedAt, report?.scope.currency, report?.scope.representative]);

  return (
    <section
      aria-busy={loading}
      aria-labelledby="wallet-reconciliation-heading"
      className={`dashboard-v2-panel wallet-reconciliation is-${tone}`}
    >
      <header className="wallet-reconciliation-header">
        <div>
          <p>MONEY RECONCILIATION</p>
          <h2 id="wallet-reconciliation-heading">
            {zh ? "资金健康" : "Funds health"}
          </h2>
        </div>
        <div className="wallet-reconciliation-state">
          <span className={`wallet-status is-${tone}`} role="status">
            {report
              ? reconciliationStatusLabel(report.status, locale)
              : loading
                ? zh ? "核对中" : "Checking"
                : zh ? "尚未核对" : "Not checked"}
          </span>
          {report ? (
            <time dateTime={report.checkedAt}>
              {zh ? "核对于" : "Checked"}
              {" · "}
              {formatTimestamp(report.checkedAt, locale, true)}
            </time>
          ) : null}
        </div>
      </header>

      <p className="dashboard-v2-panel-description wallet-reconciliation-description">
        {zh
          ? "只读核对当前代表范围与币种下的余额、额度、收益、提现和账本关系；不会修改任何财务数据，也不受日期、事件类型或搜索条件影响。"
          : "A read-only check of balances, credits, earnings, withdrawals, and ledger relationships for the current representative scope and currency. It changes no financial data and is unaffected by date, event-type, or search filters."}
      </p>

      {error ? (
        <div className="skills-banner is-error" role="alert">
          <span>
            <strong>
              {zh ? "资金核对暂时无法完成" : "Funds reconciliation could not be completed"}
            </strong>
            {" · "}
            {error}
          </span>
          <button
            className="dashboard-v2-button-secondary"
            disabled={loading}
            onClick={onRetry}
            type="button"
          >
            {loading ? zh ? "核对中…" : "Checking…" : zh ? "重试" : "Retry"}
          </button>
        </div>
      ) : null}

      {loading ? (
        <p aria-live="polite" className="wallet-reconciliation-refreshing" role="status">
          {report
            ? zh ? "正在刷新只读核对结果…" : "Refreshing the read-only reconciliation…"
            : zh ? "正在核对资金与账本关系…" : "Checking funds and ledger relationships…"}
        </p>
      ) : null}

      {report ? (
        <>
          <div className="wallet-reconciliation-scope">
            <span>{report.readOnly ? zh ? "只读检查" : "Read-only check" : null}</span>
            <code>
              {report.scope.representative === "all"
                ? zh ? "全部代表" : "All representatives"
                : report.scope.representative}
              {" · "}
              {report.scope.currency}
            </code>
          </div>

          <dl className="wallet-reconciliation-summary">
            <div>
              <dt>{zh ? "通过检查" : "Checks passed"}</dt>
              <dd>{report.summary.passed} / {report.summary.checks}</dd>
            </div>
            <div>
              <dt>{zh ? "发现项" : "Findings"}</dt>
              <dd>{report.summary.findings}</dd>
              <small>
                {zh
                  ? `${report.summary.warnings} 项复核 · ${report.summary.errors} 项差异`
                  : `${report.summary.warnings} review · ${report.summary.errors} difference`}
              </small>
            </div>
            <div>
              <dt>{zh ? "资金绝对差异" : "Absolute money difference"}</dt>
              <dd>
                {formatMoney(
                  report.summary.absoluteAmountDifferenceCents,
                  report.scope.currency,
                  locale,
                )}
              </dd>
            </div>
            <div>
              <dt>{zh ? "额度绝对差异" : "Absolute credit difference"}</dt>
              <dd>
                {new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US")
                  .format(report.summary.absoluteTokenDifference)}
              </dd>
            </div>
          </dl>

          {report.status === "healthy" && report.issueCount === 0 ? (
            <div className="wallet-reconciliation-empty">
              <strong>{zh ? "当前资金关系正常" : "Current funds reconcile"}</strong>
              <span>
                {zh
                  ? `已完成 ${report.summary.checks} 项只读检查，未发现资金或额度差异。`
                  : `${report.summary.checks} read-only checks completed with no money or credit differences.`}
              </span>
            </div>
          ) : report.issues.length ? (
            <>
              <ol className="wallet-reconciliation-issues" id="wallet-reconciliation-issues">
                {visibleIssues.map((issue) => (
                  <li className={`is-${issue.severity}`} key={issue.id}>
                    <header>
                      <span className={`wallet-status is-${issue.severity === "error" ? "error" : "warning"}`}>
                        {issue.severity === "error"
                          ? zh ? "资金差异" : "Difference"
                          : zh ? "需要复核" : "Review needed"}
                      </span>
                      <div>
                        <strong>{reconciliationIssueLabel(issue.code, locale)}</strong>
                        <small>
                          {reconciliationDomainLabel(issue.domain, locale)}
                          {" · "}
                          {issue.representativeName
                            ?? issue.representativeSlug
                            ?? (zh ? "工作区" : "Workspace")}
                        </small>
                      </div>
                    </header>
                    <dl>
                      <div>
                        <dt>{zh ? "预期" : "Expected"}</dt>
                        <dd>
                          {formatReconciliationValue(
                            issue.expectedValue,
                            issue.unit,
                            issue.currency ?? report.scope.currency,
                            locale,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{zh ? "实际" : "Actual"}</dt>
                        <dd>
                          {formatReconciliationValue(
                            issue.actualValue,
                            issue.unit,
                            issue.currency ?? report.scope.currency,
                            locale,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{zh ? "差异" : "Difference"}</dt>
                        <dd>
                          {formatReconciliationValue(
                            issue.differenceValue,
                            issue.unit,
                            issue.currency ?? report.scope.currency,
                            locale,
                            true,
                          )}
                        </dd>
                      </div>
                    </dl>
                    {issue.references.length ? (
                      <div className="wallet-reconciliation-references">
                        <span>{zh ? "关联记录" : "Linked records"}</span>
                        <div>
                          {issue.references.map((reference) => (
                            <code
                              key={`${reference.kind}:${reference.id}`}
                              title={`${reference.kind} · ${reference.id}`}
                            >
                              {humanizeCode(reference.kind)}
                              {" · "}
                              {shortId(reference.id)}
                            </code>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
              <footer className="wallet-reconciliation-footer">
                <span>
                  {report.issuesTruncated
                    ? zh
                      ? `当前展示报告返回的 ${report.issues.length} / ${report.issueCount} 项。`
                      : `Showing ${report.issues.length} of ${report.issueCount} findings returned by this report.`
                    : zh
                      ? `共 ${report.issueCount} 项发现。`
                      : `${report.issueCount} findings.`}
                </span>
                {canToggleIssues ? (
                  <button
                    aria-controls="wallet-reconciliation-issues"
                    aria-expanded={expanded}
                    className="dashboard-v2-button-secondary"
                    onClick={() => setExpanded((current) => !current)}
                    type="button"
                  >
                    {expanded
                      ? zh ? "收起问题" : "Show fewer"
                      : zh
                        ? `展开 ${report.issues.length} 项`
                        : `Show all ${report.issues.length}`}
                  </button>
                ) : null}
              </footer>
            </>
          ) : (
            <div className="wallet-reconciliation-empty is-warning">
              <strong>{zh ? "报告包含发现，但没有可展示明细" : "The report contains findings without displayable details"}</strong>
              <span>{zh ? "请重试核对；若持续出现，请保留核对时间交由运营复核。" : "Retry the check. If this persists, retain the checked time for operations review."}</span>
            </div>
          )}
        </>
      ) : !loading && !error ? (
        <div className="wallet-reconciliation-empty is-warning">
          <strong>{zh ? "等待资金核对" : "Waiting for funds reconciliation"}</strong>
          <span>{zh ? "选择可用币种后会自动执行只读核对。" : "A read-only check starts after an available currency is selected."}</span>
        </div>
      ) : null}
    </section>
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
  onRequestWeChatRefund,
  refundFeedback,
  refundSubmitting,
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
  onRequestWeChatRefund: (event: WorkspaceWalletEvent) => void;
  refundFeedback: WalletRefundFeedback | null;
  refundSubmitting: boolean;
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
          <EventDetail
            event={detail.row}
            feedback={refundFeedback}
            locale={locale}
            onRequestWeChatRefund={onRequestWeChatRefund}
            submitting={refundSubmitting}
          />
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

function EventDetail({
  event,
  feedback,
  locale,
  onRequestWeChatRefund,
  submitting,
}: {
  event: WorkspaceWalletEvent;
  feedback: WalletRefundFeedback | null;
  locale: Locale;
  onRequestWeChatRefund: (event: WorkspaceWalletEvent) => void;
  submitting: boolean;
}) {
  const zh = locale === "zh";
  const canRequestWeChatRefund =
    event.sourceType === "AgentTokenPurchase"
    && Boolean(event.sourceId);
  return (
    <>
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
      {canRequestWeChatRefund ? (
        <section className="wallet-refund-operation">
          <header>
            <strong>{zh ? "微信全额退款" : "Full WeChat Pay refund"}</strong>
            <span className="wallet-status is-warning">
              {zh ? "后台异步处理" : "Async processing"}
            </span>
          </header>
          <p>
            {zh
              ? "仅购买额度完全未使用、未预留时可退。提交后先冻结额度，再由后台向微信提交并验真；此操作不会直接修改余额。"
              : "Only completely unused and unreserved credits are eligible. Submission freezes the credits, then a worker submits and verifies the refund; this action never changes balances directly."}
          </p>
          {feedback ? (
            <div
              className={`wallet-refund-feedback is-${feedback.tone}`}
              role={feedback.tone === "error" ? "alert" : "status"}
            >
              <strong>
                {feedback.tone === "queued"
                  ? zh ? "已排队" : "Queued"
                  : feedback.tone === "pending"
                    ? zh ? "提交中" : "Submitting"
                    : zh ? "提交失败" : "Failed"}
              </strong>
              <span>{feedback.message}</span>
            </div>
          ) : null}
          <button
            className="dashboard-v2-button-secondary wallet-refund-button"
            disabled={submitting || feedback?.tone === "queued"}
            onClick={() => onRequestWeChatRefund(event)}
            type="button"
          >
            {submitting
              ? zh ? "正在提交…" : "Submitting…"
              : feedback?.tone === "queued"
                ? zh ? "退款已排队" : "Refund queued"
                : zh ? "发起全额退款" : "Request full refund"}
          </button>
        </section>
      ) : null}
    </>
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
    user_recharge: ["服务包收款（兼容事件）", "Service-package payment (legacy event)"],
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

function reconciliationStatusLabel(
  status: WorkspaceWalletReconciliationReport["status"],
  locale: Locale,
) {
  const labels: Record<
    WorkspaceWalletReconciliationReport["status"],
    [string, string]
  > = {
    healthy: ["资金正常", "Funds reconciled"],
    warning: ["存在需复核项", "Review needed"],
    blocked: ["发现资金差异", "Money differences found"],
  };
  return labels[status][locale === "zh" ? 0 : 1];
}

function reconciliationDomainLabel(domain: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    wallet: ["钱包余额", "Wallet balances"],
    purchase: ["额度购买", "Credit purchases"],
    usage: ["服务用量", "Service usage"],
    entitlement: ["服务权益", "Service entitlements"],
    earning: ["创作者收益", "Creator earnings"],
    ledger: ["资金账本", "Money ledger"],
    user_cash: ["用户现金", "User cash"],
    service_credit: ["服务额度", "Service credits"],
    agent_wallet: ["代表钱包", "Representative wallet"],
    creator_earning: ["创作者收益", "Creator earnings"],
    withdrawal: ["提现", "Withdrawal"],
    ledger_group: ["账本交易组", "Ledger group"],
  };
  return labels[domain.toLowerCase()]?.[locale === "zh" ? 0 : 1]
    ?? humanizeCode(domain);
}

function reconciliationIssueLabel(code: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    agent_wallet_token_balance_mismatch: ["代表可用额度汇总不一致", "Representative credit balance does not match scoped wallets"],
    agent_wallet_purchased_total_mismatch: ["代表累计购买额度不一致", "Representative purchased-credit total does not match"],
    agent_wallet_consumed_total_mismatch: ["代表累计消耗额度不一致", "Representative consumed-credit total does not match"],
    scoped_wallet_conservation_mismatch: ["用户额度余额不守恒", "User credit balance does not conserve"],
    scoped_wallet_currency_mismatch: ["用户额度钱包币种不一致", "User credit wallet currency does not match"],
    scoped_wallet_reserved_usage_mismatch: ["预留额度与进行中用量不一致", "Reserved credits do not match active usage"],
    scoped_wallet_consumed_usage_mismatch: ["累计消耗额度与已结算用量不一致", "Consumed credits do not match settled usage"],
    purchase_lot_balance_mismatch: ["剩余购买额度与当前余额不一致", "Remaining purchase lots do not match the current balance"],
    service_credit_ledger_projection_mismatch: ["服务额度余额与账本投影不一致", "Service-credit balance does not match the ledger projection"],
    entitlement_available_balance_mismatch: ["可用额度与服务权益不一致", "Available credits do not match service entitlements"],
    entitlement_reserved_balance_mismatch: ["预留额度与服务权益不一致", "Reserved credits do not match service entitlements"],
    missing_entitlement_binding: ["额度余额缺少服务权益绑定", "Credit balance has no service-entitlement binding"],
    audience_identity_resolution_incomplete: ["受众身份归并证据不完整", "Audience identity resolution is incomplete"],
    unsupported_entitlement_ledger_semantics: ["服务权益包含需人工复核的调整", "Service entitlement contains adjustments needing review"],
    purchase_scope_mismatch: ["额度购买归属范围不一致", "Credit purchase scope does not match"],
    purchase_arithmetic_mismatch: ["额度购买金额计算不一致", "Credit purchase arithmetic does not match"],
    purchase_dimensions_invalid: ["额度购买记录包含无效数值", "Credit purchase contains invalid numeric dimensions"],
    purchase_creator_share_mismatch: ["额度购买收益分成不一致", "Purchase creator share does not match"],
    purchase_creator_liability_mismatch: ["购买产生的创作者收益负债不守恒", "Purchase creator liability does not conserve"],
    creator_earning_scope_mismatch: ["创作者收益归属范围不一致", "Creator earning scope does not match"],
    purchase_remaining_out_of_range: ["剩余购买额度超出有效范围", "Remaining purchase credits are outside the valid range"],
    usage_scope_mismatch: ["服务用量归属范围不一致", "Service usage scope does not match"],
    usage_entitlement_binding_incomplete: ["服务用量的权益绑定不完整", "Service usage has an incomplete entitlement binding"],
    usage_entitlement_reserve_mismatch: ["服务用量缺少匹配的权益预留", "Service usage has no matching entitlement reservation"],
    usage_entitlement_transfer_chain_invalid: ["服务用量的授权转移链无效", "Service usage has an invalid authorization transfer chain"],
    usage_entitlement_transfer_orphan: ["权益授权转移缺少对应的服务用量", "Entitlement authorization transfer has no matching service usage"],
    usage_entitlement_terminal_mismatch: ["服务用量的权益结算凭证不一致", "Service usage has inconsistent entitlement settlement evidence"],
    usage_allocation_token_mismatch: ["已结算用量分配不一致", "Settled usage allocation does not match"],
    usage_allocation_value_mismatch: ["已结算用量金额分配不一致", "Settled usage value allocation does not match"],
    usage_allocation_currency_mismatch: ["用量分配币种不一致", "Usage allocation currency does not match"],
    usage_creator_earning_mismatch: ["用量释放收益与创作者收益记录不一致", "Usage creator release does not match its earning"],
    creator_frozen_allocation_mismatch: ["冻结收益与提现分配不一致", "Frozen earnings do not match withdrawal allocations"],
    creator_withdrawn_allocation_mismatch: ["已提现收益与打款分配不一致", "Withdrawn earnings do not match paid allocations"],
    creator_pending_ledger_projection_mismatch: ["待释放收益与账本投影不一致", "Pending earnings do not match the ledger projection"],
    creator_withdrawable_ledger_projection_mismatch: ["可提现收益与账本投影不一致", "Withdrawable earnings do not match the ledger projection"],
    creator_frozen_ledger_projection_mismatch: ["冻结收益与账本投影不一致", "Frozen earnings do not match the ledger projection"],
    withdrawal_allocation_total_mismatch: ["提现金额与收益分配不一致", "Withdrawal amount does not match its allocations"],
    withdrawal_scope_mismatch: ["提现分配归属范围不一致", "Withdrawal allocation scope does not match"],
    withdrawal_allocation_state_mismatch: ["提现状态与分配状态不一致", "Withdrawal state does not match its allocations"],
    ledger_event_group_amount_unbalanced: ["账本交易组金额不平衡", "Ledger transaction group is not balanced"],
    ledger_event_group_currency_mismatch: ["账本交易组币种不一致", "Ledger transaction-group currency does not match"],
    ledger_transaction_link_mismatch: ["账本明细与交易头关联不一致", "Ledger entries do not match their transaction header"],
    wallet_transaction_without_ledger: ["资金交易缺少账本明细", "Money transaction has no ledger entries"],
    user_cash_ledger_projection_mismatch: ["用户现金余额与账本投影不一致", "User cash balance does not match the ledger projection"],
    legacy_purchase_lot_coverage: ["旧购买记录缺少剩余额度证据", "Legacy purchase has incomplete remaining-credit evidence"],
    legacy_purchase_scope_coverage: ["旧购买记录缺少用户额度钱包绑定", "Legacy purchase has incomplete wallet-scope evidence"],
    legacy_usage_scope_coverage: ["旧用量记录缺少用户额度钱包绑定", "Legacy usage has incomplete wallet-scope evidence"],
    legacy_usage_allocation_coverage: ["旧用量记录缺少结算分配证据", "Legacy usage has incomplete settlement-allocation evidence"],
    legacy_service_credit_ledger_coverage: ["旧服务额度缺少完整账本投影", "Legacy service credits have incomplete ledger projection"],
    legacy_creator_pending_ledger_coverage: ["旧待释放收益缺少完整账本投影", "Legacy pending earnings have incomplete ledger projection"],
    legacy_creator_withdrawable_ledger_coverage: ["旧可提现收益缺少完整账本投影", "Legacy withdrawable earnings have incomplete ledger projection"],
    legacy_creator_frozen_ledger_coverage: ["旧冻结收益缺少完整账本投影", "Legacy frozen earnings have incomplete ledger projection"],
    legacy_transaction_header_coverage: ["旧账本交易组缺少交易头", "Legacy ledger group has no transaction header"],
    legacy_ledger_transaction_link_coverage: ["旧账本明细缺少交易头关联", "Legacy ledger entries have incomplete transaction links"],
    legacy_user_cash_ledger_coverage: ["旧现金余额缺少完整账本投影", "Legacy cash balance has incomplete ledger projection"],
    legacy_withdrawal_allocation_coverage: ["旧提现记录缺少完整收益分配证据", "Legacy withdrawal has incomplete allocation evidence"],
    legacy_creator_liability_coverage: ["旧购买记录缺少完整收益负债证据", "Legacy purchase has incomplete creator-liability evidence"],
    user_cash_balance_mismatch: ["用户现金余额与账本不一致", "User cash balance does not match its ledger"],
    service_credit_balance_mismatch: ["服务额度双账本不一致", "Service-credit ledgers do not match"],
    agent_wallet_balance_mismatch: ["代表额度汇总不一致", "Representative credit totals do not match"],
    creator_earning_balance_mismatch: ["创作者收益与账本不一致", "Creator earnings do not match their ledger"],
    withdrawal_allocation_mismatch: ["提现分配与冻结收益不一致", "Withdrawal allocations do not match frozen earnings"],
    ledger_group_unbalanced: ["账本交易组不平衡", "Ledger transaction group is unbalanced"],
    legacy_ledger_coverage: ["旧账本记录需要人工复核", "Legacy ledger coverage needs review"],
  };
  return labels[code.toLowerCase()]?.[locale === "zh" ? 0 : 1]
    ?? humanizeCode(code);
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

function formatReconciliationValue(
  value: number | null,
  unit: WorkspaceWalletReconciliationIssue["unit"],
  currency: string,
  locale: Locale,
  signed = false,
) {
  if (value === null) return "—";
  if (unit === "minor_currency") {
    return signed
      ? formatSignedMoney(value, currency, locale)
      : formatMoney(value, currency, locale);
  }
  const formatted = signed
    ? formatSignedNumber(value)
    : new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US").format(value);
  return unit === "tokens"
    ? `${formatted} ${locale === "zh" ? "额度" : "credits"}`
    : formatted;
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

function walletExceptionSeverityLabel(
  severity: WalletExceptionCase["severity"],
  locale: Locale,
) {
  const labels: Record<WalletExceptionCase["severity"], [string, string]> = {
    warning: ["需要复核", "Review needed"],
    error: ["处理失败", "Processing failed"],
    critical: ["严重异常", "Critical exception"],
  };
  return labels[severity][locale === "zh" ? 0 : 1];
}

function walletExceptionStatusTone(status: WalletExceptionCase["status"]) {
  if (status === "resolved") return "success";
  if (status === "open") return "error";
  if (status === "claimed") return "warning";
  return "neutral";
}

function walletExceptionStatusLabel(
  status: WalletExceptionCase["status"],
  claimedByCurrentOwner: boolean,
  locale: Locale,
) {
  const zh = locale === "zh";
  if (status === "open") return zh ? "待认领" : "Open";
  if (status === "claimed") {
    return claimedByCurrentOwner
      ? zh ? "已由你认领" : "Claimed by you"
      : zh ? "已认领" : "Claimed";
  }
  if (status === "acknowledged") return zh ? "已确认" : "Acknowledged";
  return zh ? "已恢复" : "Resolved";
}

function walletExceptionKindLabel(kind: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    order_reconciliation: ["支付订单核对", "Payment order reconciliation"],
    payment_order_reconciliation: ["支付订单核对", "Payment order reconciliation"],
    refund_lifecycle: ["微信退款状态跟踪", "WeChat Pay refund tracking"],
    refund_submission: ["微信退款提交", "WeChat Pay refund submission"],
    refund_reversal: ["退款资金冲正", "Refund funds reversal"],
    refund_reconciliation: ["退款资金核对", "Refund funds reconciliation"],
    refund_abnormal: ["微信退款异常", "WeChat Pay refund exception"],
  };
  return labels[kind]?.[locale === "zh" ? 0 : 1]
    ?? (locale === "zh" ? "资金处理异常" : "Funds processing exception");
}

function walletExceptionReasonLabel(reasonCode: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    wechat_order_reconciliation_dead_letter: [
      "支付订单自动核对多次失败",
      "Automatic payment order reconciliation failed repeatedly",
    ],
    wechat_refund_lifecycle_dead_letter: [
      "退款状态自动跟踪多次失败",
      "Automatic refund tracking failed repeatedly",
    ],
    wechat_refund_submission_dead_letter: [
      "退款提交结果需要人工复核",
      "Refund submission outcome needs manual review",
    ],
    wechat_refund_reversal_dead_letter: [
      "退款后的资金冲正需要人工复核",
      "Post-refund funds reversal needs manual review",
    ],
    wechat_refund_reconciliation_required: [
      "退款与本地资金状态需要复核",
      "Refund and local funds state need reconciliation",
    ],
    wechat_refund_provider_abnormal: [
      "微信退款返回异常状态",
      "WeChat Pay reported an abnormal refund state",
    ],
  };
  return labels[reasonCode]?.[locale === "zh" ? 0 : 1]
    ?? (locale === "zh"
      ? "资金处理需要运营复核"
      : "Funds processing needs operations review");
}

function walletExceptionActionPendingLabel(
  action: WalletExceptionAction,
  locale: Locale,
) {
  const labels: Record<WalletExceptionAction, [string, string]> = {
    claim: ["正在认领异常…", "Claiming the exception…"],
    retry: ["正在恢复对应的精确后台任务…", "Restoring the exact background job…"],
    acknowledge: ["正在记录非敏感处理说明…", "Recording the non-sensitive handling note…"],
  };
  return labels[action][locale === "zh" ? 0 : 1];
}

function walletExceptionActionSuccessLabel(
  action: WalletExceptionAction,
  locale: Locale,
) {
  const labels: Record<WalletExceptionAction, [string, string]> = {
    claim: ["异常已由你认领。", "The exception is now claimed by you."],
    retry: [
      "精确后台任务已恢复；资金仍由后台验真流程更新。",
      "The exact background job was restored; funds still change only through verified processing.",
    ],
    acknowledge: [
      "处理说明已记录；此次确认没有修改任何资金。",
      "The handling note was recorded; acknowledging changed no funds.",
    ],
  };
  return labels[action][locale === "zh" ? 0 : 1];
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

async function readWalletRefundFailure(
  response: Response,
  locale: Locale,
): Promise<{ code: string; message: string }> {
  const payload = (await response.json().catch(() => null)) as {
    code?: string;
    error?: string;
  } | null;
  const code = payload?.code ?? "refund_request_failed";
  const messages: Record<string, [string, string]> = {
    refund_already_queued: [
      "这笔购买已有退款正在处理或已经完成。",
      "This purchase already has a refund in progress or completed.",
    ],
    refund_credits_not_unused: [
      "仅完全未使用、未预留的购买额度可以退款。",
      "Only completely unused and unreserved credits can be refunded.",
    ],
    refund_idempotency_conflict: [
      "退款重试标识与原请求不一致，请刷新后重试。",
      "The refund retry key conflicts with the original request. Refresh and retry.",
    ],
    refund_order_not_eligible: [
      "只有已支付的微信购买订单可在这里退款。",
      "Only paid WeChat Pay purchases can be refunded here.",
    ],
    refund_purchase_ambiguous: [
      "这笔支付无法自动退款，需要运营复核。",
      "This payment cannot be refunded automatically and needs operations review.",
    ],
    refund_purchase_not_found: [
      "未找到当前 Owner 可退款的购买记录。",
      "No refundable purchase was found for the current Owner.",
    ],
    refund_queue_failed: [
      "退款未能写入队列，请使用当前页面重试。",
      "The refund could not be queued. Retry from this page.",
    ],
    refund_request_conflict: [
      "当前状态不允许自动退款，请刷新状态或联系运营。",
      "The current state does not allow an automatic refund. Refresh or contact operations.",
    ],
    refund_request_invalid: [
      "退款请求格式无效，请检查原因长度后重试。",
      "The refund request is invalid. Check the reason length and retry.",
    ],
    wechat_pay_configuration_invalid: [
      "微信退款配置尚未就绪，请联系运营。",
      "WeChat Pay refund configuration is not ready. Contact operations.",
    ],
    wechat_pay_processing_unavailable: [
      "微信退款处理当前暂停，请稍后重试。",
      "WeChat Pay refund processing is paused. Retry later.",
    ],
  };
  return {
    code,
    message:
      messages[code]?.[locale === "zh" ? 0 : 1]
      ?? payload?.error
      ?? (locale === "zh"
        ? `退款请求失败（${response.status}）。`
        : `Refund request failed (${response.status}).`),
  };
}
