import { describe, expect, it, vi } from "vitest";

import {
  buildTurnSourceRequirementPromptV3,
  constrainTurnSourceRequirementForRetrievalV3,
  inferTurnSourceRequirementV3,
  type StrictPlannerAdapter,
} from "../src";

describe("TurnPlan V3 source-requirement inference", () => {
  it("infers a composable live external requirement without naming a capability", async () => {
    const adapter = strictAdapter({
      protocolVersion: 3,
      operations: ["read", "search"],
      evidenceClasses: ["current_external"],
      freshnessClasses: ["live"],
      authorityClasses: ["external_authoritative"],
      confidence: 0.97,
      reasonCode: "current_public_fact",
    });

    await expect(inferTurnSourceRequirementV3({
      text: "今天的股市情况如何",
      language: "zh",
      now: "2026-09-01T07:48:51.194Z",
      adapter,
    })).resolves.toEqual({
      ok: true,
      requirement: {
        operations: ["read", "search"],
        evidenceClasses: ["current_external"],
        freshnessClasses: ["live"],
        authorityClasses: ["external_authoritative"],
      },
      confidence: 0.97,
      reasonCode: "current_public_fact",
      provider: "test",
      model: "requirements-test",
    });
    const request = vi.mocked(adapter.generateStrictObject).mock.calls[0]![0];
    expect(request.instructions).toContain("not an intent taxonomy");
    expect(request.input).not.toContain("capabilityCatalog");
  });

  it("accepts stable general constraints without granting a source capability", async () => {
    const result = await inferTurnSourceRequirementV3({
      text: "解释 CAP 定理",
      adapter: strictAdapter({
        protocolVersion: 3,
        operations: ["explain"],
        evidenceClasses: ["none"],
        freshnessClasses: ["stable"],
        authorityClasses: ["general"],
        confidence: 0.99,
        reasonCode: "stable_general_explanation",
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      requirement: {
        operations: ["explain"],
        evidenceClasses: ["none"],
        freshnessClasses: ["stable"],
        authorityClasses: ["general"],
      },
    });
  });

  it("rejects contradictory proposals and returns a safe inference failure", async () => {
    const result = await inferTurnSourceRequirementV3({
      text: "读取当前余额",
      adapter: strictAdapter({
        protocolVersion: 3,
        operations: ["read"],
        evidenceClasses: ["transactional_authority"],
        freshnessClasses: ["stable"],
        authorityClasses: ["general"],
        confidence: 0.9,
        reasonCode: "invalid_transactional_requirement",
      }),
    });
    expect(result).toEqual({
      ok: false,
      reason: "No provider produced a validated source-requirement proposal.",
      diagnostics: [{
        provider: "test",
        model: "requirements-test",
        stage: "schema",
      }],
    });
  });

  it("keeps the prompt bounded to the turn and server time", () => {
    const request = buildTurnSourceRequirementPromptV3({
      text: "综合资料并计算结果",
      language: "zh",
      now: "2026-09-01T07:48:51.194Z",
    });
    expect(JSON.parse(request.input)).toEqual({
      text: "综合资料并计算结果",
      language: "zh",
      now: "2026-09-01T07:48:51.194Z",
    });
    expect(JSON.stringify(request.responseSchema.schema)).not.toContain("capabilityKey");
  });

  it("uses stable-general inference only as advisory full-catalog retrieval", () => {
    expect(constrainTurnSourceRequirementForRetrievalV3({
      operations: ["explain"],
      evidenceClasses: ["none"],
      freshnessClasses: ["stable"],
      authorityClasses: ["general"],
    })).toEqual({});
    expect(constrainTurnSourceRequirementForRetrievalV3({
      operations: ["read", "search"],
      evidenceClasses: ["current_external"],
      freshnessClasses: ["live"],
      authorityClasses: ["external_authoritative"],
    })).toEqual({
      operations: [],
      evidenceClasses: ["current_external"],
      freshnessClasses: ["live"],
      authorityClasses: ["external_authoritative"],
    });
  });
});

function strictAdapter(proposal: unknown): StrictPlannerAdapter {
  return {
    provider: "test",
    model: "requirements-test",
    supportsStrictStructuredOutput: true,
    generateStrictObject: vi.fn().mockResolvedValue(proposal),
  };
}
