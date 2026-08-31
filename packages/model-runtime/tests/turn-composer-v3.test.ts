import { describe, expect, it, vi } from "vitest";

import type { StrictPlannerAdapter } from "../src";
import { buildTurnComposerV3Prompt, composeTurnV3 } from "../src";

describe("TurnPlan V3 composer", () => {
  it("returns only a validated evidence-bound draft", async () => {
    const adapter: StrictPlannerAdapter = {
      provider: "test",
      model: "composer-test",
      supportsStrictStructuredOutput: true,
      generateStrictObject: vi.fn().mockResolvedValue({
        segments: [{
          kind: "claim",
          goalId: "goal-1",
          text: "订单已完成。",
          sourceClass: "transactional_authority",
          evidenceRefs: ["order-1"],
        }],
      }),
    };
    const result = await composeTurnV3({
      plan: planFixture(),
      taskInput: { text: "查询订单状态", language: "zh" },
      actionResults: [],
      evidence: [{
        evidenceId: "order-1",
        evidenceClass: "transactional_authority",
        sourceKinds: ["order_api"],
        content: { status: "completed" },
      }],
      goalOutcomes: [{ goalId: "goal-1", status: "succeeded" }],
      adapter,
    });
    expect(result).toMatchObject({ ok: true, provider: "test" });
  });

  it("fails closed when the provider invents an evidence reference", async () => {
    const result = await composeTurnV3({
      plan: planFixture(),
      taskInput: { text: "查询订单状态", language: "zh" },
      actionResults: [],
      evidence: [],
      goalOutcomes: [{ goalId: "goal-1", status: "succeeded" }],
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-1",
            text: "订单已完成。",
            sourceClass: "transactional_authority",
            evidenceRefs: ["invented"],
          }],
        }),
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "composition_failed",
      diagnostics: [{
        stage: "evidence_validation",
        issueCodes: expect.arrayContaining(["evidence_ref_unknown_or_class_mismatch"]),
      }],
    });
  });

  it("answers an evidence-free stable-general goal in the requested language", async () => {
    const result = await composeTurnV3({
      plan: stableGeneralPlanFixture(),
      taskInput: { text: "请用三句话解释 CAP 定理", language: "zh" },
      actionResults: [],
      evidence: [],
      goalOutcomes: [{ goalId: "goal-general", status: "succeeded" }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-general",
            text: "CAP 定理说明，在网络分区发生时，一致性与可用性无法同时完全保证。",
            sourceClass: "stable_general",
            evidenceRefs: [],
          }],
        }),
      },
    });

    expect(result).toMatchObject({ ok: true, provider: "test" });
  });

  it("discards invented references from an authorized stable-general fallback claim", async () => {
    const result = await composeTurnV3({
      plan: knowledgeFallbackPlanFixture(),
      taskInput: { text: "新西兰的气候特征是什么", language: "zh" },
      actionResults: [{ actionId: "knowledge", semanticOutcome: "succeeded" }],
      evidence: [],
      goalOutcomes: [{ goalId: "goal-fallback", status: "succeeded" }],
      knowledgeFallbacks: [{ goalId: "goal-fallback", status: "not_found" }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-fallback",
            text: "新西兰大部分地区属于温带海洋性气候。",
            sourceClass: "stable_general",
            // Some providers copy an evidence alias even though a verified
            // Knowledge miss supplies no evidence. Stable-general facts are
            // explicitly evidence-free, so this coordinate must be discarded.
            evidenceRefs: ["E1"],
          }],
        }),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      draft: {
        segments: [{ sourceClass: "stable_general", evidenceRefs: [] }],
      },
    });
  });

  it("composes a disclosed stable answer after a capability entitlement denial", async () => {
    const result = await composeTurnV3({
      plan: capabilityFallbackPlanFixture(),
      taskInput: { text: "a2aproject/A2A 主要解决什么问题？", language: "zh" },
      actionResults: [],
      evidence: [],
      goalOutcomes: [{ goalId: "goal-capability-fallback", status: "failed" }],
      knowledgeFallbacks: [{
        goalId: "goal-capability-fallback",
        status: "entitlement_denied",
      }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "inference",
            goalId: "goal-capability-fallback",
            text: "A2A 项目旨在通过开放协议促进不同智能体之间的互操作与协作。",
            sourceClass: "tool_output",
            inferenceFromRefs: ["E1"],
          }],
        }),
      },
    });
    expect(result).toMatchObject({
      ok: true,
      provider: "test",
      draft: {
        segments: [{
          kind: "claim",
          sourceClass: "stable_general",
          evidenceRefs: [],
        }],
      },
    });
  });

  it("rejects a missing-evidence refusal for an authorized stable-general goal", async () => {
    const result = await composeTurnV3({
      plan: stableGeneralPlanFixture(),
      taskInput: { text: "请用三句话解释 CAP 定理", language: "zh" },
      actionResults: [],
      evidence: [],
      goalOutcomes: [{ goalId: "goal-general", status: "succeeded" }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-general",
            text: "I am unable to generate a response because no evidence or action results were provided.",
            sourceClass: "stable_general",
            evidenceRefs: [],
          }],
        }),
      },
    });

    expect(result).toMatchObject({ ok: false, code: "composition_failed" });
  });

  it("passes the normalized user task separately from evidence", () => {
    const request = buildTurnComposerV3Prompt({
      plan: stableGeneralPlanFixture(),
      taskInput: { text: "请用三句话解释 CAP 定理", language: "zh" },
      actionResults: [],
      evidence: [],
      goalOutcomes: [{ goalId: "goal-general", status: "succeeded" }],
      responseLanguage: "zh",
      representativeStyle: {
        representativeName: "地理代表——周行知",
        tone: "清晰、直接、礼貌，优先给出下一步，而不是泛泛闲聊。",
      },
    });
    const input = JSON.parse(request.input);

    expect(input.taskInput).toEqual({
      text: "请用三句话解释 CAP 定理",
      language: "zh",
    });
    expect(input.evidence).toEqual([]);
    expect(input.evidenceClassMapping).toEqual({
      capability_result: "tool_output",
    });
    expect(input.representativeStyle).toEqual({
      representativeName: "地理代表——周行知",
      tone: "清晰、直接、礼貌，优先给出下一步，而不是泛泛闲聊。",
    });
    expect(request.instructions).toContain("not evidence");
    expect(request.instructions).toContain("清晰、直接、礼貌");
    expect(request.instructions).toContain("Never prefix prose");
  });

  it("normalizes short evidence aliases into canonical knowledge references", async () => {
    const evidence = [{
      evidenceId: "memory-use-item-profile-long-reference",
      evidenceClass: "authorized_knowledge" as const,
      sourceKinds: ["public_knowledge"],
      content: "等温线连接气温相同的地点，判读时应结合纬度、海陆和地形。",
    }, {
      evidenceId: "memory-use-item-material-long-reference",
      evidenceClass: "authorized_knowledge" as const,
      sourceKinds: ["public_knowledge"],
      content: "学习建议包括理解概念、练习判读和结合案例复盘。",
    }];
    const result = await composeTurnV3({
      plan: authorizedKnowledgePlanFixture(),
      taskInput: { text: "什么是等温线，我应该怎么学习？", language: "zh" },
      actionResults: [{ actionId: "knowledge", semanticOutcome: "succeeded" }],
      evidence,
      goalOutcomes: [{ goalId: "goal-knowledge", status: "succeeded" }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-knowledge",
            text: "等温线是连接气温相同地点的曲线。",
            sourceClass: "authorized_knowledge",
            evidenceRefs: ["E1"],
          }, {
            kind: "inference",
            goalId: "goal-knowledge",
            sourceClass: "authorized_knowledge",
            text: "可以按理解概念、练习判读、结合案例复盘三个步骤学习。",
            inferenceFromRefs: ["E1", "E2"],
          }],
        }),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      draft: {
        segments: [{
          evidenceRefs: ["memory-use-item-profile-long-reference"],
        }, {
          inferenceFromRefs: [
            "memory-use-item-profile-long-reference",
            "memory-use-item-material-long-reference",
          ],
        }],
      },
    });
  });

  it("diagnoses stable-general output as invalid for a knowledge-bound goal", async () => {
    const result = await composeTurnV3({
      plan: authorizedKnowledgePlanFixture(),
      taskInput: { text: "解释这个知识点", language: "zh" },
      actionResults: [],
      evidence: [{
        evidenceId: "knowledge-1",
        evidenceClass: "authorized_knowledge",
        sourceKinds: ["public_knowledge"],
        content: "已授权知识内容。",
      }],
      goalOutcomes: [{ goalId: "goal-knowledge", status: "succeeded" }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-knowledge",
            text: "这是一个通用模型回答。",
            sourceClass: "stable_general",
            evidenceRefs: [],
          }],
        }),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{
        stage: "evidence_validation",
        issueCodes: expect.arrayContaining(["stable_general_not_allowed"]),
      }],
    });
  });

  it("normalizes Profile and Knowledge claim labels from same-class references", async () => {
    const result = await composeTurnV3({
      plan: representativeDescriptionPlanFixture(),
      taskInput: { text: "请做个自我介绍", language: "zh" },
      actionResults: [{ actionId: "describe", semanticOutcome: "succeeded" }],
      evidence: [{
        evidenceId: "representative-profile:plan-self",
        evidenceClass: "tool_output",
        sourceKinds: ["capability_result"],
        content: { representativeName: "周老师", capabilityOutcomes: ["地理学习辅导"] },
      }, {
        evidenceId: "memory-materials-1",
        evidenceClass: "authorized_knowledge",
        sourceKinds: ["authorized_knowledge"],
        content: "已发布的地理学习资料包含地图判读和气候专题。",
      }],
      goalOutcomes: [{ goalId: "goal-self", status: "succeeded" }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-self",
            text: "我是周老师的地理对外代理，可以协助地理学习。",
            // Proposal labels are not authoritative; E1 is immutable tool_output.
            sourceClass: "authorized_knowledge",
            evidenceRefs: ["E1"],
          }, {
            kind: "claim",
            goalId: "goal-self",
            text: "已发布资料覆盖地图判读和气候专题。",
            // E2 is immutable authorized_knowledge.
            sourceClass: "tool_output",
            evidenceRefs: ["E2"],
          }],
        }),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      draft: {
        segments: [{
          sourceClass: "tool_output",
          evidenceRefs: ["representative-profile:plan-self"],
        }, {
          sourceClass: "authorized_knowledge",
          evidenceRefs: ["memory-materials-1"],
        }],
      },
    });
  });

  it("fails closed when one claim mixes Profile and Knowledge references", async () => {
    const result = await composeTurnV3({
      plan: representativeDescriptionPlanFixture(),
      taskInput: { text: "请做个自我介绍", language: "zh" },
      actionResults: [],
      evidence: [{
        evidenceId: "profile-1",
        evidenceClass: "tool_output",
        sourceKinds: ["capability_result"],
        content: { representativeName: "周老师" },
      }, {
        evidenceId: "knowledge-1",
        evidenceClass: "authorized_knowledge",
        sourceKinds: ["authorized_knowledge"],
        content: "地理学习资料。",
      }],
      goalOutcomes: [{ goalId: "goal-self", status: "succeeded" }],
      responseLanguage: "zh",
      adapter: {
        provider: "test",
        model: "composer-test",
        supportsStrictStructuredOutput: true,
        generateStrictObject: vi.fn().mockResolvedValue({
          segments: [{
            kind: "claim",
            goalId: "goal-self",
            text: "我是周老师的对外代理，并有地理学习资料。",
            sourceClass: "tool_output",
            evidenceRefs: ["E1", "E2"],
          }],
        }),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{
        stage: "evidence_validation",
        issueCodes: ["evidence_ref_unknown_or_class_mismatch"],
      }],
    });
  });
});

function planFixture(): any {
  return {
    protocolVersion: 3,
    planId: "plan-1",
    scopeKey: { kind: "generation_turn", conversationId: "c1", inputMessageId: "m1" },
    revision: 1,
    envelopeHash: `sha256:${"a".repeat(64)}`,
    capabilityCatalogHash: `sha256:${"b".repeat(64)}`,
    validationPolicyVersion: "v1",
    objective: "查询订单",
    goals: [{
      id: "goal-1",
      objective: "查询订单",
      sourcePointers: ["/currentMessage/text"],
      strategy: "capability",
      actionIds: [],
      deliverableIds: [],
      evidenceRequirement: {
        kind: "transactional_authority",
        freshness: "live",
        allowedSourceKinds: ["order_api"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
      failurePolicy: { strategy: "stop", reasonCode: "failed" },
    }],
    actions: [],
    deliverables: [],
    decisionTrace: [],
  };
}

function stableGeneralPlanFixture(): any {
  return {
    protocolVersion: 3,
    planId: "plan-general",
    scopeKey: { kind: "generation_turn", conversationId: "c1", inputMessageId: "m-general" },
    revision: 1,
    envelopeHash: `sha256:${"a".repeat(64)}`,
    capabilityCatalogHash: `sha256:${"b".repeat(64)}`,
    validationPolicyVersion: "v1",
    objective: "用三句话解释一个稳定的通用概念",
    goals: [{
      id: "goal-general",
      objective: "解释稳定的通用概念",
      sourcePointers: ["/currentMessage/text"],
      strategy: "general",
      actionIds: ["compose"],
      deliverableIds: [],
      evidenceRequirement: {
        kind: "none",
        freshness: "stable",
        allowedSourceKinds: [],
        citationRequired: false,
        minimumEvidenceCount: 0,
      },
      failurePolicy: { strategy: "stop", reasonCode: "failed" },
    }],
    actions: [],
    deliverables: [],
    decisionTrace: [],
  };
}

function authorizedKnowledgePlanFixture(): any {
  return {
    ...stableGeneralPlanFixture(),
    planId: "plan-knowledge",
    objective: "回答当前知识问题",
    goals: [{
      id: "goal-knowledge",
      objective: "使用已授权知识回答并提供学习建议",
      sourcePointers: ["/currentMessage/text"],
      strategy: "knowledge",
      actionIds: ["knowledge", "compose"],
      deliverableIds: [],
      evidenceRequirement: {
        kind: "authorized_knowledge",
        freshness: "bounded",
        allowedSourceKinds: ["public_knowledge"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
      failurePolicy: { strategy: "stop", reasonCode: "knowledge_unavailable" },
    }],
  };
}

function knowledgeFallbackPlanFixture(): any {
  return {
    ...stableGeneralPlanFixture(),
    planId: "plan-knowledge-fallback",
    objective: "先查授权知识，未命中后回答稳定通用知识",
    goals: [{
      id: "goal-fallback",
      objective: "回答稳定的公共知识问题",
      sourcePointers: ["/currentMessage/text"],
      strategy: "knowledge",
      actionIds: ["knowledge", "compose"],
      deliverableIds: [],
      generalEligibility: "allowed",
      evidenceRequirement: {
        kind: "knowledge_preferred",
        freshness: "stable",
        allowedSourceKinds: ["authorized_knowledge"],
        citationRequired: false,
        minimumEvidenceCount: 0,
      },
      evidenceFallbackPolicy: {
        kind: "authorized_knowledge_miss_to_stable_general",
        policySource: "server_planning_default",
        activationStatuses: ["not_found", "unavailable"],
        disclosureRequired: true,
        authorityBoundary: "non_owner_specific_stable_general",
      },
      sourceAuthorityBoundary: {
        classification: "stable_general_allowed",
        policySource: "server_authority_policy",
        policyVersion: "delegate.source-authority.v1",
        reasonCodes: ["stable_general_explanation_confirmed"],
      },
      failurePolicy: { strategy: "stop", reasonCode: "knowledge_unavailable" },
    }],
  };
}

function capabilityFallbackPlanFixture(): any {
  return {
    ...stableGeneralPlanFixture(),
    planId: "plan-capability-fallback",
    objective: "解释公开项目目的",
    goals: [{
      id: "goal-capability-fallback",
      objective: "解释公开项目目的",
      sourcePointers: ["/currentMessage/text"],
      strategy: "capability",
      operation: "explain",
      actionIds: ["external", "compose"],
      deliverableIds: [],
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
      failurePolicy: { strategy: "stop", reasonCode: "external_unavailable" },
    }],
  };
}

function representativeDescriptionPlanFixture(): any {
  return {
    ...stableGeneralPlanFixture(),
    planId: "plan-self",
    objective: "介绍对外代理",
    goals: [{
      id: "goal-self",
      objective: "综合代表资料与已授权知识进行介绍",
      sourcePointers: ["/currentMessage/text"],
      strategy: "capability",
      actionIds: ["describe", "compose"],
      deliverableIds: [],
      evidenceRequirement: {
        kind: "capability_result",
        freshness: "bounded",
        allowedSourceKinds: ["capability_result", "authorized_knowledge"],
        citationRequired: true,
        minimumEvidenceCount: 1,
      },
      failurePolicy: { strategy: "stop", reasonCode: "description_unavailable" },
    }],
  };
}
