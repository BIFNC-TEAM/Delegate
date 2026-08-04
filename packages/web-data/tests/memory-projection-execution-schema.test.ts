import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804110000_memory_projection_execution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const service = readFileSync(
  new URL("../src/memory-projection-execution.ts", import.meta.url),
  "utf8",
);
const providerService = readFileSync(
  new URL("../src/memory-projection-provider.ts", import.meta.url),
  "utf8",
);

describe("Memory System T5 projection execution schema", () => {
  it("locks every projection to one canonical managed-user version URI", () => {
    const projection = modelBlock("MemoryProjectionItem");
    expect(projection).toMatch(/remoteUri\s+String\b/u);
    expect(projection).not.toMatch(/remoteUri\s+String\?/u);
    expect(migration).toContain('ALTER COLUMN "remoteUri" SET NOT NULL');
    expect(migration).toContain("MemoryProjectionItem_canonical_uri_check");
    expect(migration).toContain("MemoryProjectionItem_locked_coordinates_check");
    expect(migration).toContain("viking://user/delegate-memory-");
    expect(migration).toContain("/versions/' || NEW.\"memoryVersionId\" || '.md'");
    expect(migration).toContain("NEW.\"remoteUri\" LIKE 'viking://agent/%'");
    expect(migration).toContain("NEW.\"remoteUri\" LIKE 'viking://user/memories/%'");
  });

  it("refuses to orphan legacy remote evidence during canonical URI backfill", () => {
    expect(migration).toContain("LEGACY_REMOTE_EVIDENCE_PREFLIGHT_BEGIN");
    expect(migration).toContain(
      "MemoryProjectionItem_legacy_remote_evidence_requires_cleanup",
    );
    expect(migration).toContain('projection."remoteUri" IS NOT NULL');
    expect(migration).toContain('projection."remoteObjectId" IS NOT NULL');
    expect(migration).toContain('projection."projectedAt" IS NOT NULL');
    expect(migration).toContain('projection."attemptCount" <> 0');
    expect(migration).toMatch(
      /projection\."status" NOT IN \([\s\S]*?'DISABLED'[\s\S]*?'QUEUED'[\s\S]*?'DELETE_PENDING'/u,
    );
    expect(migration).toMatch(
      /UPDATE "MemoryProjectionItem" projection[\s\S]*?projection\."remoteUri" IS NULL[\s\S]*?projection\."remoteObjectId" IS NULL[\s\S]*?projection\."projectedAt" IS NULL/u,
    );
  });

  it("requires leases, CAS receipts, and confirmed exact-leaf absence", () => {
    const projection = modelBlock("MemoryProjectionItem");
    for (const field of [
      "writeReceiptHash",
      "writeVerifiedAt",
      "deleteReceiptHash",
      "remoteAbsentAt",
    ]) {
      expect(projection).toContain(field);
    }
    expect(migration).toContain("MemoryProjectionItem_execution_claim_check");
    expect(migration).toContain("MemoryProjectionItem_execution_active_receipt_check");
    expect(migration).toContain("MemoryProjectionItem_execution_delete_receipt_check");
    expect(migration).toContain('OLD."status" <> \'DELETING\'');
    expect(migration).toContain('OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP');
    expect(migration).not.toContain(
      'OLD."status" = \'DELETE_PENDING\' AND NEW."status" IN (\'DELETING\', \'DELETE_FAILED\', \'DELETED\')',
    );
    expect(service).toContain("FOR UPDATE SKIP LOCKED");
    expect(service).toContain('projection."leaseToken" = ${claim.leaseToken}');
    expect(service).toContain('projection."leaseExpiresAt" > CURRENT_TIMESTAMP');
  });

  it("fences reconciliation repairs and chains hash-mismatch deletion evidence into the write receipt", () => {
    expect(migration).toContain("MemoryProjectionItem_reconciliation_repair_check");
    expect(migration).toContain("MemoryProjectionItem_write_receipt_chain_check");
    expect(migration).toContain("reconciliation_missing_remote");
    expect(migration).toContain("reconciliation_hash_mismatch");
    expect(migration).toContain("reconciliation_stale_active_pointer");
    expect(migration).toMatch(
      /FROM "MemoryReconciliationItem" item[\s\S]*?item\."status" IN \([\s\S]*?'OPEN'[\s\S]*?'RETRYING'/u,
    );
    expect(service).toMatch(
      /repairReason === "reconciliation_hash_mismatch"[\s\S]*?inspectExact[\s\S]*?deleteExact[\s\S]*?inspectExact/u,
    );
    expect(service).toContain("previousWriteReceiptHash: claim.previousWriteReceiptHash");
    expect(service).toContain("projection_write_cleanup_required");
    expect(migration).toContain("projection_write_cleanup_required");
    expect(service).toMatch(
      /return client\.\$transaction[\s\S]*?resolveProjectionReconciliationIssues/u,
    );
    expect(service).toMatch(
      /UPDATE "MemoryReconciliationItem" item[\s\S]*?'RESOLVED'[\s\S]*?UPDATE "MemoryReconciliationRun" run[\s\S]*?"resolvedCount"/u,
    );
    expect(service).toMatch(
      /completeProjectionDeletion[\s\S]*?"MISSING_REMOTE"[\s\S]*?"HASH_MISMATCH"[\s\S]*?"STALE_ACTIVE_POINTER"/u,
    );
  });

  it("keeps network calls out of transactions and provisions the exact root before create", () => {
    expect(service).toMatch(
      /const claim = await claimNextProjectionWrite[\s\S]*?provider\.ensureRoot[\s\S]*?provider\.writeExact[\s\S]*?provider\.inspectExact/u,
    );
    expect(providerService).toContain("client.ensureGovernedMemoryRoot");
    expect(providerService).toContain("client.createGovernedMemoryVersion");
    expect(providerService).toContain("client.deleteGovernedMemoryVersion");
    expect(providerService).toContain("buildGovernedMemoryManagedUserId(namespaceKey)");
    expect(providerService).toMatch(
      /if \(!env\.enabled\) return null;[\s\S]*?new OpenVikingMemoryProjectionProvider/u,
    );
  });

  it("allows deletion proof completion only after all leases drain and all absence receipts exist", () => {
    expect(migration).toContain("MemoryDeletionProof_projection_drain_check");
    expect(migration).toContain('"status" <> \'DELETED\'');
    expect(migration).toContain('"leaseToken" IS NOT NULL');
    expect(migration).toContain('"deleteReceiptHash" IS NULL');
    expect(migration).toContain('"remoteAbsentAt" IS NULL');
    expect(migration).toContain("MemoryDeletionProof_provider_receipt_check");
    expect(service).toContain("projection_drain_pending");
    expect(service).toContain("providerReceiptHash");
    expect(modelBlock("MemoryDeletionProof")).not.toMatch(
      /\b(?:safeText|summary|rawText|messageText|remoteUri)\b/u,
    );
  });

  it("recovers expired write, delete, and proof leases without shortcut completion", () => {
    expect(service).toContain("projection_write_lease_expired");
    expect(service).toContain("projection_delete_lease_expired");
    expect(service).toContain("memory_cleanup_lease_expired");
    expect(service.match(/FOR UPDATE SKIP LOCKED/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(service).toContain("'DELETING'::\"MemoryProjectionStatus\"");
    expect(service).toContain("'DELETE_FAILED'::\"MemoryProjectionStatus\"");
  });
});

function modelBlock(modelName: string) {
  const match = schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));
  return match?.[0] ?? "";
}
