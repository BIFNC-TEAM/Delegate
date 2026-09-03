import {
  continuationDecisionProposalSchema,
  pendingClarificationSpecSchema,
  validateJsonSchemaValue,
  type ContinuationDecision,
  type PendingClarificationSpec,
} from "@delegate/runtime";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  createConfiguredPlannerAdapters,
  type StrictPlannerAdapter,
  type StrictPlannerRequest,
} from "./turn-planner";

export {
  continuationDecisionProposalSchema,
  pendingClarificationSpecSchema,
};
export type {
  ContinuationDecision,
  PendingClarificationSpec,
};

export type ClarificationContinuationResult =
  | {
      ok: true;
      decision: ContinuationDecision;
      provider: string;
      model: string;
    }
  | {
      ok: false;
      reason: string;
    };

export function buildClarificationContinuationPrompt(input: {
  pending: PendingClarificationSpec;
  currentMessage: string;
  language?: string;
}): StrictPlannerRequest {
  const parsed = z.object({
    pending: pendingClarificationSpecSchema,
    currentMessage: z.string().trim().min(1).max(12_000),
    language: z.string().trim().min(1).max(40).optional(),
  }).strict().parse(input);
  const format = zodTextFormat(
    continuationDecisionProposalSchema,
    "delegate_clarification_continuation_v1",
    { description: "A non-authoritative decision about whether one message continues a pending clarification." },
  );
  return {
    instructions: [
      "Decide whether the current message continues, replaces, cancels, or ambiguously relates to the pending clarification.",
      "Return only the strict JSON object requested by the response schema.",
      "A complete standalone new request must be replace even when it contains a value that could fit a missing slot.",
      "Use continue only when the message primarily supplies one or more missing slots or explicitly refers to the pending request.",
      "Use cancel only for an explicit request to stop, abandon, or dismiss the pending request.",
      "Use ambiguous when both continuation and replacement remain plausible.",
      "For continue, bind only declared slot ids. Every value must be stated in the current message; never infer a hidden value from prior turns.",
      "For replace, cancel, and ambiguous, bindings must be empty.",
      "Do not choose capabilities, alter the pending objective, authorize execution, or answer the user.",
    ].join("\n"),
    input: JSON.stringify(parsed),
    responseSchema: {
      name: "delegate_clarification_continuation_v1",
      description: "A bounded continuation decision with grounded slot bindings.",
      schema: structuredClone(format.schema) as Record<string, unknown>,
      strict: true,
    },
  };
}

export async function resolveClarificationContinuation(input: {
  pending: PendingClarificationSpec;
  currentMessage: string;
  language?: string;
  adapter?: StrictPlannerAdapter;
}): Promise<ClarificationContinuationResult> {
  const pending = pendingClarificationSpecSchema.parse(input.pending);
  const currentMessage = input.currentMessage.trim();
  if (isExplicitClarificationCancellation(currentMessage)) {
    return {
      ok: true,
      decision: {
        protocolVersion: 1,
        decision: "cancel",
        bindings: [],
        confidence: 1,
        reasonCode: "explicit_cancellation",
      },
      provider: "server",
      model: "deterministic-cancel-v1",
    };
  }
  const resolved = input.adapter
    ? { ok: true as const, adapters: [input.adapter] }
    : createConfiguredPlannerAdapters();
  if (!resolved.ok) return { ok: false, reason: "continuation_runtime_unavailable" };
  const request = buildClarificationContinuationPrompt({
    pending,
    currentMessage,
    ...(input.language ? { language: input.language } : {}),
  });
  for (const adapter of resolved.adapters) {
    if (!adapter.supportsStrictStructuredOutput && adapter.serverValidatedJson !== true) {
      continue;
    }
    try {
      const raw = await adapter.generateStrictObject(request);
      const proposal = continuationDecisionProposalSchema.safeParse(raw);
      if (!proposal.success) continue;
      const validated = validateContinuationDecision({
        pending,
        currentMessage,
        proposal: proposal.data,
      });
      if (!validated) continue;
      return {
        ok: true,
        decision: validated,
        provider: adapter.provider,
        model: adapter.model,
      };
    } catch {
      // Try only the configured fallback chain. No decision can execute work.
    }
  }
  return { ok: false, reason: "continuation_decision_unavailable" };
}

export function validateContinuationDecision(input: {
  pending: PendingClarificationSpec;
  currentMessage: string;
  proposal: ContinuationDecision;
}): ContinuationDecision | null {
  const proposal = continuationDecisionProposalSchema.parse(input.proposal);
  if (proposal.decision !== "continue") {
    return proposal.bindings.length === 0 ? proposal : null;
  }
  if (!proposal.bindings.length) return null;
  const slotById = new Map(input.pending.missingSlots.map((slot) => [slot.id, slot] as const));
  const seen = new Set<string>();
  for (const binding of proposal.bindings) {
    const slot = slotById.get(binding.slotId);
    if (!slot || seen.has(binding.slotId)) return null;
    seen.add(binding.slotId);
    if (!isValueGroundedInCurrentMessage(binding.value, input.currentMessage)) return null;
    if (validateJsonSchemaValue(binding.value, slot.schema, `/bindings/${binding.slotId}`).length) {
      return null;
    }
  }
  return proposal;
}

export function isPendingClarificationExpired(
  pending: PendingClarificationSpec,
  now = new Date(),
) {
  return Date.parse(pending.expiresAt) <= now.getTime();
}

export function applyContinuationBindings(input: {
  pending: PendingClarificationSpec;
  decision: ContinuationDecision;
}) {
  const values = new Map(input.decision.bindings.map((binding) => [binding.slotId, binding.value]));
  return {
    boundValues: Object.fromEntries(values),
    remainingSlots: input.pending.missingSlots.filter((slot) => !values.has(slot.id)),
  };
}

function isValueGroundedInCurrentMessage(value: string | number | boolean, message: string) {
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  if (typeof value === "string") {
    return normalized.includes(value.normalize("NFKC").toLocaleLowerCase());
  }
  if (typeof value === "number") return normalized.includes(String(value));
  return normalized.includes(String(value));
}

function isExplicitClarificationCancellation(value: string) {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return /^(?:算了|取消|不查了|不用了|停止|结束|cancel|stop|never\s*mind)[。.!！]?$/iu
    .test(normalized);
}
