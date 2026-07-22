import type { ParsedComputeRequest } from "@delegate/runtime";
import { readPersistedDelegationStepRequest } from "@delegate/runtime";

export type DelegationOrchestrationStep = {
  id: string;
  sequence: number;
  status: string;
  dependsOnStepIds: string[];
  inputSnapshot: unknown;
};

export function validateDelegationStepDependencies(dependencyIndexes: number[], stepIndex: number) {
  if (dependencyIndexes.some((dependencyIndex) => dependencyIndex < 0 || dependencyIndex >= stepIndex)) {
    throw new Error("Delegation task step dependencies must reference an earlier plan step.");
  }
}

export function selectNextDelegationTaskStep(steps: DelegationOrchestrationStep[]) {
  const completedIds = new Set(
    steps.filter((step) => step.status === "COMPLETED" || step.status === "SKIPPED").map((step) => step.id),
  );
  return [...steps]
    .sort((left, right) => left.sequence - right.sequence)
    .find((step) =>
      ["DRAFT", "READY", "BLOCKED"].includes(step.status) &&
      step.dependsOnStepIds.every((dependencyId) => completedIds.has(dependencyId)),
    ) ?? null;
}

export function readDelegationTaskStepRequest(step: { inputSnapshot: unknown }): ParsedComputeRequest | null {
  if (!step.inputSnapshot || typeof step.inputSnapshot !== "object" || Array.isArray(step.inputSnapshot)) return null;
  const snapshot = step.inputSnapshot as Record<string, unknown>;
  return readPersistedDelegationStepRequest(snapshot.request);
}

export function readDelegationExternalEffectRequest(effect: { requestPayload: unknown }): ParsedComputeRequest | null {
  if (!effect.requestPayload || typeof effect.requestPayload !== "object" || Array.isArray(effect.requestPayload)) return null;
  return readPersistedDelegationStepRequest((effect.requestPayload as Record<string, unknown>).request);
}

export function buildExternalEffectActionAvailability(input: {
  status: string;
  hasPersistedRequest: boolean;
}) {
  const reconcile = input.status === "RECONCILIATION_REQUIRED";
  const retry = input.status === "FAILED" && input.hasPersistedRequest;
  const recordCompensation = input.status === "SUCCEEDED";
  return {
    reconcile: {
      enabled: reconcile,
      reason: reconcile
        ? "Confirm the remote outcome before any retry to prevent a duplicate side effect."
        : "Reconciliation is required only when the remote outcome is unknown.",
    },
    retry: {
      enabled: retry,
      reason: retry
        ? "Retry reuses the captured request and idempotency context, then re-evaluates current policy."
        : input.status === "RECONCILIATION_REQUIRED"
          ? "Reconcile the unknown remote outcome before retrying."
          : "Retry is available only for a confirmed failed effect with a captured request.",
    },
    recordCompensation: {
      enabled: recordCompensation,
      reason: recordCompensation
        ? "Record externally completed compensation with evidence; Delegate will not invent an inverse MCP call."
        : "Only a succeeded external effect can be recorded as compensated.",
    },
  };
}
