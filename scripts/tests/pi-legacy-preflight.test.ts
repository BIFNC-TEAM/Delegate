import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "scripts/pi-legacy-preflight.ts"),
  "utf8",
);

describe("Pi legacy preflight", () => {
  it("looks up mixed-case Prisma tables by exact catalog name", () => {
    expect(source).toContain("relation.relname = $1");
    expect(source).toContain("namespace.nspname = 'public'");
    expect(source).not.toContain("to_regclass($1)");
  });

  it("blocks unresolved execution and external-effect state", () => {
    for (const category of [
      "active_legacy_tool_executions",
      "active_legacy_compute_sessions",
      "unresolved_legacy_external_effects",
      "reconciliation_required_plan_actions",
    ]) {
      expect(source).toContain(category);
    }
  });

  it("keeps the database transaction read-only", () => {
    expect(source).toContain('SET TRANSACTION READ ONLY');
    expect(source).not.toMatch(/\.(?:create|delete|update|updateMany)\s*\(/u);
  });
});
