import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getGovernedContextDisclosure } from "../app/reps/[slug]/governed-context-disclosure";

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

  it("renders explicit enabled and disabled governed-context disclosures", () => {
    const enabledZh = getGovernedContextDisclosure("zh", true);
    const disabledZh = getGovernedContextDisclosure("zh", false);
    const enabledEn = getGovernedContextDisclosure("en", true);
    const disabledEn = getGovernedContextDisclosure("en", false);

    expect(enabledZh).toContain("当前已启用");
    expect(enabledZh).toContain("仅在这个数字代表范围内");
    expect(disabledZh).toContain("当前未启用");
    expect(disabledZh).toContain("不会形成或调用跨会话长期记忆");
    expect(enabledEn).toContain("is enabled");
    expect(enabledEn).toContain("scoped to this representative");
    expect(disabledEn).toContain("is disabled");
    expect(disabledEn).toContain("does not create or use memory across conversations");
    expect(enabledZh).not.toBe(disabledZh);
    expect(enabledEn).not.toBe(disabledEn);

    expect(pageSource).toContain(
      "runtime.governedContextEnabled",
    );
    expect(pageSource).toContain(
      "governedContextEnabled={runtime.governedContextEnabled}",
    );
    expect(chatSource).toContain(
      "props.governedContextEnabled",
    );
    expect(pageSource).not.toMatch(
      /openvikingAgentId|openvikingAutoRecall|openvikingTargetUri|baseUrl|consoleUrl/u,
    );
    expect(chatSource).toContain('citationsLabel: "回答依据"');
    expect(chatSource).toContain('citationsLabel: "Context used"');
    expect(chatSource).toContain("props.governedContextEnabled");
    expect(pageSource).not.toContain("回答只使用已发布");
  });

  it("stops reading legacy audience cookies when v2 enforcement modes are selected", () => {
    expect(pageSource).toContain(
      "usesLegacyAccountSessionAuthority(",
    );
    expect(pageSource).toContain("readAccountSessionMode()");
    expect(pageSource).toMatch(
      /const authSession = legacyAuthorityEnabled[\s\S]*?: null;/u,
    );
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

  it("presents representative-scoped service packages without exposing wallet cash", () => {
    expect(pageSource).toContain('rechargeNav: "服务包"');
    expect(pageSource).toContain("购买当前数字代表的服务额度");
    expect(rechargePanelSource).toContain("snapshot.servicePackages");
    expect(rechargePanelSource).toContain(
      "billingPriceVersionId: intent.priceVersionId",
    );
    expect(rechargePanelSource).not.toContain(
      "amountCents: intent.amountCents",
    );
    expect(rechargePanelSource).not.toContain("cashBalanceCents");
    expect(rechargePanelSource).not.toContain("[500, 2000, 10000]");
    expect(rechargePanelSource).toContain(
      "选择当前数字代表的服务包",
    );
    expect(rechargePanelSource).toContain(
      "无需再用余额二次购买",
    );
    expect(rechargePanelSource).toContain(
      "仅适用于当前数字代表",
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
      "代表专属服务额度会保持一致",
    );
    expect(identityBindingSource).toContain(
      "复制命令并发送给",
    );
    expect(identityBindingSource).toContain("binding.connectionId");
    expect(identityBindingSource).toContain(
      "https://t.me/${bot.username}?start=${payload}",
    );
    expect(identityBindingSource).toContain("`rep_${representativeSlug}`");
    expect(identityBindingSource).toContain("navigator.clipboard.writeText");
    expect(identityBindingSource).toContain("creatingProvider");
    expect(identityBindingSource).toContain("Legacy binding; rebind required");
    expect(identityBindingSource).toContain('method: "DELETE"');
    expect(identityBindingSource).toContain("解除绑定");
    expect(identityBindingSource).toContain("历史消息、服务额度和订单不会删除");
    expect(identityBindingSource).toContain("capabilities?.telegram");
    expect(identityBindingSource).toContain("capabilities?.matrix");
    expect(identityBindingSource).toContain(
      "当前代表下已绑定的 Telegram 账号",
    );
    expect(identityBindingSource).toContain(
      "当前绑定的 Matrix MXID（可输入新账号替换）",
    );
    expect(identityBindingSource).toContain(
      "Matrix 账号已验证并替换完成",
    );
    expect(identityBindingSource).toContain("currentBindings");
    expect(identityBindingSource).toContain(
      "fetchBindingChallengeState",
    );
    expect(identityBindingSource).toContain(
      'challenge.status === "PENDING"',
    );
    expect(identityBindingSource).toContain('bindingLoadStatus === "loading"');
    expect(identityBindingSource).toContain('bindingLoadStatus === "error"');
    expect(identityBindingSource).toContain("setBindingLoadAttempt");
    expect(identityBindingSource).toContain("if (result.changed)");
    expect(identityBindingSource).toContain(
      "const payload = await fetchBindingState(representativeSlug)",
    );
    expect(identityBindingSource).toContain("window.setTimeout");
    expect(identityBindingSource).not.toContain("window.setInterval");
    expect(identityBindingSource).not.toContain("生成 Telegram 绑定命令");
  });
});
