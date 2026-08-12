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
const globalStyles = readFileSync(
  resolve(__dirname, "../../../packages/web-ui/styles/globals.css"),
  "utf8",
);

describe("public representative product shell", () => {
  it("keeps secondary account, language, and session actions in the top-right account menu", () => {
    expect(pageSource).toContain('className="representative-account-menu"');
    expect(pageSource).toContain("t.accountCommerceLabel");
    expect(pageSource).toContain("t.accountBindingsLabel");
    expect(pageSource).toContain("t.logoutLabel");
    expect(pageSource).toContain('className="representative-account-language"');
    expect(globalStyles).toContain(".representative-account-popover");
    expect(globalStyles).toContain(".representative-account-avatar");
    expect(pageSource).not.toContain("representative.languages.map");
  });

  it("uses one compact session panel instead of stacked operational cards", () => {
    expect(chatSource).toContain('className="representative-session-panel"');
    expect(chatSource).not.toContain("representative-session-state");
    expect(chatSource).not.toContain("representative-chat-memory-note");
    expect(chatSource).toContain('className="representative-chat-trust-note"');
  });

  it("surfaces a contextual service-package action when continuation requires credits", () => {
    expect(chatSource).toContain("servicePurchaseRequired");
    expect(chatSource).toContain('className="representative-chat-continuation"');
    expect(chatSource).toContain('<a className="button-primary" href="#recharge">');
    expect(chatSource).toContain("t.serviceGateTitle");
    expect(chatSource).toContain("t.lastFreeReplyDetail");
  });

  it("collapses the detailed memory policy behind a visitor-friendly disclosure", () => {
    expect(pageSource).toContain('className="representative-trust-disclosure"');
    expect(pageSource).toContain("t.memoryDisclosureTitle");
    expect(pageSource).toContain("<p>{governedContextDisclosure}</p>");
  });
});
