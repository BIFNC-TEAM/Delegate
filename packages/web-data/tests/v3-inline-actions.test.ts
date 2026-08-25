import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attemptFindUnique: vi.fn(),
  attemptFindMany: vi.fn(),
  attemptUpdateMany: vi.fn(),
  attemptCount: vi.fn(),
  resultUpsert: vi.fn(),
  attemptUpdate: vi.fn(),
  planFindUnique: vi.fn(),
  planUpdateMany: vi.fn(),
  actionFindMany: vi.fn(),
  actionUpdateMany: vi.fn(),
  actionUpdate: vi.fn(),
  outboxUpdate: vi.fn(),
  outboxUpdateMany: vi.fn(),
  memoryUpdateMany: vi.fn(),
  billableUnitUpdateMany: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("../src/prisma", () => {
  const tx = {
    $executeRaw: mocks.executeRaw,
    toolExecution: {
      findUnique: mocks.attemptFindUnique,
      findMany: mocks.attemptFindMany,
      update: mocks.attemptUpdate,
      updateMany: mocks.attemptUpdateMany,
      count: mocks.attemptCount,
    },
    actionResult: { upsert: mocks.resultUpsert },
    conversationTurnPlan: {
      findUnique: mocks.planFindUnique,
      updateMany: mocks.planUpdateMany,
    },
    conversationPlanAction: {
      findMany: mocks.actionFindMany,
      update: mocks.actionUpdate,
      updateMany: mocks.actionUpdateMany,
    },
    outboxEvent: {
      update: mocks.outboxUpdate,
      updateMany: mocks.outboxUpdateMany,
    },
    memoryUseRun: { updateMany: mocks.memoryUpdateMany },
    billableUnit: { updateMany: mocks.billableUnitUpdateMany },
  };
  return {
    prisma: {
      toolExecution: { findUnique: mocks.attemptFindUnique },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx)),
    },
  };
});

describe("V3 inline ActionResult fence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects completion if a newer plan becomes active between read and commit", async () => {
    const attempt = buildAttempt("plan-1");
    mocks.attemptFindUnique
      .mockResolvedValueOnce(attempt)
      .mockResolvedValueOnce(buildAttempt("plan-2"));
    const { completeV3InlineAction } = await import("../src/v3-inline-actions");

    await expect(completeV3InlineAction({
      executionAttemptId: "attempt-1",
      expectedExecutionLeaseToken: "inline-lease-1",
      transportOutcome: "response_received",
      rawOutput: { value: "ok" },
    })).rejects.toThrow("lost its active plan fence during completion");
    expect(mocks.resultUpsert).not.toHaveBeenCalled();
    expect(mocks.actionUpdate).not.toHaveBeenCalled();
  }, 15_000);

  it("moves a leased inline attempt to CALL_STARTED before provider execution", async () => {
    const prepared = {
      ...buildAttempt("plan-1"),
      attemptPhase: "CALL_PREPARED",
    };
    mocks.attemptFindUnique.mockResolvedValue(prepared);
    mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
    mocks.outboxUpdateMany.mockResolvedValue({ count: 1 });
    const { markV3InlineActionCallStarted } = await import("../src/v3-inline-actions");

    await expect(markV3InlineActionCallStarted({
      executionAttemptId: "attempt-1",
      expectedExecutionLeaseToken: "inline-lease-1",
    })).resolves.toMatchObject({ attemptPhase: "CALL_STARTED" });
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "attempt-1",
        attemptPhase: "CALL_PREPARED",
        executionLeaseToken: "inline-lease-1",
      }),
      data: { attemptPhase: "CALL_STARTED" },
    }));
  });

  it("atomically closes attempts, actions, plan, memory, and execution outbox", async () => {
    mocks.attemptFindUnique.mockResolvedValue(
      buildAttempt("plan-1", "CALL_PREPARED"),
    );
    mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
    mocks.attemptCount.mockResolvedValue(0);
    mocks.actionUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mocks.planUpdateMany.mockResolvedValue({ count: 1 });
    mocks.outboxUpdateMany.mockResolvedValue({ count: 1 });
    mocks.memoryUpdateMany.mockResolvedValue({ count: 1 });
    const { failV3InlinePlanExecution } = await import("../src/v3-inline-actions");

    await expect(failV3InlinePlanExecution({
      executionAttemptId: "attempt-1",
      expectedExecutionLeaseToken: "inline-lease-1",
      reasonCode: "composer_validation_failed",
    })).resolves.toEqual({
      attemptsClosed: 1,
      actionsFailed: 1,
      planFailed: true,
      memoryRunsFailed: 1,
      reconciliationRequired: false,
    });
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "FAILED",
        attemptPhase: "FAILED_BEFORE_CALL",
        transportOutcome: "confirmed_not_sent",
        semanticOutcome: "failed",
        executionLeaseToken: null,
      }),
    }));
    expect(mocks.outboxUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PROCESSED",
        lastError: "composer_validation_failed",
      }),
    }));
    expect(mocks.planUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED" }),
    }));
    expect(mocks.memoryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { generationRunId: "run-1", status: "STARTED" },
      data: expect.objectContaining({
        status: "FAILED",
        reasonCode: "memory_generation_failed",
      }),
    }));
  });

  it("fails only the claimed Action while another Action remains in flight", async () => {
    mocks.attemptFindUnique.mockResolvedValue(
      buildAttempt("plan-1", "CALL_PREPARED"),
    );
    mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
    mocks.actionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.attemptCount.mockResolvedValue(1);
    mocks.outboxUpdateMany.mockResolvedValue({ count: 1 });
    const { failV3InlinePlanExecution } = await import("../src/v3-inline-actions");

    await expect(failV3InlinePlanExecution({
      executionAttemptId: "attempt-1",
      expectedExecutionLeaseToken: "inline-lease-1",
      reasonCode: "current_action_failed",
    })).resolves.toMatchObject({
      attemptsClosed: 1,
      actionsFailed: 1,
      planFailed: false,
    });
    expect(mocks.actionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1", status: "EXECUTING" },
    }));
    expect(mocks.planUpdateMany).not.toHaveBeenCalled();
    expect(mocks.memoryUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves a CALL_STARTED local failure as an unknown outcome", async () => {
    mocks.attemptFindUnique.mockResolvedValue(buildAttempt("plan-1"));
    mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
    mocks.actionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.outboxUpdateMany.mockResolvedValue({ count: 1 });
    mocks.billableUnitUpdateMany.mockResolvedValue({ count: 1 });
    const { failV3InlinePlanExecution } = await import("../src/v3-inline-actions");

    await expect(failV3InlinePlanExecution({
      executionAttemptId: "attempt-1",
      expectedExecutionLeaseToken: "inline-lease-1",
      reasonCode: "provider_socket_closed",
    })).resolves.toMatchObject({
      attemptsClosed: 1,
      actionsFailed: 0,
      planFailed: false,
      reconciliationRequired: true,
    });
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attemptPhase: "OUTCOME_UNKNOWN",
        transportOutcome: "outcome_unknown",
        semanticOutcome: "unknown",
      }),
    }));
    expect(mocks.actionUpdateMany).toHaveBeenCalledWith({
      where: { id: "action-1", status: "EXECUTING" },
      data: { status: "RECONCILIATION_REQUIRED" },
    });
    expect(mocks.billableUnitUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "HELD_FOR_RECONCILIATION" }),
    }));
    expect(mocks.planUpdateMany).not.toHaveBeenCalled();
  });
});

function buildAttempt(
  activePlanId: string,
  attemptPhase = "CALL_STARTED",
) {
  return {
    id: "attempt-1",
    status: "RUNNING",
    attemptPhase,
    executionLeaseToken: "inline-lease-1",
    planRevision: 2,
    executionEpoch: 4,
    executionOutboxId: "execution-outbox-1",
    actionResult: null,
    planAction: {
      id: "action-1",
      status: "EXECUTING",
      expectedOutputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      successContract: {
        kind: "success_schema",
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      turnPlan: {
        id: "plan-1",
        scopeKey: "generation:conversation-1:message-1",
        protocolVersion: 3,
        shadowMode: false,
        status: "EXECUTING",
        generationRunId: "run-1",
        revision: 2,
        executionEpoch: 4,
        activeExecutionFence: {
          activePlanId,
          activeRevision: activePlanId === "plan-1" ? 2 : 3,
          executionEpoch: activePlanId === "plan-1" ? 4 : 5,
        },
      },
    },
  };
}
