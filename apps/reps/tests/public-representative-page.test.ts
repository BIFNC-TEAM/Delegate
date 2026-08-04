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
const disclosureSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/governed-context-disclosure.ts"),
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
    const enabledPolicy = {
      enabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: true,
      automaticExtractionEnabled: false,
      retentionDays: 45,
      expiryAction: "ARCHIVE" as const,
      policyRevision: 7,
      fingerprint: "a".repeat(43),
    };
    const disabledPolicy = {
      enabled: false,
      contactMemoryEnabled: false,
      representativeExperienceEnabled: false,
      automaticExtractionEnabled: false,
      retentionDays: null,
      expiryAction: null,
      policyRevision: null,
      fingerprint: "b".repeat(43),
    };
    const enabledZh = getGovernedContextDisclosure("zh", enabledPolicy);
    const disabledZh = getGovernedContextDisclosure("zh", disabledPolicy);
    const enabledEn = getGovernedContextDisclosure("en", enabledPolicy);
    const disabledEn = getGovernedContextDisclosure("en", disabledPolicy);
    const extractionOnlyZh = getGovernedContextDisclosure("zh", {
      ...enabledPolicy,
      enabled: false,
      automaticExtractionEnabled: true,
      expiryAction: "DELETE",
    });

    expect(enabledZh).toContain("长期记忆已启用");
    expect(enabledZh).toContain("当前联系人、当前数字代表和 Web 渠道");
    expect(enabledZh).toContain("去标识化且经人工审核");
    expect(enabledZh).toContain("原始聊天全文");
    expect(enabledZh).toContain("付款、余额、退款和权益");
    expect(enabledZh).toContain("保留 45 天");
    expect(enabledZh).toContain("到期后归档并停止召回");
    expect(enabledZh).toContain("查看、纠正或删除");
    expect(disabledZh).toContain("当前未启用");
    expect(disabledZh).toContain("不会创建或调用跨会话");
    expect(disabledZh).not.toMatch(/保留 \d+ 天/u);
    expect(enabledEn).toContain("is enabled");
    expect(enabledEn).toContain("this contact, this representative, and the Web channel");
    expect(enabledEn).toContain("deidentified representative experience");
    expect(enabledEn).toContain("retained for 45 days");
    expect(enabledEn).toContain("view, correct, or delete");
    expect(disabledEn).toContain("is currently disabled");
    expect(disabledEn).toContain("will not create or recall cross-conversation");
    expect(extractionOnlyZh).toContain("召回当前未启用");
    expect(extractionOnlyZh).toContain("联系人记忆候选自动提取已启用");
    expect(extractionOnlyZh).toContain("只可能生成联系人偏好、目标、约束与必要背景候选");
    expect(extractionOnlyZh).toContain("代表经验不会从 Web 消息自动提取");
    expect(extractionOnlyZh).toContain("保留 45 天");
    expect(extractionOnlyZh).toContain("异步清理");
    expect(enabledZh).not.toBe(disabledZh);
    expect(enabledEn).not.toBe(disabledEn);

    expect(pageSource).toContain(
      "runtime.governedContextEnabled",
    );
    expect(pageSource).toContain(
      "governedMemoryDisclosure={runtime.governedMemoryDisclosure}",
    );
    expect(chatSource).toContain(
      "props.governedMemoryDisclosure",
    );
    expect(chatSource).toContain("policyRevision: governedMemoryDisclosure.policyRevision");
    expect(chatSource).toContain("fingerprint: governedMemoryDisclosure.fingerprint");
    expect(chatSource).toContain('payload.code === "memory_disclosure_stale"');
    expect(chatSource).toContain("setGovernedMemoryDisclosure(payload.governedMemoryDisclosure)");
    expect(chatSource).toContain("setInput(text)");
    expect(chatSource).toContain("collectPendingMemoryDisplayAcks(");
    expect(chatSource).toContain("acknowledgedDisplayKeysRef.current.add(key)");
    expect(chatSource).toContain("sendPublicMemoryDisplayAck(props.representativeSlug, ack)");
    expect(pageSource).not.toMatch(
      /openvikingAgentId|openvikingAutoRecall|openvikingTargetUri|baseUrl|consoleUrl/u,
    );
    expect(`${chatSource}\n${disclosureSource}`).not.toMatch(
      /openviking|agent id|target uri|provider/u,
    );
    expect(chatSource).toContain('citationsLabel: "回答依据"');
    expect(chatSource).toContain('citationsLabel: "Context used"');
    expect(chatSource).toContain("props.governedMemoryDisclosure");
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
