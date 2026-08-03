import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260803161000_memory_authority_foundation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const provenanceIndexMigrations = [
  "20260803160000_memory_contact_provenance_index",
  "20260803160010_memory_conversation_provenance_index",
  "20260803160020_memory_message_provenance_index",
  "20260803160030_memory_generation_run_provenance_index",
  "20260803160040_memory_representative_version_provenance_index",
  "20260803160050_memory_knowledge_binding_provenance_index",
].map((directory) => readFileSync(
  new URL(`../../../prisma/migrations/${directory}/migration.sql`, import.meta.url),
  "utf8",
));

describe("Memory System authoritative schema", () => {
  it("adds every authoritative business, projection, usage, deletion, and reconciliation model", () => {
    for (const model of [
      "MemoryCandidate",
      "GovernedMemory",
      "GovernedMemoryVersion",
      "MemoryReviewDecision",
      "RepresentativeMemoryPolicy",
      "MemoryExtractionRun",
      "MemoryProjectionItem",
      "MemoryUseRun",
      "MemoryUseItem",
      "MemoryDeletionProof",
      "MemoryReconciliationRun",
      "MemoryReconciliationItem",
    ]) {
      expect(modelBlock(model), model).toBeTruthy();
      expect(migration, model).toContain(`CREATE TABLE "${model}"`);
    }
  });

  it("keeps candidate, business, and projection states separate", () => {
    expect(enumBlock("MemoryCandidateStatus")).toMatch(
      /EXTRACTED[\s\S]*QUARANTINED[\s\S]*BLOCKED[\s\S]*PENDING_REVIEW[\s\S]*APPROVED[\s\S]*REJECTED[\s\S]*EXPIRED/u,
    );
    expect(enumBlock("GovernedMemoryStatus")).toMatch(
      /ACTIVE[\s\S]*SUPPRESSED[\s\S]*SUPERSEDED[\s\S]*EXPIRED[\s\S]*ARCHIVED[\s\S]*DELETE_PENDING[\s\S]*DELETED/u,
    );
    expect(enumBlock("GovernedMemoryStatus")).not.toContain("DELETE_FAILED");
    expect(enumBlock("MemoryCandidateStatus")).not.toContain("DELETE_FAILED");
    expect(enumBlock("MemoryProjectionStatus")).toContain("DELETE_FAILED");
    expect(enumBlock("MemoryProjectionStatus")).toContain("STAGED");
  });

  it("stores only sanitized candidate content plus fully scoped message provenance", () => {
    const candidate = modelBlock("MemoryCandidate");

    expect(candidate).toContain("safeText");
    expect(candidate).toContain("summary");
    expect(candidate).toContain("sourceContactId");
    expect(candidate).toContain("sourceConversationId");
    expect(candidate).toContain("sourceMessageId");
    expect(candidate).toContain("category             MemoryCategory");
    expect(candidate).toContain("sourceKind           MemorySourceKind");
    expect(candidate).toContain(
      "@relation(fields: [sourceConversationId, representativeId, sourceContactId], references: [id, representativeId, contactId], onDelete: Restrict, map: \"MemoryCandidate_conversation_scope_fkey\")",
    );
    expect(candidate).toContain(
      "@relation(fields: [sourceMessageId, sourceConversationId], references: [id, conversationId], onDelete: Restrict, map: \"MemoryCandidate_message_scope_fkey\")",
    );
    expect(candidate).not.toMatch(
      /\b(rawText|rawTranscript|queryText|prompt|credential|paymentAmount|balance|ownerNote|toolOutput|computeOutput)\b/u,
    );
    expect(migration).toContain('CONSTRAINT "MemoryCandidate_scope_check"');
    expect(migration).toContain('"contactId" = "sourceContactId"');
    expect(migration).toContain('"scopeChannel" = "originChannel"');
    expect(migration).toContain("'MemoryCandidate_origin_channel_check'");
  });

  it("makes all policy and channel capabilities fail closed by default", () => {
    const policy = modelBlock("RepresentativeMemoryPolicy");

    for (const field of [
      "longTermMemoryEnabled",
      "contactMemoryEnabled",
      "representativeExperienceEnabled",
      "autoExtract",
      "webRecallEnabled",
      "webExtractEnabled",
      "matrixRecallEnabled",
      "matrixExtractEnabled",
      "telegramRecallEnabled",
      "telegramExtractEnabled",
    ]) {
      expect(policy, field).toMatch(
        new RegExp(`${field}\\s+Boolean\\s+@default\\(false\\)`),
      );
    }
    expect(migration).toContain('CONSTRAINT "MemoryPolicy_safe_enablement_check"');
    expect(migration).toContain('"retentionDays" BETWEEN 1 AND 3650');
  });

  it("locks immutable versions to the candidate and governed scope", () => {
    const version = modelBlock("GovernedMemoryVersion");

    expect(version).toContain("scope                  MemoryScope");
    expect(version).toContain("deidentifiedAt");
    expect(version).toContain("deidentificationMethod");
    expect(version).toContain("purgedAt");
    expect(version).not.toContain("@@unique([memoryId, contentHash])");
    expect(version).toContain(
      '@@index([memoryId, contentHash], map: "GovernedMemoryVersion_memory_hash_idx")',
    );
    expect(migration).toContain('CONSTRAINT "GovernedMemoryVersion_deidentification_check"');
    expect(migration).toContain('CONSTRAINT = \'GovernedMemoryVersion_contact_scope_binding_check\'');
    expect(migration).toContain('CONSTRAINT = \'GovernedMemory_locked_coordinates_check\'');
    expect(migration).toContain('CONSTRAINT = \'GovernedMemoryVersion_immutable_check\'');
  });

  it("requires a terminal independent review and prevents approving candidate A as version B", () => {
    expect(migration).toContain('CONSTRAINT "MemoryReviewDecision_system_approval_check"');
    expect(migration).toContain('"MemoryReviewDecision_one_terminal_candidate_key"');
    expect(migration).toContain('CONSTRAINT = \'MemoryReviewDecision_candidate_result_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryReviewDecision_independent_review_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryReviewDecision_append_only_check\'');
    expect(migration).toContain('CONSTRAINT = \'GovernedMemory_approved_version_check\'');
  });

  it("binds extraction and use runs to representative, contact, conversation, message, channel, and published version", () => {
    const extraction = modelBlock("MemoryExtractionRun");
    const useRun = modelBlock("MemoryUseRun");

    expect(extraction).toContain("sourceConversationId");
    expect(extraction).toContain(
      "@relation(fields: [sourceMessageId, sourceConversationId], references: [id, conversationId], onDelete: Restrict, map: \"MemoryExtractionRun_message_scope_fkey\")",
    );
    expect(useRun).toContain("representativeVersionId");
    expect(useRun).toContain(
      "@relation(fields: [generationRunId, conversationId], references: [id, conversationId], onDelete: Restrict, map: \"MemoryUseRun_generation_fkey\")",
    );
    expect(migration).toContain("'MemoryExtractionRun_source_channel_check'");
    expect(migration).toContain("'MemoryUseRun_source_channel_check'");
    expect(migration).toContain('CONSTRAINT = \'MemoryUseRun_pinned_version_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseRun_active_version_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseRun_generation_version_check\'');
  });

  it("records searched, scope-checked, safety-checked, injected, and displayed as distinct stages", () => {
    const item = modelBlock("MemoryUseItem");

    for (const field of [
      "searchedAt",
      "scopeCheckedAt",
      "scopePassedAt",
      "safetyCheckedAt",
      "safetyPassedAt",
      "injectedAt",
      "displayedAt",
    ]) {
      expect(item, field).toContain(field);
    }
    expect(item).toContain("representativeId");
    expect(item).toContain("memoryScope");
    expect(item).toContain("knowledgeBindingId");
    expect(item).toContain("representativeVersionId");
    expect(item).not.toContain("knowledgeAssetId");
    expect(migration).toContain('CONSTRAINT "MemoryUseItem_stage_chain_check"');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseItem_contact_scope_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseItem_rep_experience_scope_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseItem_injection_allowlist_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseItem_published_knowledge_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseItem_content_hash_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseItem_knowledge_snapshot_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryUseItem_displayed_source_check\'');
  });

  it("keeps projection failure separate and allows only one active projection pointer", () => {
    const projection = modelBlock("MemoryProjectionItem");

    expect(projection).toContain("status              MemoryProjectionStatus     @default(DISABLED)");
    expect(projection).toContain("lane                MemoryProjectionLane");
    expect(migration).toContain('"MemoryProjectionItem_one_active_memory_key"');
    expect(migration).toContain('WHERE "status" = \'ACTIVE\'::"MemoryProjectionStatus"');
    expect(migration).toContain('CONSTRAINT = \'MemoryProjectionItem_locked_coordinates_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryProjectionItem_staged_lane_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryProjectionItem_tombstone_required_check\'');
  });

  it("supports irreversible body-free deletion proof after local content purge", () => {
    const proof = modelBlock("MemoryDeletionProof");

    expect(proof).not.toMatch(/\b(safeText|summary|body|rawText|uri)\b/u);
    expect(proof).toContain("contentHash");
    expect(proof).toContain("localPurgeCompletedAt");
    expect(proof).toContain("remotePurgeCompletedAt");
    expect(migration).toContain('"recallBlockedAt" <= "createdAt"');
    expect(migration).toContain('CONSTRAINT = \'MemoryDeletionProof_content_purged_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryDeletionProof_remote_purged_check\'');
    expect(migration).toContain('CONSTRAINT = \'GovernedMemory_deleted_proof_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryDeletionProof_irreversible_check\'');
    expect(migration).toContain('CONSTRAINT = \'MemoryDeletionProof_append_only_check\'');
    expect(migration).toContain(
      'FOREIGN KEY ("representativeId") REFERENCES "Representative"("id")\n  ON DELETE RESTRICT',
    );
  });

  it("is additive and never promotes legacy records into governed memory", () => {
    expect(migration).not.toMatch(/^\s*(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE|DROP\s+)\b/mu);
    expect(migration).not.toContain('FROM "OpenVikingMemoryRecord"');
    expect(migration).not.toContain('FROM "CreatorTrainingSuggestion"');
    expect(migration).not.toContain('DEFAULT \'ACTIVE\'::"GovernedMemoryStatus"');
  });

  it("builds each hot-table provenance key in an independently recoverable concurrent migration", () => {
    expect(provenanceIndexMigrations).toHaveLength(6);
    for (const indexMigration of provenanceIndexMigrations) {
      expect(indexMigration.match(/CREATE UNIQUE INDEX CONCURRENTLY/gu)).toHaveLength(1);
      expect(indexMigration).not.toContain("IF NOT EXISTS");
      expect(indexMigration).not.toMatch(/\b(?:BEGIN|COMMIT)\b/u);
    }
    expect(migration).toMatch(/\bBEGIN;[\s\S]*COMMIT;\s*$/u);
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
