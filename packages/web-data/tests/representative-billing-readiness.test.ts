import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildRepresentativeReadiness } from "../src/conversation-platform";

const baseReadinessInput = {
  displayName: "Representative",
  roleSummary: "Answers public questions.",
  tone: "Clear",
  publicMode: true,
  humanInLoop: true,
  handoffPrompt: "Ask the owner to review.",
  knowledgeCount: 1,
  knowledgePackItemCount: 0,
  pricingCount: 4,
  channelCount: 1,
  enabledSkillCount: 0,
  skillIssueCount: 0,
};

describe("representative billing readiness", () => {
  it("initializes a wallet and three immutable CNY service packages with every representative", () => {
    const source = readFileSync(
      new URL("../src/representative-setup.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /representative\.create\([\s\S]*?agentWallet:\s*\{\s*create:\s*\{[\s\S]*?tokenUnitPriceCents:\s*1,[\s\S]*?creatorRevenueShareBps:\s*2000,/,
    );
    expect(source).toMatch(
      /defaultCnyServicePackages\s*=\s*\[[\s\S]*?amountMinor:\s*500,[\s\S]*?entitlementUnits:\s*500,[\s\S]*?amountMinor:\s*2_000,[\s\S]*?entitlementUnits:\s*2_000,[\s\S]*?amountMinor:\s*10_000,[\s\S]*?entitlementUnits:\s*10_000,/,
    );
    expect(source).toMatch(
      /representative\.create\([\s\S]*?billingProducts:\s*\{\s*create:\s*defaultCnyServicePackages\.map\([\s\S]*?status:\s*BillingProductStatus\.ACTIVE,[\s\S]*?priceVersions:\s*\{\s*create:\s*\{[\s\S]*?version:\s*1,[\s\S]*?status:\s*BillingPriceVersionStatus\.ACTIVE,[\s\S]*?currency:\s*"CNY",[\s\S]*?unitName:\s*"credit",[\s\S]*?creatorRevenueShareBps:\s*2_000,[\s\S]*?platformRevenueShareBps:\s*8_000,[\s\S]*?refundPolicy:\s*BillingRefundPolicy\.FULL_WHEN_UNUSED,[\s\S]*?expiryPolicy:\s*BillingEntitlementExpiryPolicy\.NEVER_EXPIRES,[\s\S]*?entitlementValidityDays:\s*null,[\s\S]*?publishedAt:\s*now,/,
    );
  });

  it("keeps Telegram Stars pricing independent from CNY service packages", () => {
    const readiness = buildRepresentativeReadiness({
      ...baseReadinessInput,
    });

    expect(readiness.find((item) => item.id === "pricing")).toMatchObject({
      complete: true,
      detail:
        "Free, pass, deep help, and sponsor tiers are configured independently from CNY service packages.",
    });
  });

  it("still requires all four representative pricing tiers", () => {
    const readiness = buildRepresentativeReadiness({
      ...baseReadinessInput,
      pricingCount: 3,
    });

    expect(readiness.find((item) => item.id === "pricing")).toMatchObject({
      complete: false,
    });
  });
});
