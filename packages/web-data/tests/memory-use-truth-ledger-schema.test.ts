import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260804130000_memory_use_truth_ledger/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Memory use truth ledger schema", () => {
  it("removes legacy raw recall coordinates and public citation diagnostics", () => {
    expect(schema).not.toContain("model ConversationRecallTrace");
    expect(modelBlock("MessageCitation")).not.toMatch(/\b(uri|score)\s+/u);
    expect(migration).toContain('DROP TABLE "ConversationRecallTrace"');
    expect(migration).toContain('DROP COLUMN "uri"');
    expect(migration).toContain('DROP COLUMN "score"');
    expect(migration).toContain("memory_scrub_selected_recall_uris");
    expect(migration).toContain("entry.key <> 'selectedRecallUris'");
  });

  it("fails closed instead of inventing legacy generation or public projection provenance", () => {
    expect(migration).toContain("MemoryUseRun_generation_required_preflight");
    expect(migration).toContain("MemoryUseItem_public_projection_preflight");
    expect(migration).toContain("MemoryUseRun_terminal_reason_preflight");
    expect(migration).not.toMatch(
      /UPDATE\s+"MemoryUseRun"[\s\S]{0,300}SET\s+"generationRunId"/u,
    );
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+"PublicKnowledgeProjectionItem"/u,
    );
  });

  it("keeps checked failures observable while enforcing five monotonic truth stages", () => {
    const item = modelBlock("MemoryUseItem");
    for (const field of [
      "searchedAt",
      "scopeCheckedAt",
      "scopePassedAt",
      "safetyCheckedAt",
      "safetyPassedAt",
      "injectedAt",
      "citedAt",
      "displayedAt",
      "rejectionReasonCode",
    ]) {
      expect(item, field).toContain(field);
    }
    expect(migration).toContain('CONSTRAINT "MemoryUseItem_rejection_shape_check"');
    expect(migration).toContain("MemoryUseItem_append_only_stages_check");
    expect(migration).toContain('AND ("displayedAt" IS NULL OR "citedAt" IS NOT NULL)');
    expect(migration).toContain("MemoryUseItem_rejected_terminal_check");
  });

  it("derives mapped counts from items and stores only an aggregate unmapped count", () => {
    const run = modelBlock("MemoryUseRun");
    expect(run).toContain("unmappedCandidateCount");
    expect(run).toContain("citedCount");
    expect(run).not.toMatch(/unmapped(?:Uri|Id|Item|CandidateIds)/iu);
    expect(migration).toContain("memory_use_item_count_refresh");
    expect(migration).toContain("MemoryUseRun_item_counts_managed_check");
    expect(migration).toContain("MemoryUseRun_unmapped_monotonic_check");
    expect(migration).toContain('"displayedCount" BETWEEN 0 AND "citedCount"');
  });

  it("requires stable terminal reasons without storing raw provider errors", () => {
    const run = modelBlock("MemoryUseRun");
    expect(run).toMatch(/reasonCode\s+String\?/u);
    expect(run).not.toMatch(/(?:errorMessage|rawError|providerError)/u);
    expect(migration).toContain('CONSTRAINT "MemoryUseRun_reason_code_check"');
    expect(migration).toContain('CONSTRAINT "MemoryUseRun_terminal_reason_check"');
    expect(migration).toContain("MemoryUseRun_reason_immutable_check");
  });

  it("binds public projections to an immutable published resource manifest", () => {
    const manifest = modelBlock("RepresentativeVersionResource");
    const projection = modelBlock("PublicKnowledgeProjectionItem");
    expect(manifest).toContain("publishedVersionId");
    expect(manifest).toContain("resourceKey");
    expect(manifest).toContain("contentHash");
    expect(projection).toContain("publishedResource");
    expect(migration).toContain("PublicKnowledgeProjectionItem_resource_manifest_fkey");
    expect(migration).toContain("RepresentativeVersion_published_immutable_check");
    expect(migration).toContain("RepresentativeVersionResource_append_only_check");
    expect(migration).toContain("MemoryUseItem_public_manifest_check");
  });

  it("normalizes unsupported channel flags and structurally keeps governed memory Web-only", () => {
    expect(migration).toContain('UPDATE "RepresentativeMemoryPolicy"');
    expect(migration).toContain('CONSTRAINT "MemoryPolicy_p0_web_only_check"');
    expect(migration).toContain(
      'run_record."sourceChannel" <> \'WEB\'::"RepresentativeChannelKind"',
    );
  });

  it("lets message and generation retention remove or detach usage safely", () => {
    const run = modelBlock("MemoryUseRun");
    const item = modelBlock("MemoryUseItem");
    expect(run).toContain(
      '@relation("MemoryUseInputMessage", fields: [inputMessageId, conversationId], references: [id, conversationId], onDelete: Cascade',
    );
    expect(run).toContain(
      '@relation("MemoryUseOutputMessage", fields: [outputMessageId], references: [id], onDelete: SetNull',
    );
    expect(run).toContain(
      '@relation(fields: [generationRunId, conversationId], references: [id, conversationId], onDelete: Cascade',
    );
    expect(item).toContain("citationPurgedAt");
    expect(item).toContain(
      "@relation(fields: [citationId], references: [id], onDelete: SetNull",
    );
    expect(migration).toContain("MemoryUseRun_parent_retention_check");
    expect(migration).toContain("MemoryUseItem_citation_purge_internal_check");
  });
});

function modelBlock(modelName: string) {
  const match = schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));
  return match?.[0] ?? "";
}
