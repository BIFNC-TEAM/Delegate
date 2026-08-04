import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804100000_memory_governance_foundation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const t1Migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260803161000_memory_authority_foundation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const t3Migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260803163000_memory_source_message_guard/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Memory System T4 governance schema", () => {
  it("binds correction candidates to an exact memory and base version", () => {
    const candidate = modelBlock("MemoryCandidate");
    const version = modelBlock("GovernedMemoryVersion");

    expect(candidate).toContain("correctionMemoryId");
    expect(candidate).toContain("correctionBaseVersionId");
    expect(candidate).toContain(
      "fields: [correctionMemoryId, representativeId, scope]",
    );
    expect(candidate).toContain(
      "fields: [correctionBaseVersionId, correctionMemoryId, representativeId, scope]",
    );
    expect(version).toContain(
      '@@unique([id, memoryId, representativeId, scope], map: "GovernedMemoryVersion_id_memory_rep_scope_key")',
    );
    expect(migration).toContain(
      'CONSTRAINT "MemoryCandidate_correction_coordinates_check"',
    );
    expect(migration).toContain('"extractionRunId" IS NULL');
    expect(migration).toContain(
      '"MemoryCandidate_one_pending_correction_key"',
    );
    expect(migration).toContain(
      '"MemoryReviewDecision_one_correction_request_key"',
    );
    expect(migration).toContain(
      "MemoryReviewDecision_correction_base_current_check",
    );
    expect(migration).toContain("MemoryCandidate_locked_coordinates_check");
    expect(migration).toContain("MemoryCandidate_correction_parent_state_check");
    expect(migration).toContain(
      'memory_record."status" <> \'SUPPRESSED\'::"GovernedMemoryStatus"',
    );
    expect(migration).toContain(
      'memory_record."currentVersionId" IS DISTINCT FROM NEW."correctionBaseVersionId"',
    );
    expect(migration).toContain('FROM "MemoryDeletionProof"');
  });

  it("rechecks approval and activation under source and policy locks", () => {
    expect(migration).toContain('FOR SHARE;');
    expect(migration).toContain('"memory_assert_audience_text_source"');
    expect(migration).toContain("MemoryReviewDecision_candidate_expired_check");
    expect(migration).toContain("MemoryReviewDecision_candidate_reviewable_check");
    expect(migration).toContain("MemoryReviewDecision_independent_review_check");
    expect(migration).toContain("GovernedMemory_active_source_check");
    expect(migration).toContain("GovernedMemory_active_policy_check");
    expect(migration).toContain("GovernedMemory_active_correction_check");
    expect(migration).toContain(
      "GovernedMemory_active_pending_correction_check",
    );
    expect(migration).toMatch(
      /"correctionMemoryId" = NEW\."id"[\s\S]*?"status" = 'PENDING_REVIEW'[\s\S]*?FOR SHARE/u,
    );
    expect(migration).toContain('candidate_record."expiresAt" <= CURRENT_TIMESTAMP');
    expect(migration).toContain('NEW."expiresAt" <= CURRENT_TIMESTAMP');
    expect(migration).toContain('policy_record."contactMemoryEnabled"');
    expect(migration).toContain('policy_record."representativeExperienceEnabled"');
  });

  it("adds a durable lease-backed cleanup state machine", () => {
    const proof = modelBlock("MemoryDeletionProof");

    expect(enumBlock("MemoryCleanupStatus")).toMatch(
      /QUEUED[\s\S]*RUNNING[\s\S]*RETRYING[\s\S]*FAILED[\s\S]*SUCCEEDED/u,
    );
    for (const field of [
      "cleanupStatus",
      "attemptCount",
      "availableAt",
      "leaseToken",
      "leaseExpiresAt",
      "lastErrorCode",
    ]) {
      expect(proof, field).toContain(field);
    }
    expect(proof).toContain(
      '@@index([cleanupStatus, availableAt, leaseExpiresAt], map: "MemoryDeletionProof_cleanup_due_idx")',
    );
    expect(migration).toContain("MemoryDeletionProof_cleanup_transition_check");
    expect(migration).toContain("MemoryDeletionProof_cleanup_claim_check");
    expect(migration).toContain("MemoryDeletionProof_cleanup_success_check");
    expect(migration).toContain("MemoryDeletionProof_cleanup_terminal_check");
    expect(migration).toContain("MemoryDeletionProof_cleanup_worker_state_check");
    expect(migration).toContain("MemoryDeletionProof_cleanup_completion_state_check");
    expect(migration).toContain("GovernedMemory_deleted_cleanup_check");
    expect(migration).toContain("MemoryDeletionProof_pending_correction_check");
    expect(migration).toContain(
      "MemoryDeletionProof_correction_content_purged_check",
    );
    expect(migration).toMatch(
      /"correctionMemoryId" = NEW\."memoryId"[\s\S]*?"contentPurgedAt" IS NULL[\s\S]*?"safeText" IS NOT NULL[\s\S]*?"summary" IS NOT NULL/u,
    );
    expect(migration).toContain(
      'OLD."cleanupStatus" = \'FAILED\' AND NEW."cleanupStatus" = \'QUEUED\'',
    );
  });

  it("adds only body-free governance audit event types", () => {
    const events = enumBlock("EventType");
    for (const eventType of [
      "MEMORY_CANDIDATE_APPROVED",
      "MEMORY_CANDIDATE_REJECTED",
      "MEMORY_CANDIDATE_BLOCKED",
      "MEMORY_CORRECTION_REQUESTED",
      "MEMORY_STATUS_CHANGED",
      "MEMORY_DELETION_REQUESTED",
      "MEMORY_CLEANUP_RETRY_REQUESTED",
    ]) {
      expect(events).toContain(eventType);
      expect(migration).toContain(
        `ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS '${eventType}'`,
      );
    }
    expect(modelBlock("MemoryDeletionProof")).not.toMatch(
      /\b(?:safeText|summary|rawText|messageText|note|uri)\b/u,
    );
    expect(migration).toContain("EventAudit_memory_command_code_check");
    expect(migration).toContain("MemoryDeletionProof_command_code_check");
    expect(migration).toContain("MemoryReviewDecision_reason_code_check");
    expect(migration).toContain(
      "^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$",
    );
  });

  it("is replay-safe without removing the T1 or T3 guards", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION");
    expect(migration).not.toContain(
      'DROP TRIGGER IF EXISTS "MemoryCandidate_guard"',
    );
    expect(migration).not.toContain(
      'DROP TRIGGER IF EXISTS "MemoryCandidate_source_guard"',
    );
    expect(migration).not.toContain(
      'DROP TRIGGER IF EXISTS "Message_memory_source_invalidation"',
    );
    expect(t1Migration).toContain(
      'CREATE TRIGGER "MemoryCandidate_guard"',
    );
    expect(t3Migration).toContain(
      'CREATE TRIGGER "MemoryCandidate_source_guard"',
    );
    expect(t3Migration).toContain(
      'CREATE TRIGGER "Message_memory_source_invalidation"',
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
