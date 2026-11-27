import { describe, expect, it } from "vitest";
import { prepareServiceRequestChange } from "../src/service-request-followups";
const pending = { items: [
  { id: "a", question: "需要多少件？", originalSummary: "商品a八折" },
  { id: "b", question: "需要多少件？", originalSummary: "商品b八折" },
], hasMore: false };
const answer = { operation: "successor", mode: "answer", id: "a", item: {}, reply: { text: "10件" } };
describe("follow-up target evidence", () => {
  it("rejects bare values, invented current quotes and shared question text before dispatch", async () => {
    for (const targetQuote of [undefined, "10件", "商品a", "多少件"]) {
      await expect(prepareServiceRequestChange({ ...answer, targetQuote }, pending, "10件")).rejects.toThrow();
    }
    await expect(prepareServiceRequestChange({ ...answer, targetQuote: "多少件" }, pending, "我在回答多少件的问题，10件")).rejects.toThrow();
  });
  it("accepts an explicit unique current subject and strips host-only evidence", async () => {
    expect(await prepareServiceRequestChange({ ...answer, targetQuote: "商品 a" }, pending, "商品 A 要10件")).toEqual(answer);
    await expect(prepareServiceRequestChange({ ...answer, id: "b", targetQuote: "商品 a" }, pending, "商品a要10件")).rejects.toThrow();
  });
  it("does not assume omitted candidates are unrelated", async () => {
    await expect(prepareServiceRequestChange({ ...answer, targetQuote: "商品a" }, { ...pending, hasMore: true }, "商品a要10件")).rejects.toThrow();
    expect(await prepareServiceRequestChange({ ...answer, targetQuote: "商品a" }, { ...pending, hasMore: true }, "商品a要10件", async () => "a")).toEqual(answer);
  });
  it("allows a bare answer for a single current question and leaves unrelated operations alone", async () => {
    expect(await prepareServiceRequestChange(answer, { items: [pending.items[0]!], hasMore: false }, "10件")).toEqual(answer);
    expect(await prepareServiceRequestChange({ operation: "resolve", id: "a", action: "withdraw" }, pending, "撤回")).toMatchObject({ operation: "resolve" });
  });
});
