import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const schema = read("prisma/schema.prisma");
const migration = read(
  "prisma/migrations/20260817070000_remove_compute_credits/migration.sql",
);
const runtimeSources = [
  "apps/compute-broker/src/billing.ts",
  "apps/compute-broker/src/executions.ts",
  "apps/conversation-worker/src/processor.ts",
  "packages/compute-protocol/src/index.ts",
  "packages/web-data/src/compute-conversation-results.ts",
  "packages/web-data/src/conversation-platform.ts",
].map(read).join("\n");

describe("Compute-credit retirement", () => {
  it("removes legacy balances, budgets, deltas, and debit enum values from Prisma", () => {
    for (const legacyName of [
      "balanceCredits",
      "sponsorPoolCredit",
      "computeBudgetRemainingCredits",
      "maxCredits",
      "creditDelta",
      "PLAN_DEBIT",
      "SPONSOR_CREDIT",
    ]) {
      expect(schema).not.toContain(legacyName);
    }
  });

  it("physically drops legacy storage and recreates the cost-only ledger enum", () => {
    expect(migration).toContain('DROP COLUMN IF EXISTS "computeBudgetRemainingCredits"');
    expect(migration).toContain('DROP COLUMN IF EXISTS "creditDelta"');
    expect(migration).toContain("WHERE \"kind\" IN ('PLAN_DEBIT', 'SPONSOR_CREDIT')");
    expect(migration).toContain("'MCP_CALLS'");
  });

  it("keeps approval and public result paths free of Compute-credit semantics", () => {
    for (const legacyName of [
      "estimatedCredits",
      "actualCredits",
      "insufficient_compute_budget",
      "消耗：",
    ]) {
      expect(runtimeSources).not.toContain(legacyName);
    }
  });
});

function read(path: string) {
  return readFileSync(fileURLToPath(new URL(path, root)), "utf8");
}
