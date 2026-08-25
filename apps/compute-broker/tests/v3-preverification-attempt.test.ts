import { describe, expect, it } from "vitest";

import { vi } from "vitest";

vi.mock("../src/lifecycle-hooks", () => ({
  computeLifecycleHooks: { emit: vi.fn() },
}));
vi.mock("../src/prisma", () => ({ prisma: {} }));
vi.mock("../src/policy", () => ({
  evaluateExecutionRequest: vi.fn(),
  loadSessionPolicyContext: vi.fn(),
}));
vi.mock("@delegate/web-data", () => ({
  finalizeComputeApprovalConversation: vi.fn(),
  markDelegationTaskRunningAfterApprovalInTransaction: vi.fn(),
  recordConversationPlanActionAuthorization: vi.fn(),
  resolveServerOwnedMcpCapabilityPolicyV3: vi.fn((input: {
    serverUrl: string;
    transportKind: string;
    toolName: string;
    toolSchemaHash: string;
  }) => input.serverUrl === "https://mcp.deepwiki.com/mcp"
    && input.transportKind.toLowerCase() === "streamable_http"
    && input.toolName === "ask_question"
    && input.toolSchemaHash === "tool-schema-hash"
    ? {
        policyId: "delegate.mcp-policy.deepwiki.public-read.v1",
        classificationVersion: "delegate.mcp-effect.deepwiki.v1",
        effect: {
          boundary: "external",
          mutation: "none",
          reversibility: "not_applicable",
        },
        idempotency: "naturally_idempotent",
        successContract: {
          kind: "server_evaluator",
          evaluatorId: "mcp.deepwiki.read_semantic",
          evaluatorVersion: "1",
        },
      }
    : null),
  terminalizeV3ActionAdmission: vi.fn(),
  terminalizeV3ActionAdmissionInTransaction: vi.fn(),
  validateDelegationApprovedExecutionInTransaction: vi.fn(),
}));

import {
  assertCurrentMcpEffectPolicyPin,
  buildV3PreverificationAttemptState,
  classifyMcpTransportOutcome,
  resolveExecutionResponseOutcome,
  shouldFinalizeApprovedExecutionImmediately,
} from "../src/executions";

describe("V3 pre-verification attempt state", () => {
  it("never exposes a received MCP response as terminal success", () => {
    const state = buildV3PreverificationAttemptState("response_received");
    expect(state).toEqual({
      status: "RUNNING",
      attemptPhase: "RESPONSE_RECEIVED",
      transportOutcome: "response_received",
      semanticOutcome: null,
      finishedAt: null,
    });
    expect(state).not.toHaveProperty("executionLeaseToken");
  });

  it("records unknown transport state without guessing a business outcome", () => {
    expect(buildV3PreverificationAttemptState("outcome_unknown")).toMatchObject({
      status: "RUNNING",
      attemptPhase: "VERIFYING",
      semanticOutcome: null,
      finishedAt: null,
    });
  });

  it("revalidates the server-owned MCP Effect and SuccessContract at execution", () => {
    const valid = {
      serverUrl: "https://mcp.deepwiki.com/mcp",
      transportKind: "STREAMABLE_HTTP",
      toolName: "ask_question",
      toolSchemaHash: "tool-schema-hash",
      bindingRevision: 7,
      capabilityVersion: [
        "7",
        "delegate.mcp-policy.deepwiki.public-read.v1",
        "delegate.mcp-effect.deepwiki.v1",
      ].join(":"),
      plannedEffect: {
        boundary: "external",
        mutation: "none",
        reversibility: "not_applicable",
      },
      plannedSuccessContract: {
        kind: "server_evaluator",
        evaluatorId: "mcp.deepwiki.read_semantic",
        evaluatorVersion: "1",
      },
    };

    expect(() => assertCurrentMcpEffectPolicyPin(valid)).not.toThrow();
    expect(() => assertCurrentMcpEffectPolicyPin({
      ...valid,
      capabilityVersion: [
        "7",
        "delegate.mcp-policy.deepwiki.public-read.v1",
        "delegate.mcp-effect.deepwiki.v0",
      ].join(":"),
    })).toThrow("mcp_effect_policy_drift_replan_required");
    expect(() => assertCurrentMcpEffectPolicyPin({
      ...valid,
      serverUrl: "https://attacker.example/mcp",
    })).toThrow("mcp_effect_policy_drift_replan_required");
    expect(() => assertCurrentMcpEffectPolicyPin({
      ...valid,
      toolSchemaHash: "spoofed-tool-schema",
    })).toThrow("mcp_effect_policy_drift_replan_required");
  });

  it("never maps transport exit zero to completion without semantic success", () => {
    expect(resolveExecutionResponseOutcome({
      runtimeExitCode: 0,
      execution: {
        planActionId: "action-1",
        status: "FAILED",
        semanticOutcome: "failed",
      },
    })).toBe("failed");
    expect(resolveExecutionResponseOutcome({
      runtimeExitCode: 0,
      execution: {
        planActionId: "action-1",
        status: "FAILED",
        semanticOutcome: "unknown",
      },
    })).toBe("failed");
    expect(resolveExecutionResponseOutcome({
      runtimeExitCode: 0,
      execution: {
        planActionId: "action-1",
        status: "SUCCEEDED",
        semanticOutcome: "succeeded",
      },
    })).toBe("completed");
    expect(shouldFinalizeApprovedExecutionImmediately({
      planActionId: "action-1",
    })).toBe(false);
    expect(shouldFinalizeApprovedExecutionImmediately({
      planActionId: null,
    })).toBe(true);
  });

  it("distinguishes pre-call V3 rejection from a tagged unknown MCP outcome", () => {
    expect(classifyMcpTransportOutcome(
      new Error("effect_policy_drift"),
      "confirmed_not_sent",
    )).toBe("confirmed_not_sent");
    expect(classifyMcpTransportOutcome(Object.assign(
      new Error("socket_closed"),
      { delegateMcpTransportOutcome: "outcome_unknown" },
    ), "confirmed_not_sent")).toBe("outcome_unknown");
  });
});
