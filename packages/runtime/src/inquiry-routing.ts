import type {
  ActionKey,
  AudienceRole,
  Channel,
  InquiryIntent,
  PlanTier,
  Representative,
} from "@delegate/domain";

import { evaluateActionGate } from "./action-gate";

export type ConversationUsage = {
  freeRepliesUsed: number;
  passUnlocked: boolean;
  deepHelpUnlocked: boolean;
};

export type ConversationStep =
  | "answer"
  | "collect_intake"
  | "offer_paid_unlock"
  | "handoff"
  | "deny"
  | "ask_owner";

export type ConversationPlan = {
  intent: InquiryIntent;
  audienceRole: AudienceRole;
  action: ActionKey;
  nextStep: ConversationStep;
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

const collaborationKeywords = [
  "合作",
  "cooperate",
  "partnership",
  "partner",
  "bd",
  "collab",
  "业务合作",
  "agency",
];

const pricingKeywords = [
  "价格",
  "报价",
  "多少钱",
  "quote",
  "pricing",
  "budget",
  "费用",
];

const materialsKeywords = [
  "资料",
  "案例",
  "材料",
  "介绍",
  "deck",
  "case study",
  "portfolio",
  "demo",
];

const schedulingKeywords = [
  "预约",
  "时间",
  "schedule",
  "calendar",
  "meeting",
  "call",
  "book",
];

const handoffKeywords = [
  "真人",
  "本人",
  "founder",
  "owner",
  "升级",
  "转接",
  "speak to",
  "talk to",
];

const refundKeywords = ["退款", "refund", "chargeback"];

const discountKeywords = ["折扣", "优惠", "discount", "deal"];

const candidateKeywords = [
  "招聘",
  "求职",
  "简历",
  "candidate",
  "job",
  "hire",
  "resume",
];

const mediaKeywords = [
  "采访",
  "媒体",
  "podcast",
  "press",
  "记者",
  "newsletter",
];

const restrictedKeywords = [
  "密码",
  "token",
  "ssh",
  "服务器",
  "本地文件",
  "private memory",
  "登录",
  "账号密码",
];

const intentToAction: Record<InquiryIntent, ActionKey> = {
  faq: "answer_faq",
  collaboration: "collect_lead",
  pricing: "collect_quote_request",
  materials: "deliver_material",
  scheduling: "collect_scheduling_request",
  handoff: "request_handoff",
  refund: "issue_refund",
  discount: "offer_discount",
  candidate: "collect_lead",
  media: "collect_lead",
  support: "request_handoff",
  restricted: "access_private_files",
  unknown: "answer_faq",
};

export function classifyInquiry(text: string): InquiryIntent {
  const normalized = text.toLowerCase();

  if (matchesAny(normalized, restrictedKeywords)) {
    return "restricted";
  }

  if (matchesAny(normalized, refundKeywords)) {
    return "refund";
  }

  if (matchesAny(normalized, discountKeywords)) {
    return "discount";
  }

  if (matchesAny(normalized, handoffKeywords)) {
    return "handoff";
  }

  if (matchesAny(normalized, pricingKeywords)) {
    return "pricing";
  }

  if (matchesAny(normalized, collaborationKeywords)) {
    return "collaboration";
  }

  if (matchesAny(normalized, schedulingKeywords)) {
    return "scheduling";
  }

  if (matchesAny(normalized, materialsKeywords)) {
    return "materials";
  }

  if (matchesAny(normalized, candidateKeywords)) {
    return "candidate";
  }

  if (matchesAny(normalized, mediaKeywords)) {
    return "media";
  }

  if (
    normalized.includes("help") ||
    normalized.includes("支持") ||
    normalized.includes("问题") ||
    normalized.includes("做什么") ||
    normalized.includes("是什么") ||
    normalized.includes("who are you")
  ) {
    return "faq";
  }

  return "unknown";
}

export function detectAudienceRole(text: string): AudienceRole {
  const normalized = text.toLowerCase();

  if (matchesAny(normalized, candidateKeywords)) {
    return "candidate";
  }

  if (matchesAny(normalized, mediaKeywords)) {
    return "media";
  }

  if (matchesAny(normalized, collaborationKeywords) || matchesAny(normalized, pricingKeywords)) {
    return "lead";
  }

  if (normalized.includes("community") || normalized.includes("群")) {
    return "community";
  }

  if (normalized.includes("partner")) {
    return "partner";
  }

  return "other";
}

export function createConversationPlan(input: PlanInput): ConversationPlan {
  const intent = classifyInquiry(input.text);
  const audienceRole = detectAudienceRole(input.text);
  const action = intentToAction[intent];
  const gate = evaluateActionGate(input.representative, action);
  const reasons = [`Intent detected: ${intent}.`, gate.reason];

  if (gate.mode === "deny" || intent === "restricted") {
    return {
      intent,
      audienceRole,
      action,
      nextStep: "deny",
      reasons,
      responseOutline: [
        "Explain that the representative only operates on public knowledge and safe workflows.",
        "Refuse the request without implying private access is possible later.",
        "Offer a safe alternative such as public materials or structured handoff.",
      ],
    };
  }

  if (gate.mode === "ask_first") {
    return {
      intent,
      audienceRole,
      action,
      nextStep: "ask_owner",
      reasons,
      suggestedPlan: "deep_help",
      responseOutline: [
        "Acknowledge the request.",
        "Explain that this requires owner approval.",
        "Collect the context needed for manual review.",
      ],
    };
  }

  const freeRepliesExhausted =
    input.usage.freeRepliesUsed >= input.representative.contract.freeReplyLimit &&
    !input.usage.passUnlocked &&
    !input.usage.deepHelpUnlocked;

  if (intent === "handoff" || intent === "support") {
    return {
      intent,
      audienceRole,
      action,
      nextStep: "handoff",
      ...(input.usage.deepHelpUnlocked ? {} : { suggestedPlan: "deep_help" as const }),
      reasons: [...reasons, "Human review is explicitly allowed for this request type."],
      responseOutline: [
        "Confirm that a human handoff can be requested.",
        "Collect identity, need, budget, and timing.",
        "Promise only an inbox submission and a review window, not an immediate reply.",
      ],
    };
  }

  if (freeRepliesExhausted) {
    return {
      intent,
      audienceRole,
      action,
      nextStep: "offer_paid_unlock",
      suggestedPlan: suggestPlan(intent),
      reasons: [...reasons, "Free quota is exhausted for this conversation."],
      responseOutline: [
        "State that the free conversation window has been used up.",
        "Offer the smallest fitting paid plan.",
        "Explain what additional depth unlocks.",
      ],
    };
  }

  if (
    intent === "collaboration" ||
    intent === "pricing" ||
    intent === "scheduling" ||
    intent === "refund" ||
    intent === "discount" ||
    intent === "candidate" ||
    intent === "media"
  ) {
    return {
      intent,
      audienceRole,
      action,
      nextStep: "collect_intake",
      ...(input.representative.contract.paywalledIntents.includes(intent)
        ? { suggestedPlan: "pass" as const }
        : {}),
      reasons: [...reasons, "This request is best handled through structured intake."],
      responseOutline: buildIntakeOutline(intent, input.channel),
    };
  }

  return {
    intent,
    audienceRole,
    action,
    nextStep: "answer",
    reasons,
    responseOutline: [
      "Answer from the public knowledge pack.",
      "Stay within explicit scope and boundary wording.",
      "Offer one concrete next action.",
    ],
  };
}

export function renderReplyPreview(
  representative: Representative,
  plan: ConversationPlan,
): string {
  const header = `${representative.name}\n${representative.tagline}`;

  switch (plan.nextStep) {
    case "deny":
      return [
        header,
        "我只能使用公开知识和安全流程工作，不能访问私有文件、私有记忆、账号或本地环境。",
        "如果你愿意，我可以继续提供公开资料，或帮你整理一份可人工评估的请求。",
      ].join("\n\n");

    case "ask_owner":
      return [
        header,
        "这个请求触及折扣、退款、敏感材料或其他需要主人明确批准的事项。",
        "请发送你的身份、具体诉求、背景和时间要求，我会整理成收件项提交人工评估。",
      ].join("\n\n");

    case "offer_paid_unlock":
      return [
        header,
        `当前免费额度已用完。更适合你的下一步是 ${formatPlanName(plan.suggestedPlan)}。`,
        "解锁后我可以继续深入追问、完成需求采集，并把上下文保留在同一段会话里。",
      ].join("\n\n");

    case "collect_intake":
      return [
        header,
        "为了给你更准确的下一步，我需要先做一个简短 intake。",
        plan.responseOutline
          .map((line, index) => `${index + 1}. ${line}`)
          .join("\n"),
      ].join("\n\n");

    case "handoff":
      return [
        header,
        "我可以为你发起人工转接，但不会承诺立即得到本人回复。",
        "请发送：你是谁、想解决什么、预算区间、希望何时推进、为什么需要真人接手。",
      ].join("\n\n");

    case "answer":
    default:
      {
        const matchedKnowledge = selectPreviewKnowledge(representative, plan);
        if (matchedKnowledge) {
          return [
            header,
            representative.knowledgePack.identitySummary,
            `我能根据公开资料回答：${matchedKnowledge.title}`,
            matchedKnowledge.summary,
            matchedKnowledge.url ? `相关链接：${matchedKnowledge.url}` : null,
            "如果你需要更具体的合作判断、报价采集或预约意向，我也可以继续帮你做结构化 intake。",
          ]
            .filter(Boolean)
            .join("\n\n");
        }
      }
      return [
        header,
        representative.knowledgePack.identitySummary,
        "如果你需要更具体的合作判断、报价采集或预约意向，我也可以继续帮你做结构化 intake。",
      ].join("\n\n");
  }
}

function selectPreviewKnowledge(
  representative: Representative,
  plan: ConversationPlan,
) {
  const allKnowledge = [
    ...representative.knowledgePack.faq,
    ...representative.knowledgePack.materials,
    ...representative.knowledgePack.policies,
  ];
  if (!allKnowledge.length) {
    return null;
  }

  if (plan.intent === "materials") {
    return (
      allKnowledge.find((item) => item.kind === "deck" || item.kind === "download" || item.kind === "case_study") ??
      allKnowledge[0]!
    );
  }
  if (plan.intent === "faq" || plan.intent === "unknown") {
    return allKnowledge.find((item) => item.kind === "faq") ?? allKnowledge[0]!;
  }

  return allKnowledge[0]!;
}

function buildIntakeOutline(intent: InquiryIntent, channel: Channel): string[] {
  const moveToPrivateNote =
    channel === "private_chat"
      ? []
      : ["为了保护上下文和联系方式，后续细节建议转到 bot 私聊里继续。"];

  switch (intent) {
    case "pricing":
      return [
        ...moveToPrivateNote,
        "你是谁，来自哪里？",
        "想解决的核心问题是什么？",
        "预算区间大概是多少？",
        "希望多久内推进？",
        "是否希望进入真人评估？",
      ];
    case "scheduling":
      return [
        ...moveToPrivateNote,
        "你希望约什么类型的沟通？",
        "你的目标主题是什么？",
        "你偏好的时间段和时区是什么？",
        "这次沟通是否已经付费或属于付费用户？",
      ];
    case "candidate":
      return [
        ...moveToPrivateNote,
        "你申请的是哪一类角色？",
        "请发一段背景介绍或作品链接。",
        "你最擅长解决什么问题？",
        "可开始时间是什么时候？",
      ];
    case "media":
      return [
        ...moveToPrivateNote,
        "媒体或节目的名称是什么？",
        "希望讨论的主题是什么？",
        "预计发布时间和截稿时间是什么？",
        "是否需要主理人本人参与？",
      ];
    case "collaboration":
    default:
      return [
        ...moveToPrivateNote,
        "你是谁，来自哪里？",
        "你想合作的具体方向是什么？",
        "这件事对你来说为什么现在重要？",
        "预算、资源或流量基础大概如何？",
        "你是否需要真人进一步沟通？",
      ];
  }
}

function suggestPlan(intent: InquiryIntent): PlanTier {
  if (intent === "handoff" || intent === "support") {
    return "deep_help";
  }

  if (intent === "pricing" || intent === "collaboration" || intent === "scheduling") {
    return "pass";
  }

  return "pass";
}

function formatPlanName(plan: PlanTier | undefined): string {
  switch (plan) {
    case "deep_help":
      return "Deep Help";
    case "sponsor":
      return "Sponsor";
    case "pass":
    default:
      return "Pass";
  }
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}
