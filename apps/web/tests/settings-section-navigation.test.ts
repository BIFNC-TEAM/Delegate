import { describe, expect, it } from "vitest";

import {
  buildSettingsSectionHref,
  parseSettingsSection,
} from "../app/dashboard/settings-section-navigation";

describe("settings section navigation", () => {
  it("falls back to profile for absent or invalid sections", () => {
    expect(parseSettingsSection(undefined)).toBe("profile");
    expect(parseSettingsSection("developer")).toBe("profile");
    expect(parseSettingsSection("security")).toBe("security");
  });

  it("preserves owner dashboard context while clearing unrelated module state", () => {
    const href = buildSettingsSectionHref({
      currentSearch:
        "view=representatives&rep=lin&lang=zh&conversation=secret&repSection=setup&setupSection=knowledge",
      locale: "en",
      pathname: "/dashboard",
      section: "notifications",
    });

    expect(href).toBe(
      "/dashboard?view=settings&rep=lin&lang=en&settingsSection=notifications",
    );
    expect(href).not.toContain("conversation");
    expect(href).not.toContain("repSection");
    expect(href).not.toContain("setupSection");
  });
});
