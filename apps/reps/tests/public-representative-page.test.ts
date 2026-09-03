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
const mockSuccessRouteSource = readFileSync(
  resolve(
    __dirname,
    "../app/reps/[slug]/recharge/[id]/mock-success/route.ts",
  ),
  "utf8",
);

describe("public representative visitor-first page", () => {
  it("keeps supporting information inside the contextual rail instead of below the chat", () => {
    expect(pageSource.indexOf("<RepresentativeChatPanel")).toBeGreaterThan(-1);
    expect(pageSource).toContain("profilePanel={(" );
    expect(pageSource).toContain("<RepresentativeProfileInspector");
    expect(pageSource).not.toContain('id="identity-bindings"');
    expect(pageSource).not.toContain('id="about"');
    expect(pageSource).not.toContain('id="recharge"');
    expect(pageSource).not.toContain('id="trust"');
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
      shortTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: true,
      automaticExtractionEnabled: false,
      retentionDays: 45,
      expiryAction: "ARCHIVE" as const,
      policyRevision: 7,
      fingerprint: "a".repeat(43),
    };
    const disabledPolicy = {
      enabled: false,
      shortTermMemoryEnabled: false,
      contactMemoryEnabled: false,
      contactMemoryCrossChannelEnabled: false,
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
    const representativeExtractionOnlyZh = getGovernedContextDisclosure("zh", {
      ...enabledPolicy,
      enabled: false,
      contactMemoryEnabled: false,
      representativeExperienceEnabled: true,
      automaticExtractionEnabled: true,
      expiryAction: "DELETE",
    });
    const enabledCrossChannelZh = getGovernedContextDisclosure("zh", {
      ...enabledPolicy,
      contactMemoryCrossChannelEnabled: true,
    });

    expect(enabledZh).toContain("长期记忆已启用");
    expect(enabledZh).toContain("当前联系人、当前对外代理和 Web 渠道");
    expect(enabledZh).toContain("去标识化、经多来源聚合并通过自动策略");
    expect(enabledZh).toContain("原始聊天全文");
    expect(enabledZh).toContain("付款、余额、退款和权益");
    expect(enabledZh).toContain("保留 45 天");
    expect(enabledZh).toContain("到期后归档并停止召回");
    expect(enabledZh).toContain("删除我的记忆");
    expect(enabledZh).not.toContain("你可以在聊天中");
    expect(disabledZh).toContain("当前未启用");
    expect(disabledZh).toContain("不会创建或调用联系人长期记忆");
    expect(disabledZh).not.toMatch(/保留 \d+ 天/u);
    expect(enabledEn).toContain("is enabled");
    expect(enabledEn).toContain("this contact, this representative, and the Web channel");
    expect(enabledEn).toContain("deidentified representative experience");
    expect(enabledEn).toContain("retained for 45 days");
    expect(enabledEn).toContain("send “删除我的记忆”");
    expect(enabledEn).not.toContain("You can ask in chat");
    expect(disabledEn).toContain("is currently disabled");
    expect(disabledEn).toContain("will not create or recall contact long-term memory");
    expect(extractionOnlyZh).toContain("召回当前未启用");
    expect(extractionOnlyZh).toContain("长期记忆自动提取已启用");
    expect(extractionOnlyZh).toContain("可能提取仅限当前联系人的偏好、目标、约束与必要背景");
    expect(extractionOnlyZh).toContain("单条消息或单个联系人不会直接生成代表经验");
    expect(extractionOnlyZh).toContain("自动来源、范围和安全策略");
    expect(extractionOnlyZh).toContain("保留 45 天");
    expect(extractionOnlyZh).toContain("异步清理");
    expect(extractionOnlyZh).toContain("删除我的记忆");
    expect(representativeExtractionOnlyZh).toContain("长期记忆自动提取已启用");
    expect(representativeExtractionOnlyZh).toContain("去标识化、多来源聚合的代表经验输入");
    expect(representativeExtractionOnlyZh).toContain("联系人事实不会进入代表经验");
    expect(representativeExtractionOnlyZh).not.toContain("只可能提取联系人偏好");
    expect(enabledCrossChannelZh).toContain("同一已验证 Delegate 身份");
    expect(enabledCrossChannelZh).toContain("默认开启");
    expect(enabledCrossChannelZh).toContain("随时关闭");
    expect(enabledCrossChannelZh).toContain("Web、Matrix、Telegram");
    expect(enabledCrossChannelZh).toContain("原始会话仍分别保存");
    expect(enabledCrossChannelZh).not.toContain("暂不支持");
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
    expect(chatSource).toContain('rejection === "memory_disclosure_stale"');
    expect(chatSource).toContain("setGovernedMemoryDisclosure(payload.governedMemoryDisclosure)");
    expect(chatSource).toContain("restoreRejectedPublicChatDraft({");
    expect(chatSource).toContain("collectPendingMemoryDisplayAcks(");
    expect(chatSource).toContain("acknowledgedDisplayKeysRef.current.add(key)");
    expect(chatSource).toContain("sendPublicMemoryDisplayAck(props.representativeSlug, ack)");
    expect(pageSource).not.toMatch(
      /openvikingAgentId|openvikingAutoRecall|openvikingTargetUri|baseUrl|consoleUrl/u,
    );
    expect(`${chatSource}\n${disclosureSource}`).not.toMatch(
      /openviking|agent id|target uri|provider/u,
    );
    expect(chatSource).not.toContain('citationsLabel: "回答依据"');
    expect(chatSource).not.toContain('citationsLabel: "Context used"');
    expect(chatSource).not.toContain("并在使用公开来源时标明依据");
    expect(chatSource).not.toContain("show the public sources they use");
    expect(chatSource).toContain("props.governedMemoryDisclosure");
    expect(pageSource).not.toContain("回答只使用已发布");
  });

  it("delegates legacy and v2 audience authority to one verified context resolver", () => {
    expect(pageSource).toContain(
      "resolvePublicAudienceVerifiedAuthContext",
    );
    expect(pageSource).not.toContain("verifyDelegateAuthSession(");
    expect(pageSource).not.toContain(
      "DELEGATE_AUDIENCE_AUTH_SESSION_COOKIE",
    );
  });

  it("keeps existing WeChat orders visible when new collection is paused", () => {
    expect(pageSource).toContain(
      "preflightWeChatPayRuntime()",
    );
    expect(pageSource).toContain(
      '"collection_paused" as const',
    );
    expect(pageSource).toContain(
      "collectionEnabled={collectionEnabled}",
    );
    expect(pageSource).toContain(
      "serviceCreditPurchaseEnabled={hasServicePackages && collectionEnabled}",
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

  it("uses the unified live commerce catalog without exposing wallet cash", () => {
    expect(pageSource).toContain('rechargeNav: "服务与支持"');
    expect(pageSource).toContain("按需要继续服务或自愿支持");
    expect(rechargePanelSource).toContain("snapshot.commerceProducts");
    expect(rechargePanelSource).toContain(
      "billingPriceVersionId: intent.priceVersionId",
    );
    expect(rechargePanelSource).not.toContain(
      "amountCents: intent.amountCents",
    );
    expect(rechargePanelSource).not.toContain("cashBalanceCents");
    expect(rechargePanelSource).not.toContain("[500, 2000, 10000]");
    expect(rechargePanelSource).toContain(
      "选择当前对外代理的服务包",
    );
    expect(rechargePanelSource).toContain(
      "自愿支持",
    );
    expect(rechargePanelSource).toContain(
      "不赠服务额度 · 不含人工接管 · 不可退款",
    );
    expect(rechargePanelSource).toContain('product.kind === "SERVICE_PACKAGE"');
    expect(rechargePanelSource).toContain('product.kind === "TIP"');
  });

  it("keeps pricing contextual and hides answer-basis citations", () => {
    expect(chatSource).toContain("showServices");
    expect(chatSource).toContain('accessMode === "TRIAL_THEN_CREDITS"');
    expect(chatSource).toContain('accessMode === "FREE"');
    expect(chatSource).toMatch(
      /accessMode !== "FREE" && \(\s+accessMode === "CREDITS_ONLY"/,
    );
    expect(chatSource).toContain(
      'rejection === "service_credit_required"',
    );
    expect(chatSource).toContain("restoreRejectedPublicChatDraft({");
    expect(chatSource).toContain("resolvePublicChatServiceCreditNextStep({");
    expect(chatSource).toContain("props.serviceCreditPurchaseEnabled");
    expect(chatSource).not.toContain(
      "process.env.NEXT_PUBLIC_ENABLE_PUBLIC_DEMOS",
    );
    expect(chatSource).toContain("detail.serviceCreditsReserved > 0");
    expect(chatSource).toContain("t.serviceCreditPending");
    expect(chatSource).toContain("t.serviceCreditRequired");
    expect(chatSource).toContain("t.serviceCreditUnavailable");
    expect(chatSource).toContain("t.serviceCreditUnavailableWithHandoff");
    expect(chatSource).not.toContain("PricingPlan");
    expect(chatSource).not.toContain("props.pricing");
    expect(chatSource).not.toContain("representative-chat-tier-grid");
    expect(chatSource).not.toContain('className="representative-chat-citations"');
    expect(chatSource).toContain("representative-chat-starters");
    expect(pageSource).toContain("faqQuestions={representative.knowledgePack.faq.map((item) => item.title)}");
  });

  it("supports bounded public-chat attachments through multipart submission", () => {
    expect(chatSource).toContain("PUBLIC_CHAT_ATTACHMENT_MAX_FILES = 5");
    expect(chatSource).toContain("PUBLIC_CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024");
    expect(chatSource).toContain("PUBLIC_CHAT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024");
    expect(chatSource).toContain("new FormData()");
    expect(chatSource).toContain('form.append("attachments", attachment');
    expect(chatSource).toContain("representative-chat-pending-attachments");
  });

  it("lets the visitor cancel a pending handoff or end active human service", () => {
    expect(chatSource).toContain("cancel_request");
    expect(chatSource).toContain("end_human_service");
    expect(chatSource).toContain("representative-handoff-control-trigger");
    expect(chatSource).toContain('role="alertdialog"');
    expect(chatSource).toContain(
      "A consumed handoff entitlement is not refunded.",
    );
    expect(chatSource).toContain(
      "你已取消人工接管请求，对外代理将继续回复。",
    );
    expect(chatSource).toContain(
      "你已结束人工接待，对外代理将继续回复。",
    );
  });

  it("treats tips as support without exposing mock payment controls", () => {
    expect(rechargePanelSource).not.toContain("mock-success");
    expect(rechargePanelSource).not.toContain("mock-reversal");
    expect(rechargePanelSource).not.toContain("模拟支付成功");
    expect(rechargePanelSource).not.toContain("Simulate payment success");
    expect(rechargePanelSource).toContain(
      'order.productKind === "TIP" && (tipCompleted || order.status === "paid")',
    );
    expect(rechargePanelSource).toContain(
      'activity.order?.productKind !== "TIP"',
    );
    expect(rechargePanelSource).toContain(
      'selectedProduct?.kind === "SERVICE_PACKAGE"',
    );
    expect(rechargePanelSource).toContain(
      "const requiresTelegramBinding",
    );
    expect(chatSource).not.toContain("if (detail.handoffEntitlement)");
    expect(rechargePanelSource).toContain(
      "hasActiveWeChatOrder || paymentResultConfirmed",
    );
    expect(rechargePanelSource).toContain(
      "selectedProduct?.kind ?? order?.productKind ?? null",
    );
    expect(mockSuccessRouteSource).toContain(
      "serializePublicMockCommerceCompletion(result)",
    );
    expect(mockSuccessRouteSource).not.toContain("privateJson(result");
    expect(mockSuccessRouteSource).not.toContain(
      "rechargeOrder.cashBalanceCents",
    );
    expect(mockSuccessRouteSource).not.toContain("result.fulfillment");
  });

  it("keeps FREE access free and hides empty commerce sections", () => {
    expect(pageSource).toContain(
      "visibleCommerceProducts.length > 0 || hasRestorableCommerceActivity",
    );
    expect(pageSource).toContain(
      "hasRestorablePublicCommerceActivity({",
    );
    expect(pageSource).toContain("{hasPublicCommerce ? (");
    expect(chatSource).toContain('accessMode !== "FREE"');
    expect(chatSource).toContain("当前对话永久免费");
    expect(chatSource).toContain(
      "不会销售继续对话所需的服务套餐",
    );
    expect(pageSource).not.toContain("const hasHandoffPackages");
    expect(chatSource).not.toContain("props.hasHandoffPackages");
  });

  it("shows localized source notes only from server markers", () => {
    expect(chatSource).toContain(
      'message.sourceDisclosure === "same_conversation"',
    );
    expect(chatSource).toContain('message.role === "assistant"');
    expect(chatSource).toContain("payload.reply.sourceDisclosure");
    expect(chatSource).toContain("snapshot.message.sourceDisclosure");
    expect(chatSource).toContain(
      "!hasInlineAnswerSourceDisclosure(message.text)",
    );
    expect(chatSource).toContain('(?:来源说明：|Source note:)');
    expect(chatSource).toContain(
      "来源说明：本回答未引用已授权知识或记忆。",
    );
    expect(chatSource).toContain(
      "来源说明：外部工具本轮未执行，以下内容由通用模型根据已有知识概括；未核验相关项目或仓库的最新内容，也未引用已授权知识或记忆。",
    );
    expect(chatSource).toContain(
      "Source note: This answer did not cite authorized knowledge or memory.",
    );
    expect(chatSource).toContain(
      "来源说明：根据本次对话记录整理。",
    );
    expect(chatSource).toContain(
      "Source note: Based on this conversation's record.",
    );
    expect(chatSource).toContain(
      'className="representative-answer-source-disclosure"',
    );
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
    expect(identityBindingSource).toContain("capabilities.telegram");
    expect(identityBindingSource).toContain("capabilities.matrix");
    expect(identityBindingSource).toContain(
      "当前代表下已绑定的 Telegram 账号",
    );
    expect(identityBindingSource).toContain("currentBindings.telegram.length === 0");
    expect(identityBindingSource).toContain("currentBindings.matrix.length === 0");
    expect(identityBindingSource).not.toContain("绑定另一个或重新验证 Telegram 账号");
    expect(identityBindingSource).not.toContain("生成 Matrix 替换命令");
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
