import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("automatic memory authority-only migration", () => {
  const migration = fs.readFileSync(
    path.join(
      process.cwd(),
      "../../prisma/migrations/20260806180000_automatic_memory_authority_only/migration.sql",
    ),
    "utf8",
  );

  it("suppresses and withdraws legacy human-only recall", () => {
    expect(migration).toContain('UPDATE "GovernedMemory" memory_record');
    expect(migration).toContain("'SUPPRESSED'::\"GovernedMemoryStatus\"");
    expect(migration).toContain("legacy_human_authority_retired");
    expect(migration).toContain("'DELETE_PENDING'::\"MemoryProjectionStatus\"");
  });

  it("requires automatic decisions for memory, projection, and injection", () => {
    expect(migration).toContain("GovernedMemory_automatic_authority_only_check");
    expect(migration).toContain("MemoryProjectionItem_automatic_authority_only_check");
    expect(migration).toContain("MemoryUseItem_automatic_authority_only_check");
    expect(migration.match(/FROM "MemoryPolicyDecision"|JOIN "MemoryPolicyDecision"/gu))
      .toHaveLength(5);
    expect(migration).not.toContain('FROM "MemoryReviewDecision"');
    expect(migration).not.toContain('JOIN "MemoryReviewDecision"');
  });
});
