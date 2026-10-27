import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { SiteSessionState } from "../app/site-session-client";

const session = vi.hoisted(() => ({
  state: { status: "loading" } as SiteSessionState,
  retry: vi.fn(),
}));
vi.mock("../app/site-session", () => ({ useSiteSession: () => session }));
import { SiteAccountNavigation } from "../app/site-account-navigation";

const props: ComponentProps<typeof SiteAccountNavigation> = {
  activeLocale: "zh",
  dashboardBaseUrl: "http://localhost:3001",
  loginHref: "/auth/login?flow=sign_in",
  registerHref: "/auth/login?flow=register&returnTo=representatives",
  signupHref: "/auth/login?flow=register",
  registerLabel: "创建对外代理",
  siteReturnTo: "/?lang=zh",
  menu: [],
  copy: {
    languageAriaLabel: "语言",
    menuLabel: "菜单",
    login: "登录",
    signup: "注册",
    checking: "正在确认账号",
    unavailable: "账号状态暂不可用",
    retry: "重试",
    accountFallback: "账号",
    accountMenuLabel: "账号菜单",
    console: "工作台",
    representatives: "我的对外代理",
    settings: "设置",
    signOut: "退出登录",
    zh: "中文",
    en: "English",
  },
};
const render = () => renderToStaticMarkup(<SiteAccountNavigation {...props} />);
beforeEach(() => {
  session.state = { status: "loading" };
});

describe("website account navigation", () => {
  it("does not flash login or creation buttons while the session loads", () => {
    const html = render();
    expect(html).toContain("正在确认账号");
    expect(html).not.toContain('class="site-header-cta"');
    const hydratedMarkup = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
    expect(hydratedMarkup).not.toContain('href="/auth/login');
    expect(html).toContain('<noscript><a href="/auth/login?flow=sign_in">');
  });
  it("replaces desktop and mobile acquisition actions with the authenticated identity", () => {
    session.state = {
      status: "authenticated",
      account: { displayName: "测试用户名", email: "lin@example.com" },
    };
    const html = render();
    expect(html).toContain("测试用户名");
    expect(html).toContain("我的对外代理");
    expect(html).toContain("view=representatives");
    expect(html).toContain('method="post"');
    expect(html).not.toContain('href="/auth/login');
    expect(html).not.toContain("创建对外代理");
  });
  it("shows login, explicit signup, and creation for anonymous visitors", () => {
    session.state = { status: "anonymous" };
    const html = render();
    expect(html).toContain("登录");
    expect(html).toContain("注册");
    expect(html).toContain("创建对外代理");
    expect(html).not.toContain("site-account-popover");
  });
  it("shows a recoverable error rather than claiming the visitor is signed out", () => {
    session.state = { status: "unavailable" };
    const html = render();
    expect(html).toContain("账号状态暂不可用");
    expect(html).toContain("重试");
    expect(html).not.toContain('href="/auth/login');
  });
});

// The default context is loading on the server, before any session lookup.
it("keeps creation reachable when scripts cannot run", async () => {
  const { SiteCreationLink } = await vi.importActual<
    typeof import("../app/site-session")
  >("../app/site-session");
  const html = renderToStaticMarkup(
    <SiteCreationLink
      href="/auth/login?flow=register"
      signedInHref="/dashboard"
      locale="zh"
    >
      创建我的对外代理
    </SiteCreationLink>,
  );
  expect(html).toContain(
    '<noscript><a class="button" href="/auth/login?flow=register">创建我的对外代理</a></noscript>',
  );
  expect(html).toContain("site-session-js-only");
});
