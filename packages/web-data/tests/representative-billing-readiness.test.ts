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

  it("removes the retired four-tier catalog from publish readiness", () => {
    const readiness = buildRepresentativeReadiness({
      ...baseReadinessInput,
    });

    expect(readiness.find((item) => item.id === "pricing")).toBeUndefined();
  });

  it("keeps live commerce access fields out of legacy setup writes", () => {
    const source = readFileSync(
      new URL("../src/representative-setup.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "humanInLoop and freeReplyLimit are live commerce settings",
    );
    expect(source).not.toContain("humanInLoop: input.humanInLoop");
    expect(source).not.toContain(
      "freeReplyLimit: input.contract.freeReplyLimit",
    );
    expect(source).toContain("!liveRepresentative.humanInLoop");
    expect(source).not.toContain("pricingPlans");
    expect(source).not.toContain("tx.pricingPlan");
    expect(source).not.toContain("snapshot.pricing");
  });

  it("does not gate publication on the retired four-tier catalog", () => {
    const readiness = buildRepresentativeReadiness(baseReadinessInput);

    expect(readiness.find((item) => item.id === "pricing")).toBeUndefined();
  });
});
