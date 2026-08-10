import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("non-manual automatic memory authority migration", () => {
  const migration = fs.readFileSync(
    path.join(
      process.cwd(),
      "../../prisma/migrations/20260806190000_block_manual_memory_policy_sources/migration.sql",
    ),
    "utf8",
  );

  it("keeps historical correction records audit-only", () => {
    expect(migration).toContain("OWNER_VERIFIED_CORRECTION");
    expect(migration).toContain("MemoryPolicyDecision_non_manual_source_check");
    expect(migration).toContain("manual_memory_policy_source_retired");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"MemoryReviewDecision"/u);
  });

  it("guards activation, projection, and injection", () => {
    expect(migration).toContain("GovernedMemory_non_manual_authority_check");
    expect(migration).toContain("MemoryProjectionItem_non_manual_authority_check");
    expect(migration).toContain("MemoryUseItem_non_manual_authority_check");
  });
});
