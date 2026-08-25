import type {
  AudienceRole,
  Channel,
  InquiryIntent,
  PlanTier,
  Representative,
} from "@delegate/domain";

export type ConversationUsage = {
  freeRepliesUsed: number;
  passUnlocked: boolean;
  deepHelpUnlocked: boolean;
};

export type ConversationGoal =
  | "get_information"
  | "get_material"
  | "provide_information"
  | "create_request"
  | "perform_action"
  | "request_human"
  | "unsafe_request"
  | "unknown";

export type ConversationDisposition =
  | "answer"
  | "collect"
  | "payment_required"
  | "handoff"
  | "refuse";

export type ConversationIntentResult = {
  primaryGoal: ConversationGoal;
  primaryIntent: InquiryIntent;
  businessLabels: string[];
  requestedOutcomes: string[];
  entities: Record<string, string>;
  missingFields: string[];
  confidence: number;
  safetySignals: string[];
};

export type ConversationBillingDecision = {
  decision: "no_charge" | "allow_free" | "allow_entitlement" | "payment_required";
  billable: boolean;
  reason: string;
};

export type ConversationAuthorizationDecision =
  | { decision: "allow"; reason: string }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };

export type ConversationActionExecutionResult = {
  actionId: string;
  status: "completed" | "waiting_input" | "waiting_approval" | "deferred" | "denied" | "failed";
  summary: string;
  output?: Record<string, unknown>;
};

export type ConversationTurnTrace = {
  version: 1;
  plan: {
    goal: ConversationGoal;
    intent: InquiryIntent;
    businessLabels: string[];
    requestedOutcomes: string[];
    disposition: ConversationDisposition;
    replyGoal: string;
    reasons: string[];
  };
  billing: ConversationBillingDecision;
  actions: Array<{
    id: string;
    kind: ConversationActionKind;
    authorization: ConversationAuthorizationDecision;
    execution: ConversationActionExecutionResult;
  }>;
};

export type ConversationActionKind =
  | "answer_public_information"
  | "collect_request_description"
  | "deliver_public_material"
  | "create_service_request"
  | "execute_tool"
  | "cancel_pending_action"
  | "request_human_handoff"
  | "refuse_unsafe_request";

export type PlannedConversationAction = {
  id: string;
  kind: ConversationActionKind;
  status: "planned";
  sideEffect: "none" | "internal_record" | "human_queue";
  target?: string;
  /** Optional only while replaying plans persisted before protocol version 1. */
  input?: Record<string, unknown>;
  /** Optional only while replaying plans persisted before protocol version 1. */
  requiredCapabilities?: string[];
  /** Optional only while replaying plans persisted before protocol version 1. */
  externalSideEffect?: boolean;
  estimatedTokens?: number;
};

export type ConversationPlan = {
  goal: ConversationGoal;
  intent: InquiryIntent;
  audienceRole: AudienceRole;
  disposition: ConversationDisposition;
  /** Optional only while replaying plans persisted before protocol version 1. */
  intentResult?: ConversationIntentResult;
  /** Optional only while replaying plans persisted before protocol version 1. */
  billingDecision?: ConversationBillingDecision;
  /** Optional only while replaying plans persisted before protocol version 1. */
  replyGoal?: string;
  actions: PlannedConversationAction[];
  suggestedPlan?: PlanTier;
  reasons: string[];
  responseOutline: string[];
};

/** Protocol-v1 plan emitted by the current planner. */
export type CurrentPlannedConversationAction = PlannedConversationAction & {
  input: Record<string, unknown>;
  requiredCapabilities: string[];
  externalSideEffect: boolean;
};

export type CurrentConversationPlan = ConversationPlan & {
  intentResult: ConversationIntentResult;
  billingDecision: ConversationBillingDecision;
  replyGoal: string;
  actions: CurrentPlannedConversationAction[];
};

type PlanInput = {
  text: string;
  channel: Channel;
  representative: Representative;
  usage: ConversationUsage;
  proposedAction?: {
    target: string;
    input: Record<string, unknown>;
    requiredCapabilities: string[];
    estimatedTokens?: number;
  };
};

const keywords = {
  collaboration: ["合作", "cooperate", "partnership", "partner", "bd", "collab", "业务合作", "agency"],
  pricing: ["价格", "报价", "多少钱", "quote", "pricing", "budget", "费用"],
  materials: ["资料", "案例", "材料", "介绍", "deck", "case study", "portfolio", "demo"],
  scheduling: ["预约", "时间", "schedule", "calendar", "meeting", "call", "book"],
  handoff: ["真人", "本人", "founder", "owner", "升级", "转接", "speak to", "talk to"],
  refund: ["退款", "refund", "chargeback"],
  discount: ["折扣", "优惠", "discount", "deal"],
  candidate: ["招聘", "求职", "简历", "candidate", "job", "hire", "resume"],
  media: ["采访", "媒体", "podcast", "press", "记者", "newsletter"],
  restricted: ["密码", "token", "ssh", "服务器", "本地文件", "private memory", "登录", "账号密码"],
} as const;

export function classifyInquiry(text: string): InquiryIntent {
  return recognizeConversationIntent(text).primaryIntent;
}

export function recognizeConversationIntent(
  text: string,
  representative?: Pick<Representative, "skillPacks">,
): ConversationIntentResult {
  const normalized = text.toLowerCase();
  const ordered: Array<[InquiryIntent, readonly string[]]> = [
    ["restricted", keywords.restricted], ["refund", keywords.refund], ["discount", keywords.discount],
    ["handoff", keywords.handoff], ["pricing", keywords.pricing], ["collaboration", keywords.collaboration],
    ["scheduling", keywords.scheduling], ["materials", keywords.materials], ["candidate", keywords.candidate],
    ["media", keywords.media],
  ];
  const matched = ordered
    .filter(([, values]) => matchesAny(normalized, values))
    .map(([intent]) => intent);
  const faqMatched = ["help", "支持", "问题", "做什么", "是什么", "who are you"]
    .some((value) => normalized.includes(value));
  const primaryIntent = matched[0] ?? (faqMatched ? "faq" : "unknown");
  const dynamicLabels = representative?.skillPacks
    .filter((pack) => pack.enabled)
    .filter((pack) => {
      const tokens = [pack.slug, pack.displayName, ...pack.capabilityTags]
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length >= 2);
      return tokens.some((token) => normalized.includes(token));
    })
    .flatMap((pack) => [pack.slug, ...pack.capabilityTags]) ?? [];
  // Fixed vertical names remain only as a compatibility intent signal. Runtime
  // routing is driven by generic requested outcomes, while business labels are
  // limited to capabilities actually configured on this representative.
  const businessLabels = [...new Set(dynamicLabels)];
  const requestedOutcomes = detectRequestedOutcomes(
    normalized,
    primaryIntent,
  );
  const safetySignals = primaryIntent === "restricted"
    ? keywords.restricted.filter((value) => normalized.includes(value)).map((value) => `restricted:${value}`)
    : looksLikePromptInjection(normalized)
      ? ["prompt_injection_suspected"]
      : [];
  const primaryGoal = safetySignals.length > 0
    ? "unsafe_request"
    : requestedOutcomes.includes("request_human_follow_up")
      ? "request_human"
      : requestedOutcomes.includes("create_service_request")
        ? "create_request"
        : requestedOutcomes.includes("receive_public_material")
          ? "get_material"
          : primaryIntent === "faq"
            ? "get_information"
            : "unknown";
  return {
    primaryGoal,
    primaryIntent,
    businessLabels,
    requestedOutcomes,
    entities: {},
    missingFields: primaryGoal === "create_request"
      ? ["description"]
      : [],
    confidence: primaryIntent === "unknown" ? 0.25 : matched.length || faqMatched ? 0.9 : 0.5,
    safetySignals,
  };
}

export function detectAudienceRole(text: string): AudienceRole {
  const normalized = text.toLowerCase();
  if (matchesAny(normalized, keywords.candidate)) return "candidate";
  if (matchesAny(normalized, keywords.media)) return "media";
  if (matchesAny(normalized, keywords.collaboration) || matchesAny(normalized, keywords.pricing)) return "lead";
  if (normalized.includes("community") || normalized.includes("群")) return "community";
  if (normalized.includes("partner")) return "partner";
  return "other";
}

export function createConversationPlan(input: PlanInput): CurrentConversationPlan {
  let intentResult = recognizeConversationIntent(input.text, input.representative);
  const intent = intentResult.primaryIntent;
  const audienceRole = detectAudienceRole(input.text);
  const matchedExecutableSkill = findMatchedExecutableSkill(
    input.text,
    input.representative,
  );
  const proposedAction = input.proposedAction ?? (matchedExecutableSkill
    ? {
        target: `skill:${matchedExecutableSkill.slug}`,
        input: {
          source: "current_user_message",
          skillPackId: matchedExecutableSkill.id,
          skillPackSlug: matchedExecutableSkill.slug,
        },
        requiredCapabilities: [
          "compute.execute",
          ...matchedExecutableSkill.capabilityTags,
        ],
      }
    : undefined);
  const goal = intentResult.primaryGoal === "unsafe_request"
    ? "unsafe_request"
    : proposedAction
      ? "perform_action"
      : intentResult.primaryGoal;
  if (proposedAction && intentResult.primaryGoal !== "unsafe_request") {
    intentResult = {
      ...intentResult,
      primaryGoal: "perform_action",
      requestedOutcomes: [
        ...new Set([...intentResult.requestedOutcomes, "execute_governed_tool"]),
      ],
      missingFields: [],
    };
  }
  const reasons = [
    `Goal detected: ${goal}.`,
    `Configured capability labels detected: ${intentResult.businessLabels.join(", ") || "none"}.`,
  ];
  const makeAction = (
    kind: ConversationActionKind,
    sideEffect: PlannedConversationAction["sideEffect"] = "none",
    target?: string,
  ): CurrentPlannedConversationAction => ({
    id: `${kind}:${intent}`,
    kind,
    status: "planned",
    sideEffect,
    ...(target ? { target } : {}),
    input: { source: "current_user_message" },
    requiredCapabilities: requiredCapabilitiesForAction(kind),
    externalSideEffect: kind === "execute_tool",
  });

  const billingDecision = resolveConversationBillingDecision({
    intentResult,
    usage: input.usage,
    freeReplyLimit: input.representative.contract.freeReplyLimit,
  });

  if (goal === "unsafe_request") {
    return {
      goal, intent, audienceRole, disposition: "refuse",
      intentResult, billingDecision, replyGoal: "拒绝越权请求并提供安全替代方案。",
      actions: [makeAction("refuse_unsafe_request")], reasons,
      responseOutline: ["拒绝访问私有系统、凭据或未授权数据。", "提供公开信息或人工接手等安全替代方案。"],
    };
  }

  if (goal === "request_human") {
    return {
      goal, intent, audienceRole, disposition: "handoff",
      intentResult, billingDecision, replyGoal: "确认人工接手请求并收集最少必要描述。",
      actions: [makeAction("collect_request_description", "internal_record"), makeAction("request_human_handoff", "human_queue")],
      ...(input.usage.deepHelpUnlocked ? {} : { suggestedPlan: "deep_help" as const }), reasons,
      responseOutline: ["确认可提交人工接手请求。", "只请用户描述需求。", "只承诺进入队列，不承诺即时回复；其余信息由真人接手后确认。"],
    };
  }

  if (isConversationCancellationRequest(input.text)) {
    return {
      goal: "perform_action",
      intent,
      audienceRole,
      disposition: "answer",
      intentResult: {
        ...intentResult,
        primaryGoal: "perform_action",
        requestedOutcomes: [
          ...new Set([...intentResult.requestedOutcomes, "cancel_pending_action"]),
        ],
        missingFields: [],
      },
      billingDecision: {
        decision: "no_charge",
        billable: false,
        reason: "Canceling pending work never consumes conversation usage.",
      },
      replyGoal: "取消当前会话中仍可安全撤销的待处理任务。",
      actions: [makeAction("cancel_pending_action", "internal_record")],
      reasons: [...reasons, "The user explicitly requested cancellation."],
      responseOutline: [
        "只处理当前代表、当前联系人和当前会话中的任务。",
        "撤销待审批动作并释放未消费额度。",
        "已经开始产生外部副作用的任务不得伪装成已取消。",
      ],
    };
  }

  if (billingDecision.decision === "payment_required") {
    return {
      goal, intent, audienceRole, disposition: "payment_required", actions: [],
      intentResult, billingDecision, replyGoal: "说明额度不足并提供当前可用的继续方式。",
      suggestedPlan: suggestPlan(intent), reasons: [...reasons, "The configured free reply allowance is exhausted."],
      responseOutline: ["说明当前免费额度已用完。", "展示当前价格目录中最小可用的继续方式。"],
    };
  }

  if (proposedAction) {
    return {
      goal,
      intent,
      audienceRole,
      disposition: "answer",
      intentResult,
      billingDecision,
      replyGoal: "执行受治理的工具任务并返回可审计结果。",
      actions: [{
        id: `execute_tool:${proposedAction.target}`,
        kind: "execute_tool",
        status: "planned",
        sideEffect: "none",
        target: proposedAction.target,
        input: proposedAction.input,
        requiredCapabilities: [
          ...new Set(["compute.execute", ...proposedAction.requiredCapabilities]),
        ],
        externalSideEffect: true,
        ...(proposedAction.estimatedTokens !== undefined
          ? { estimatedTokens: proposedAction.estimatedTokens }
          : {}),
      }],
      reasons: [
        ...reasons,
        "The turn requests a governed tool capability and must not be answered as ordinary text.",
      ],
      responseOutline: [
        "先检查能力、计费和动作权限。",
        "需要审批时创建审批，不得提前执行。",
        "执行完成后只返回可公开的结果和审计引用。",
      ],
    };
  }

  const requestedOutcomes = new Set(intentResult.requestedOutcomes);
  if (
    requestedOutcomes.has("receive_public_material")
    && !requestedOutcomes.has("create_service_request")
  ) {
    return {
      goal, intent, audienceRole, disposition: "answer",
      intentResult, billingDecision, replyGoal: "回答资料请求并交付匹配的已发布公开资料。",
      actions: [makeAction("answer_public_information"), makeAction("deliver_public_material", "none", "public_material")], reasons,
      responseOutline: ["从已授权公开资料中匹配内容。", "仅发送已发布的公开链接或附件。", "无法匹配时说明缺少资料。"],
    };
  }

  if (requestedOutcomes.has("create_service_request")) {
    const actions = [
      ...(requestedOutcomes.has("receive_public_material")
        ? [makeAction("deliver_public_material", "none", "public_material")]
        : []),
      makeAction("collect_request_description", "internal_record"),
      makeAction("create_service_request", "internal_record"),
    ];
    return {
      goal, intent, audienceRole, disposition: "collect",
      intentResult, billingDecision, replyGoal: "收集一段需求描述并创建可跟踪的服务请求。",
      actions,
      reasons: [...reasons, "The request needs structured context before any commitment or external action."],
      responseOutline: buildIntakeOutline(intent, input.channel),
    };
  }

  return {
    goal, intent, audienceRole, disposition: "answer",
    intentResult, billingDecision, replyGoal: "根据已授权公开信息直接回答用户问题。",
    actions: [makeAction("answer_public_information")], reasons,
    responseOutline: ["仅根据经过授权的公开知识回答。", "缺少依据时明确说明。", "给出一个安全、具体的下一步。"],
  };
}

export function resolveConversationBillingDecision(input: {
  intentResult: ConversationIntentResult;
  usage: ConversationUsage;
  freeReplyLimit: number;
}): ConversationBillingDecision {
  if (
    input.intentResult.primaryGoal === "unsafe_request"
    || input.intentResult.primaryGoal === "request_human"
  ) {
    return {
      decision: "no_charge",
      billable: false,
      reason: "Safety refusals and human-handoff requests do not consume conversation usage.",
    };
  }
  if (input.usage.passUnlocked || input.usage.deepHelpUnlocked) {
    return {
      decision: "allow_entitlement",
      billable: true,
      reason: "A current conversation entitlement authorizes this turn.",
    };
  }
  if (input.usage.freeRepliesUsed >= input.freeReplyLimit) {
    return {
      decision: "payment_required",
      billable: false,
      reason: "The configured free reply allowance is exhausted.",
    };
  }
  return {
    decision: "allow_free",
    billable: true,
    reason: "An available free reply authorizes this turn.",
  };
}

export function authorizeConversationAction(
  action: PlannedConversationAction,
): ConversationAuthorizationDecision {
  if (action.kind === "execute_tool" || action.externalSideEffect) {
    return {
      decision: "ask",
      reason: "Tool calls and external side effects require the governed Compute authorization flow.",
    };
  }
  if (action.kind === "refuse_unsafe_request") {
    return { decision: "allow", reason: "Fail-closed safety responses are always allowed." };
  }
  return {
    decision: "allow",
    reason: "This built-in action is limited to public data or an internal conversation record.",
  };
}

export function renderReplyPreview(representative: Representative, plan: ConversationPlan): string {
  const header = `${representative.name}\n${representative.tagline}`;
  switch (plan.disposition) {
    case "refuse": return [header, "我不能访问私有文件、账号、凭据或未授权环境。", "我可以继续提供已公开资料，或帮你整理人工接手请求。"].join("\n\n");
    case "payment_required": return [header, `当前免费额度已用完。可选择 ${formatPlanName(plan.suggestedPlan)} 继续。`, "具体价格与权益以当前服务目录为准。"].join("\n\n");
    case "collect": return [header, "请描述你的需求，我会据此创建可跟踪的服务请求。", plan.responseOutline.map((line, index) => `${index + 1}. ${line}`).join("\n")].join("\n\n");
    case "handoff": return [header, "我可以提交人工接手请求，但不会承诺立即回复。", "请简要描述你的需求；联系人、预算和时间等必要信息由真人接手后确认。"].join("\n\n");
    case "answer":
    default: {
      const knowledge = selectPreviewKnowledge(representative, plan);
      return [header, representative.knowledgePack.identitySummary, knowledge ? `${knowledge.title}\n${knowledge.summary}${knowledge.url ? `\n${knowledge.url}` : ""}` : null, "还需要办理事项时，我可以继续收集需求并创建服务请求。"].filter(Boolean).join("\n\n");
    }
  }
}

export function renderFailClosedReplyPreview(representative: Pick<Representative, "name">, userText: string): string {
  return /\p{Script=Han}/u.test(userText)
    ? `${representative.name}\n\n当前无法完成基于已授权资料的回答，请稍后重试，或请求人工接管。`
    : `${representative.name}\n\nI cannot complete an answer from authorized sources right now. Please try again later or request human support.`;
}

function goalForIntent(intent: InquiryIntent): ConversationGoal {
  if (intent === "restricted") return "unsafe_request";
  if (intent === "handoff" || intent === "support") return "request_human";
  if (intent === "materials") return "get_material";
  if (intent === "refund" || intent === "discount") return "perform_action";
  if (["collaboration", "pricing", "scheduling", "candidate", "media"].includes(intent)) return "create_request";
  if (intent === "faq") return "get_information";
  return "unknown";
}

function selectPreviewKnowledge(representative: Representative, plan: ConversationPlan) {
  const all = [...representative.knowledgePack.faq, ...representative.knowledgePack.materials, ...representative.knowledgePack.policies];
  if (plan.intentResult?.requestedOutcomes.includes("receive_public_material")) {
    return all.find((item) => ["deck", "download", "case_study"].includes(item.kind)) ?? all[0] ?? null;
  }
  return all.find((item) => item.kind === "faq") ?? all[0] ?? null;
}

function buildIntakeOutline(intent: InquiryIntent, channel: Channel): string[] {
  void intent;
  void channel;
  return ["请用一段话描述希望解决的问题或获得的结果。", "联系人、预算、时间等必要信息由真人接手后确认。"];
}

function suggestPlan(intent: InquiryIntent): PlanTier {
  return intent === "handoff" || intent === "support" ? "deep_help" : "pass";
}

function formatPlanName(plan: PlanTier | undefined): string {
  return plan === "deep_help" ? "Deep Help" : plan === "sponsor" ? "Sponsor" : "Pass";
}

function requiredCapabilitiesForAction(kind: ConversationActionKind): string[] {
  switch (kind) {
    case "answer_public_information":
      return ["public_knowledge.read"];
    case "deliver_public_material":
      return ["public_material.read"];
    case "collect_request_description":
      return ["conversation_intake.write"];
    case "create_service_request":
      return ["service_request.write"];
    case "execute_tool":
      return ["compute.execute"];
    case "cancel_pending_action":
      return ["delegation.cancel"];
    case "request_human_handoff":
      return ["handoff.request"];
    case "refuse_unsafe_request":
      return [];
  }
}

function detectRequestedOutcomes(
  normalizedText: string,
  compatibilityIntent: InquiryIntent,
): string[] {
  const outcomes: string[] = [];
  if (matchesAny(normalizedText, keywords.materials)) {
    outcomes.push("receive_public_material");
  }
  if (matchesAny(normalizedText, keywords.handoff)) {
    outcomes.push("request_human_follow_up");
  }
  if (compatibilityIntent === "restricted") {
    outcomes.push("access_restricted_resource");
  }
  if (looksLikeServiceRequest(normalizedText)) {
    outcomes.push("create_service_request");
  }
  return [...new Set(outcomes)];
}

function looksLikeServiceRequest(text: string) {
  const requestCues = [
    "申请", "提交", "安排", "预约", "请联系", "希望合作", "想合作", "想聊",
    "需要报价", "申请退款", "申请折扣", "帮我联系", "帮我安排",
    "apply ", "submit ", "book ", "schedule ", "request a quote",
    "request a refund", "contact me", "work with", "collaborate",
  ];
  return requestCues.some((token) => text.includes(token));
}

function looksLikePromptInjection(text: string): boolean {
  return [
    "ignore previous instructions",
    "ignore all instructions",
    "system prompt",
    "developer message",
    "忽略之前的指令",
    "忽略所有指令",
    "系统提示词",
  ].some((token) => text.includes(token));
}

function matchesAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}

export function isConversationCancellationRequest(text: string) {
  return [
    "/cancel",
    "cancel",
    "cancel current task",
    "取消",
    "取消任务",
    "取消当前任务",
    "停止当前任务",
  ].includes(text.trim().toLowerCase());
}

function findMatchedExecutableSkill(
  text: string,
  representative: Pick<Representative, "skillPacks">,
) {
  const normalized = text.toLowerCase();
  if (!looksLikeExplicitActionRequest(normalized)) return undefined;
  return representative.skillPacks
    .filter((pack) => pack.enabled && pack.executesCode)
    .find((pack) => [pack.slug, pack.displayName, ...pack.capabilityTags]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length >= 2)
      .some((value) => normalized.includes(value)));
}

function looksLikeExplicitActionRequest(text: string) {
  return [
    "请使用",
    "帮我",
    "替我",
    "执行",
    "运行",
    "调用",
    "创建",
    "发送",
    "更新",
    "同步",
    "导出",
    "生成",
    "查询",
    "查一下",
    "安排",
    "预订",
    "please ",
    "run ",
    "execute ",
    "use ",
    "call ",
    "create ",
    "send ",
    "update ",
    "sync ",
    "export ",
    "generate ",
    "look up ",
    "lookup ",
    "fetch ",
    "schedule ",
    "book ",
  ].some((token) => text.includes(token));
}

export function hasMatchedExecutableSkill(
  text: string,
  representative: Pick<Representative, "skillPacks">,
) {
  return Boolean(findMatchedExecutableSkill(text, representative));
}
