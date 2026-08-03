import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260803162000_quarantine_legacy_openviking_memories/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Memory System legacy OpenViking quarantine", () => {
  it("suppresses only legacy records that are still ACTIVE", () => {
    expect(migration.match(/UPDATE\s+"OpenVikingMemoryRecord"/gu)).toHaveLength(1);
    expect(migration).toContain(
      'WHERE "status" = \'ACTIVE\'::"OpenVikingMemoryStatus"',
    );
    expect(migration).toContain(
      '"status" = \'SUPPRESSED\'::"OpenVikingMemoryStatus"',
    );
    expect(migration).toContain(
      '"suppressedAt" = COALESCE("suppressedAt", CURRENT_TIMESTAMP)',
    );
    expect(migration).toContain('"updatedAt" = CURRENT_TIMESTAMP');
  });

  it("does not migrate, approve, delete, or rewrite legacy content", () => {
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|DROP)\b/u);
    expect(migration).not.toMatch(/\b(?:summary|safeText|contentHash)\b/u);
    expect(migration).not.toMatch(
      /\b(?:GovernedMemory|MemoryCandidate|MemoryReviewDecision|APPROVED)\b/u,
    );
  });

  it("does not touch knowledge or representative context-sync storage", () => {
    expect(migration).not.toMatch(
      /\b(?:KnowledgeAsset|KnowledgePack|KnowledgeBinding|RepresentativeContextSync)\b/u,
    );
  });
});
