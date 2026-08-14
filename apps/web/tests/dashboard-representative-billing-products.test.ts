import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  editorIsValid,
  editorRequiresPackageHandoff,
} from "../app/dashboard/dashboard-representative-billing-products-logic";

const billingProductsSource = readFileSync(
  new URL(
    "../app/dashboard/dashboard-representative-billing-products.tsx",
    import.meta.url,
  ),
  "utf8",
);
const setupSource = readFileSync(
  new URL(
    "../app/dashboard/dashboard-representative-setup.tsx",
    import.meta.url,
  ),
  "utf8",
);
const dashboardCssSource = readFileSync(
  new URL("../app/dashboard/dashboard-v2.css", import.meta.url),
  "utf8",
);

describe("representative commerce management", () => {
  it("makes Owner Billing Catalog the only editable pricing source", () => {
    const setupFormEnd = setupSource.indexOf("</form>");
    const commerceMount = setupSource.indexOf(
      "<DashboardRepresentativeBillingProducts",
    );

    expect(setupSource).toContain('label: "价格"');
    expect(setupSource).toContain('label: "Pricing"');
    expect(setupSource).toContain("唯一价格真相");
    expect(setupSource).toContain("handoffConfiguration={{");
    expect(setupFormEnd).toBeGreaterThan(-1);
    expect(commerceMount).toBeGreaterThan(setupFormEnd);
    expect(billingProductsSource).not.toContain("<form");
    expect(setupSource).not.toContain("pricing-editor-grid");
    expect(setupSource).not.toContain("Free / Pass / Deep Help / Sponsor");
    expect(setupSource).not.toContain("<span>{t.freeReplyLimit}</span>");
    expect(setupSource).not.toContain("<span>{t.humanInLoop}</span>");
  });

  it("reads the live owner-scoped catalog without example balances or local persistence", () => {
    expect(billingProductsSource).toContain("/billing-products`");
    expect(billingProductsSource).toContain('{ cache: "no-store" }');
    expect(billingProductsSource).toContain("Loading pricing configuration");
    expect(billingProductsSource).toContain("公开销售只读取此处的服务套餐与打赏档位");
    expect(billingProductsSource).not.toContain("¥8,420");
    expect(billingProductsSource).not.toContain("localStorage");
    expect(billingProductsSource).not.toContain("sessionStorage");
  });

  it("saves commerce policy independently and exposes all access and handoff modes", () => {
    expect(billingProductsSource).toContain('method: "PATCH"');
    expect(billingProductsSource).toContain('value="FREE"');
    expect(billingProductsSource).toContain('value="TRIAL_THEN_CREDITS"');
    expect(billingProductsSource).toContain('value="CREDITS_ONLY"');
    expect(billingProductsSource).toContain(
      'settings.accessMode === "TRIAL_THEN_CREDITS"',
    );
    expect(billingProductsSource).toContain("freeReplyLimit");
    expect(billingProductsSource).toContain("humanInLoop");
    expect(billingProductsSource).toContain("handoffAccessMode");
    expect(billingProductsSource).toContain("tipsEnabled");
    expect(billingProductsSource).toContain("Save access and handoff");
    expect(billingProductsSource).toContain("Handoff prompt");
    expect(billingProductsSource).toContain("Human review window (hours)");
    expect(billingProductsSource).toContain("Archive every active service package");
    expect(billingProductsSource).toContain("Archive every active tip option");
  });

  it("separates active packages, tip options, and archived history", () => {
    expect(billingProductsSource).toContain('type CatalogCategory = ProductKind | "ARCHIVED"');
    expect(billingProductsSource).toContain('setCatalogCategory("SERVICE_PACKAGE")');
    expect(billingProductsSource).toContain('product.kind === "SERVICE_PACKAGE" && product.status !== "ARCHIVED"');
    expect(billingProductsSource).toContain('product.kind === "TIP" && product.status !== "ARCHIVED"');
    expect(billingProductsSource).toContain('product.status === "ARCHIVED"');
    expect(billingProductsSource).toContain("Service packages");
    expect(billingProductsSource).toContain("Tip options");
    expect(billingProductsSource).toContain("Archived products no longer accept purchases");
    expect(billingProductsSource).toContain("sortOrder");
    expect(billingProductsSource).toContain("isRecommended");
    expect(billingProductsSource).toContain("打赏不赠送服务额度或人工权益");
    expect(billingProductsSource).toContain("non-refundable");
    expect(billingProductsSource).toContain(
      'catalog?.representative.accessMode === "FREE"',
    );
    expect(billingProductsSource).toContain(
      "!catalog?.representative.tipsEnabled",
    );
  });

  it("uses one accessible modal for create, package details, and immutable price publication", () => {
    expect(billingProductsSource).toContain('role="dialog"');
    expect(billingProductsSource).toContain('aria-modal="true"');
    expect(billingProductsSource).toContain('className="representative-billing-modal-backdrop"');
    expect(billingProductsSource).toContain('event.key === "Escape"');
    expect(billingProductsSource).toContain("Package details");
    expect(billingProductsSource).toContain("Publish new price");
    expect(billingProductsSource).toContain("Manage service package");
    expect(billingProductsSource).toContain("This tab has unsaved changes");
    expect(billingProductsSource).not.toContain(">{zh ? \"编辑信息\"");
  });

  it("supports arbitrary price-to-credit ratios and complete handoff terms", () => {
    expect(billingProductsSource).toContain("Any positive price-to-credit ratio is allowed");
    expect(billingProductsSource).not.toContain("amountMinor %");
    expect(billingProductsSource).toContain('value="NONE"');
    expect(billingProductsSource).toContain('value="LIMITED"');
    expect(billingProductsSource).toContain('value="UNLIMITED"');
    expect(billingProductsSource).toContain('value="STANDARD"');
    expect(billingProductsSource).toContain('value="PRIORITY"');
    expect(billingProductsSource).toContain("handoffUnits");
    expect(billingProductsSource).toContain("handoffValidityDays");
  });

  it("blocks paid handoff publication until package-required handoff is enabled", () => {
    type CreateEditor = Extract<
      Parameters<typeof editorRequiresPackageHandoff>[0],
      { mode: "create" }
    >;
    const editor: CreateEditor = {
      mode: "create",
      idempotencyKey: "handoff-policy",
      productKind: "SERVICE_PACKAGE",
      name: "Priority package",
      description: "",
      sortOrder: 0,
      isRecommended: false,
      price: {
        amountMinor: 10,
        entitlementUnits: 100_000,
        handoffAllowance: "LIMITED",
        handoffUnits: 3,
        handoffServiceLevel: "PRIORITY",
        handoffValidityDays: 30,
      },
    };

    expect(editorRequiresPackageHandoff(editor)).toBe(true);
    expect(editorRequiresPackageHandoff({
      ...editor,
      price: { ...editor.price, handoffAllowance: "NONE" },
    })).toBe(false);
    expect(billingProductsSource).toContain("先启用套餐人工权益");
    expect(billingProductsSource).toContain("启用套餐人工权益");
    expect(billingProductsSource).toContain("Enable package-required human handoff");
    expect(billingProductsSource).toContain("handoffPolicyBlocked || !editorIsValid(editor)");
  });

  it("rejects editor values above every published API limit before submission", () => {
    type CreateEditor = Extract<
      Parameters<typeof editorIsValid>[0],
      { mode: "create" }
    >;
    const editor: CreateEditor = {
      mode: "create",
      idempotencyKey: "editor-limits",
      productKind: "SERVICE_PACKAGE",
      name: "Priority package",
      description: "Credits and priority handoff",
      sortOrder: 10,
      isRecommended: false,
      price: {
        amountMinor: 1_000,
        entitlementUnits: 100_000,
        handoffAllowance: "LIMITED",
        handoffUnits: 2,
        handoffServiceLevel: "PRIORITY",
        handoffValidityDays: 30,
      },
    };

    expect(editorIsValid(editor)).toBe(true);
    expect(editorIsValid({ ...editor, sortOrder: 1_000_001 })).toBe(false);
    expect(editorIsValid({
      ...editor,
      price: { ...editor.price, amountMinor: 1_000_001 },
    })).toBe(false);
    expect(editorIsValid({
      ...editor,
      price: { ...editor.price, entitlementUnits: 10_000_001 },
    })).toBe(false);
    expect(editorIsValid({
      ...editor,
      price: { ...editor.price, handoffUnits: 1_000_001 },
    })).toBe(false);
    expect(editorIsValid({
      ...editor,
      price: { ...editor.price, handoffValidityDays: 3_651 },
    })).toBe(false);
  });

  it("publishes immutable price versions with idempotency and concurrency guards", () => {
    expect(billingProductsSource).toContain("/price-versions`");
    expect(billingProductsSource).toContain('"Idempotency-Key"');
    expect(billingProductsSource).toContain("expectedRevision");
    expect(billingProductsSource).toContain("expectedActivePriceVersionId");
    expect(billingProductsSource).toContain("confirmPricePublication(editor, locale)");
    expect(billingProductsSource).toContain("价格版本发布后不可修改");
    expect(billingProductsSource).toContain("catalog.revenueSharePolicy");
    expect(billingProductsSource).toContain("平台政策只读");
    expect(billingProductsSource).not.toContain("Creator share (bps)");
  });

  it("keeps archive confirmed, revision guarded, and displays field/global errors", () => {
    expect(billingProductsSource).toContain("window.confirm(");
    expect(billingProductsSource).toContain("/archive`");
    expect(billingProductsSource).toContain(
      "{ expectedRevision: product.revision }",
    );
    expect(billingProductsSource).toContain("现有订单仍会继续处理");
    expect(billingProductsSource).toContain("fieldErrors");
    expect(billingProductsSource).toContain('aria-invalid={Boolean(');
    expect(billingProductsSource).toContain("representative-billing-field-error");
  });

  it("provides textual states, labels, focus treatment, and mobile touch targets", () => {
    expect(billingProductsSource).toContain('role={kind === "error" ? "alert" : "status"}');
    expect(billingProductsSource).toContain(
      'aria-labelledby="representative-commerce-title"',
    );
    expect(billingProductsSource).toContain("AI access mode");
    expect(billingProductsSource).toContain("Handoff access mode");
    expect(billingProductsSource).toContain("aria-describedby={");
    expect(billingProductsSource).toContain("representative-commerce-notification-viewport");
    expect(billingProductsSource).toContain("window.setTimeout(() => setNotice(null), 6_000)");
    expect(billingProductsSource).toContain("Dismiss pricing notification");
    expect(dashboardCssSource).toContain(".representative-commerce-settings-grid");
    expect(dashboardCssSource).toContain(".representative-commerce-category-tabs");
    expect(dashboardCssSource).toContain(".representative-billing-modal-backdrop");
    expect(dashboardCssSource).toContain("outline: 3px solid rgba(22,163,148,.12);");
    expect(dashboardCssSource).toContain("min-height: 44px;");
    expect(dashboardCssSource).toContain(
      ".representative-billing-facts { grid-template-columns: repeat(2,minmax(0,1fr)); }",
    );
  });

  it("keeps commerce typography at the 12px DESIGN microcopy floor without overrides", () => {
    const commerceCss = dashboardCssSource.slice(
      dashboardCssSource.indexOf(".representative-billing-products {"),
      dashboardCssSource.indexOf(".representative-knowledge-binding {"),
    );
    const remSizes = [...commerceCss.matchAll(
      /(?:font-size:\s*|font:[^;]*?\s)(\.\d+)rem/g,
    )].map((match) => Number(match[1]));

    expect(remSizes.length).toBeGreaterThan(0);
    expect(remSizes.every((size) => size >= 0.75)).toBe(true);
    expect(commerceCss).not.toContain("!important");
  });
});
