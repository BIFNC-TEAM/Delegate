import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");

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
