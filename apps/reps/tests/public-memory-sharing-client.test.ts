import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  resolve(
    __dirname,
    "../app/reps/[slug]/representative-memory-sharing-panel.tsx",
  ),
  "utf8",
);
const pageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/page.tsx"),
  "utf8",
);
const routeSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/memory-sharing/route.ts"),
  "utf8",
);

describe("public cross-channel memory consent panel", () => {
  it("is visible only inside the authenticated channel-management workspace", () => {
    expect(pageSource).toContain(
      'import { RepresentativeMemorySharingPanel } from "./representative-memory-sharing-panel"',
    );
    expect(pageSource).toMatch(
      /bindingManagement=\{audienceSession \? \([\s\S]*?<RepresentativeIdentityBindingPanel[\s\S]*?<RepresentativeMemorySharingPanel[\s\S]*?\) : undefined\}/u,
    );
    expect(pageSource).not.toContain('id="identity-bindings"');
  });

  it("states scope, exclusions, isolation, and immediate withdrawal behavior", () => {
    expect(panelSource).toContain("同一已验证 Delegate 身份");
    expect(panelSource).toContain("未验证账号、其他联系人及其他数字代表保持隔离");
    expect(panelSource).toContain("原始聊天");
    expect(panelSource).toContain("Owner 私有备注");
    expect(panelSource).toContain("Compute 原始产物");
    expect(panelSource).toContain("付款、余额、退款和权益信息");
    expect(panelSource).toContain("立即停止共享召回");
    expect(panelSource).toContain("异步清理共享记忆");
    expect(panelSource).toContain("历史消息、账号绑定、订单和权益不受影响");
    expect(panelSource).toContain("Raw chats");
    expect(panelSource).toContain("other contacts");
    expect(panelSource).toContain("stops shared recall immediately");
  });

  it("defaults on under user control and keeps server-challenge proof for re-enabling", () => {
    expect(panelSource).toContain('type="checkbox"');
    expect(panelSource).toContain('role="switch"');
    expect(panelSource).toContain("state && !state.active");
    expect(panelSource).not.toContain('return zh ? "已启用" : "Enabled"');
    expect(panelSource).toContain("开关仅由你控制，默认开启");
    expect(panelSource).toContain(
      "challengeToken: state.challengeToken",
    );
    expect(panelSource).toContain('method: "POST"');
    expect(routeSource).toContain('state.blockedReason === "consent_missing"');
    expect(routeSource).toContain("web-default-confirmation:");
    expect(routeSource).toContain(
      "/^[A-Za-z0-9_-]{43}$/u.test(challengeToken)",
    );
  });

  it("uses a two-step destructive confirmation for withdrawal", () => {
    expect(panelSource).toContain("confirmingRevocation");
    expect(panelSource).toContain("representative-memory-confirmation-modal");
    expect(panelSource).toContain('aria-modal="true"');
    expect(panelSource).toContain('role="alertdialog"');
    expect(panelSource).toContain("createPortal(");
    expect(panelSource).toContain('setAttribute("inert", "")');
    expect(panelSource).toContain("停止并删除跨渠道联系人记忆？");
    expect(panelSource).toContain("确认停止并删除");
    expect(panelSource).toContain('method: "DELETE"');
    expect(panelSource).not.toContain("window.confirm");
  });

  it("keeps internal memory diagnostics out of the public UI and API response", () => {
    expect(panelSource).not.toMatch(
      /viking:\/\/|target uri|agent id|recalltrace|cosine score|session id/iu,
    );
    expect(routeSource).toContain("toPublicMemorySharingState");
    expect(routeSource).not.toMatch(
      /audienceIdentityId:\s*state\.|policyRevision:\s*state\.|consentVersion:\s*state\.|uri:\s*state\.|score:\s*state\./u,
    );
  });

  it("handles loading, retryable failure, success, and stale-policy errors", () => {
    expect(panelSource).toContain('role="status"');
    expect(panelSource).toContain('role="alert"');
    expect(panelSource).toContain("setLoadAttempt");
    expect(panelSource).toContain("setNotice");
    expect(panelSource).toContain("payload?.error || response.statusText");
    expect(routeSource).toContain(
      "Memory-sharing policy or disclosure changed. Refresh and confirm again.",
    );
  });
});
