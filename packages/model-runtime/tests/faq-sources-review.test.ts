import { expect, it } from "vitest";
import { prepareFaqSources } from "../src/faq/sources";
it.each([0, -1, 2.5, NaN, Infinity])("rejects invalid budget %s", limit => {
  expect(() => prepareFaqSources([], limit)).toThrow(RangeError);
});
it("bounds large Unicode bodies and preserves all five explicit budgets", () => {
  const result = prepareFaqSources(Array.from({length: 5}, (_, i) => ({id: String(i), title: "x", text: "😀".repeat(1000000)})), 2000);
  expect(result.used).toHaveLength(5);
  expect(result.used.every(s => Array.from(s.text).length === 2000)).toBe(true);
  expect(result.base.sources.every(s => s.status === "partial")).toBe(true);
});
