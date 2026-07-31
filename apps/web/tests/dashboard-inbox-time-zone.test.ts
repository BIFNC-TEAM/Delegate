import { afterEach, describe, expect, it } from "vitest";

import {
  formatMessageTime,
  formatRelativeTime,
  formatVersionDateTime,
} from "../app/dashboard/dashboard-time";

const timestamp = "2026-07-22T10:12:57.314Z";
const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimeZone;
  }
});

describe("dashboard inbox time formatting", () => {
  it("renders the owner time zone identically across server and browser host zones", () => {
    process.env.TZ = "UTC";
    const serverMarkupTimes = [
      formatRelativeTime(timestamp, "zh", "Asia/Shanghai"),
      formatMessageTime(timestamp, "zh", "Asia/Shanghai"),
      formatVersionDateTime(timestamp, "zh", "Asia/Shanghai"),
    ];

    process.env.TZ = "America/Los_Angeles";
    const browserMarkupTimes = [
      formatRelativeTime(timestamp, "zh", "Asia/Shanghai"),
      formatMessageTime(timestamp, "zh", "Asia/Shanghai"),
      formatVersionDateTime(timestamp, "zh", "Asia/Shanghai"),
    ];

    expect(browserMarkupTimes).toEqual(serverMarkupTimes);
    expect(serverMarkupTimes).toEqual([
      "18:12",
      "7月22日 18:12",
      "2026年7月22日 18:12",
    ]);
  });

  it("falls back to UTC instead of throwing for an invalid time zone", () => {
    expect(formatRelativeTime(timestamp, "en", "Not/A-Time-Zone")).toBe(
      formatRelativeTime(timestamp, "en", "UTC"),
    );
    expect(formatMessageTime(timestamp, "en", "Not/A-Time-Zone")).toBe(
      formatMessageTime(timestamp, "en", "UTC"),
    );
    expect(formatVersionDateTime(timestamp, "en", "Not/A-Time-Zone")).toBe(
      formatVersionDateTime(timestamp, "en", "UTC"),
    );
  });
});
