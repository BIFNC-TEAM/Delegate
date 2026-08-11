import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readWorkspaceFile(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

describe("legacy fixed-tier pricing retirement", () => {
  it("drops the mutable PricingPlan catalog while preserving historical invoice facts", () => {
    const schema = readWorkspaceFile("prisma/schema.prisma");
    const migration = readWorkspaceFile(
      "prisma/migrations/20260811143000_remove_legacy_pricing_plans/migration.sql",
    );

    expect(schema).not.toContain("model PricingPlan {");
    expect(schema).toContain("model Invoice {");
    expect(schema).toContain("planType                PricingPlanType");
    expect(migration).toContain('DROP TABLE IF EXISTS "PricingPlan";');
  });

  it("keeps setup, publishing, knowledge, bot sales, and generation off the old catalog", () => {
    const sources = [
      readWorkspaceFile("packages/web-data/src/representative-setup.ts"),
      readWorkspaceFile("packages/web-data/src/conversation-platform.ts"),
      readWorkspaceFile("packages/web-data/src/openviking.ts"),
      readWorkspaceFile("packages/model-runtime/src/context.ts"),
      readWorkspaceFile("apps/bot/src/representative-config.ts"),
      readWorkspaceFile("apps/bot/src/telegram-bot-runtime.ts"),
      readWorkspaceFile("apps/conversation-worker/src/processor.ts"),
    ].join("\n");

    expect(sources).not.toContain("pricingPlans");
    expect(sources).not.toContain("representative.pricing");
    expect(sources).not.toContain("createPlanInvoice");
    expect(sources).not.toContain("formatTelegramPlans");
    expect(sources).not.toContain("reserveGenerationConversationEntitlement");
    expect(sources).not.toContain('callbackQuery(/^buy:(pass|deep_help|sponsor)');
  });
});
