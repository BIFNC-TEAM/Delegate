import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/page.tsx"),
  "utf8",
);

describe("public representative profile stage", () => {
  it("uses a compact profile stage immediately before the conversation workspace", () => {
    const stageIndex = pageSource.indexOf('className="representative-profile-stage"');
    const workspaceIndex = pageSource.indexOf('className="representative-profile-workspace"');
    const chatIndex = pageSource.indexOf("<RepresentativeChatPanel");

    expect(stageIndex).toBeGreaterThan(-1);
    expect(pageSource).toContain('className="representative-profile-stage-backdrop"');
    expect(pageSource).toContain('className="representative-profile-intro"');
    expect(workspaceIndex).toBeGreaterThan(stageIndex);
    expect(chatIndex).toBeGreaterThan(workspaceIndex);
    expect(pageSource).not.toContain('className="representative-visitor-start"');
  });

  it("replaces section navigation with a lightweight, accessible profile action", () => {
    expect(pageSource).not.toContain("representative-menu-tabs");
    expect(pageSource).not.toContain("const menu = [");
    expect(pageSource).toContain("<RepresentativeProfileRailLink");
    expect(pageSource).toContain("ariaLabel={t.profileInfoAriaLabel}");
    expect(pageSource).toContain("label={t.profileInfoLabel}");
  });
});
