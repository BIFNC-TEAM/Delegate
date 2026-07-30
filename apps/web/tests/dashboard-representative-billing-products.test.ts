import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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

describe("representative service-package management", () => {
  it("mounts CNY service packages in Pricing without nesting its own save flow", () => {
    const setupFormEnd = setupSource.indexOf("</form>");
    const billingProductsMount = setupSource.indexOf(
      "<DashboardRepresentativeBillingProducts",
    );

    expect(setupSource).toContain('activeSection === "pricing"');
    expect(setupFormEnd).toBeGreaterThan(-1);
    expect(billingProductsMount).toBeGreaterThan(setupFormEnd);
    expect(billingProductsSource).not.toContain("<form");
    expect(billingProductsSource).toContain(
      "服务包独立于代表发布版本",
    );
  });

  it("reads live owner-scoped products and never substitutes example money", () => {
    expect(billingProductsSource).toContain(
      "/billing-products`",
    );
    expect(billingProductsSource).toContain('{ cache: "no-store" }');
    expect(billingProductsSource).toContain(
      "Loading live service packages",
    );
    expect(billingProductsSource).not.toContain("¥8,420");
    expect(billingProductsSource).not.toContain("localStorage");
    expect(billingProductsSource).not.toContain("sessionStorage");
  });

  it("publishes price versions explicitly with idempotency and concurrency guards", () => {
    expect(billingProductsSource).toContain(
      '/price-versions`',
    );
    expect(billingProductsSource).toContain('"Idempotency-Key"');
    expect(billingProductsSource).toContain("expectedRevision");
    expect(billingProductsSource).toContain(
      "expectedActivePriceVersionId",
    );
    expect(billingProductsSource).toContain(
      "confirmPricePublication(editor, locale)",
    );
    expect(billingProductsSource).toContain(
      "价格版本发布后不可修改",
    );
    expect(billingProductsSource).toContain("catalog.revenueSharePolicy");
    expect(billingProductsSource).toContain("平台政策只读");
    expect(billingProductsSource).not.toContain("Creator share (bps)");
    expect(billingProductsSource).not.toContain(
      "creatorRevenueShareBps: Number(",
    );
  });

  it("keeps archive a confirmed, revision-guarded operation", () => {
    expect(billingProductsSource).toContain("window.confirm(");
    expect(billingProductsSource).toContain(
      "/archive`",
    );
    expect(billingProductsSource).toContain(
      "{ expectedRevision: product.revision }",
    );
    expect(billingProductsSource).toContain(
      "现有订单仍会继续处理",
    );
  });

  it("provides responsive and accessible operational states", () => {
    expect(billingProductsSource).toContain('role="status"');
    expect(billingProductsSource).toContain('role="alert"');
    expect(billingProductsSource).toContain(
      'aria-labelledby="representative-service-packages-title"',
    );
    expect(dashboardCssSource).toContain(
      ".representative-billing-products",
    );
    expect(dashboardCssSource).toContain(
      ".representative-billing-facts { grid-template-columns: repeat(2,minmax(0,1fr)); }",
    );
    expect(dashboardCssSource).toContain("min-height: 44px;");
  });
});
