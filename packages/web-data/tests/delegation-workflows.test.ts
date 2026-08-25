import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enqueueDelegationExecutionSignalInTransaction,
  ensureDelegationExecutionWorkflowInTransaction,
} from "../src/delegation-workflows";

function createTx() {
  return {
    $executeRaw: vi.fn(),
    workflowRun: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "workflow-1",
        ...data,
      })),
      update: vi.fn(),
    },
    delegationTask: {
      findUnique: vi.fn().mockResolvedValue({
        representativeId: "rep-1",
        originConversationId: "conversation-1",
        generationRuns: [{ id: "run-1", inputMessageId: "message-1" }],
      }),
    },
    conversationTurnPlan: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    conversationPlanAction: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    eventAudit: { create: vi.fn() },
    workflowCommandOutbox: { upsert: vi.fn().mockImplementation(async ({ create }) => create) },
  };
}

describe("delegation execution workflow enqueue", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates one explicit local-runner workflow in development", async () => {
    vi.stubEnv("WORKFLOW_ENGINE", "local_runner");
    const tx = createTx();

    await ensureDelegationExecutionWorkflowInTransaction(tx as never, {
      representativeId: "rep-1",
      representativeSlug: "rep",
      contactId: "contact-1",
      conversationId: "conversation-1",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
    });

    expect(tx.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "DELEGATION_EXECUTION",
        engine: "LOCAL_RUNNER",
        dedupeKey: "delegation_execution:task-1",
        externalWorkflowId: "delegate:delegation_execution:task-1",
      }),
    });
  });

  it("creates a START command when Temporal is explicitly configured", async () => {
    vi.stubEnv("WORKFLOW_ENGINE", "temporal");
    vi.stubEnv("WORKFLOW_TEMPORAL_ADDRESS", "temporal:7233");
    vi.stubEnv("WORKFLOW_TEMPORAL_NAMESPACE", "delegate");
    vi.stubEnv("WORKFLOW_TEMPORAL_TASK_QUEUE", "delegate-runtime");
    const tx = createTx();

    await ensureDelegationExecutionWorkflowInTransaction(tx as never, {
      representativeId: "rep-1",
      representativeSlug: "rep",
      conversationId: "conversation-1",
      delegationTaskId: "task-1",
    });

    expect(tx.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        engine: "TEMPORAL",
        enginePhase: "DISPATCH_PENDING",
        commandOutbox: {
          create: expect.objectContaining({ commandType: "START" }),
        },
      }),
    });
  });

  it("binds a plan created before the task and starts the workflow with it", async () => {
    vi.stubEnv("WORKFLOW_ENGINE", "local_runner");
    const tx = createTx();
    tx.conversationTurnPlan.findFirst.mockResolvedValue({
      id: "plan-1",
      delegationTaskId: null,
    });

    await ensureDelegationExecutionWorkflowInTransaction(tx as never, {
      representativeId: "rep-1",
      representativeSlug: "rep",
      conversationId: "conversation-1",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
    });

    expect(tx.conversationTurnPlan.updateMany).toHaveBeenCalledWith({
      where: { id: "plan-1", delegationTaskId: null },
      data: { delegationTaskId: "task-1" },
    });
    expect(tx.conversationPlanAction.updateMany).toHaveBeenCalledWith({
      where: { turnPlanId: "plan-1", delegationTaskId: null },
      data: { delegationTaskId: "task-1" },
    });
    expect(tx.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        turnPlanId: "plan-1",
        input: expect.objectContaining({ turnPlanId: "plan-1" }),
      }),
    });
  });

  it("refreshes a nonterminal workflow to the latest effective plan revision", async () => {
    vi.stubEnv("WORKFLOW_ENGINE", "local_runner");
    const tx = createTx();
    tx.conversationTurnPlan.findFirst.mockResolvedValue({
      id: "plan-2",
      delegationTaskId: "task-1",
    });
    tx.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-1",
      status: "RUNNING",
      turnPlanId: "plan-1",
      input: { delegationTaskId: "task-1", turnPlanId: "plan-1" },
    });

    await ensureDelegationExecutionWorkflowInTransaction(tx as never, {
      representativeId: "rep-1",
      representativeSlug: "rep",
      conversationId: "conversation-1",
      delegationTaskId: "task-1",
    });

    expect(tx.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "workflow-1" },
      data: {
        turnPlanId: "plan-2",
        input: { delegationTaskId: "task-1", turnPlanId: "plan-2" },
      },
    });
    expect(tx.workflowRun.create).not.toHaveBeenCalled();
  });

  it("scopes otherwise-identical signal ids to their workflow outbox", async () => {
    const tx = createTx();
    tx.workflowRun.findUnique
      .mockResolvedValueOnce({ id: "workflow-1", engine: "TEMPORAL", status: "RUNNING" })
      .mockResolvedValueOnce({ id: "workflow-2", engine: "TEMPORAL", status: "RUNNING" });
    const signal = {
      signalId: "policy:revision-7",
      kind: "policy_revoked" as const,
      reason: "policy revision revoked",
      policyVersion: "7",
      occurredAt: "2026-08-18T00:00:00.000Z",
    };

    await enqueueDelegationExecutionSignalInTransaction(tx as never, {
      delegationTaskId: "task-1",
      signal,
    });
    await enqueueDelegationExecutionSignalInTransaction(tx as never, {
      delegationTaskId: "task-2",
      signal,
    });

    const firstId = tx.workflowCommandOutbox.upsert.mock.calls[0]?.[0]?.where?.id;
    const secondId = tx.workflowCommandOutbox.upsert.mock.calls[1]?.[0]?.where?.id;
    expect(firstId).toMatch(/^workflow_signal_[a-f0-9]{64}$/);
    expect(secondId).toMatch(/^workflow_signal_[a-f0-9]{64}$/);
    expect(secondId).not.toBe(firstId);
  });
});
