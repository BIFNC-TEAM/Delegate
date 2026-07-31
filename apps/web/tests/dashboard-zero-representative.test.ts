import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboardPage = readFileSync(
  new URL("../app/dashboard/page.tsx", import.meta.url),
  "utf8",
);
const dashboardFramework = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const sitePage = readFileSync(
  new URL("../../site/app/page.tsx", import.meta.url),
  "utf8",
);

describe("zero-representative dashboard", () => {
  it("does not select or query a global demo representative for an empty owner directory", () => {
    expect(dashboardPage).not.toContain('import { demoRepresentative } from "@delegate/domain"');
    expect(dashboardPage).toContain(
      'const fallbackSlug = representatives[0]?.slug ?? "";',
    );
    expect(dashboardPage).toContain('activeView === "inbox" && activeSlug');
    expect(dashboardPage).toContain(
      'activeView === "representatives" && activeSlug',
    );
    expect(dashboardPage).toContain("representativeSlug: activeSlug");
    expect(dashboardPage).toContain("ownerId,");
  });

  it("renders honest onboarding and never builds a public-page link without an owned representative", () => {
    expect(dashboardFramework).toContain("hasActiveRepresentative");
    expect(dashboardFramework).toContain("<DashboardRepresentativeOnboarding");
    expect(dashboardFramework).toContain(
      'props.activeView !== "settings" && hasActiveRepresentative',
    );
    expect(dashboardFramework).toContain(
      "No demo representative or another Owner's records are loaded before creation.",
    );
    expect(dashboardFramework).toContain("if (representativeSlug)");
  });

  it("keeps the workspace knowledge library available before the first representative is created", () => {
    expect(dashboardFramework).toContain(
      '&& props.activeView !== "knowledge"',
    );
    expect(dashboardFramework).toContain(
      '<DashboardKnowledgeLibrary activeSlug={props.activeSlug} locale={props.locale} />',
    );
  });

  it("routes every marketing creation CTA to the real representative directory", () => {
    expect(sitePage).toContain(
      "/dashboard?view=representatives&repSection=directory",
    );
    expect(sitePage).not.toContain("/dashboard?view=setup");
  });
});
