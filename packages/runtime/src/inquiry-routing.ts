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

export type ConversationActionKind =
  | "answer_public_information"
  | "collect_contact_and_requirements"
  | "deliver_public_material"
  | "create_service_request"
  | "request_human_handoff"
  | "refuse_unsafe_request";

export type PlannedConversationAction = {
  id: string;
  kind: ConversationActionKind;
  status: "planned";
  sideEffect: "none" | "internal_record" | "human_queue";
};

export type ConversationPlan = {
  goal: ConversationGoal;
  intent: InquiryIntent;
  audienceRole: AudienceRole;
  disposition: ConversationDisposition;
  actions: PlannedConversationAction[];
  suggestedPlan?: PlanTier;
  reasons: string[];
  responseOutline: string[];
};

type PlanInput = {
  text: string;
  channel: Channel;
  representative: Representative;
  usage: ConversationUsage;
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
  const normalized = text.toLowerCase();
  const ordered: Array<[InquiryIntent, readonly string[]]> = [
    ["restricted", keywords.restricted], ["refund", keywords.refund], ["discount", keywords.discount],
    ["handoff", keywords.handoff], ["pricing", keywords.pricing], ["collaboration", keywords.collaboration],
    ["scheduling", keywords.scheduling], ["materials", keywords.materials], ["candidate", keywords.candidate],
    ["media", keywords.media],
  ];
  for (const [intent, values] of ordered) if (matchesAny(normalized, values)) return intent;
  if (["help", "支持", "问题", "做什么", "是什么", "who are you"].some((value) => normalized.includes(value))) return "faq";
  return "unknown";
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

export function createConversationPlan(input: PlanInput): ConversationPlan {
  const intent = classifyInquiry(input.text);
  const audienceRole = detectAudienceRole(input.text);
  const goal = goalForIntent(intent);
  const reasons = [`Goal detected: ${goal}.`, `Business label detected: ${intent}.`];
  const makeAction = (kind: ConversationActionKind, sideEffect: PlannedConversationAction["sideEffect"] = "none"): PlannedConversationAction => ({
    id: `${kind}:${intent}`,
    kind,
    status: "planned",
    sideEffect,
  });

  if (intent === "restricted") {
    return {
      goal, intent, audienceRole, disposition: "refuse",
      actions: [makeAction("refuse_unsafe_request")], reasons,
      responseOutline: ["拒绝访问私有系统、凭据或未授权数据。", "提供公开信息或人工接手等安全替代方案。"],
    };
  }

  if (intent === "handoff" || intent === "support") {
    return {
      goal, intent, audienceRole, disposition: "handoff",
      actions: [makeAction("collect_contact_and_requirements", "internal_record"), makeAction("request_human_handoff", "human_queue")],
      ...(input.usage.deepHelpUnlocked ? {} : { suggestedPlan: "deep_help" as const }), reasons,
      responseOutline: ["确认可提交人工接手请求。", "收集身份、目标、背景、时限和联系方式。", "只承诺进入队列，不承诺即时回复。"],
    };
  }

  const freeRepliesExhausted = input.usage.freeRepliesUsed >= input.representative.contract.freeReplyLimit && !input.usage.passUnlocked && !input.usage.deepHelpUnlocked;
  if (freeRepliesExhausted) {
    return {
      goal, intent, audienceRole, disposition: "payment_required", actions: [],
      suggestedPlan: suggestPlan(intent), reasons: [...reasons, "The configured free reply allowance is exhausted."],
      responseOutline: ["说明当前免费额度已用完。", "展示当前价格目录中最小可用的继续方式。"],
    };
  }

  if (intent === "materials") {
    return {
      goal, intent, audienceRole, disposition: "answer",
      actions: [makeAction("answer_public_information"), makeAction("deliver_public_material")], reasons,
      responseOutline: ["从已授权公开资料中匹配内容。", "仅发送已发布的公开链接或附件。", "无法匹配时说明缺少资料。"],
    };
  }

  if (["collaboration", "pricing", "scheduling", "refund", "discount", "candidate", "media"].includes(intent)) {
    return {
      goal, intent, audienceRole, disposition: "collect",
      actions: [makeAction("collect_contact_and_requirements", "internal_record"), makeAction("create_service_request", "internal_record")],
      reasons: [...reasons, "The request needs structured context before any commitment or external action."],
      responseOutline: buildIntakeOutline(intent, input.channel),
    };
  }

  return {
    goal, intent, audienceRole, disposition: "answer",
    actions: [makeAction("answer_public_information")], reasons,
    responseOutline: ["仅根据经过授权的公开知识回答。", "缺少依据时明确说明。", "给出一个安全、具体的下一步。"],
  };
}

export function renderReplyPreview(representative: Representative, plan: ConversationPlan): string {
  const header = `${representative.name}\n${representative.tagline}`;
  switch (plan.disposition) {
    case "refuse": return [header, "我不能访问私有文件、账号、凭据或未授权环境。", "我可以继续提供已公开资料，或帮你整理人工接手请求。"].join("\n\n");
    case "payment_required": return [header, `当前免费额度已用完。可选择 ${formatPlanName(plan.suggestedPlan)} 继续。`, "具体价格与权益以当前服务目录为准。"].join("\n\n");
    case "collect": return [header, "我会先整理必要信息，再创建可跟踪的服务请求。", plan.responseOutline.map((line, index) => `${index + 1}. ${line}`).join("\n")].join("\n\n");
    case "handoff": return [header, "我可以提交人工接手请求，但不会承诺立即回复。", "请发送：你的身份与联系方式、目标、背景、期望时间，以及需要真人处理的原因。"].join("\n\n");
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
  if (plan.intent === "materials") return all.find((item) => ["deck", "download", "case_study"].includes(item.kind)) ?? all[0] ?? null;
  return all.find((item) => item.kind === "faq") ?? all[0] ?? null;
}

function buildIntakeOutline(intent: InquiryIntent, channel: Channel): string[] {
  const privacy = channel === "private_chat" ? [] : ["请转到私聊发送联系方式和敏感背景。"];
  const shared = ["你的身份与可联系信息是什么？", "希望达成什么结果，当前背景是什么？", "有哪些约束、预算或时间要求？", "怎样算处理完成？"];
  if (intent === "scheduling") return [...privacy, "希望沟通的主题和产出是什么？", "请提供时区和 2-3 个候选时间。", "是否有现有订单或服务请求？", "请留下联系人信息。"];
  if (intent === "refund") return [...privacy, "请提供订单标识和联系人信息。", "退款原因及期望结果是什么？", "请勿发送支付凭据或完整敏感信息。"];
  if (intent === "discount") return [...privacy, "请说明目标服务、使用规模和预算约束。", "请留下联系人信息和期望时间。"];
  return [...privacy, ...shared];
}

function suggestPlan(intent: InquiryIntent): PlanTier {
  return intent === "handoff" || intent === "support" ? "deep_help" : "pass";
}

function formatPlanName(plan: PlanTier | undefined): string {
  return plan === "deep_help" ? "Deep Help" : plan === "sponsor" ? "Sponsor" : "Pass";
}

function matchesAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}
