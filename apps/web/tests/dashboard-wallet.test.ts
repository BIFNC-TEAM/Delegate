import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const walletSource = readFileSync(
  new URL("../app/dashboard/dashboard-wallet.tsx", import.meta.url),
  "utf8",
);
const frameworkSource = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const designSource = readFileSync(
  new URL("../../../DESIGN.md", import.meta.url),
  "utf8",
);

describe("Dashboard Wallet & Billing", () => {
  it("is a functional workspace module rather than a framework-data placeholder", () => {
    expect(frameworkSource).toContain('props.activeView === "wallet"');
    expect(frameworkSource).toContain("<DashboardWallet");
    expect(frameworkSource).toContain('"skills", "wallet", "audit"');
    expect(walletSource).toContain("/api/dashboard/wallet?");
    expect(walletSource).not.toContain("¥8,420");
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
});
