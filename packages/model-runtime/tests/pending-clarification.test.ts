import { describe, expect, it } from "vitest";

import {
  applyContinuationBindings,
  resolveClarificationContinuation,
  validateContinuationDecision,
  type PendingClarificationSpec,
} from "../src/pending-clarification";

const pending: PendingClarificationSpec = {
  protocolVersion: 1,
  source: "turn_plan_v3",
  originInputMessageId: "message-weather",
  originPlanId: "plan-weather",
  representativeVersionId: "version-1",
  objective: "查询今天的天气",
  capabilityPins: [{
    key: "mcp.weather.search",
    version: "1",
    definitionHash: `sha256:${"a".repeat(64)}`,
  }],
  missingSlots: [{
    id: "location",
    argumentPath: "/actions/0/arguments/location",
    schema: { type: "string", minLength: 1 },
    prompt: "请补充地点。",
  }],
  semanticRequirement: {
    operations: [],
    evidenceClasses: ["current_external"],
    freshnessClasses: ["live"],
    authorityClasses: ["external_authoritative"],
  },
  clarificationCount: 0,
  createdAt: "2026-09-03T00:00:00.000Z",
  expiresAt: "2026-09-03T00:30:00.000Z",
};

describe("pending clarification continuation", () => {
  it("accepts a grounded compatible slot continuation", async () => {
    const result = await resolveClarificationContinuation({
      pending,
      currentMessage: "深圳",
      adapter: adapter({
        protocolVersion: 1,
        decision: "continue",
        bindings: [{ slotId: "location", value: "深圳" }],
        confidence: 0.99,
        reasonCode: "supplies_missing_location",
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      decision: { decision: "continue" },
    });
    if (result.ok) {
      expect(applyContinuationBindings({ pending, decision: result.decision })).toEqual({
        boundValues: { location: "深圳" },
        remainingSlots: [],
      });
    }
  });

  it("lets a complete new request replace the pending task", async () => {
    const result = await resolveClarificationContinuation({
      pending,
      currentMessage: "北京有什么好吃的？",
      adapter: adapter({
        protocolVersion: 1,
        decision: "replace",
        bindings: [],
        confidence: 0.98,
        reasonCode: "standalone_new_request",
      }),
    });

    expect(result).toMatchObject({ ok: true, decision: { decision: "replace" } });
  });

  it("cancels deterministically without a model call", async () => {
    let called = false;
    const result = await resolveClarificationContinuation({
      pending,
      currentMessage: "算了",
      adapter: {
        ...adapter({}),
        generateStrictObject: async () => {
          called = true;
          return {};
        },
      },
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({ ok: true, decision: { decision: "cancel" } });
  });

  it("rejects an ungrounded or schema-invalid binding", () => {
    expect(validateContinuationDecision({
      pending,
      currentMessage: "深圳",
      proposal: {
        protocolVersion: 1,
        decision: "continue",
        bindings: [{ slotId: "location", value: "北京" }],
        confidence: 0.9,
        reasonCode: "ungrounded",
      },
    })).toBeNull();
  });
});

function adapter(value: unknown) {
  return {
    provider: "test",
    model: "test-model",
    supportsStrictStructuredOutput: true,
    generateStrictObject: async () => value,
  };
}
