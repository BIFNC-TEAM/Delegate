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
    expect(profileStyles).toMatch(/\.representative-profile-page \.representative-profile-rail \{[\s\S]*?gap:\s*0;/);
  });

  it("covers explicit authorship, system messages, and the structured composer", () => {
    expect(profileStyles).toContain(".representative-message-avatar.is-ai");
    expect(profileStyles).toContain(".representative-message-avatar.is-operator");
    expect(profileStyles).toContain(".representative-message-avatar.is-visitor");
    expect(profileStyles).toContain(".representative-system-message.is-task-update");
    expect(profileStyles).toContain(".representative-message-copy.is-copied");
    expect(profileStyles).toContain(".representative-message-copy.is-failed");
    expect(profileStyles).toContain("@media (hover: hover) and (pointer: fine)");
    expect(profileStyles).toContain(".representative-chat-message:hover .representative-message-time");
    expect(profileStyles).toContain(".representative-chat-message:hover .representative-message-copy");
    expect(profileStyles).toContain(".representative-chat-composer-body:focus-within");
  });

  it("keeps controls touchable and motion optional across responsive disclosure modes", () => {
    expect(profileStyles).toMatch(/\.representative-profile-rail-toggle[\s\S]*?min-height:\s*44px/);
    expect(profileStyles).toMatch(/\.representative-message-copy[\s\S]*?min-height:\s*44px/);
    expect(profileStyles).toContain("@media (max-width: 1180px)");
    expect(profileStyles).toContain("@media (max-width: 640px)");
    expect(profileStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toMatch(/\.representative-shell\.representative-profile-page \{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[\s\S]*?height:\s*100svh;[\s\S]*?overflow:\s*hidden;/);
    expect(styles).toMatch(/\.representative-shell\.representative-profile-page \.representative-chat-first-grid \{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;/);
    expect(styles).toMatch(/@media \(min-width: 1181px\)[\s\S]*?\.representative-shell\.representative-profile-page \.representative-profile-workspace \{[\s\S]*?width:\s*min\(1280px, calc\(100vw - 32px\)\);[\s\S]*?height:\s*100%;/);
    expect(styles).toMatch(/@media \(min-width: 1181px\)[\s\S]*?> \.representative-visitor-footer \{[\s\S]*?width:\s*min\(1280px, calc\(100vw - 32px\)\);[\s\S]*?margin:\s*10px auto 0;/);
    expect(styles).toMatch(/\.representative-shell\.representative-profile-page \.representative-chat-surface,[\s\S]*?\.representative-shell\.representative-profile-page \.representative-profile-rail \{[\s\S]*?height:\s*100%;[\s\S]*?max-height:\s*none;/);
    expect(styles).toContain("align-items: stretch");
    expect(styles).toContain("overflow-y: auto");
    expect(styles).toMatch(/@media \(max-width: 1180px\)[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[\s\S]*?height:\s*100dvh;/);
    expect(styles).toMatch(/@media \(max-width: 1180px\)[\s\S]*?\.representative-chat-surface \{[\s\S]*?height:\s*100%;[\s\S]*?overflow:\s*hidden;/);
    expect(styles).toContain(".representative-account-language");
    expect(styles).toMatch(/\.representative-shell\.representative-profile-page \.representative-chat-message-user \{[\s\S]*?display: inline-flex;[\s\S]*?width: fit-content;/);
    expect(styles).toMatch(/\.representative-chat-message-user \.representative-message-content \{[\s\S]*?width: fit-content;/);
    expect(styles).toMatch(/\.representative-chat-message-user \.representative-message-bubble \{[\s\S]*?width: fit-content;[\s\S]*?max-width: 100%;[\s\S]*?justify-self: end;/);
    expect(styles).toContain("top: 56px");
    expect(profileStyles).not.toContain("transition: all");
  });
});
