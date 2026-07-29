import { describe, expect, it } from "vitest";

import { listSettingsTimeZones } from "../app/dashboard/settings-time-zones";

describe("listSettingsTimeZones", () => {
  it("produces one stable sorted list without trusting an invalid stored zone", () => {
    const current = "Etc/Owner_Custom";
    const values = listSettingsTimeZones(current);

    expect(values).toContain("UTC");
    expect(values).not.toContain(current);
    expect(values).toEqual([...values].sort((left, right) => left.localeCompare(right)));
    expect(new Set(values).size).toBe(values.length);
  });

  it("retains a valid stored zone even when supportedValuesOf omits it", () => {
    expect(listSettingsTimeZones("Etc/GMT+5")).toContain("Etc/GMT+5");
  });

  it("falls back to a useful curated list when supportedValuesOf is unavailable", () => {
    const intl = Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    };
    const original = intl.supportedValuesOf;
    Object.defineProperty(intl, "supportedValuesOf", {
      configurable: true,
      value: undefined,
    });

    try {
      expect(listSettingsTimeZones("Asia/Shanghai")).toEqual(
        expect.arrayContaining(["UTC", "Asia/Shanghai", "America/New_York"]),
      );
    } finally {
      Object.defineProperty(intl, "supportedValuesOf", {
        configurable: true,
        value: original,
      });
    }
  });
});
