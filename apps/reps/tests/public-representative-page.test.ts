import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/page.tsx"),
  "utf8",
);
const chatSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-chat-panel.tsx"),
  "utf8",
);

describe("public representative visitor-first page", () => {
  it("places the conversation before supporting information", () => {
    expect(pageSource.indexOf("<RepresentativeChatPanel")).toBeGreaterThan(-1);
    expect(pageSource.indexOf('id="about"')).toBeGreaterThan(
      pageSource.indexOf("<RepresentativeChatPanel"),
    );
  });

  it("does not render owner-facing runtime metrics or skill-pack sections", () => {
    expect(pageSource).not.toContain("DashboardSignalStrip");
    expect(pageSource).not.toContain('id="skills"');
    expect(pageSource).not.toContain('id="plans"');
    expect(pageSource).not.toContain("representative.skillPacks");
  });

  it("keeps pricing contextual and long citations collapsed", () => {
    expect(chatSource).toContain("showPlans");
    expect(chatSource).toContain("usage.freeRepliesRemaining > 0");
    expect(chatSource).toContain("<details key=");
    expect(chatSource).toContain("representative-chat-starters");
  });
});
