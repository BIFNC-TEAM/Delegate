import {
  WorkflowCommandType,
  WorkflowEngine,
  WorkflowEnginePhase,
  WorkflowKind,
  WorkflowStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const prismaMock = {
    workflowCommandOutbox: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workflowRun: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  prismaMock.$transaction.mockImplementation(async (value: unknown) => {
    if (typeof value === "function") {
      return (value as (client: typeof prismaMock) => unknown)(prismaMock);
    }
    if (Array.isArray(value)) {
      return Promise.all(value);
    }
    return value;
  });

  return {
    mockPrisma: prismaMock,
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

import { runWorkflowTick } from "../src/runner";

describe("workflow command outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (value: unknown) => {
      if (typeof value === "function") {
        return (value as (client: typeof mockPrisma) => unknown)(mockPrisma);
      }
      if (Array.isArray(value)) {
        return Promise.all(value);
      }
      return value;
    });
  });

  it("dispatches START commands from the Temporal outbox and persists Temporal metadata", async () => {
    const scheduledAt = new Date("2026-04-05T12:00:00.000Z");
    const observedAt = new Date("2026-04-05T11:30:00.000Z");

    mockPrisma.workflowCommandOutbox.findMany.mockResolvedValue([
      {
        id: "cmd-start-1",
        attemptCount: 0,
      },
    ]);
    mockPrisma.workflowCommandOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowCommandOutbox.findUnique.mockResolvedValue({
      id: "cmd-start-1",
      workflowRunId: "workflow-1",
      commandType: WorkflowCommandType.START,
      payload: {
        source: "test",
      },
      attemptCount: 1,
      workflowRun: {
        id: "workflow-1",
        kind: WorkflowKind.APPROVAL_EXPIRATION,
        engine: WorkflowEngine.TEMPORAL,
        status: WorkflowStatus.QUEUED,
        enginePhase: WorkflowEnginePhase.DISPATCH_PENDING,
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:rep-1:approval_expiration:approval-1",
        externalRunId: null,
        scheduledAt,
        startedAt: null,
        nextWakeAt: null,
        lastObservedAt: null,
        cancelRequestedAt: null,
      },
    });
    mockPrisma.workflowRun.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.workflowCommandOutbox.update.mockResolvedValue({
      id: "cmd-start-1",
    });

    const temporalDispatcher = {
      startWorkflowExecution: vi.fn().mockResolvedValue({
        outcome: "started",
        runId: "temporal-run-1",
        observedAt,
      }),
      cancelWorkflowExecution: vi.fn(),
    };

    const summary = await runWorkflowTick({
      engine: WorkflowEngine.TEMPORAL,
      limit: 10,
      temporalDispatcher,
    });

    expect(summary).toEqual({
      processed: 1,
      completed: 0,
      dispatched: 1,
      failed: 0,
    });
    expect(temporalDispatcher.startWorkflowExecution).toHaveBeenCalledWith({
      workflowRunId: "workflow-1",
      workflowKind: WorkflowKind.APPROVAL_EXPIRATION,
      workflowId: "delegate:rep-1:approval_expiration:approval-1",
      taskQueue: "delegate-public-runtime",
      scheduledAt,
    });
    expect(mockPrisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "workflow-1",
        status: {
          in: [WorkflowStatus.QUEUED, WorkflowStatus.RUNNING],
        },
      },
      data: expect.objectContaining({
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.WAITING_TIMER,
        externalRunId: "temporal-run-1",
        startedAt: observedAt,
        nextWakeAt: scheduledAt,
        lastObservedAt: observedAt,
        lastEngineError: null,
        dispatchAttemptCount: {
          increment: 1,
        },
      }),
    });
    expect(mockPrisma.workflowCommandOutbox.update).toHaveBeenCalledWith({
      where: { id: "cmd-start-1" },
      data: {
        processedAt: observedAt,
        lastError: null,
      },
    });
    expect(mockPrisma.workflowRun.update).not.toHaveBeenCalled();
  });

  it("dispatches a durable delegation SIGNAL command", async () => {
    const signal = {
      signalId: "approval:approval-1:approved",
      kind: "approval_resolved" as const,
      approvalId: "approval-1",
      resolution: "approved" as const,
      occurredAt: "2026-08-18T00:00:00.000Z",
    };
    mockPrisma.workflowCommandOutbox.findMany.mockResolvedValue([
      { id: "cmd-signal-1", attemptCount: 0 },
    ]);
    mockPrisma.workflowCommandOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowCommandOutbox.findUnique.mockResolvedValue({
      id: "cmd-signal-1",
      workflowRunId: "workflow-signal-1",
      commandType: WorkflowCommandType.SIGNAL,
      payload: { signal },
      attemptCount: 1,
      workflowRun: {
        id: "workflow-signal-1",
        kind: WorkflowKind.DELEGATION_EXECUTION,
        engine: WorkflowEngine.TEMPORAL,
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.WAITING_SIGNAL,
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:delegation_execution:task-1",
        externalRunId: "temporal-run-signal-1",
        scheduledAt: new Date("2026-08-18T00:00:00.000Z"),
        startedAt: new Date("2026-08-18T00:00:00.000Z"),
        nextWakeAt: null,
        lastObservedAt: null,
        cancelRequestedAt: null,
      },
    });
    mockPrisma.workflowRun.update.mockResolvedValue({ id: "workflow-signal-1" });
    mockPrisma.workflowCommandOutbox.update.mockResolvedValue({ id: "cmd-signal-1" });
    const temporalDispatcher = {
      startWorkflowExecution: vi.fn(),
      cancelWorkflowExecution: vi.fn(),
      signalDelegationExecution: vi.fn().mockResolvedValue(undefined),
    };

    const summary = await runWorkflowTick({
      engine: WorkflowEngine.TEMPORAL,
      limit: 10,
      temporalDispatcher,
    });

    expect(summary).toMatchObject({ processed: 1, dispatched: 1, failed: 0 });
    expect(temporalDispatcher.signalDelegationExecution).toHaveBeenCalledWith({
      workflowId: "delegate:delegation_execution:task-1",
      runId: "temporal-run-signal-1",
      signal,
    });
    expect(mockPrisma.workflowCommandOutbox.update).toHaveBeenCalledWith({
      where: { id: "cmd-signal-1" },
      data: { processedAt: expect.any(Date), lastError: null },
    });
  });

  it("treats already-started START commands as a recoverable success path", async () => {
    const observedAt = new Date("2026-04-05T11:45:00.000Z");
    const scheduledAt = new Date("2026-04-05T12:30:00.000Z");

    mockPrisma.workflowCommandOutbox.findMany.mockResolvedValue([
      {
        id: "cmd-start-2",
        attemptCount: 0,
      },
    ]);
    mockPrisma.workflowCommandOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowCommandOutbox.findUnique.mockResolvedValue({
      id: "cmd-start-2",
      workflowRunId: "workflow-2",
      commandType: WorkflowCommandType.START,
      payload: null,
      attemptCount: 1,
      workflowRun: {
        id: "workflow-2",
        kind: WorkflowKind.HANDOFF_FOLLOW_UP,
        engine: WorkflowEngine.TEMPORAL,
        status: WorkflowStatus.QUEUED,
        enginePhase: WorkflowEnginePhase.DISPATCH_PENDING,
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:rep-1:handoff_follow_up:handoff-1",
        externalRunId: null,
        scheduledAt,
        startedAt: null,
        nextWakeAt: null,
        lastObservedAt: null,
        cancelRequestedAt: null,
      },
    });
    mockPrisma.workflowRun.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.workflowCommandOutbox.update.mockResolvedValue({
      id: "cmd-start-2",
    });

    const temporalDispatcher = {
      startWorkflowExecution: vi.fn().mockResolvedValue({
        outcome: "already_started",
        runId: "temporal-run-existing",
        observedAt,
      }),
      cancelWorkflowExecution: vi.fn(),
    };

    const summary = await runWorkflowTick({
      engine: WorkflowEngine.TEMPORAL,
      limit: 10,
      temporalDispatcher,
    });

    expect(summary.failed).toBe(0);
    expect(summary.dispatched).toBe(1);
    expect(mockPrisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "workflow-2",
        status: {
          in: [WorkflowStatus.QUEUED, WorkflowStatus.RUNNING],
        },
      },
      data: expect.objectContaining({
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.WAITING_TIMER,
        externalRunId: "temporal-run-existing",
        nextWakeAt: scheduledAt,
        lastObservedAt: observedAt,
      }),
    });
  });

  it("does not overwrite terminal workflow state when Temporal start races with completion", async () => {
    const observedAt = new Date("2026-04-05T12:45:00.000Z");
    const scheduledAt = new Date("2026-04-05T13:30:00.000Z");

    mockPrisma.workflowCommandOutbox.findMany.mockResolvedValue([
      {
        id: "cmd-start-race",
        attemptCount: 0,
      },
    ]);
    mockPrisma.workflowCommandOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowCommandOutbox.findUnique.mockResolvedValue({
      id: "cmd-start-race",
      workflowRunId: "workflow-race",
      commandType: WorkflowCommandType.START,
      payload: null,
      attemptCount: 1,
      workflowRun: {
        id: "workflow-race",
        kind: WorkflowKind.APPROVAL_EXPIRATION,
        engine: WorkflowEngine.TEMPORAL,
        status: WorkflowStatus.QUEUED,
        enginePhase: WorkflowEnginePhase.DISPATCH_PENDING,
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:rep-1:approval_expiration:approval-race",
        externalRunId: null,
        scheduledAt,
        startedAt: null,
        nextWakeAt: null,
        lastObservedAt: null,
        cancelRequestedAt: null,
      },
    });
    mockPrisma.workflowRun.updateMany.mockResolvedValue({
      count: 0,
    });
    mockPrisma.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-race",
      status: WorkflowStatus.COMPLETED,
      enginePhase: WorkflowEnginePhase.COMPLETED,
      startedAt: null,
      externalRunId: null,
    });
    mockPrisma.workflowRun.update.mockResolvedValue({
      id: "workflow-race",
    });
    mockPrisma.workflowCommandOutbox.update.mockResolvedValue({
      id: "cmd-start-race",
    });

    const temporalDispatcher = {
      startWorkflowExecution: vi.fn().mockResolvedValue({
        outcome: "started",
        runId: "temporal-run-race",
        observedAt,
      }),
      cancelWorkflowExecution: vi.fn(),
    };

    const summary = await runWorkflowTick({
      engine: WorkflowEngine.TEMPORAL,
      limit: 10,
      temporalDispatcher,
    });

    expect(summary).toEqual({
      processed: 1,
      completed: 0,
      dispatched: 1,
      failed: 0,
    });
    expect(mockPrisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "workflow-race" },
      data: {
        externalRunId: "temporal-run-race",
        startedAt: observedAt,
        lastObservedAt: observedAt,
        lastEngineError: null,
        dispatchAttemptCount: {
          increment: 1,
        },
      },
    });
  });

  it("processes CANCEL commands as best-effort cleanup without surfacing a failure", async () => {
    const observedAt = new Date("2026-04-05T12:15:00.000Z");

    mockPrisma.workflowCommandOutbox.findMany.mockResolvedValue([
      {
        id: "cmd-cancel-1",
        attemptCount: 0,
      },
    ]);
    mockPrisma.workflowCommandOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowCommandOutbox.findUnique.mockResolvedValue({
      id: "cmd-cancel-1",
      workflowRunId: "workflow-3",
      commandType: WorkflowCommandType.CANCEL,
      payload: null,
      attemptCount: 1,
      workflowRun: {
        id: "workflow-3",
        kind: WorkflowKind.APPROVAL_EXPIRATION,
        engine: WorkflowEngine.TEMPORAL,
        status: WorkflowStatus.CANCELED,
        enginePhase: WorkflowEnginePhase.CANCEL_REQUESTED,
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:rep-1:approval_expiration:approval-2",
        externalRunId: "temporal-run-2",
        scheduledAt: new Date("2026-04-05T13:00:00.000Z"),
        startedAt: new Date("2026-04-05T12:00:00.000Z"),
        nextWakeAt: new Date("2026-04-05T13:00:00.000Z"),
        lastObservedAt: null,
        cancelRequestedAt: new Date("2026-04-05T12:10:00.000Z"),
      },
    });
    mockPrisma.workflowRun.update.mockResolvedValue({
      id: "workflow-3",
    });
    mockPrisma.workflowCommandOutbox.update.mockResolvedValue({
      id: "cmd-cancel-1",
    });

    const temporalDispatcher = {
      startWorkflowExecution: vi.fn(),
      cancelWorkflowExecution: vi.fn().mockResolvedValue({
        outcome: "not_found",
        runId: "temporal-run-2",
        observedAt,
      }),
    };

    const summary = await runWorkflowTick({
      engine: WorkflowEngine.TEMPORAL,
      limit: 10,
      temporalDispatcher,
    });

    expect(summary).toEqual({
      processed: 1,
      completed: 0,
      dispatched: 1,
      failed: 0,
    });
    expect(temporalDispatcher.cancelWorkflowExecution).toHaveBeenCalledWith({
      workflowRunId: "workflow-3",
      workflowKind: WorkflowKind.APPROVAL_EXPIRATION,
      workflowId: "delegate:rep-1:approval_expiration:approval-2",
      runId: "temporal-run-2",
    });
    expect(mockPrisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "workflow-3" },
      data: expect.objectContaining({
        enginePhase: WorkflowEnginePhase.CANCELED,
        nextWakeAt: null,
        lastObservedAt: observedAt,
        lastEngineError: null,
        dispatchAttemptCount: {
          increment: 1,
        },
      }),
    });
  });

  it("dispatches a delegation task to its stable long-lived Temporal workflow", async () => {
    const scheduledAt = new Date("2026-08-17T08:00:00.000Z");
    const observedAt = new Date("2026-08-17T08:00:01.000Z");
    mockPrisma.workflowCommandOutbox.findMany.mockResolvedValue([{
      id: "cmd-delegation-1",
      attemptCount: 0,
    }]);
    mockPrisma.workflowCommandOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowCommandOutbox.findUnique.mockResolvedValue({
      id: "cmd-delegation-1",
      workflowRunId: "workflow-delegation-1",
      commandType: WorkflowCommandType.START,
      attemptCount: 1,
      workflowRun: {
        id: "workflow-delegation-1",
        kind: WorkflowKind.DELEGATION_EXECUTION,
        engine: WorkflowEngine.TEMPORAL,
        status: WorkflowStatus.QUEUED,
        enginePhase: WorkflowEnginePhase.DISPATCH_PENDING,
        queueName: "delegate-public-runtime",
        externalWorkflowId: "delegate:delegation_execution:task-1",
        externalRunId: null,
        scheduledAt,
        startedAt: null,
        nextWakeAt: null,
        lastObservedAt: null,
        cancelRequestedAt: null,
        delegationTaskId: "task-1",
        turnPlanId: "plan-1",
      },
    });
    mockPrisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowCommandOutbox.update.mockResolvedValue({
      id: "cmd-delegation-1",
    });
    const temporalDispatcher = {
      startWorkflowExecution: vi.fn().mockResolvedValue({
        outcome: "started",
        runId: "temporal-delegation-1",
        observedAt,
      }),
      cancelWorkflowExecution: vi.fn(),
    };

    await runWorkflowTick({
      engine: WorkflowEngine.TEMPORAL,
      temporalDispatcher,
    });

    expect(temporalDispatcher.startWorkflowExecution).toHaveBeenCalledWith({
      workflowRunId: "workflow-delegation-1",
      workflowKind: WorkflowKind.DELEGATION_EXECUTION,
      workflowId: "delegate:delegation_execution:task-1",
      taskQueue: "delegate-public-runtime",
      scheduledAt,
      delegationTaskId: "task-1",
      turnPlanId: "plan-1",
    });
    expect(mockPrisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "workflow-delegation-1",
        status: {
          in: [WorkflowStatus.QUEUED, WorkflowStatus.RUNNING],
        },
      },
      data: expect.objectContaining({
        status: WorkflowStatus.RUNNING,
        enginePhase: WorkflowEnginePhase.ACTIVITY_RUNNING,
        nextWakeAt: null,
      }),
    });
  });

  it("keeps LOCAL_RUNNER on the existing due-time execution path", async () => {
    mockPrisma.workflowRun.findMany.mockResolvedValue([
      {
        id: "workflow-local-1",
      },
    ]);
    mockPrisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-local-1",
      representativeId: "rep-1",
      contactId: null,
      conversationId: null,
      subagentId: null,
      kind: WorkflowKind.APPROVAL_EXPIRATION,
      engine: WorkflowEngine.LOCAL_RUNNER,
      status: WorkflowStatus.RUNNING,
      scheduledAt: new Date("2026-04-05T10:00:00.000Z"),
      input: {
        approvalId: "approval-local-1",
        timeoutMinutes: 30,
      },
      approvalRequest: null,
      handoffRequest: null,
    });
    mockPrisma.workflowRun.update.mockResolvedValue({
      id: "workflow-local-1",
    });

    const summary = await runWorkflowTick({
      engine: WorkflowEngine.LOCAL_RUNNER,
      limit: 10,
    });

    expect(summary).toEqual({
      processed: 1,
      completed: 1,
      dispatched: 0,
      failed: 0,
    });
    expect(mockPrisma.workflowCommandOutbox.findMany).not.toHaveBeenCalled();
  });
});
