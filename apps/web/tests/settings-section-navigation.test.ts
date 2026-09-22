import { describe, expect, it } from "vitest";

import {
  buildSettingsSectionHref,
  buildAccountCenterHref,
  parseSettingsSection,
} from "../app/dashboard/settings-section-navigation";

describe("settings section navigation", () => {
  it("falls back to profile for absent or invalid sections", () => {
    expect(parseSettingsSection(undefined)).toBe("profile");
    expect(parseSettingsSection("developer")).toBe("profile");
    expect(parseSettingsSection("security")).toBe("profile");
    expect(parseSettingsSection("connections")).toBe("profile");
    expect(parseSettingsSection("notifications")).toBe("notifications");
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


describe("Account Center return navigation", () => {
  it.each(['phone','email','password','social/wechat-web','social/wechat-web/change','social/wechat-web/remove'])('returns %s operations to account information', (path) => {
    const href=buildAccountCenterHref(`https://login.example.com/account/${path}`, 'https://dashboard.example.com','zh');
    const target=new URL(href!);
    expect(target.pathname).toBe(`/account/${path}`);
    expect(target.searchParams.get('redirect')).toBe('https://dashboard.example.com/dashboard?view=settings&settingsSection=profile&lang=zh#settings-profile-heading');
    expect(target.searchParams.get('ui_locales')).toBe('zh-CN');
  });
  it('supports local development and replaces an obsolete return target',()=>{
    const url=new URL(buildAccountCenterHref('http://127.0.0.1:3301/account/phone?redirect=https://old.example','http://localhost:3001','en')!);
    expect(url.searchParams.get('redirect')).toBe('http://localhost:3001/dashboard?view=settings&settingsSection=profile&lang=en#settings-profile-heading');
    expect(url.searchParams.get('ui_locales')).toBe('en');
  });
  it.each([undefined,'javascript:alert(1)','https://user:password@login.example.com/account/phone','http://login.example.com/account/phone','https://login.example.com/oidc/auth','not-a-url'])('does not create unsafe management links: %s',(href)=>{
    expect(buildAccountCenterHref(href,'https://dashboard.example.com','zh')).toBeNull();
  });
});
