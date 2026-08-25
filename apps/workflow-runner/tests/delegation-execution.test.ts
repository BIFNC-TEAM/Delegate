import {
  WorkflowEnginePhase,
  WorkflowKind,
  WorkflowStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const client = {
    $executeRaw: vi.fn(),
    workflowRun: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    mockPrisma: {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) =>
        callback(client)),
    },
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

import {
  executeDelegationExecutionTransition,
  resolveDelegationExecutionPhase,
} from "../src/delegation-execution";

describe("delegation execution workflow activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
  });

  it("derives wait and terminal phases from the authoritative task state", () => {
    expect(resolveDelegationExecutionPhase({ taskStatus: "AWAITING_APPROVAL" }))
      .toBe("waiting_approval");
    expect(resolveDelegationExecutionPhase({ taskStatus: "WAITING_FOR_USER" }))
      .toBe("waiting_user");
    expect(resolveDelegationExecutionPhase({ taskStatus: "WAITING_FOR_OWNER" }))
      .toBe("waiting_reconciliation");
    expect(resolveDelegationExecutionPhase({ taskStatus: "COMPLETED" }))
      .toBe("completed");
    expect(resolveDelegationExecutionPhase({ taskStatus: "CANCELED" }))
      .toBe("canceled");
    expect(resolveDelegationExecutionPhase({
      taskStatus: "RUNNING",
      signal: {
        signalId: "task:task-1:cancel:2",
        kind: "cancel_requested",
        requestedBy: "owner-1",
        occurredAt: "2026-08-17T08:00:00.000Z",
      },
    })).toBe("running");
  });

  it("persists a waiting-signal phase without changing DelegationTask business state", async () => {
    mockPrisma.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-1",
      kind: WorkflowKind.DELEGATION_EXECUTION,
      delegationTaskId: "task-1",
      turnPlanId: "plan-1",
      output: null,
      delegationTask: { status: "AWAITING_APPROVAL" },
    });

    const state = await executeDelegationExecutionTransition({
      workflowRunId: "workflow-1",
      delegationTaskId: "task-1",
      // A long-lived Temporal input may still carry an older revision. The
      // activity must use the current WorkflowRun turnPlanId from Postgres.
      turnPlanId: "plan-old",
      transitionId: "bootstrap:0",
    });

    expect(state).toMatchObject({
      phase: "waiting_approval",
      revision: 1,
      lastTransitionId: "bootstrap:0",
      turnPlanId: "plan-1",
    });
    expect(mockPrisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "workflow-1",
        kind: WorkflowKind.DELEGATION_EXECUTION,
        delegationTaskId: "task-1",
      },
      data: expect.objectContaining({
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.WAITING_SIGNAL,
        output: expect.objectContaining({
          phase: "waiting_approval",
          revision: 1,
        }),
      }),
    });
  });

  it("returns the persisted state without a duplicate write on activity replay", async () => {
    const persisted = {
      workflowRunId: "workflow-1",
      delegationTaskId: "task-1",
      phase: "running",
      revision: 3,
      lastTransitionId: "signal:2",
    };
    mockPrisma.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-1",
      kind: WorkflowKind.DELEGATION_EXECUTION,
      delegationTaskId: "task-1",
      turnPlanId: null,
      output: persisted,
      delegationTask: { status: "RUNNING" },
    });

    await expect(executeDelegationExecutionTransition({
      workflowRunId: "workflow-1",
      delegationTaskId: "task-1",
      transitionId: "signal:2",
    })).resolves.toEqual(persisted);
    expect(mockPrisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });
});
