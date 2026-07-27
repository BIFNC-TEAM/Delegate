import { describe, expect, it } from "vitest";

import { normalizeIanaTimeZone } from "../src/conversation-platform";

describe("conversation inbox time zone", () => {
  it("preserves valid IANA time zones", () => {
    expect(normalizeIanaTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(normalizeIanaTimeZone(" America/New_York ")).toBe("America/New_York");
  });

  it("falls back to UTC for missing or invalid values", () => {
    expect(normalizeIanaTimeZone(null)).toBe("UTC");
    expect(normalizeIanaTimeZone("")).toBe("UTC");
    expect(normalizeIanaTimeZone("Not/A-Time-Zone")).toBe("UTC");
  });
});
