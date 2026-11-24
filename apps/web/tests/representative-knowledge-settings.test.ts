import { describe, it, expect } from "vitest";
import {
  defaultKnowledgeSettings,
  knowledgeSettingsSchema,
  normalizeFaqQuestion,
} from "@delegate/domain/representative-knowledge-settings";
describe("knowledge workbench settings", () => {
  it("defaults downloads off and preserves the five service scenarios", () => {
    const value = defaultKnowledgeSettings(["asset-a"]);
    expect(knowledgeSettingsSchema.parse(value).files).toEqual([
      { id: "asset-a", allowDownload: false },
    ]);
    expect(value.boundaries.filter((b) => b.action === "approve")).toHaveLength(
      3,
    );
    expect(value.boundaries.filter((b) => b.action === "handoff")).toHaveLength(
      2,
    );
  });
  it("rejects duplicate bindings, missing presets, empty custom requests and more than three featured questions", () => {
    const base = defaultKnowledgeSettings();
    for (const patch of [
      {
        files: [
          { id: "a", allowDownload: false },
          { id: "a", allowDownload: true },
        ],
      },
      { boundaries: base.boundaries.slice(1) },
      {
        boundaries: [
          ...base.boundaries,
          { id: "custom", request: "", action: "approve" },
        ],
      },
      { featuredFaqIds: ["a", "b", "c", "d"] },
      { featuredFaqIds: ["a", "a"] },
    ])
      expect(
        knowledgeSettingsSchema.safeParse({ ...base, ...patch }).success,
      ).toBe(false);
  });
  it("only treats exact questions after trimming input padding as duplicates", () => {
    expect(normalizeFaqQuestion("如何预约？")).toBe(normalizeFaqQuestion(" 如何预约？ "));
    for (const [left, right] of [["如何预约？", "如何预约?"], ["ＡＢＣ", "ABC"], ["ABC", "abc"], ["A B", "AB"], ["如何退款？", "怎么申请退款？"]]) {
      expect(normalizeFaqQuestion(left!)).not.toBe(normalizeFaqQuestion(right!));
    }
    expect(normalizeFaqQuestion("C++是什么？")).not.toBe(normalizeFaqQuestion("C#是什么？"));
  });
});
