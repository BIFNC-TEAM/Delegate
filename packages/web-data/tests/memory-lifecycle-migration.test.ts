import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806130000_memory_lifecycle_execution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const previousMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806120000_automatic_memory_runtime_guard_trust/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const projectionExecutionMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804110000_memory_projection_execution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const repairMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806160000_memory_projection_policy_reenable_guard_repair/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("memory lifecycle migration", () => {
  const guard = functionBlock(migration, "memory_projection_state_guard");
  const previousGuard = functionBlock(
    previousMigration,
    "memory_projection_state_guard",
  );
  const coordinatesGuard = functionBlock(
    migration,
    "memory_projection_coordinates_guard",
  );
  const executionGuard = functionBlock(
    migration,
    "memory_projection_execution_guard",
  );

  it("adds one policy recovery fence without dropping prior projection constraints", () => {
    expect(new Set(constraintNames(guard))).toEqual(new Set([
      ...constraintNames(previousGuard),
      "MemoryProjectionItem_policy_reenable_requeue_check",
    ]));
  });

  it("allows only proof-free, current, unexpired and policy-eligible recall tombstones", () => {
    expect(guard).toContain(
      "OLD.\"status\" IN ('DELETE_PENDING', 'DELETE_FAILED', 'DELETED')",
    );
    expect(guard).toContain("OLD.\"deleteRequestedAt\" IS NOT NULL");
    expect(guard).toContain('FROM "MemoryDeletionProof"');
    expect(guard).toContain('memory_record."status" = \'ACTIVE\'');
    expect(guard).toContain('memory_record."recallDisabledAt" IS NULL');
    expect(guard).toContain(
      'memory_record."currentVersionId" = NEW."memoryVersionId"',
    );
    expect(guard).toContain(
      'memory_record."expiresAt" > CURRENT_TIMESTAMP',
    );
    expect(guard).toContain('version_record."purgedAt" IS NULL');
    expect(guard).toContain('policy_record."longTermMemoryEnabled"');
    expect(guard).toContain('policy_record."contactMemoryEnabled"');
    expect(guard).toContain(
      'memory_record."sourceChannel" = \'WEB\'::"RepresentativeChannelKind"',
    );
    expect(guard).not.toContain("policy_record.\"matrixRecallEnabled\"");
    expect(guard).not.toContain("policy_record.\"telegramRecallEnabled\"");
    expect(guard).toContain(
      'policy_record."representativeExperienceEnabled"',
    );
  });

  it("requires deletion/write receipts and leases to be cleared on recovery", () => {
    for (const field of [
      "remoteObjectId",
      "writeReceiptHash",
      "writeVerifiedAt",
      "deleteReceiptHash",
      "remoteAbsentAt",
      "leaseToken",
      "leaseExpiresAt",
      "projectedAt",
      "deleteRequestedAt",
      "deletedAt",
      "lastErrorCode",
    ]) {
      expect(guard).toContain(`NEW."${field}" IS NULL`);
    }
    expect(guard).toContain('NEW."attemptCount" = 0');
    expect(guard).not.toMatch(
      /OLD\."status" = 'FAILED'[\s\S]{0,120}policy_reenable_requeue/u,
    );
  });

  it("opens the receipt and attempt guards only through the same strict recovery predicate", () => {
    const previousCoordinates = functionBlock(
      projectionExecutionMigration,
      "memory_projection_coordinates_guard",
    );
    const previousExecution = functionBlock(
      projectionExecutionMigration,
      "memory_projection_execution_guard",
    );
    expect(new Set(constraintNames(coordinatesGuard))).toEqual(
      new Set(constraintNames(previousCoordinates)),
    );
    expect(new Set(constraintNames(executionGuard))).toEqual(
      new Set(constraintNames(previousExecution)),
    );
    expect(coordinatesGuard).toContain(
      'memory_projection_policy_reenable_allowed"(OLD, NEW)',
    );
    expect(executionGuard).toContain(
      'memory_projection_policy_reenable_allowed"(OLD, NEW)',
    );
    expect(coordinatesGuard).toContain("NOT policy_reenable_reset");
    expect(executionGuard).toContain("AND NOT policy_reenable_reset");
  });

  it("replays the finalized helper and receipt guards for databases with an already-applied 1300", () => {
    const repairCoordinates = functionBlock(
      repairMigration,
      "memory_projection_coordinates_guard",
    );
    const repairExecution = functionBlock(
      repairMigration,
      "memory_projection_execution_guard",
    );
    expect(repairMigration).toContain(
      'CREATE OR REPLACE FUNCTION "memory_projection_policy_reenable_allowed"',
    );
    expect(repairMigration).toContain('FROM "MemoryDeletionProof"');
    expect(repairMigration).toContain(
      'memory_record."sourceChannel" = \'WEB\'::"RepresentativeChannelKind"',
    );
    expect(new Set(constraintNames(repairCoordinates))).toEqual(
      new Set(constraintNames(coordinatesGuard)),
    );
    expect(new Set(constraintNames(repairExecution))).toEqual(
      new Set(constraintNames(executionGuard)),
    );
    expect(repairCoordinates).toContain("NOT policy_reenable_reset");
    expect(repairExecution).toContain("AND NOT policy_reenable_reset");
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
