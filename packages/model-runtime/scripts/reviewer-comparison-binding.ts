/** Evaluation-only binding. Production runtime and default model selection are unchanged. */
import type { PiModelBinding } from "../src/pi/types";

type Context = Parameters<PiModelBinding["streamFn"]>[1];

function isGoalAssessment(context: Context) {
  if (!context.systemPrompt?.startsWith("You verify a candidate answer")
    || context.tools?.length || context.messages.length !== 1) return false;
  const message = context.messages[0];
  if (message?.role !== "user" || typeof message.content !== "string") return false;
  try {
    const value: unknown = JSON.parse(message.content);
    return Boolean(value && typeof value === "object" && "candidate" in value && typeof value.candidate === "string"
      && "goal" in value && typeof value.goal === "string" && "observations" in value && Array.isArray(value.observations));
  } catch { return false; }
}

export function createReviewerComparisonBinding(primary: PiModelBinding, reviewer: PiModelBinding): PiModelBinding {
  const route = (primaryStream: PiModelBinding["streamFn"], reviewStream: PiModelBinding["streamFn"]): PiModelBinding["streamFn"] =>
    (_model, context, options) => isGoalAssessment(context)
      ? reviewStream(reviewer.model, context, options)
      : primaryStream(primary.model, context, options);
  return {
    ...primary,
    streamFn: route(primary.streamFn, reviewer.streamFn),
    createObservedStreamFn: (observer, beforeRequest) => route(
      primary.createObservedStreamFn?.(observer, beforeRequest) ?? primary.streamFn,
      reviewer.createObservedStreamFn?.(observer, beforeRequest) ?? reviewer.streamFn,
    ),
  };
}
