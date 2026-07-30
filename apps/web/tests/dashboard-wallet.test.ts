import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const walletSource = readFileSync(
  new URL("../app/dashboard/dashboard-wallet.tsx", import.meta.url),
  "utf8",
);
const payoutProfileSource = readFileSync(
  new URL("../app/dashboard/dashboard-payout-profile.tsx", import.meta.url),
  "utf8",
);
const frameworkSource = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const dashboardUiDataSource = readFileSync(
  new URL("../app/dashboard/dashboard-ui-data.ts", import.meta.url),
  "utf8",
);
const designSource = readFileSync(
  new URL("../../../DESIGN.md", import.meta.url),
  "utf8",
);
const walletCssSource = readFileSync(
  new URL("../app/dashboard/dashboard-v2.css", import.meta.url),
  "utf8",
);

describe("Dashboard Wallet & Billing", () => {
  it("is a functional workspace module rather than a framework-data placeholder", () => {
    expect(frameworkSource).toContain('props.activeView === "wallet"');
    expect(frameworkSource).toContain("<DashboardWallet");
    expect(frameworkSource).toContain('"skills", "wallet", "audit"');
    expect(walletSource).toContain("/api/dashboard/wallet?");
    expect(walletSource).not.toContain("¥8,420");
    expect(frameworkSource).not.toContain("¥8,420");
    expect(frameworkSource).not.toContain("¥1,240");
    expect(frameworkSource).not.toContain("¥572");
    expect(frameworkSource).toContain("概览暂不加载资金数据");
    expect(frameworkSource).toContain("示例金额冒充真实余额");
    expect(dashboardUiDataSource).not.toContain("¥8,420");
    expect(dashboardUiDataSource).not.toContain("¥2,860");
    expect(dashboardUiDataSource).not.toContain("¥1,240");
    expect(dashboardUiDataSource).not.toContain("User recharge");
    expect(dashboardUiDataSource).toContain("购买服务包");
  });

  it("keeps business transactions, settlements, and immutable ledger entries separate", () => {
    expect(walletSource).toContain('"overview",');
    expect(walletSource).toContain('"transactions",');
    expect(walletSource).toContain('"settlements",');
    expect(walletSource).toContain('"ledger",');
    expect(walletSource).toContain("Business events explain what happened");
    expect(walletSource).toContain("immutable entries prove how value moved");
  });

  it("filters by workspace dimensions and paginates with stale-response protection", () => {
    expect(walletSource).toContain("setRepresentative");
    expect(walletSource).toContain("setCurrency");
    expect(walletSource).toContain("setEventType");
    expect(walletSource).toContain('parameters.set("cursor", cursor)');
    expect(walletSource).toContain("snapshot?.page.hasMore");
    expect(walletSource).toContain("requestSequenceRef.current !== requestId");
    expect(walletSource).toContain("activeFilterKeyRef.current !== requestedFilterKey");
  });

  it("keeps first-page summary semantics stable while appending event pages", () => {
    expect(walletSource).toContain('mode === "append" && current');
    expect(walletSource).toContain("workspace: current.workspace");
    expect(walletSource).toContain("metrics: current.metrics");
    expect(walletSource).toContain("primaryAction: current.primaryAction");
    expect(walletSource).toContain("representatives: current.representatives");
    expect(walletSource).toContain("currencies: current.currencies");
    expect(walletSource).toContain("eventTypes: current.eventTypes");
    expect(walletSource).toContain('zh ? "账目事件截止" : "Event cutoff"');
    expect(walletSource).toContain("summary cards are current balances and period totals calculated with the first page");
    expect(designSource).toContain("`asOf` is not a historical balance snapshot");
  });

  it("shows a retryable failure state instead of zero-value content when the first request fails", () => {
    expect(walletSource).toContain("error && !snapshot && !showInitialLoading");
    expect(walletSource).toContain('showInitialFailure ? (');
    expect(walletSource).toContain("Wallet and billing could not load");
  });

  it("states and implements the single-currency aggregation boundary", () => {
    expect(walletSource).toContain("currencies are never combined");
    expect(walletSource).toContain("所有汇总均限定在当前币种");
    expect(designSource).toContain("Never add unlike currencies");
  });

  it("provides keyboard-operable rows and a mobile detail sheet escape path", () => {
    expect(walletSource).toContain('event.key === "Enter" || event.key === " "');
    expect(walletSource).toContain('keyboardEvent.key === "Escape"');
    expect(walletSource).toContain('keyboardEvent.key !== "Tab"');
    expect(walletSource).toContain("closeButtonRef.current?.focus()");
    expect(walletSource).toContain("aria-label={zh ? \"关闭详情\"");
    expect(walletSource).toContain('role={detail && isMobileSheet ? "dialog" : "region"}');
    expect(walletSource).toContain("aria-modal={detail && isMobileSheet ? true : undefined}");
    expect(walletSource).toContain('aria-labelledby="wallet-detail-heading"');
  });

  it("supports a scoped, confirmed withdrawal request and owner cancellation", () => {
    expect(walletSource).toContain("/api/dashboard/wallet/withdrawals?rep=");
    expect(walletSource).toContain("representativeSlug: selectedRepresentative.slug");
    expect(walletSource).toContain("eligibleWithdrawalRepresentatives");
    expect(walletSource).toContain("确认并冻结收益");
    expect(walletSource).toContain("Confirm and freeze earnings");
    expect(walletSource).toContain("/cancel?rep=");
    expect(walletSource).toContain("dashboard-cancel:");
    expect(walletSource).not.toContain("申请提现 · 流程接入中");
  });

  it("requires a tokenized, version-locked payout destination before withdrawal", () => {
    expect(walletSource).toContain('"payout_profile"');
    expect(walletSource).toContain("Set up payout account");
    expect(walletSource).toContain("<DashboardPayoutProfile");
    expect(payoutProfileSource).toContain(
      "/api/dashboard/wallet/payout-profile",
    );
    expect(payoutProfileSource).toContain("Provider recipient token");
    expect(payoutProfileSource).toContain('type="password"');
    expect(payoutProfileSource).toContain(
      "Each withdrawal locks its masked destination snapshot",
    );
    expect(payoutProfileSource).toContain(
      "Production review and payout require separate Operator access",
    );
    expect(payoutProfileSource).not.toMatch(
      /bankCard|cardNumber|identityNumber|paymentPassword/,
    );
    expect(walletCssSource).toContain(".wallet-payout-profile");
  });

  it("queues owner-scoped full WeChat refunds from purchase details", () => {
    expect(walletSource).toContain(
      'event.sourceType === "AgentTokenPurchase"',
    );
    expect(walletSource).toContain(
      "/api/dashboard/wallet/refunds?rep=",
    );
    expect(walletSource).toContain("window.confirm(");
    expect(walletSource).toContain("window.prompt(");
    expect(walletSource).toContain(
      "new TextEncoder().encode(reason).byteLength > 80",
    );
    expect(walletSource).toContain("refundIdempotencyKeysRef");
    expect(walletSource).toContain("refund:${crypto.randomUUID()}");
    expect(walletSource).toContain("Only completely unused and unreserved credits");
    expect(walletSource).toContain("后台异步处理");
    expect(walletSource).toContain("不会直接修改余额");
    expect(walletSource).toContain("Promise.allSettled([");
    expect(walletSource).toContain('loadWallet("replace")');
    expect(walletSource).toContain("loadReconciliation()");
    expect(walletCssSource).toContain(".wallet-refund-operation");
    expect(walletCssSource).toContain(
      ".wallet-refund-button {\n  min-height: 44px;",
    );
  });

  it("keeps mock operations visibly non-production and improves withdrawal trace detail", () => {
    expect(walletSource).toContain("mockWithdrawalOperations");
    expect(walletSource).toContain("本地模拟运营");
    expect(walletSource).toContain("it is not creator self-approval");
    expect(walletSource).toContain("/mock-action");
    expect(walletSource).toContain('label={zh ? "申请 ID" : "Request ID"}');
    expect(walletSource).toContain('label={zh ? "审核人" : "Reviewer"}');
    expect(walletSource).toContain('label="Transaction ID"');
    expect(walletSource).toContain('label="Event group"');
  });

  it("loads a read-only reconciliation independently for representative and currency scope", () => {
    expect(walletSource).toContain("/api/dashboard/wallet/reconciliation?");
    expect(walletSource).toContain("setReconciliationReport");
    expect(walletSource).toContain("setReconciliationError");
    expect(walletSource).toContain("activeReconciliationScopeKeyRef");
    expect(walletSource).toContain("representative,");
    expect(walletSource).toContain("currency: resolvedCurrency");
    expect(walletSource).toContain("refreshWalletAndReconciliation");
    expect(walletSource).toContain("refreshReconciliationAfterMutation");
    expect(walletSource).toContain('loadWallet("replace")');
    expect(walletSource).toContain("loadReconciliation()");
  });

  it("places funds health after primary money metrics without adding a fifth wallet view", () => {
    const metricsIndex = walletSource.indexOf(
      'className="dashboard-v2-metric-grid wallet-metrics"',
    );
    const reconciliationIndex = walletSource.indexOf("<WalletReconciliationPanel");
    const recentEventsIndex = walletSource.indexOf('className="wallet-overview-layout"');

    expect(metricsIndex).toBeGreaterThan(-1);
    expect(reconciliationIndex).toBeGreaterThan(metricsIndex);
    expect(recentEventsIndex).toBeGreaterThan(reconciliationIndex);
    expect(walletSource).toContain('healthy: ["资金正常", "Funds reconciled"]');
    expect(walletSource).toContain('warning: ["存在需复核项", "Review needed"]');
    expect(walletSource).toContain('blocked: ["发现资金差异", "Money differences found"]');
    expect(walletSource).not.toContain("资金操作已阻断");
  });

  it("places an independent owner-scoped exception queue after funds health", () => {
    const reconciliationIndex = walletSource.indexOf("<WalletReconciliationPanel");
    const exceptionQueueIndex = walletSource.indexOf("<WalletExceptionQueue");
    const recentEventsIndex = walletSource.indexOf('className="wallet-overview-layout"');

    expect(exceptionQueueIndex).toBeGreaterThan(reconciliationIndex);
    expect(recentEventsIndex).toBeGreaterThan(exceptionQueueIndex);
    expect(walletSource).toContain(
      "/api/dashboard/wallet/exceptions?rep=",
    );
    expect(walletSource).toContain("异常队列暂时无法加载");
    expect(walletSource).toContain("当前没有待处理资金异常");
    expect(walletSource).toContain('aria-labelledby="wallet-exception-queue-heading"');
    expect(walletSource).toContain('aria-busy={loading}');
    expect(walletCssSource).toContain(".wallet-exception-queue");
  });

  it("uses versioned idempotent exception actions without directly mutating funds", () => {
    expect(walletSource).toContain(
      "/api/dashboard/wallet/exceptions/${encodeURIComponent(exceptionCase.id)}/actions?rep=",
    );
    expect(walletSource).toContain("expectedVersion: exceptionCase.version");
    expect(walletSource).toContain("wallet-exception:${action}:${crypto.randomUUID()}");
    expect(walletSource).toContain("actionIdempotencyKeysRef");
    expect(walletSource).toContain("response.status === 409");
    expect(walletSource).toContain("Promise.allSettled([");
    expect(walletSource).toContain("onRefreshReconciliation()");
    expect(walletSource).toContain('applyAction(exceptionCase, "claim")');
    expect(walletSource).toContain('applyAction(exceptionCase, "retry")');
    expect(walletSource).toContain('applyAction(exceptionCase, "acknowledge")');
    expect(walletSource).toContain("确认只记录说明，不会修改资金");
    expect(walletSource).toContain("retry restores only the exact background job");
  });

  it("keeps exception text safe and requires a non-sensitive acknowledgement note", () => {
    expect(walletSource).toContain("walletExceptionReasonLabel(exceptionCase.reasonCode");
    expect(walletSource).toContain(
      '?? (locale === "zh"\n      ? "资金处理需要运营复核"',
    );
    expect(walletSource).not.toContain("humanizeCode(exceptionCase.reasonCode)");
    expect(walletSource).not.toContain("exceptionCase.representativeSlug}");
    expect(walletSource).toContain("不包含账号、订单号、退款号或个人信息");
    expect(walletSource).toContain("A non-sensitive handling note is required");
    expect(walletSource).toContain("claimedByCurrentOwner");
    expect(walletCssSource).toContain(
      ".wallet-exception-actions button {\n    flex: 1 1 180px;\n    min-height: 44px;",
    );
  });

  it("keeps reconciliation read-only, current, and separate from date and search filters", () => {
    expect(walletSource).toContain("只读核对当前代表范围与币种");
    expect(walletSource).toContain("不会修改任何财务数据");
    expect(walletSource).toContain("不受日期、事件类型或搜索条件影响");
    expect(walletSource).toContain("changes no financial data");
    expect(walletSource).toContain("unaffected by date, event-type, or search filters");
    expect(walletSource).toContain("absoluteAmountDifferenceCents");
    expect(walletSource).toContain("absoluteTokenDifference");
  });

  it("shows textual issue severity and supports accessible expansion", () => {
    expect(walletSource).toContain('aria-controls="wallet-reconciliation-issues"');
    expect(walletSource).toContain("aria-expanded={expanded}");
    expect(walletSource).toContain('role="alert"');
    expect(walletSource).toContain('role="status"');
    expect(walletSource).toContain("issue.references.map");
    expect(walletCssSource).toContain(".wallet-reconciliation.is-success");
    expect(walletCssSource).toContain(".wallet-reconciliation.is-warning");
    expect(walletCssSource).toContain(".wallet-reconciliation.is-error");
    expect(walletCssSource).toContain(".wallet-reconciliation-footer > button { min-height: 44px; }");
  });
});
