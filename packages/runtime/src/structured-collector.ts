import {
  channelSchema,
  inquiryIntentSchema,
  planTierSchema,
  type Channel,
  type InquiryIntent,
  type PlanTier,
} from "@delegate/domain";
import { z } from "zod";

import type { ConversationPlan } from "./inquiry-routing";

const quoteCollectorFields = [
  {
    field: "identity",
    label: "身份",
    prompt: "请介绍一下你是谁、来自哪里，最好带上项目、公司或角色。",
  },
  {
    field: "goal",
    label: "目标",
    prompt: "你想解决的核心问题是什么？如果有背景，也可以一起说明。",
  },
  {
    field: "budget",
    label: "预算",
    prompt: "预算区间大概是多少？如果还不确定，也请直接说明当前阶段。",
  },
  {
    field: "timeline",
    label: "时间",
    prompt: "你希望多久内推进？有没有明确的 deadline 或上线时间？",
  },
  {
    field: "handoffPreference",
    label: "人工需求",
    prompt: "你是想先拿初步判断，还是希望进入真人沟通 / 报价评估？",
  },
] as const;

const schedulingCollectorFields = [
  {
    field: "meetingType",
    label: "沟通类型",
    prompt: "你想约的是什么类型的沟通？例如咨询、合作讨论、面试、媒体采访。",
  },
  {
    field: "agenda",
    label: "议题",
    prompt: "这次沟通最想覆盖的主题是什么？希望产出什么结果？",
  },
  {
    field: "timezone",
    label: "时区",
    prompt: "你的时区是什么？如果方便，也可以直接给城市或 UTC offset。",
  },
  {
    field: "timeWindows",
    label: "可约时间",
    prompt: "你偏好的时间段是什么？请给 2-3 个候选窗口，越具体越好。",
  },
  {
    field: "paidContext",
    label: "付费背景",
    prompt: "这次沟通是否已付费、属于现有客户，或需要先走付费咨询？",
  },
] as const;

const serviceRequestCollectorFields = [
  {
    field: "contact",
    label: "联系人",
    prompt: "请留下称呼和可联系信息；不需要发送密码、支付凭据或其他敏感信息。",
  },
  {
    field: "goal",
    label: "目标",
    prompt: "你希望最终解决什么问题，或获得什么结果？",
  },
  {
    field: "context",
    label: "背景与约束",
    prompt: "请补充当前背景、已经尝试过的方式，以及预算、范围或其他约束。",
  },
  {
    field: "timeline",
    label: "时间与完成标准",
    prompt: "希望何时完成？什么结果可以视为本次请求已处理？",
  },
] as const;

export const structuredCollectorStateSchema = z.object({
  kind: z.enum(["quote", "scheduling", "service_request"]),
  intent: inquiryIntentSchema,
  stepIndex: z.number().int().min(0),
  sourceChannel: channelSchema,
  suggestedPlan: planTierSchema.optional(),
  startedAt: z.string(),
  answers: z.record(z.string(), z.string()),
});

export type StructuredCollectorState = z.infer<typeof structuredCollectorStateSchema>;

type StructuredCollectorQuestion = {
  field: string;
  label: string;
  prompt: string;
};

export function shouldStartStructuredCollector(plan: ConversationPlan): boolean {
  return plan.disposition === "collect";
}

export function beginStructuredCollector(params: {
  plan: ConversationPlan;
  channel: Channel;
}): StructuredCollectorState {
  return {
    kind: params.plan.intent === "scheduling"
      ? "scheduling"
      : params.plan.intent === "pricing" || params.plan.intent === "collaboration"
        ? "quote"
        : "service_request",
    intent: params.plan.intent,
    stepIndex: 0,
    sourceChannel: params.channel,
    ...(params.plan.suggestedPlan ? { suggestedPlan: params.plan.suggestedPlan } : {}),
    startedAt: new Date().toISOString(),
    answers: {},
  };
}

export function readStructuredCollectorState(value: unknown): StructuredCollectorState | null {
  const parsed = structuredCollectorStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function getStructuredCollectorQuestion(
  state: StructuredCollectorState,
): (StructuredCollectorQuestion & { index: number; total: number }) | null {
  const questions = getQuestionsForState(state);
  const question = questions[state.stepIndex];

  if (!question) {
    return null;
  }

  return {
    ...question,
    index: state.stepIndex + 1,
    total: questions.length,
  };
}

export function advanceStructuredCollector(
  state: StructuredCollectorState,
  answer: string,
): {
  completed: boolean;
  state?: StructuredCollectorState;
} {
  const currentQuestion = getStructuredCollectorQuestion(state);
  if (!currentQuestion) {
    return { completed: true };
  }

  const nextAnswers = {
    ...state.answers,
    [currentQuestion.field]: answer.trim(),
  };

  const nextStepIndex = state.stepIndex + 1;
  const questions = getQuestionsForState(state);

  if (nextStepIndex >= questions.length) {
    return {
      completed: true,
      state: {
        ...state,
        stepIndex: nextStepIndex,
        answers: nextAnswers,
      },
    };
  }

  return {
    completed: false,
    state: {
      ...state,
      stepIndex: nextStepIndex,
      answers: nextAnswers,
    },
  };
}

export function formatStructuredCollectorPrompt(state: StructuredCollectorState): string {
  const question = getStructuredCollectorQuestion(state);
  if (!question) {
    return formatStructuredCollectorSummary(state);
  }

  const intro =
    state.kind === "quote"
      ? "我会用 5 个问题整理你的报价 / 合作背景，方便后续评估。"
      : state.kind === "scheduling"
        ? "我会用 5 个问题整理你的预约意向，方便后续给出候选时间。"
        : "我会用 4 个问题整理联系人和需求，完成后创建可跟踪的服务请求。";

  return [
    intro,
    `第 ${question.index}/${question.total} 步 · ${question.label}`,
    question.prompt,
  ].join("\n\n");
}

export function formatStructuredCollectorSummary(state: StructuredCollectorState): string {
  return orderedQuestions(state)
    .map((question) => {
      const value = state.answers[question.field];
      return value ? `${question.label}：${value}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildStructuredCollectorHandoffSummary(
  state: StructuredCollectorState,
): string {
  const firstKey = state.kind === "scheduling" ? "agenda" : "goal";
  const firstValue = state.answers[firstKey] ?? "";
  const timeline = state.answers[state.kind === "scheduling" ? "timeWindows" : "timeline"] ?? "";
  const identity = state.answers.identity ?? state.answers.contact ?? state.answers.meetingType ?? "";
  const normalized = [identity, firstValue, timeline]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" | ");

  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

export function buildStructuredCollectorOwnerAction(
  state: StructuredCollectorState,
): string {
  if (state.kind === "scheduling") {
    return "Review agenda, timezone, and preferred windows before deciding whether to share candidate slots.";
  }

  if (state.kind === "service_request") {
    return "Review the request, decide the next owner response, and create a separately governed task before any tool or external action.";
  }

  return "Review fit, budget, and timeline before deciding whether to quote, invite a paid consult, or decline.";
}

export function calculateStructuredCollectorPriority(
  state: StructuredCollectorState,
  isPaid: boolean,
): number {
  if (isPaid) {
    return 90;
  }

  if (state.kind === "scheduling") {
    return 82;
  }

  if (state.kind === "service_request") {
    return 72;
  }

  const budget = (state.answers.budget ?? "").toLowerCase();
  if (
    budget.includes("k") ||
    budget.includes("万") ||
    budget.includes("budget") ||
    budget.includes("usd")
  ) {
    return 84;
  }

  return 76;
}

function orderedQuestions(state: StructuredCollectorState): readonly StructuredCollectorQuestion[] {
  return getQuestionsForState(state);
}

function getQuestionsForState(
  state: StructuredCollectorState,
): readonly StructuredCollectorQuestion[] {
  return state.kind === "scheduling"
    ? schedulingCollectorFields
    : state.kind === "quote"
      ? quoteCollectorFields
      : serviceRequestCollectorFields;
}
