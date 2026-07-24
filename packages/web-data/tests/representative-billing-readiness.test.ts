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
  it("initializes a service-credit wallet with every newly created representative", () => {
    const source = readFileSync(
      new URL("../src/representative-setup.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /representative\.create\([\s\S]*?agentWallet:\s*\{\s*create:\s*\{[\s\S]*?tokenUnitPriceCents:\s*1,[\s\S]*?creatorRevenueShareBps:\s*2000,/,
    );
  });

  it("blocks paid pricing when the service-credit wallet is missing or invalid", () => {
    const missingWallet = buildRepresentativeReadiness({
      ...baseReadinessInput,
      paidPricingCount: 1,
      agentWallet: null,
    });
    const invalidWallet = buildRepresentativeReadiness({
      ...baseReadinessInput,
      paidPricingCount: 1,
      agentWallet: {
        currency: "CNY",
        tokenUnitPriceCents: 0,
        creatorRevenueShareBps: 2000,
      },
    });

    expect(missingWallet.find((item) => item.id === "pricing")).toMatchObject({
      complete: false,
    });
    expect(invalidWallet.find((item) => item.id === "pricing")).toMatchObject({
      complete: false,
    });
  });

  it("allows free-only pricing without a wallet and paid pricing with a valid wallet", () => {
    const freeOnly = buildRepresentativeReadiness({
      ...baseReadinessInput,
      paidPricingCount: 0,
      agentWallet: null,
    });
    const paid = buildRepresentativeReadiness({
      ...baseReadinessInput,
      paidPricingCount: 3,
      agentWallet: {
        currency: "CNY",
        tokenUnitPriceCents: 1,
        creatorRevenueShareBps: 2000,
      },
    });

    expect(freeOnly.find((item) => item.id === "pricing")).toMatchObject({
      complete: true,
    });
    expect(paid.find((item) => item.id === "pricing")).toMatchObject({
      complete: true,
    });
  });
});
