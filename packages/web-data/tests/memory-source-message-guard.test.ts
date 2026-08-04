import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260803163000_memory_source_message_guard/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Memory System source-message database guard", () => {
  it("accepts only locked audience text provenance and rejects edited or redacted sources", () => {
    expect(migration).toContain('FOR SHARE;');
    expect(migration).toContain(
      'source_record."senderType" <> \'AUDIENCE\'::"MessageSenderType"',
    );
    expect(migration).toContain(
      'source_record."contentType" <> \'TEXT\'::"MessageContentType"',
    );
    expect(migration).toContain('source_record."editedAt" IS NOT NULL');
    expect(migration).toContain('source_record."redactedAt" IS NOT NULL');
    expect(migration).toContain(
      "'MemoryExtractionRun_audience_text_source_check'",
    );
    expect(migration).toContain(
      "'MemoryCandidate_audience_text_source_check'",
    );
  });

  it("binds every candidate to the exact extraction message and channel", () => {
    expect(migration).toContain(
      'extraction_record."sourceMessageId" IS DISTINCT FROM NEW."sourceMessageId"',
    );
    expect(migration).toContain(
      'extraction_record."sourceChannel" IS DISTINCT FROM NEW."originChannel"',
    );
    expect(migration).toContain(
      "'MemoryCandidate_extraction_source_check'",
    );
    expect(migration).toContain(
      "'MemoryCandidate_extraction_active_check'",
    );
    expect(migration).toContain(
      'NEW."sourceKind" <> \'AUDIENCE_MESSAGE\'::"MemorySourceKind"',
    );
    expect(migration).toContain(
      "'MemoryCandidate_extraction_source_kind_check'",
    );
  });

  it("invalidates unfinished work with stable reason codes and bodyless payloads", () => {
    expect(migration).toContain("'source_message_edited'");
    expect(migration).toContain("'source_message_redacted'");
    expect(migration).toContain("'source_message_ineligible'");
    expect(migration).toContain(
      'extraction_run."status" IN (\'QUEUED\', \'RUNNING\')',
    );
    expect(migration).toContain(
      "THEN 'EXPIRED'::\"MemoryCandidateStatus\"",
    );
    expect(migration).toContain(
      "THEN 'BLOCKED'::\"MemoryCandidateStatus\"",
    );
    expect(migration).toContain(
      'candidate."status" <> \'APPROVED\'::"MemoryCandidateStatus"',
    );
    expect(migration).toContain('"safeText" = NULL');
    expect(migration).toContain('"summary" = NULL');
    expect(migration).toContain(
      'NEW."contentHash" IS NOT DISTINCT FROM OLD."contentHash"',
    );
    expect(migration).toContain(
      '"contentPurgedAt" = COALESCE(candidate."contentPurgedAt", CURRENT_TIMESTAMP)',
    );
  });

  it("keeps quarantined markers in quarantine and never adds a hidden transition", () => {
    expect(migration).not.toMatch(
      /OLD\."status"\s*=\s*'QUARANTINED'[\s\S]{0,100}NEW\."status"\s+IN/u,
    );
    expect(migration).not.toMatch(
      /candidate\."status"\s+IN\s*\('EXTRACTED',\s*'QUARANTINED'\)[\s\S]{0,80}'BLOCKED'/u,
    );
  });

  it("requires bodyless blocked/quarantined markers and review-only approval", () => {
    expect(migration).toContain(
      "'MemoryCandidate_marker_bodyless_check'",
    );
    expect(migration).toContain(
      "'MemoryCandidate_direct_approval_check'",
    );
    expect(migration).toContain(
      'NEW."status" = \'APPROVED\'::"MemoryCandidateStatus"',
    );
    expect(migration).toContain(
      'AND candidate."status" <> \'APPROVED\'::"MemoryCandidateStatus"',
    );
  });

  it("installs idempotent triggers while serializing the one-time backfill", () => {
    expect(migration).toContain(
      'LOCK TABLE "Message", "MemoryExtractionRun", "MemoryCandidate"',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "memory_candidate_source_guard"()',
    );
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION "memory_candidate_guard"()',
    );
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS "Message_memory_mark_edit" ON "Message"',
    );
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS "Message_memory_source_invalidation" ON "Message"',
    );
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS "MemoryCandidate_source_guard" ON "MemoryCandidate"',
    );
  });

  it("expires versioned pending candidates and recall-blocks them for durable cleanup", () => {
    expect(migration).toContain(
      'FROM "GovernedMemoryVersion" version_record',
    );
    expect(migration).toContain(
      '"status" = \'DELETE_PENDING\'::"GovernedMemoryStatus"',
    );
    expect(migration).toContain(
      '"recallDisabledAt" = COALESCE(memory_record."recallDisabledAt", CURRENT_TIMESTAMP)',
    );
    expect(migration).toContain(
      '"deleteRequestedAt" = COALESCE(memory_record."deleteRequestedAt", CURRENT_TIMESTAMP)',
    );
  });

  it("suppresses only an approved invalidated source that owns the current version", () => {
    expect(migration).toContain(
      'version_record."id" = memory_record."currentVersionId"',
    );
    expect(migration).toContain(
      'candidate."status" = \'APPROVED\'::"MemoryCandidateStatus"',
    );
    expect(migration).toContain(
      'THEN \'SUPPRESSED\'::"GovernedMemoryStatus"',
    );
    expect(migration).toContain(
      '"suppressedAt" = CASE',
    );
    expect(migration).toContain(
      '"recallDisabledAt" = COALESCE(',
    );
    expect(migration).not.toMatch(
      /version_record\."sourceCandidateId"[\s\S]{0,160}memory_record\."currentVersionId"\s+IS\s+NULL/u,
    );
  });
});
