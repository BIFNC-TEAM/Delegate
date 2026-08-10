import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "../../prisma/migrations/20260806140000_memory_source_automatic_policy_invalidation/migration.sql",
  ),
  "utf8",
);

describe("automatic memory source invalidation migration", () => {
  it("preserves locked automatic-decision safety coordinates while purging content", () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "memory_invalidate_message_source"()',
    );
    expect(migration).toContain('FROM "MemoryPolicyDecision" policy_decision');
    expect(migration).toContain(
      'policy_decision."candidateId" = candidate."id"',
    );
    expect(migration).toContain('"safeText" = NULL');
    expect(migration).toContain('"summary" = NULL');
    expect(migration).toContain(
      "THEN 'BLOCKED'::\"MemoryCandidateStatus\"",
    );
  });
});
