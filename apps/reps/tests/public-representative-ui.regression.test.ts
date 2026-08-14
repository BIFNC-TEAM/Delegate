import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/page.tsx"),
  "utf8",
);
const accountMenuSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-account-menu.tsx"),
  "utf8",
);
const accountSettingsPageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/settings/page.tsx"),
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
  it("routes account settings to an extensible second-level page", () => {
    expect(pageSource).toContain("<RepresentativeAccountMenu");
    expect(accountMenuSource).toContain('className={`representative-account-menu');
    expect(accountMenuSource).toContain("logoutLabel");
    expect(accountMenuSource).toContain('className="representative-account-settings-trigger"');
    expect(accountMenuSource).toContain("href={settingsHref}");
    expect(accountMenuSource).not.toContain("<LanguageSwitcher");
    expect(accountSettingsPageSource).toContain("<LanguageSwitcher");
    expect(accountSettingsPageSource).toContain('id="profile"');
    expect(accountSettingsPageSource).toContain('id="language"');
    expect(accountSettingsPageSource).toContain("t.editProfile");
    expect(accountSettingsPageSource).toContain("t.comingSoon");
    expect(globalStyles).toContain(".representative-account-popover");
    expect(globalStyles).toContain(".representative-account-avatar");
    expect(globalStyles).toContain(".representative-settings-layout");
    expect(pageSource).not.toContain("t.accountCommerceLabel");
    expect(pageSource).not.toContain("t.accountBindingsLabel");
    expect(pageSource).not.toContain("representative.languages.map");
    expect(pageSource).not.toContain("t.homeLabel");
    expect(pageSource).not.toContain("RepresentativeProfileRailLink");
    expect(accountMenuSource).toContain('" representative-guest-menu"');
  });

  it("uses one compact session panel instead of stacked operational cards", () => {
    expect(chatSource).toContain(
      'className="representative-session-panel representative-session-details"',
    );
    expect(chatSource).toContain('className="representative-session-panel-body"');
    expect(chatSource).not.toContain("representative-session-state");
    expect(chatSource).not.toContain("representative-chat-memory-note");
    expect(chatSource).not.toContain('className="representative-chat-trust-note"');
    expect(chatSource).not.toContain("你正在与数字代表对话；需要真人判断时会明确提示。");
    expect(chatSource).not.toContain("t.aiActiveDetail");
    expect(chatSource).toContain("{sessionSummary}");
  });

  it("keeps the conversation header status and profile control icon-only where requested", () => {
    expect(chatSource).toContain('className={`representative-conversation-status is-${responder.kind}`}');
    expect(chatSource).not.toContain("representative-conversation-status-avatar");
    expect(chatSource).not.toContain("t.currentResponder");
    expect(chatSource).not.toContain("humanStatusAvatar");
    expect(chatSource).toContain("aria-label={profileRailOpen ? t.hideProfilePanel : t.showProfilePanel}");
    expect(chatSource).toContain("<ProfilePanelIcon />");
    expect(chatSource).not.toContain("<span>{profileRailOpen ? t.hideProfilePanel : t.showProfilePanel}</span>");
    expect(globalStyles).not.toContain(".representative-conversation-status-avatar");
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

  it("offers voluntary support as a separate right-rail action", () => {
    expect(pageSource).toContain("commercePresentation.tipsEnabled");
    expect(pageSource).toContain('product.kind === "TIP"');
    expect(pageSource).toContain("tipManagement={hasPublicTips ? (");
    expect(globalStyles).toContain(".representative-tip-entry");
  });
});
