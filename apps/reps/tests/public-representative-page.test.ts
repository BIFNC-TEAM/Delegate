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
const identityBindingSource = readFileSync(
  resolve(
    __dirname,
    "../app/reps/[slug]/representative-identity-binding-panel.tsx",
  ),
  "utf8",
);
const rechargePanelSource = readFileSync(
  resolve(
    __dirname,
    "../app/reps/[slug]/representative-recharge-panel.tsx",
  ),
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

  it("keeps existing WeChat orders visible when new collection is paused", () => {
    expect(pageSource).toContain(
      "weChatPayReleaseFlags?.processingEnabled === true",
    );
    expect(pageSource).toContain(
      "weChatPayReleaseFlags?.collectionEnabled === true",
    );
    expect(pageSource).toContain(
      "collectionEnabled={collectionEnabled}",
    );
  });

  it("does not treat an unclaimed provider-query lease as final expiry confirmation", () => {
    expect(rechargePanelSource).toContain(
      "result.providerChecked === true",
    );
    expect(rechargePanelSource).toContain("markExpiryUnconfirmed()");
  });

  it("keeps CREATED and expired WeChat orders locked while status polling continues", () => {
    expect(rechargePanelSource).toContain(
      'order.status !== "created"',
    );
    expect(rechargePanelSource).toContain(
      "hasRecoveringWeChatOrder || hasPendingWeChatOrder",
    );
    expect(rechargePanelSource).toContain(
      "message: t.wechatRecovering",
    );
    expect(rechargePanelSource).toContain(
      "message: t.wechatExpiredConfirmed",
    );
    expect(rechargePanelSource).toContain(
      "t.wechatExpiredPreventsDuplicate",
    );
  });

  it("keeps pricing contextual and long citations collapsed", () => {
    expect(chatSource).toContain("showPlans");
    expect(chatSource).toContain("usage.freeRepliesRemaining > 0");
    expect(chatSource).toContain("<details key=");
    expect(chatSource).toContain("representative-chat-starters");
  });

  it("describes Telegram as visitor identity linking rather than Bot setup", () => {
    expect(identityBindingSource).toContain("绑定我的 Telegram 账号");
    expect(identityBindingSource).toContain(
      "Web 充值余额和服务权益会保持一致",
    );
    expect(identityBindingSource).toContain(
      "复制命令并在 Delegate Bot 私聊中发送",
    );
    expect(identityBindingSource).not.toContain("生成 Telegram 绑定命令");
  });
});
