import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attemptFindUnique: vi.fn(),
  resultUpsert: vi.fn(),
  attemptUpdate: vi.fn(),
  actionUpdate: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("../src/prisma", () => {
  const tx = {
    $executeRaw: mocks.executeRaw,
    actionResult: { upsert: mocks.resultUpsert },
    toolExecution: {
      findUnique: mocks.attemptFindUnique,
      update: mocks.attemptUpdate,
    },
    conversationPlanAction: { update: mocks.actionUpdate },
  };
  return {
    prisma: {
      toolExecution: { findUnique: mocks.attemptFindUnique },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    },
  };
});

describe("verified action result persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.attemptFindUnique.mockResolvedValue({
      id: "attempt-1",
      planRevision: 2,
      executionEpoch: 4,
      externalEffectId: null,
      executionOutboxId: null,
      actionResult: null,
      planAction: {
        id: "action-1",
        expectedOutputSchema: {
          type: "object",
          properties: { status: { type: "string" }, token: { type: "string" } },
          required: ["status", "token"],
          additionalProperties: false,
        },
        successContract: {
          kind: "status_predicate",
          pointer: "/status",
          operator: "equals",
          value: "ok",
        },
        turnPlan: {
          id: "plan-1",
          scopeKey: "generation:conversation-1:message-1",
          protocolVersion: 3,
          shadowMode: false,
          status: "EXECUTING",
          revision: 2,
          executionEpoch: 4,
          activeExecutionFence: {
            activePlanId: "plan-1",
            activeRevision: 2,
            executionEpoch: 4,
          },
        },
      },
    });
    mocks.resultUpsert.mockImplementation(async ({ create }) => ({ id: "result-1", ...create }));
    mocks.attemptUpdate.mockResolvedValue({});
    mocks.actionUpdate.mockResolvedValue({});
  });

  it("persists sanitized output and closes the matching attempt and action", async () => {
    const { persistVerifiedActionResult } = await import("../src/verified-action-results");
    const result = await persistVerifiedActionResult({
      executionAttemptId: "attempt-1",
      transportOutcome: "response_received",
      rawOutput: { status: "ok", token: "secret-value" },
      expectedOutputSchema: {
        type: "object",
        properties: { status: { type: "string" }, token: { type: "string" } },
        required: ["status", "token"],
        additionalProperties: false,
      },
      successContract: {
        kind: "status_predicate",
        pointer: "/status",
        operator: "equals",
        value: "ok",
      },
      billingUnitIds: ["unit-1"],
    });

    expect(result).toMatchObject({ id: "result-1", semanticOutcome: "succeeded" });
    expect(mocks.resultUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        planId: "plan-1",
        actionId: "action-1",
        output: { status: "ok", token: "[REDACTED_SECRET]" },
        semanticOutcome: "succeeded",
        billingUnitIds: ["unit-1"],
      }),
    }));
    expect(mocks.attemptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attemptPhase: "FINISHED", status: "SUCCEEDED" }),
    }));
    expect(mocks.actionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SUCCEEDED" }),
    }));
  });

  it("maps unknown transport outcome to reconciliation instead of retryable failure", async () => {
    const { persistVerifiedActionResult } = await import("../src/verified-action-results");
    await persistVerifiedActionResult({
      executionAttemptId: "attempt-1",
      transportOutcome: "outcome_unknown",
    });
    expect(mocks.attemptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attemptPhase: "OUTCOME_UNKNOWN" }),
    }));
    expect(mocks.actionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RECONCILIATION_REQUIRED" }),
    }));
  });

  it("does not treat a transport response as business success without a contract", async () => {
    mocks.attemptFindUnique.mockResolvedValue({
      id: "attempt-1",
      planRevision: 2,
      executionEpoch: 4,
      externalEffectId: null,
      executionOutboxId: null,
      actionResult: null,
      planAction: {
        id: "action-1",
        expectedOutputSchema: {
          type: "object",
          properties: { result: {} },
          required: ["result"],
          additionalProperties: false,
        },
        successContract: null,
        turnPlan: {
          id: "plan-1",
          scopeKey: "generation:conversation-1:message-1",
          protocolVersion: 3,
          shadowMode: false,
          status: "EXECUTING",
          revision: 2,
          executionEpoch: 4,
          activeExecutionFence: {
            activePlanId: "plan-1",
            activeRevision: 2,
            executionEpoch: 4,
          },
        },
      },
    });
    const { persistVerifiedActionResult } = await import("../src/verified-action-results");
    await persistVerifiedActionResult({
      executionAttemptId: "attempt-1",
      transportOutcome: "response_received",
      rawOutput: { result: "Error processing question: Repository not found" },
    });
    expect(mocks.resultUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        transportOutcome: "response_received",
        semanticOutcome: "unknown",
        failure: { code: "success_contract_missing" },
      }),
    }));
    expect(mocks.actionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RECONCILIATION_REQUIRED" }),
    }));
  });

  it("keeps generic MCP non-failure responses in reconciliation until a reliable contract exists", async () => {
    const initial = await mocks.attemptFindUnique({ where: { id: "attempt-1" } });
    mocks.attemptFindUnique.mockResolvedValue({
      ...initial,
      planAction: {
        ...initial.planAction,
        expectedOutputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
        },
        successContract: {
          kind: "server_evaluator",
          evaluatorId: "mcp.generic_semantic",
          evaluatorVersion: "1",
        },
      },
    });
    const { persistVerifiedActionResult } = await import("../src/verified-action-results");
    await persistVerifiedActionResult({
      executionAttemptId: "attempt-1",
      transportOutcome: "response_received",
      rawOutput: { result: "Plausible but not contract-verifiable answer." },
    });
    expect(mocks.resultUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        semanticOutcome: "unknown",
        failure: { code: "mcp_success_contract_unverified" },
      }),
    }));
    expect(mocks.actionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RECONCILIATION_REQUIRED" }),
    }));
  });

  it("rejects an attempt whose plan epoch no longer matches", async () => {
    mocks.attemptFindUnique.mockResolvedValueOnce({
      id: "attempt-1",
      planRevision: 2,
      executionEpoch: 3,
      planAction: {
        id: "action-1",
        turnPlan: { id: "plan-1", revision: 2, executionEpoch: 4 },
      },
    });
    const { persistVerifiedActionResult } = await import("../src/verified-action-results");
    await expect(persistVerifiedActionResult({
      executionAttemptId: "attempt-1",
      transportOutcome: "response_received",
      rawOutput: {},
      expectedOutputSchema: { type: "object" },
    })).rejects.toThrow("execution_attempt_plan_fence_lost");
    expect(mocks.resultUpsert).not.toHaveBeenCalled();
  });

  it("rejects a result when the active plan is superseded after the initial read", async () => {
    const initial = await mocks.attemptFindUnique({ where: { id: "attempt-1" } });
    mocks.attemptFindUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        actionResult: null,
        planAction: {
          ...initial.planAction,
          turnPlan: {
            ...initial.planAction.turnPlan,
            activeExecutionFence: {
              activePlanId: "plan-2",
              activeRevision: 3,
              executionEpoch: 5,
            },
          },
        },
      });
    const { persistVerifiedActionResult } = await import("../src/verified-action-results");
    await expect(persistVerifiedActionResult({
      executionAttemptId: "attempt-1",
      transportOutcome: "response_received",
      rawOutput: { status: "ok", token: "value" },
    })).rejects.toThrow("execution_attempt_plan_fence_lost");
    expect(mocks.resultUpsert).not.toHaveBeenCalled();
  });

  it("records a late call-started result on the superseded Plan for audit only", async () => {
    const initial = await mocks.attemptFindUnique({ where: { id: "attempt-1" } });
    mocks.attemptFindUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        attemptPhase: "CALL_STARTED",
        planAction: {
          ...initial.planAction,
          turnPlan: {
            ...initial.planAction.turnPlan,
            status: "SUPERSEDED",
            activeExecutionFence: null,
          },
        },
      });
    const { persistVerifiedActionResult } = await import("../src/verified-action-results");

    await expect(persistVerifiedActionResult({
      executionAttemptId: "attempt-1",
      transportOutcome: "response_received",
      rawOutput: { status: "ok", token: "value" },
    })).resolves.toMatchObject({ id: "result-1" });
    expect(mocks.resultUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ planId: "plan-1", actionId: "action-1" }),
    }));
  });
});
