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

const requestDescriptionCollectorField = {
  field: "description",
  label: "需求描述",
  prompt: "请用一段话描述你希望解决的问题或获得的结果。其他信息可在真人接手后再补充。",
} as const;

const collectorQuestionFieldSchema = z.enum([
  "identity",
  "goal",
  "budget",
  "timeline",
  "handoffPreference",
  "meetingType",
  "agenda",
  "timezone",
  "timeWindows",
  "paidContext",
  "contact",
  "context",
  "description",
]);

export const structuredCollectorStateSchema = z.object({
  kind: z.enum(["quote", "scheduling", "service_request"]),
  intent: inquiryIntentSchema,
  stepIndex: z.number().int().min(0),
  sourceChannel: channelSchema,
  suggestedPlan: planTierSchema.optional(),
  startedAt: z.string(),
  answers: z.record(z.string(), z.string()),
  questionFields: z.array(collectorQuestionFieldSchema).min(1).max(5).optional(),
});

export type StructuredCollectorState = z.infer<typeof structuredCollectorStateSchema>;

type StructuredCollectorQuestion = {
  field: z.infer<typeof collectorQuestionFieldSchema>;
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
  const kind = params.plan.intent === "scheduling"
    ? "scheduling"
    : params.plan.intent === "pricing" || params.plan.intent === "collaboration"
      ? "quote"
      : "service_request";
  return {
    kind,
    intent: params.plan.intent,
    stepIndex: 0,
    sourceChannel: params.channel,
    ...(params.plan.suggestedPlan ? { suggestedPlan: params.plan.suggestedPlan } : {}),
    startedAt: new Date().toISOString(),
    answers: {},
    questionFields: [requestDescriptionCollectorField.field],
  };
}

export function readStructuredCollectorState(value: unknown): StructuredCollectorState | null {
  const parsed = structuredCollectorStateSchema.safeParse(value);
  if (!parsed.success) return null;
  if (
    parsed.data.questionFields?.length === 1
    && parsed.data.questionFields[0] === requestDescriptionCollectorField.field
  ) {
    return parsed.data;
  }
  return {
    ...parsed.data,
    stepIndex: 0,
    questionFields: [requestDescriptionCollectorField.field],
  };
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

  const intro = "请先描述需求；完成后我会创建可跟踪的服务请求。需要补充的信息由真人接手后继续询问。";

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
  const description = state.answers.description?.trim();
  if (description) {
    return description.length > 180 ? `${description.slice(0, 177)}...` : description;
  }
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
    return "Review the request, take over when appropriate, then collect timezone and candidate windows.";
  }

  if (state.kind === "service_request") {
    return "Review the request, take over when appropriate, and collect any missing details before creating a governed task.";
  }

  return "Review the request, then collect scope, budget, and timing before quoting, offering a paid service, or declining.";
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
  _state: StructuredCollectorState,
): readonly StructuredCollectorQuestion[] {
  return [requestDescriptionCollectorField];
}
