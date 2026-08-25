import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  executionFind: vi.fn(),
  executionUpdate: vi.fn(),
  actionUpdate: vi.fn(),
  planUpdate: vi.fn(),
  outboxUpdate: vi.fn(),
  effectUpdate: vi.fn(),
  unitUpdate: vi.fn(),
}));

vi.mock("../src/prisma", () => {
  const tx = {
    $executeRaw: mocks.executeRaw,
    toolExecution: {
      findUnique: mocks.executionFind,
      updateMany: mocks.executionUpdate,
    },
    conversationPlanAction: { updateMany: mocks.actionUpdate },
    conversationTurnPlan: { updateMany: mocks.planUpdate },
    outboxEvent: { updateMany: mocks.outboxUpdate },
    delegationTaskExternalEffect: { updateMany: mocks.effectUpdate },
    billableUnit: { updateMany: mocks.unitUpdate },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx)),
    },
  };
});

describe("V3 Action admission terminalization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.executionFind.mockResolvedValue({
      id: "execution-1",
      status: "BLOCKED",
      attemptPhase: "CREATED",
      planRevision: 2,
      executionEpoch: 4,
      executionOutboxId: "execution-outbox-1",
      planAction: {
        id: "action-1",
        status: "WAITING_APPROVAL",
        turnPlan: {
          id: "plan-1",
          protocolVersion: 3,
          shadowMode: false,
          revision: 2,
          executionEpoch: 4,
          status: "VALIDATED",
          activeExecutionFence: {
            activePlanId: "plan-1",
            activeRevision: 2,
            executionEpoch: 4,
          },
        },
      },
    });
    mocks.executionUpdate.mockResolvedValue({ count: 1 });
    mocks.actionUpdate.mockResolvedValue({ count: 1 });
    mocks.planUpdate.mockResolvedValue({ count: 1 });
    mocks.outboxUpdate.mockResolvedValue({ count: 1 });
    mocks.effectUpdate.mockResolvedValue({ count: 1 });
    mocks.unitUpdate.mockResolvedValue({ count: 1 });
  });

  it("atomically closes a rejected pre-call admission and releases billing", async () => {
    const { terminalizeV3ActionAdmission } = await import(
      "../src/conversation-turn-plans"
    );

    await terminalizeV3ActionAdmission({
      executionId: "execution-1",
      outcome: "rejected",
      reason: "owner_rejected_action_intent",
    });

    expect(mocks.executionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "CANCELED",
        attemptPhase: "CANCELED_BEFORE_START",
        transportOutcome: "confirmed_not_sent",
      }),
    }));
    expect(mocks.actionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CANCELED" }),
    }));
    expect(mocks.effectUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CANCELED" }),
    }));
    expect(mocks.unitUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RELEASED" }),
    }));
    expect(mocks.planUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CANCELED" }),
    }));
  });

  it("moves a post-call local failure to reconciliation and suppresses retry", async () => {
    mocks.executionFind.mockResolvedValue({
      id: "execution-1",
      status: "RUNNING",
      attemptPhase: "CALL_STARTED",
      planRevision: 2,
      executionEpoch: 4,
      executionOutboxId: "execution-outbox-1",
      planAction: {
        id: "action-1",
        status: "EXECUTING",
        turnPlan: {
          id: "plan-1",
          protocolVersion: 3,
          shadowMode: false,
          revision: 2,
          executionEpoch: 4,
          status: "EXECUTING",
          activeExecutionFence: {
            activePlanId: "plan-1",
            activeRevision: 2,
            executionEpoch: 4,
          },
        },
      },
    });
    const { terminalizeV3ActionAdmission } = await import(
      "../src/conversation-turn-plans"
    );

    await terminalizeV3ActionAdmission({
      executionId: "execution-1",
      outcome: "invalid",
      reason: "local_persistence_failed_after_remote_call",
    });

    expect(mocks.executionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "FAILED",
        attemptPhase: "OUTCOME_UNKNOWN",
        transportOutcome: "outcome_unknown",
        semanticOutcome: "unknown",
      }),
    }));
    expect(mocks.actionUpdate).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: { status: "RECONCILIATION_REQUIRED" },
    });
    expect(mocks.unitUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "HELD_FOR_RECONCILIATION" }),
    }));
    expect(mocks.outboxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PROCESSED",
        lastError: "action_execution_outcome_unknown",
      }),
    }));
    expect(mocks.planUpdate).not.toHaveBeenCalled();
  });
});
