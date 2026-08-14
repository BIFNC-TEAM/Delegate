import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const setupSource = readFileSync(
  new URL("../app/dashboard/dashboard-representative-setup.tsx", import.meta.url),
  "utf8",
);
const billingProductsSource = readFileSync(
  new URL(
    "../app/dashboard/dashboard-representative-billing-products.tsx",
    import.meta.url,
  ),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/dashboard/representatives/[slug]/setup/route.ts", import.meta.url),
  "utf8",
);

describe("representative intake", () => {
  it("removes the reception-policy step and keeps human handoff under pricing", () => {
    expect(setupSource).not.toContain('id: "contract"');
    expect(setupSource).not.toContain("需求采集字段");
    expect(setupSource).not.toContain("Reception policy");
    expect(setupSource).toContain('activeSection === "pricing"');
    expect(setupSource).not.toContain("representative-handoff-status");
    expect(billingProductsSource).toContain("联系人、预算和时间由真人接手后再确认");
    expect(billingProductsSource).toContain("人工接手提示语");
    expect(billingProductsSource).toContain("人工评估时窗（小时）");
  });

  it("does not send a configurable reception policy through the setup API", () => {
    expect(routeSource).not.toContain("receptionPolicy");
    expect(routeSource).not.toContain("normalizeReceptionPolicy");
  });

  it("does not show the obsolete demo-to-owner loading headline", () => {
    expect(setupSource).not.toContain("把 demo 配置变成真的 owner 配置");
    expect(setupSource).not.toContain("Turn the demo configuration into a real owner configuration");
  });
});
