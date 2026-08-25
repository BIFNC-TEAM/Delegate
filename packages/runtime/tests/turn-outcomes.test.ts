import { describe, expect, it } from "vitest";

import {
  resolveComposerSourceGoalOutcomesV3,
  resolveGoalOutcomesV3,
  validateComposedMessageDraftV3,
  type TurnPlanV3,
} from "../src";

describe("TurnPlan V3 outcomes and composer contract", () => {
  it("derives partial and reconciliation goal outcomes from action truth", () => {
    const plan = planFixture();
    expect(resolveGoalOutcomesV3({
      plan,
      executionEpoch: 3,
      stateVersion: 7,
      actionOutcomes: [
        { actionId: "lookup", status: "succeeded" },
        { actionId: "compose", status: "failed" },
      ],
      satisfiedDeliverableIds: [],
      computedAt: "2026-08-21T10:00:00.000Z",
    })[0]).toMatchObject({ status: "partial", sourceExecutionEpoch: 3 });
    expect(resolveGoalOutcomesV3({
      plan,
      executionEpoch: 3,
      stateVersion: 8,
      actionOutcomes: [
        { actionId: "lookup", status: "reconciliation_required" },
        { actionId: "compose", status: "pending" },
      ],
      satisfiedDeliverableIds: [],
    })[0]?.status).toBe("reconciliation_required");
  });

  it("does not count a primary failure after an allowed alternative succeeds", () => {
    const plan = planFixture();
    plan.actions = [
      {
        ...action("primary"),
        failurePolicy: {
          strategy: "try_planned_alternatives",
          alternativeActionIds: ["backup"],
          terminalStrategy: "stop",
        },
      },
      {
        ...action("backup"),
        activation: {
          mode: "on_failure",
          sourceActionId: "primary",
          allowedFailureCodes: ["primary_unavailable"],
          fallbackGroupKey: "lookup",
          priority: 1,
        },
      },
    ];
    plan.goals[0]!.actionIds = ["primary", "backup"];
    plan.goals[0]!.deliverableIds = [];
    const outcome = resolveGoalOutcomesV3({
      plan,
      executionEpoch: 4,
      stateVersion: 9,
      actionOutcomes: [
        { actionId: "primary", status: "failed" },
        { actionId: "backup", status: "succeeded" },
      ],
      satisfiedDeliverableIds: [],
    })[0]!;
    expect(outcome.status).toBe("succeeded");
    expect(outcome.failedActionIds).toEqual([]);
    expect(outcome.succeededActionIds).toEqual(["backup"]);
  });

  it("accepts evidence-bound claims and server-rendered status codes", () => {
    const result = validateComposedMessageDraftV3({
      plan: planFixture(),
      draft: { segments: [{
        kind: "claim",
        goalId: "goal-1",
        text: "订单状态为已完成。",
        sourceClass: "transactional_authority",
        evidenceRefs: ["order-result-1"],
      }, {
        kind: "status",
        statusCode: "goal_succeeded",
        goalId: "goal-1",
      }] },
      evidence: [{
        evidenceId: "order-result-1",
        evidenceClass: "transactional_authority",
        sourceKinds: ["order_api"],
        goalIds: ["goal-1"],
        sourceActionId: "lookup",
      }],
      actionResults: [{ actionId: "lookup", semanticOutcome: "succeeded" }],
      goalOutcomes: [{ goalId: "goal-1", status: "succeeded" }],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown evidence and stable-general fallback for evidence-bound goals", () => {
    const result = validateComposedMessageDraftV3({
      plan: planFixture(),
      draft: { segments: [{
        kind: "claim",
        goalId: "goal-1",
        text: "我猜订单已经完成。",
        sourceClass: "stable_general",
        evidenceRefs: [],
      }, {
        kind: "claim",
        goalId: "goal-1",
        text: "退款成功。",
        sourceClass: "tool_output",
        evidenceRefs: ["missing"],
      }] },
      evidence: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("not authorized"),
          expect.stringContaining("unknown or incompatible"),
        ]),
      );
    }
  });

  it("allows stable general claims only after a verified knowledge-preferred miss", () => {
    const plan = planFixture();
    plan.goals[0] = {
      ...plan.goals[0]!,
      strategy: "knowledge",
      evidenceRequirement: {
        kind: "knowledge_preferred",
        freshness: "bounded",
        allowedSourceKinds: ["authorized_knowledge"],
        citationRequired: false,
        minimumEvidenceCount: 0,
      },
      evidenceFallbackPolicy: {
        kind: "authorized_knowledge_miss_to_stable_general",
        policySource: "server_planning_default",
        activationStatuses: ["not_found", "unavailable"],
        authorityBoundary: "non_owner_specific_stable_general",
        disclosureRequired: true,
      },
      sourceAuthorityBoundary: {
        classification: "stable_general_allowed",
        policySource: "server_authority_policy",
        policyVersion: "delegate.source-authority.v1",
        reasonCodes: ["no_owner_authority_signal"],
      },
    };
    const draft = { segments: [{
      kind: "claim" as const,
      goalId: "goal-1",
      text: "等温线是连接温度相同地点的曲线。",
      sourceClass: "stable_general" as const,
      evidenceRefs: [],
    }] };

    expect(validateComposedMessageDraftV3({
      plan,
      draft,
      evidence: [],
    }).ok).toBe(false);
    expect(validateComposedMessageDraftV3({
      plan,
      draft,
      evidence: [],
      knowledgeFallback: "not_found",
      goalOutcomes: [{ goalId: "goal-1", status: "succeeded" }],
    }).ok).toBe(true);
  });

  it("allows stable general claims after a capability was denied before execution", () => {
    const plan = planFixture();
    plan.goals[0] = {
      ...plan.goals[0]!,
      strategy: "capability",
      operation: "explain",
      generalEligibility: "not_allowed",
      evidenceRequirement: {
        kind: "capability_result",
        freshness: "bounded",
        allowedSourceKinds: ["capability_result"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
      evidenceFallbackPolicy: {
        kind: "capability_unexecuted_to_stable_general",
        policySource: "server_planning_default",
        activationStatuses: ["entitlement_denied"],
        authorityBoundary: "non_owner_specific_stable_general",
        disclosureRequired: true,
      },
      sourceAuthorityBoundary: {
        classification: "stable_general_allowed",
        policySource: "server_authority_policy",
        policyVersion: "delegate.source-authority.v1",
        reasonCodes: ["stable_general_explanation_confirmed"],
      },
    };
    const result = validateComposedMessageDraftV3({
      plan,
      draft: { segments: [{
        kind: "claim",
        goalId: "goal-1",
        text: "该项目旨在让不同智能体通过标准协议协作。",
        sourceClass: "stable_general",
        evidenceRefs: [],
      }] },
      evidence: [],
      knowledgeFallbacks: [{
        goalId: "goal-1",
        status: "entitlement_denied",
      }],
      goalOutcomes: [{ goalId: "goal-1", status: "failed" }],
    });
    expect(result.ok).toBe(true);
  });

  it("projects terminal source truth without treating the pending Composer as waiting", () => {
    const plan = planFixture();
    expect(resolveComposerSourceGoalOutcomesV3({
      plan,
      executionEpoch: 1,
      stateVersion: 2,
      actionOutcomes: [
        { actionId: "lookup", status: "succeeded" },
        { actionId: "compose", status: "pending" },
      ],
    })[0]?.status).toBe("succeeded");
    expect(resolveComposerSourceGoalOutcomesV3({
      plan,
      executionEpoch: 1,
      stateVersion: 2,
      actionOutcomes: [
        { actionId: "lookup", status: "pending" },
        { actionId: "compose", status: "pending" },
      ],
    })[0]?.status).toBe("waiting");
  });

  it("rejects composition while any source Goal remains waiting", () => {
    const result = validateComposedMessageDraftV3({
      plan: planFixture(),
      draft: { segments: [{
        kind: "status",
        statusCode: "goal_waiting",
        goalId: "goal-1",
      }] },
      evidence: [],
      goalOutcomes: [{ goalId: "goal-1", status: "waiting" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message)).toContain(
        "Composer cannot produce a successful result while a source Goal is waiting.",
      );
    }
  });

  it("rejects status-only success and a failed ActionResult presented as success", () => {
    const plan = planFixture();
    const statusOnly = validateComposedMessageDraftV3({
      plan,
      draft: { segments: [{
        kind: "status",
        statusCode: "goal_succeeded",
        goalId: "goal-1",
        actionId: "lookup",
      }] },
      evidence: [],
      actionResults: [{ actionId: "lookup", semanticOutcome: "failed" }],
      goalOutcomes: [{ goalId: "goal-1", status: "succeeded" }],
    });
    expect(statusOnly.ok).toBe(false);
    if (!statusOnly.ok) {
      expect(statusOnly.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("unsuccessful action"),
          expect.stringContaining("status segment alone"),
        ]),
      );
    }
  });

  it("rejects evidence borrowed from another Goal even when the class matches", () => {
    const plan = planFixture();
    plan.goals.push({
      ...plan.goals[0]!,
      id: "goal-2",
      objective: "查询另一订单",
      actionIds: ["other", "compose"],
    });
    plan.actions.push(action("other"));
    const result = validateComposedMessageDraftV3({
      plan,
      draft: { segments: [{
        kind: "claim",
        goalId: "goal-1",
        text: "订单已完成。",
        sourceClass: "transactional_authority",
        evidenceRefs: ["other-result"],
      }] },
      evidence: [{
        evidenceId: "other-result",
        evidenceClass: "transactional_authority",
        sourceKinds: ["order_api"],
        goalIds: ["goal-2"],
        sourceActionId: "other",
      }],
      actionResults: [{ actionId: "other", semanticOutcome: "succeeded" }],
      goalOutcomes: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message)).toContain(
        "Evidence other-result is not owned by goal goal-1.",
      );
    }
  });

  it("rejects a binding that names a source Action without its ActionResult", () => {
    const result = validateComposedMessageDraftV3({
      plan: planFixture(),
      draft: { segments: [{
        kind: "claim",
        goalId: "goal-1",
        text: "订单已完成。",
        sourceClass: "transactional_authority",
        evidenceRefs: ["orphan-binding"],
      }] },
      evidence: [{
        evidenceId: "orphan-binding",
        evidenceClass: "transactional_authority",
        sourceKinds: ["order_api"],
        goalIds: ["goal-1"],
        sourceActionId: "lookup",
      }],
      goalOutcomes: [{ goalId: "goal-1", status: "succeeded" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message)).toContain(
        "Evidence orphan-binding has no corresponding ActionResult.",
      );
    }
  });

  it("adapts legacy missing Goal coordinates only for an unambiguous single-Goal replay", () => {
    const plan = planFixture();
    const legacy = validateComposedMessageDraftV3({
      plan,
      draft: { segments: [{
        kind: "claim",
        text: "订单已完成。",
        sourceClass: "transactional_authority",
        evidenceRefs: ["order-result"],
      }] },
      evidence: [{
        evidenceId: "order-result",
        evidenceClass: "transactional_authority",
        sourceKinds: ["order_api"],
        sourceActionId: "lookup",
      }],
      actionResults: [{ actionId: "lookup", semanticOutcome: "succeeded" }],
      goalOutcomes: [{ goalId: "goal-1", status: "succeeded" }],
    });
    expect(legacy).toMatchObject({
      ok: true,
      draft: { segments: [{ goalId: "goal-1" }] },
    });

    plan.goals.push({
      ...plan.goals[0]!,
      id: "goal-2",
      actionIds: ["other", "compose"],
    });
    plan.actions.push(action("other"));
    expect(validateComposedMessageDraftV3({
      plan,
      draft: { segments: [{
        kind: "claim",
        text: "订单已完成。",
        sourceClass: "transactional_authority",
        evidenceRefs: ["order-result"],
      }] },
      evidence: [{
        evidenceId: "order-result",
        evidenceClass: "transactional_authority",
        sourceKinds: ["order_api"],
      }],
    }).ok).toBe(false);
  });
});

function planFixture(): TurnPlanV3 {
  return {
    protocolVersion: 3,
    planId: "plan-1",
    scopeKey: { kind: "generation_turn", conversationId: "c1", inputMessageId: "m1" },
    revision: 1,
    envelopeHash: `sha256:${"a".repeat(64)}`,
    capabilityCatalogHash: `sha256:${"b".repeat(64)}`,
    validationPolicyVersion: "v1",
    objective: "查询订单并回复",
    goals: [{
      id: "goal-1",
      objective: "查询订单",
      sourcePointers: ["/currentMessage/text"],
      strategy: "capability",
      operation: "read",
      semanticConfidence: 0.99,
      generalEligibility: "not_allowed",
      actionIds: ["lookup", "compose"],
      deliverableIds: ["reply"],
      evidenceRequirement: {
        kind: "transactional_authority",
        freshness: "live",
        allowedSourceKinds: ["order_api"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
      failurePolicy: { strategy: "stop", reasonCode: "order_lookup_failed" },
    }],
    actions: [action("lookup"), action("compose")],
    deliverables: [{
      id: "reply",
      kind: "message",
      format: "text",
      producedByActionIds: ["compose"],
      completionCriteria: ["回复已验证"],
    }],
    decisionTrace: [],
  };
}

function action(id: string): TurnPlanV3["actions"][number] {
  return {
    id,
    capability: {
      key: id === "compose" ? "response.compose" : "test.action",
      version: "1",
      definitionHash: `sha256:${"c".repeat(64)}`,
    },
    arguments: {},
    argumentProvenance: {},
    dependencies: [],
    activation: { mode: "primary" },
    expectedOutputSchema: { type: "object" },
    completionCriteria: ["完成"],
    failurePolicy: { strategy: "stop", publicMessageCode: "failed" },
  };
}
