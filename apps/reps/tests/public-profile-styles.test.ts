import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  resolve(__dirname, "../../../packages/web-ui/styles/globals.css"),
  "utf8",
);

const profileSectionStart = styles.indexOf(
  "/* Public representative Profile workspace — chat first, trust close to action. */",
);
const profileSectionEnd = styles.indexOf(
  "/* Public Profile cascade boundary: keep the chat-first treatment after shared shell rules. */",
);
const profileStyles = styles.slice(profileSectionStart, profileSectionEnd);

describe("public representative profile styling", () => {
  it("defines the dominant conversation and continuous inspector rail", () => {
    expect(profileSectionStart).toBeGreaterThan(-1);
    expect(profileStyles).not.toContain(".representative-profile-stage");
    expect(profileStyles).toContain(".representative-chat-first-grid");
    expect(profileStyles).toContain(".representative-profile-rail");
    expect(profileStyles).toContain(".representative-profile-inspector");
    expect(profileStyles).toContain(".representative-profile-rail.is-collapsed");
    expect(profileStyles).toContain(".representative-profile-rail.is-open");
  });

  it("covers explicit authorship, system messages, and the structured composer", () => {
    expect(profileStyles).toContain(".representative-message-avatar.is-ai");
    expect(profileStyles).toContain(".representative-message-avatar.is-operator");
    expect(profileStyles).toContain(".representative-message-avatar.is-visitor");
    expect(profileStyles).toContain(".representative-system-message.is-task-update");
    expect(profileStyles).toContain(".representative-message-copy.is-copied");
    expect(profileStyles).toContain(".representative-message-copy.is-failed");
    expect(profileStyles).toContain(".representative-chat-composer-body:focus-within");
  });

  it("keeps controls touchable and motion optional across responsive disclosure modes", () => {
    expect(profileStyles).toMatch(/\.representative-profile-rail-toggle[\s\S]*?min-height:\s*44px/);
    expect(profileStyles).toMatch(/\.representative-message-copy[\s\S]*?min-height:\s*44px/);
    expect(profileStyles).toContain("@media (max-width: 1180px)");
    expect(profileStyles).toContain("@media (max-width: 640px)");
    expect(profileStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("height: calc(100svh - 128px)");
    expect(styles).toContain(".representative-account-language");
    expect(styles).toContain("top: 56px");
    expect(profileStyles).not.toContain("transition: all");
  });
});
