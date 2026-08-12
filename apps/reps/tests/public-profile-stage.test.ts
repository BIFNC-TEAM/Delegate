import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/page.tsx"),
  "utf8",
);

describe("public representative conversation entry", () => {
  it("moves directly from the utility bar into the conversation workspace", () => {
    const topbarIndex = pageSource.indexOf('className="marketing-topbar representative-topbar"');
    const workspaceIndex = pageSource.indexOf('className="representative-profile-workspace"');
    const chatIndex = pageSource.indexOf("<RepresentativeChatPanel");

    expect(topbarIndex).toBeGreaterThan(-1);
    expect(pageSource).not.toContain('className="representative-profile-stage"');
    expect(workspaceIndex).toBeGreaterThan(topbarIndex);
    expect(chatIndex).toBeGreaterThan(workspaceIndex);
    expect(pageSource).not.toContain('className="representative-visitor-start"');
  });

  it("does not duplicate profile navigation in the utility bar", () => {
    expect(pageSource).not.toContain("representative-menu-tabs");
    expect(pageSource).not.toContain("const menu = [");
    expect(pageSource).not.toContain("<RepresentativeProfileRailLink");
    expect(pageSource).not.toContain("representative-profile-info-link");
  });
});
