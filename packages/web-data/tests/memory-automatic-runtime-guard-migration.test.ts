import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806120000_automatic_memory_runtime_guard_trust/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const originalProjectionMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804110000_memory_projection_execution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const originalUseMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804130000_memory_use_truth_ledger/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("automatic memory runtime guard trust migration", () => {
  const projectionGuard = functionBlock(
    migration,
    "memory_projection_state_guard",
  );
  const useGuard = functionBlock(migration, "memory_use_item_scope_guard");

  it("replaces both live guards without dropping their existing constraints", () => {
    expect(migration.match(
      /CREATE OR REPLACE FUNCTION "memory_projection_state_guard"/gu,
    )).toHaveLength(1);
    expect(migration.match(
      /CREATE OR REPLACE FUNCTION "memory_use_item_scope_guard"/gu,
    )).toHaveLength(1);

    const originalProjectionGuard = functionBlock(
      originalProjectionMigration,
      "memory_projection_state_guard",
    );
    const originalUseGuard = functionBlock(
      originalUseMigration,
      "memory_use_item_scope_guard",
    );
    expect(constraintNames(projectionGuard)).toEqual(
      constraintNames(originalProjectionGuard),
    );
    expect(constraintNames(useGuard)).toEqual(
      constraintNames(originalUseGuard),
    );
  });

  it("accepts only a non-system legacy approval or a fully matching automatic activation", () => {
    for (const guard of [projectionGuard, useGuard]) {
      expect(guard).toContain('FROM "MemoryReviewDecision"');
      expect(guard).toContain(
        '"reviewerRole" <> \'SYSTEM\'::"MemoryReviewerRole"',
      );
      expect(guard).toContain('FROM "MemoryPolicyDecision"');
      expect(guard).toContain(
        '"candidateId" = version_record."sourceCandidateId"',
      );
      expect(guard).toContain('"resultVersionId" = version_record."id"');
      expect(guard).toContain('"memoryId" = memory_record."id"');
      expect(guard).toMatch(
        /"representativeId" = (?:memory_record|run_record)\."representativeId"/u,
      );
      expect(guard).toContain(
        '"outputHash" IS NOT DISTINCT FROM version_record."contentHash"',
      );
      expect(guard).toContain(
        '\'ACTIVATED\'::"MemoryPolicyDecisionOutcome"',
      );
      expect(guard).toContain(
        '\'UPDATED\'::"MemoryPolicyDecisionOutcome"',
      );
      expect(guard).not.toContain(
        '\'UNCHANGED\'::"MemoryPolicyDecisionOutcome"',
      );
      expect(guard).not.toContain(
        '\'SKIPPED\'::"MemoryPolicyDecisionOutcome"',
      );
    }
  });

  it("retains projection lifecycle and use isolation fences", () => {
    for (const invariant of [
      "MemoryProjectionItem_initial_state_check",
      "MemoryProjectionItem_state_transition_check",
      "MemoryProjectionItem_reconciliation_repair_check",
      "MemoryProjectionItem_staged_lane_check",
      "MemoryProjectionItem_active_version_check",
    ]) {
      expect(projectionGuard).toContain(invariant);
    }
    for (const invariant of [
      "MemoryUseItem_generation_version_check",
      "MemoryUseItem_episode_version_check",
      "MemoryUseItem_content_hash_check",
      "MemoryUseItem_representative_scope_check",
      "MemoryUseItem_contact_scope_check",
      "MemoryUseItem_rep_experience_scope_check",
      "MemoryUseItem_injection_allowlist_check",
      "MemoryUseItem_public_manifest_check",
      "MemoryUseItem_cited_source_check",
    ]) {
      expect(useGuard).toContain(invariant);
    }
  });
});

function functionBlock(source: string, functionName: string) {
  const match = source.match(new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION "${functionName}"\\(\\) RETURNS TRIGGER AS \\$\\$[\\s\\S]*?\\$\\$ LANGUAGE plpgsql;`,
    "u",
  ));
  if (!match) throw new Error(`Missing function ${functionName}`);
  return match[0];
}

function constraintNames(source: string) {
  return [...source.matchAll(/CONSTRAINT = '([^']+)'/gu)]
    .map((match) => match[1])
    .sort();
}
