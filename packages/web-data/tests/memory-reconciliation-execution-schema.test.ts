import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804120000_memory_reconciliation_execution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const service = readFileSync(
  new URL("../src/memory-reconciliation-execution.ts", import.meta.url),
  "utf8",
);
const projectionService = readFileSync(
  new URL("../src/memory-projection-execution.ts", import.meta.url),
  "utf8",
);
const exportsSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
const scheduler = readFileSync(
  new URL("../../../apps/conversation-worker/src/scheduler.ts", import.meta.url),
  "utf8",
);

describe("Memory System T5 reconciliation execution schema", () => {
  it("persists one immutable bounded target snapshot per known projection", () => {
    const target = modelBlock("MemoryReconciliationTarget");
    expect(enumBlock("MemoryReconciliationTargetKind")).toMatch(
      /EXPECTED_ACTIVE[\s\S]*KNOWN_STALE[\s\S]*RETAINED_INACTIVE[\s\S]*LIVE_IN_FLIGHT/u,
    );
    expect(enumBlock("MemoryReconciliationTargetStatus")).toMatch(
      /PENDING[\s\S]*CHECKING[\s\S]*RETRYING[\s\S]*MATCHED[\s\S]*ISSUE[\s\S]*SKIPPED[\s\S]*FAILED/u,
    );
    for (const field of [
      "snapshotProjectionStatus",
      "snapshotProjectionUpdatedAt",
      "snapshotAttemptCount",
      "snapshotRemoteUri",
      "expectedContentHash",
      "remoteExists",
      "observedContentHash",
      "checkedAt",
      "leaseToken",
      "leaseExpiresAt",
    ]) {
      expect(target, field).toContain(field);
    }
    expect(target).toContain("@@id([reconciliationRunId, projectionItemId])");
    expect(target).toContain("MemoryReconciliationTarget_run_due_idx");
    expect(target).toContain("MemoryReconciliationTarget_lease_idx");
    expect(migration).toContain("MemoryReconciliationTarget_snapshot_immutable_check");
    expect(migration).toContain("MemoryReconciliationTarget_terminal_immutable_check");
    expect(migration).toContain("MemoryReconciliationTarget_state_shape_check");
  });

  it("requires issue evidence before fencing an active or stale projection", () => {
    expect(migration).toContain("MemoryReconciliationTarget_issue_before_fence_check");
    expect(migration).toContain("known_projection:' || NEW.\"projectionItemId\"");
    expect(migration).toMatch(
      /item\."status" IN \([\s\S]*?'OPEN'[\s\S]*?'RETRYING'[\s\S]*?issue_kind = 'MISSING_REMOTE'/u,
    );
    expect(service.indexOf("createReconciliationIssue")).toBeLessThan(
      service.indexOf("fenceExpectedProjectionForRetry"),
    );
    expect(service.indexOf("createReconciliationIssue")).toBeLessThan(
      service.indexOf("fenceKnownStaleProjection"),
    );
    expect(service).toContain('projection."updatedAt" = target."snapshotProjectionUpdatedAt"');
    expect(service).toContain('projection."attemptCount" = target."snapshotAttemptCount"');
  });

  it("enforces periodic idempotency, leases, and explicit partial truth", () => {
    expect(migration).toContain("MemoryReconciliationRun_one_active_rep_provider_key");
    expect(migration).toContain("^periodic:[0-9]+$");
    expect(migration).toContain("MemoryReconciliationRun_claim_check");
    expect(migration).toContain("MemoryReconciliationRun_requeue_check");
    expect(migration).toContain("MemoryReconciliationRun_terminal_immutable_check");
    expect(migration).toContain("openviking_inventory_no_snapshot_cursor");
    expect(migration).toContain("actual_expected");
    expect(migration).toContain("actual_observed");
    expect(migration).toContain("actual_matched");
    expect(migration).toContain("actual_issues");
    expect(migration).toContain("actual_resolved");
    expect(migration).toContain('NEW."resolvedCount" = actual_resolved');
    expect(migration).toContain(
      '"status" <> \'SUCCEEDED\'::"MemoryReconciliationStatus"',
    );
    expect(service).toContain("ON CONFLICT DO NOTHING");
    expect(service).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("allows receipt-backed repair and exact deletion to close issue and run counts", () => {
    expect(migration).toContain("MemoryReconciliationItem_resolution_receipt_check");
    expect(migration).toContain("MemoryReconciliationItem_terminal_immutable_check");
    expect(migration).toContain("MemoryReconciliationItem_initial_evidence_check");
    expect(migration).toContain("MemoryReconciliationItem_cas_ignore_check");
    expect(migration).toMatch(
      /'MISSING_REMOTE'[\s\S]*?'HASH_MISMATCH'[\s\S]*?projection_record\."status" = 'ACTIVE'[\s\S]*?projection_record\."writeReceiptHash" IS NOT NULL/u,
    );
    expect(migration).toMatch(
      /'MISSING_REMOTE'[\s\S]*?'HASH_MISMATCH'[\s\S]*?projection_record\."status" = 'DELETED'[\s\S]*?projection_record\."deleteReceiptHash" IS NOT NULL[\s\S]*?projection_record\."remoteAbsentAt" IS NOT NULL[\s\S]*?projection_record\."deletedAt" IS NOT NULL/u,
    );
    expect(migration).toMatch(
      /'STALE_ACTIVE_POINTER'[\s\S]*?projection_record\."status" <> 'DELETED'/u,
    );
    expect(projectionService).toMatch(
      /UPDATE "MemoryReconciliationItem" item[\s\S]*?"status" = 'RESOLVED'[\s\S]*?UPDATE "MemoryReconciliationRun" run[\s\S]*?"resolvedCount"/u,
    );
    expect(migration).toContain("monotonic resolution rollup");
  });

  it("exports a callable worker and never adds inventory enumeration or remote deletion", () => {
    expect(exportsSource).toContain(
      'export * from "./memory-reconciliation-execution";',
    );
    expect(scheduler).toContain('invokeMemoryWorker("runNextMemoryReconciliation")');
    expect(service).toContain("export async function runNextMemoryReconciliation");
    expect(service).toContain("if (!env.enabled)");
    expect(service).toContain("reconciliation_provider_disabled");
    expect(service).not.toMatch(
      /ORPHAN_REMOTE|FOREIGN_REMOTE|DUPLICATE_REMOTE|HEALTHY/u,
    );
    expect(service).not.toMatch(
      /deleteGovernedMemoryVersion|deleteExact|search\/glob/u,
    );
    expect(migration).not.toMatch(
      /ORPHAN_REMOTE|FOREIGN_REMOTE|DUPLICATE_REMOTE|HEALTHY/u,
    );
  });
});

function modelBlock(modelName: string) {
  const match = schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));
  return match?.[0] ?? "";
}

function enumBlock(enumName: string) {
  const match = schema.match(new RegExp(`enum ${enumName} \\{[\\s\\S]*?\\n\\}`));
  return match?.[0] ?? "";
}
