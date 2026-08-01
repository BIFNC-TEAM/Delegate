import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");
const revisionMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260731133000_creator_training_revision_order/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const suggestionOriginMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260731135000_creator_training_suggestion_origins/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const suggestionOriginRevisionMigration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260731135500_creator_training_suggestion_origin_revisions/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("creator training schema", () => {
  it("models the creator training source, feedback, suggestion, and version loop", () => {
    for (const model of [
      "CreatorTrainingSource",
      "CreatorFeedbackSignal",
      "CreatorTrainingSuggestion",
      "CreatorTrainingVersion",
    ]) {
      expect(modelBlock(model)).toBeTruthy();
    }
  });

  it("keeps training inputs tied to a representative and reviewable before publish", () => {
    expect(modelBlock("CreatorTrainingSource")).toContain("representativeId");
    expect(modelBlock("CreatorFeedbackSignal")).toContain("representativeId");
    expect(modelBlock("CreatorTrainingSuggestion")).toContain("status");
    expect(modelBlock("CreatorTrainingSuggestion")).toContain("reviewedAt");
    expect(modelBlock("CreatorTrainingVersion")).toContain("snapshotBefore");
    expect(modelBlock("CreatorTrainingVersion")).toContain("snapshotAfter");
  });

  it("orders representative revisions monotonically and audits rollback actors", () => {
    const version = modelBlock("CreatorTrainingVersion");

    expect(version).toContain("revisionNumber");
    expect(version).toContain("@@unique([representativeId, revisionNumber])");
    expect(version).toContain("rolledBackBy");
  });

  it("documents historical revision ordering as a deterministic approximation", () => {
    expect(revisionMigration).toContain(
      "WHEN is_current_match AND current_match_count = 1",
    );
    expect(revisionMigration).toContain(
      "version.\"snapshotAfter\" = jsonb_build_object(",
    );
    expect(revisionMigration).toContain(
      '"id" ASC,\n        "publishedAt" ASC,\n        "createdAt" ASC',
    );
    expect(revisionMigration).toContain(
      "must not be interpreted as an exact historical commit log",
    );
  });

  it("allows only one pending immutable successor per suggestion origin", () => {
    const suggestion = modelBlock("CreatorTrainingSuggestion");

    expect(suggestion).toContain("originKey");
    expect(schema).toMatch(
      /enum CreatorTrainingSuggestionStatus \{[\s\S]*?\bSUPERSEDED\b[\s\S]*?\}/u,
    );
    expect(suggestionOriginMigration).toContain(
      '"status" = \'SUPERSEDED\'',
    );
    expect(suggestionOriginMigration).toContain(
      'WHERE "status" = \'PENDING\'',
    );
    expect(suggestionOriginMigration).toContain(
      '"CreatorTrainingSuggestion_one_pending_origin_key"',
    );
    expect(suggestion).toContain("originRevision");
    expect(suggestion).toContain(
      "@@unique([representativeId, originKey, originRevision])",
    );
    expect(suggestion).not.toContain("@@unique([representativeId, dedupeKey])");
    expect(suggestionOriginRevisionMigration).toContain(
      'PARTITION BY "representativeId", "originKey"',
    );
    expect(suggestionOriginRevisionMigration).toContain(
      'DROP INDEX "CreatorTrainingSuggestion_representativeId_dedupeKey_key"',
    );
  });

  it("gives KnowledgePack writes a monotonic optimistic-concurrency token", () => {
    expect(modelBlock("KnowledgePack")).toContain(
      "revision         Int            @default(0)",
    );
  });

  it("does not store raw conversation text as the source of truth for feedback", () => {
    const block = modelBlock("CreatorFeedbackSignal");

    expect(block).toContain("turnId");
    expect(block).not.toMatch(/\bmessageText\b/);
    expect(block).not.toMatch(/\brawTranscript\b/);
  });
});

function modelBlock(modelName: string) {
  const match = schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));
  return match?.[0] ?? "";
}
