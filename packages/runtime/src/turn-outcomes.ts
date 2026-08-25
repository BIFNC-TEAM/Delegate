import { z } from "zod";

import type { TurnPlanV3 } from "./turn-planning-v3";

export type GoalOutcomeV3 = {
  goalId: string;
  status: "waiting" | "succeeded" | "partial" | "failed" | "reconciliation_required";
  satisfiedDeliverableIds: string[];
  succeededActionIds: string[];
  failedActionIds: string[];
  pendingActionIds: string[];
  sourceExecutionEpoch: number;
  sourceStateVersion: number;
  computedAt: string;
};

export function resolveGoalOutcomesV3(input: {
  plan: TurnPlanV3;
  executionEpoch: number;
  stateVersion: number;
  actionOutcomes: Array<{
    actionId: string;
    status: "pending" | "succeeded" | "failed" | "partial" | "skipped" | "canceled" | "reconciliation_required";
  }>;
  satisfiedDeliverableIds: string[];
  computedAt?: string;
}): GoalOutcomeV3[] {
  const actionById = new Map(input.actionOutcomes.map((outcome) => [outcome.actionId, outcome]));
  const planActionById = new Map(input.plan.actions.map((action) => [action.id, action]));
  const satisfied = new Set(input.satisfiedDeliverableIds);
  return input.plan.goals.map((goal) => {
    const outcomes = goal.actionIds.map((actionId) =>
      actionById.get(actionId) ?? { actionId, status: "pending" as const });
    const recoveredFailureIds = new Set(outcomes.flatMap((outcome) => {
      if (outcome.status !== "failed") return [];
      const action = planActionById.get(outcome.actionId);
      if (action?.failurePolicy.strategy !== "try_planned_alternatives") return [];
      return action.failurePolicy.alternativeActionIds.some((alternativeId) =>
        actionById.get(alternativeId)?.status === "succeeded")
        ? [outcome.actionId]
        : [];
    }));
    const succeededActionIds = outcomes
      .filter((outcome) => outcome.status === "succeeded")
      .map((outcome) => outcome.actionId);
    const failedActionIds = outcomes
      .filter((outcome) => (
        outcome.status === "failed"
        && !recoveredFailureIds.has(outcome.actionId)
      ) || outcome.status === "canceled")
      .map((outcome) => outcome.actionId);
    const pendingActionIds = outcomes
      .filter((outcome) => outcome.status === "pending")
      .map((outcome) => outcome.actionId);
    const partial = outcomes.some((outcome) => outcome.status === "partial");
    const reconciliation = outcomes.some((outcome) =>
      outcome.status === "reconciliation_required");
    const deliverables = goal.deliverableIds.filter((id) => satisfied.has(id));
    const status: GoalOutcomeV3["status"] = reconciliation
      ? "reconciliation_required"
      : pendingActionIds.length
        ? "waiting"
        : failedActionIds.length || partial
          ? succeededActionIds.length || deliverables.length
            ? "partial"
            : "failed"
          : goal.deliverableIds.every((id) => satisfied.has(id))
            ? "succeeded"
            : "waiting";
    return {
      goalId: goal.id,
      status,
      satisfiedDeliverableIds: deliverables,
      succeededActionIds,
      failedActionIds,
      pendingActionIds,
      sourceExecutionEpoch: input.executionEpoch,
      sourceStateVersion: input.stateVersion,
      computedAt: input.computedAt ?? new Date().toISOString(),
    };
  });
}

/**
 * Composer runs before its own ActionResult and reply Deliverable exist. This
 * projection removes only those circular coordinates and derives the terminal
 * truth of the source Actions. It must never turn a pending source Action into
 * a completed Goal.
 */
export function resolveComposerSourceGoalOutcomesV3(input: {
  plan: TurnPlanV3;
  executionEpoch: number;
  stateVersion: number;
  actionOutcomes: Array<{
    actionId: string;
    status: "pending" | "succeeded" | "failed" | "partial" | "skipped" | "canceled" | "reconciliation_required";
  }>;
  computedAt?: string;
}) {
  const composerActionIds = new Set(input.plan.actions.flatMap((action) =>
    action.capability.key === "response.compose" ? [action.id] : []));
  const sourcePlan: TurnPlanV3 = {
    ...input.plan,
    goals: input.plan.goals.map((goal) => ({
      ...goal,
      actionIds: goal.actionIds.filter((actionId) =>
        !composerActionIds.has(actionId)),
      // Reply deliverables are circular at composition time. Non-message
      // source deliverables must already have their own source Actions and are
      // reflected in those Action outcomes.
      deliverableIds: [],
    })),
    actions: input.plan.actions.filter((action) =>
      !composerActionIds.has(action.id)),
    deliverables: [],
  };
  return resolveGoalOutcomesV3({
    plan: sourcePlan,
    executionEpoch: input.executionEpoch,
    stateVersion: input.stateVersion,
    actionOutcomes: input.actionOutcomes.filter((outcome) =>
      !composerActionIds.has(outcome.actionId)),
    satisfiedDeliverableIds: [],
    ...(input.computedAt ? { computedAt: input.computedAt } : {}),
  });
}

export const composerEvidenceClassV3Schema = z.enum([
  "authorized_knowledge",
  "tool_output",
  "transactional_authority",
  "stable_general",
]);

export type ComposerEvidenceReferenceV3 = {
  evidenceId: string;
  evidenceClass: z.infer<typeof composerEvidenceClassV3Schema>;
  sourceKinds?: string[];
  goalIds?: string[];
  sourceActionId?: string;
  actionResultId?: string;
};

export type ComposerActionResultV3 = {
  actionId: string;
  actionResultId?: string;
  transportOutcome?: string;
  semanticOutcome?: string;
};

export type KnowledgeFallbackActivationV3 = {
  goalId: string;
  status:
    | "not_found"
    | "unavailable"
    | "planner_unavailable"
    | "capability_unavailable"
    | "compiler_unavailable"
    | "entitlement_denied"
    | "confirmed_not_sent";
};

export const composedMessageDraftV3Schema = z.object({
  segments: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("claim"),
      goalId: z.string().trim().min(1).max(160),
      text: z.string().trim().min(1).max(4_000),
      sourceClass: composerEvidenceClassV3Schema,
      evidenceRefs: z.array(z.string().trim().min(1).max(240)).max(32),
    }).strict(),
    z.object({
      kind: z.literal("inference"),
      goalId: z.string().trim().min(1).max(160),
      text: z.string().trim().min(1).max(4_000),
      sourceClass: composerEvidenceClassV3Schema.exclude(["stable_general"]),
      inferenceFromRefs: z.array(z.string().trim().min(1).max(240)).min(1).max(32),
    }).strict(),
    z.object({
      kind: z.literal("status"),
      statusCode: z.enum([
        "goal_succeeded",
        "goal_partial",
        "goal_failed",
        "goal_waiting",
        "goal_reconciliation_required",
      ]),
      goalId: z.string().trim().min(1).max(160),
      actionId: z.string().trim().min(1).max(160).optional(),
    }).strict(),
  ])).min(1).max(128),
}).strict();

export type ComposedMessageDraftV3 = z.infer<typeof composedMessageDraftV3Schema>;

/**
 * Replay adapter for drafts written before claim-level Goal coordinates were
 * required. It is deliberately narrow: only a single-Goal Plan can inherit a
 * missing goalId, and an inference class is recoverable only from one uniform
 * evidence class. Multi-Goal ambiguity fails closed.
 */
export function adaptComposedMessageDraftV3(input: {
  draft: unknown;
  plan: TurnPlanV3;
  evidence?: ComposerEvidenceReferenceV3[];
}) {
  const record = asRecord(input.draft);
  const segments = Array.isArray(record?.["segments"])
    ? record!["segments"] as unknown[]
    : null;
  if (!segments) return input.draft;
  const singleGoalId = input.plan.goals.length === 1
    ? input.plan.goals[0]!.id
    : null;
  const evidenceClassById = new Map(
    (input.evidence ?? []).map((item) => [item.evidenceId, item.evidenceClass]),
  );
  return {
    ...record,
    segments: segments.map((value) => {
      const segment = asRecord(value);
      if (!segment || typeof segment["kind"] !== "string") return value;
      const goalId = typeof segment["goalId"] === "string"
        ? segment["goalId"]
        : singleGoalId;
      if (!goalId) return value;
      if (segment["kind"] !== "inference" || typeof segment["sourceClass"] === "string") {
        return { ...segment, goalId };
      }
      const refs = Array.isArray(segment["inferenceFromRefs"])
        ? segment["inferenceFromRefs"].filter((item): item is string =>
            typeof item === "string")
        : [];
      const classes = new Set(refs.flatMap((ref) => {
        const evidenceClass = evidenceClassById.get(ref);
        return evidenceClass ? [evidenceClass] : [];
      }));
      if (classes.size !== 1 || classes.has("stable_general")) {
        return { ...segment, goalId };
      }
      return { ...segment, goalId, sourceClass: [...classes][0] };
    }),
  };
}

export function validateComposedMessageDraftV3(input: {
  draft: unknown;
  plan: TurnPlanV3;
  evidence: ComposerEvidenceReferenceV3[];
  actionResults?: ComposerActionResultV3[];
  goalOutcomes?: Array<Pick<GoalOutcomeV3, "goalId" | "status">>;
  knowledgeFallbacks?: KnowledgeFallbackActivationV3[];
  /** @deprecated Single-goal replay adapter only. */
  knowledgeFallback?: "not_found" | "unavailable";
}) {
  const parsed = composedMessageDraftV3Schema.safeParse(
    adaptComposedMessageDraftV3({
      draft: input.draft,
      plan: input.plan,
      evidence: input.evidence,
    }),
  );
  if (!parsed.success) return { ok: false as const, issues: parsed.error.issues };
  const issues: Array<{ path: string; message: string }> = [];
  reportDuplicateComposerCoordinates(
    input.evidence.map((item) => item.evidenceId),
    "evidence",
    issues,
  );
  reportDuplicateComposerCoordinates(
    (input.actionResults ?? []).map((item) => item.actionId),
    "actionResults",
    issues,
  );
  reportDuplicateComposerCoordinates(
    (input.actionResults ?? []).flatMap((item) =>
      item.actionResultId ? [item.actionResultId] : []),
    "actionResultIds",
    issues,
  );
  reportDuplicateComposerCoordinates(
    (input.goalOutcomes ?? []).map((item) => item.goalId),
    "goalOutcomes",
    issues,
  );
  const evidence = new Map(input.evidence.map((item) => [item.evidenceId, item]));
  const goals = new Map(input.plan.goals.map((goal) => [goal.id, goal]));
  const actions = new Map(input.plan.actions.map((action) => [action.id, action]));
  const actionResults = new Map((input.actionResults ?? []).map((result) => [
    result.actionId,
    result,
  ]));
  const actionResultsById = new Map((input.actionResults ?? []).flatMap((result) =>
    result.actionResultId ? [[result.actionResultId, result] as const] : []));
  const goalOutcomes = new Map((input.goalOutcomes ?? []).map((outcome) => [
    outcome.goalId,
    outcome,
  ]));
  const fallbackByGoalId = new Map((input.knowledgeFallbacks ?? []).map((item) => [
    item.goalId,
    item,
  ]));
  if (input.knowledgeFallback && input.plan.goals.length === 1) {
    fallbackByGoalId.set(input.plan.goals[0]!.id, {
      goalId: input.plan.goals[0]!.id,
      status: input.knowledgeFallback,
    });
  }
  const factualSegmentsByGoal = new Map<string, number>();
  const evidenceRefsByGoal = new Map<string, Set<string>>();
  parsed.data.segments.forEach((segment, index) => {
    const path = `/segments/${index}`;
    const goal = goals.get(segment.goalId);
    if (!goal) {
      issues.push({ path, message: `Segment references unknown goal ${segment.goalId}.` });
      return;
    }
    if (segment.kind === "claim" || segment.kind === "inference") {
      factualSegmentsByGoal.set(
        goal.id,
        (factualSegmentsByGoal.get(goal.id) ?? 0) + 1,
      );
      const sourceClass = segment.sourceClass;
      const refs = segment.kind === "claim"
        ? segment.evidenceRefs
        : segment.inferenceFromRefs;
      if (!isEvidenceClassAllowedForGoal(goal, sourceClass, fallbackByGoalId)) {
        issues.push({ path, message: `Evidence class ${sourceClass} is not authorized for goal ${goal.id}.` });
      }
      if (segment.kind === "claim" && sourceClass === "stable_general") {
        if (refs.length) {
          issues.push({ path, message: "Stable-general claims cannot carry fabricated evidence references." });
        }
      } else if (!refs.length) {
        issues.push({ path, message: "Evidence-bound claims and inferences require evidence references." });
      }
      const refsForGoal = evidenceRefsByGoal.get(goal.id) ?? new Set<string>();
      evidenceRefsByGoal.set(goal.id, refsForGoal);
      for (const evidenceId of refs) {
        const source = evidence.get(evidenceId);
        if (!source || source.evidenceClass !== sourceClass) {
          issues.push({ path, message: `Segment references unknown or incompatible evidence ${evidenceId}.` });
          continue;
        }
        if (!evidenceBelongsToGoal(source, goal.id, goal.actionIds, input.plan.goals.length)) {
          issues.push({ path, message: `Evidence ${evidenceId} is not owned by goal ${goal.id}.` });
          continue;
        }
        if (!evidenceSourceKindAllowed(source, goal.evidenceRequirement.allowedSourceKinds)) {
          issues.push({ path, message: `Evidence ${evidenceId} has no allowed source kind for goal ${goal.id}.` });
          continue;
        }
        const boundResult = source.actionResultId
          ? actionResultsById.get(source.actionResultId)
          : source.sourceActionId
            ? actionResults.get(source.sourceActionId)
            : undefined;
        if ((source.actionResultId || source.sourceActionId) && !boundResult) {
          issues.push({ path, message: `Evidence ${evidenceId} has no corresponding ActionResult.` });
          continue;
        }
        if (
          boundResult
          && (
            (source.sourceActionId && boundResult.actionId !== source.sourceActionId)
            || !goal.actionIds.includes(boundResult.actionId)
            || (boundResult.semanticOutcome !== "succeeded"
              && boundResult.semanticOutcome !== "partial")
          )
        ) {
          issues.push({ path, message: `Evidence ${evidenceId} is bound to an unsuccessful ActionResult.` });
          continue;
        }
        refsForGoal.add(evidenceId);
      }
    } else {
      const outcome = goalOutcomes.get(goal.id);
      const expectedStatus = outcome ? goalStatusCode(outcome.status) : null;
      if (!expectedStatus || expectedStatus !== segment.statusCode) {
        issues.push({ path, message: `Status ${segment.statusCode} does not match the verified GoalOutcome for ${goal.id}.` });
      }
      if (segment.actionId) {
        if (!actions.has(segment.actionId) || !goal.actionIds.includes(segment.actionId)) {
          issues.push({ path, message: `Status references action ${segment.actionId} outside goal ${goal.id}.` });
        }
        const result = actionResults.get(segment.actionId);
        if (
          segment.statusCode === "goal_succeeded"
          && result
          && result.semanticOutcome !== "succeeded"
        ) {
          issues.push({ path, message: `Succeeded status references unsuccessful action ${segment.actionId}.` });
        }
      }
      if (
        segment.statusCode === "goal_succeeded"
        && goal.actionIds.some((actionId) => {
          const result = actionResults.get(actionId);
          return result && result.semanticOutcome !== "succeeded";
        })
      ) {
        issues.push({ path, message: `Goal ${goal.id} cannot succeed while an owned ActionResult is unsuccessful.` });
      }
    }
  });
  for (const goal of input.plan.goals) {
    const outcome = goalOutcomes.get(goal.id);
    if (!outcome) {
      issues.push({
        path: `/goals/${goal.id}`,
        message: "Composer requires a source GoalOutcome for every planned Goal.",
      });
      continue;
    }
    if (outcome.status === "waiting") {
      issues.push({
        path: `/goals/${goal.id}`,
        message: "Composer cannot produce a successful result while a source Goal is waiting.",
      });
    }
    const knowledgeFallbackActive = isKnowledgeFallbackActive(
      goal,
      fallbackByGoalId,
    );
    const evidenceBound = goal.evidenceRequirement.kind !== "none"
      && !knowledgeFallbackActive;
    if (
      outcome
      && (outcome.status === "succeeded" || outcome.status === "partial")
      && (evidenceBound || knowledgeFallbackActive)
      && !(factualSegmentsByGoal.get(goal.id) ?? 0)
    ) {
      issues.push({
        path: `/goals/${goal.id}`,
        message: "An evidence-bound Goal cannot be completed by a status segment alone.",
      });
    }
    const minimum = evidenceBound
      ? goal.evidenceRequirement.minimumEvidenceCount
      : 0;
    if (
      (factualSegmentsByGoal.get(goal.id) ?? 0) > 0
      && (evidenceRefsByGoal.get(goal.id)?.size ?? 0) < minimum
    ) {
      issues.push({
        path: `/goals/${goal.id}`,
        message: `Goal requires at least ${minimum} verified evidence item(s).`,
      });
    }
  }
  return issues.length
    ? { ok: false as const, issues }
    : { ok: true as const, draft: parsed.data };
}

function isEvidenceClassAllowedForGoal(
  goal: TurnPlanV3["goals"][number],
  evidenceClass: z.infer<typeof composerEvidenceClassV3Schema>,
  fallbackByGoalId: Map<string, KnowledgeFallbackActivationV3>,
) {
  if (evidenceClass === "stable_general") {
    return (
      goal.evidenceRequirement.kind === "none"
      && goal.evidenceRequirement.freshness === "stable"
      && goal.strategy === "general"
    ) || isKnowledgeFallbackActive(goal, fallbackByGoalId);
  }
  const allowed = new Set<z.infer<typeof composerEvidenceClassV3Schema>>();
  switch (goal.evidenceRequirement.kind) {
    case "authorized_knowledge":
    case "knowledge_preferred":
      allowed.add("authorized_knowledge");
      break;
    case "capability_result":
    case "current_external":
      allowed.add("tool_output");
      break;
    case "transactional_authority":
      allowed.add("transactional_authority");
      break;
    case "none":
      break;
  }
  for (const sourceKind of goal.evidenceRequirement.allowedSourceKinds) {
    if (sourceKind === "authorized_knowledge") allowed.add(sourceKind);
    if (sourceKind === "tool_output" || sourceKind === "capability_result" || sourceKind === "current_external") {
      allowed.add("tool_output");
    }
    if (sourceKind === "transactional_authority") allowed.add(sourceKind);
  }
  return allowed.has(evidenceClass);
}

function isKnowledgeFallbackActive(
  goal: TurnPlanV3["goals"][number],
  fallbackByGoalId: Map<string, KnowledgeFallbackActivationV3>,
) {
  const policy = goal.evidenceFallbackPolicy;
  const activation = fallbackByGoalId.get(goal.id);
  return Boolean(
    policy
    && policy.kind !== "none"
    && goal.sourceAuthorityBoundary?.classification === "stable_general_allowed"
    && activation
    && (policy.activationStatuses as readonly string[]).includes(activation.status),
  );
}

function evidenceBelongsToGoal(
  evidence: ComposerEvidenceReferenceV3,
  goalId: string,
  goalActionIds: string[],
  goalCount: number,
) {
  if (evidence.goalIds?.length && !evidence.goalIds.includes(goalId)) return false;
  if (evidence.sourceActionId && !goalActionIds.includes(evidence.sourceActionId)) {
    return false;
  }
  return Boolean(evidence.goalIds?.length || evidence.sourceActionId || goalCount === 1);
}

function evidenceSourceKindAllowed(
  evidence: ComposerEvidenceReferenceV3,
  allowedSourceKinds: string[],
) {
  if (!allowedSourceKinds.length) return false;
  const sourceKinds = new Set([
    evidence.evidenceClass,
    ...(evidence.sourceKinds ?? []),
  ]);
  if (evidence.evidenceClass === "tool_output") {
    sourceKinds.add("capability_result");
  }
  return allowedSourceKinds.some((kind) => sourceKinds.has(kind));
}

function goalStatusCode(status: GoalOutcomeV3["status"]) {
  switch (status) {
    case "succeeded": return "goal_succeeded" as const;
    case "partial": return "goal_partial" as const;
    case "failed": return "goal_failed" as const;
    case "waiting": return "goal_waiting" as const;
    case "reconciliation_required": return "goal_reconciliation_required" as const;
  }
}

function reportDuplicateComposerCoordinates(
  values: string[],
  path: string,
  issues: Array<{ path: string; message: string }>,
) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push({
        path: `/${path}`,
        message: `Duplicate Composer coordinate ${value} is not allowed.`,
      });
    }
    seen.add(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
