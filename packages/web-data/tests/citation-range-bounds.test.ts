import { describe, expect, it } from "vitest";
import { assertCitationRangeBounds, citationBodyHash } from "../src/citation-persistence";

describe("citation storage bounds", () => {
  it("accepts sorted nonoverlapping UTF-16 ranges and exact body hashes", () => {
    expect(() => assertCitationRangeBounds("甲😀乙", [{ start: 0, end: 1, sourceIds: ["1"] }, { start: 1, end: 4, sourceIds: ["1", "2"] }])).not.toThrow();
    expect(citationBodyHash("甲😀乙")).not.toBe(citationBodyHash("甲😀丙"));
  });
  it.each([
    { start: -1, end: 2, sourceIds: ["1"] },
    { start: 1, end: 1, sourceIds: ["1"] },
    { start: 0, end: 99, sourceIds: ["1"] },
    { start: 0, end: 2, sourceIds: ["1"] },
    { start: 2, end: 3, sourceIds: ["1"] },
    { start: 0, end: 1, sourceIds: [] },
    { start: 0, end: 1, sourceIds: ["1", "1"] },
    { start: 0, end: 1, sourceIds: ["0"] },
    { start: 0.5, end: 1, sourceIds: ["1"] },
  ])("rejects invalid persisted range %j", range => {
    expect(() => assertCitationRangeBounds("甲😀乙", [range])).toThrow();
  });
  it("rejects unsorted/overlapping ranges and noncanonical CRLF text", () => {
    expect(() => assertCitationRangeBounds("abc", [{ start: 0, end: 2, sourceIds: ["1"] }, { start: 1, end: 3, sourceIds: ["1"] }])).toThrow();
    expect(() => assertCitationRangeBounds("a\r\nb", [])).toThrow();
  });
});
