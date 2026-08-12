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
  it("keeps only account, language, and logout actions in the top-right menu", () => {
    expect(pageSource).toContain('className="representative-account-menu"');
    expect(pageSource).toContain("t.logoutLabel");
    expect(pageSource).toContain('className="representative-account-language"');
    expect(globalStyles).toContain(".representative-account-popover");
    expect(globalStyles).toContain(".representative-account-avatar");
    expect(pageSource).not.toContain("t.accountCommerceLabel");
    expect(pageSource).not.toContain("t.accountBindingsLabel");
    expect(pageSource).not.toContain("representative.languages.map");
    expect(pageSource).not.toContain("t.homeLabel");
    expect(pageSource).not.toContain("RepresentativeProfileRailLink");
    expect(pageSource).toContain('className="representative-account-menu representative-guest-menu"');
  });

  it("uses one compact session panel instead of stacked operational cards", () => {
    expect(chatSource).toContain(
      'className="representative-session-panel representative-session-details"',
    );
    expect(chatSource).toContain('className="representative-session-panel-body"');
    expect(chatSource).not.toContain("representative-session-state");
    expect(chatSource).not.toContain("representative-chat-memory-note");
    expect(chatSource).toContain('className="representative-chat-trust-note"');
  });

  it("surfaces a contextual service-package action when continuation requires credits", () => {
    expect(chatSource).toContain("servicePurchaseRequired");
    expect(chatSource).toContain('className="representative-chat-continuation"');
    expect(chatSource).toContain('openProfileSection("services"');
    expect(chatSource).toContain("REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT");
    expect(chatSource).toContain("t.serviceGateTitle");
    expect(chatSource).toContain("t.lastFreeReplyDetail");
  });

  it("moves the detailed memory policy into the right-rail privacy workspace", () => {
    expect(pageSource).toContain("memoryDisclosure={governedContextDisclosure}");
    expect(pageSource).toContain("trustItems={t.trustItems(runtime.governedContextEnabled)}");
    expect(pageSource).not.toContain('className="representative-trust-disclosure"');
  });
});
