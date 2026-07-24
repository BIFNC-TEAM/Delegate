import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tx } = vi.hoisted(() => ({
  tx: {
    $executeRaw: vi.fn(),
    conversation: {
      findUnique: vi.fn(),
    },
    generationRun: {
      findUnique: vi.fn(),
    },
    delegationTask: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    delegationTaskStep: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    approvalRequest: {
      findUnique: vi.fn(),
    },
    delegationTaskExternalEffect: {
      updateMany: vi.fn(),
    },
    delegationTaskEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({ prisma: {} }));

import {
  markDelegationTaskRunningAfterApprovalInTransaction,
  validateDelegationApprovedExecutionInTransaction,
} from "../src/delegation-tasks";

const input = {
  taskId: "task-approval",
  stepId: "step-approval",
  generationRunId: "run-approval",
  originConversationId: "conversation-approval",
  approvalId: "approval-1",
};

describe("delegated approval state", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    tx.conversation.findUnique.mockResolvedValue({
      state: "AI_QUEUED",
    });
    tx.generationRun.findUnique.mockResolvedValue({
      conversationId: input.originConversationId,
      delegationTaskId: input.taskId,
      delegationTaskStepId: input.stepId,
      status: "WAITING_APPROVAL",
    });
    tx.delegationTask.findUnique.mockResolvedValue({
      originConversationId: input.originConversationId,
      status: "AWAITING_APPROVAL",
      startedAt: null,
    });
    tx.delegationTaskStep.findUnique.mockResolvedValue({
      delegationTaskId: input.taskId,
      status: "WAITING_APPROVAL",
      startedAt: null,
    });
    tx.approvalRequest.findUnique.mockResolvedValue({
      status: "APPROVED",
      conversationId: input.originConversationId,
      generationRunId: input.generationRunId,
      delegationTaskId: input.taskId,
      delegationTaskStepId: input.stepId,
    });
    tx.delegationTask.updateMany.mockResolvedValue({ count: 1 });
    tx.delegationTaskStep.updateMany.mockResolvedValue({ count: 1 });
    tx.delegationTaskExternalEffect.updateMany.mockResolvedValue({
      count: 1,
    });
    tx.delegationTaskEvent.findFirst.mockResolvedValue(null);
    tx.delegationTaskEvent.create.mockResolvedValue({ id: "task-event-1" });
  });

  it("atomically resumes the exact waiting task and step after approval", async () => {
    await expect(
      markDelegationTaskRunningAfterApprovalInTransaction(
        tx as unknown as Prisma.TransactionClient,
        { ...input, actorId: "owner-1" },
      ),
    ).resolves.toEqual({
      taskId: input.taskId,
      stepId: input.stepId,
      generationRunId: input.generationRunId,
      transitioned: true,
    });

    expect(tx.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
      input.originConversationId,
      input.generationRunId,
      input.taskId,
    ]);
    expect(tx.delegationTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.taskId,
        originConversationId: input.originConversationId,
        status: "AWAITING_APPROVAL",
      },
      data: {
        status: "RUNNING",
        nextActionBy: "SYSTEM",
        blockingReason: null,
        startedAt: expect.any(Date),
        version: { increment: 1 },
      },
    });
    expect(tx.delegationTaskStep.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.stepId,
        delegationTaskId: input.taskId,
        status: "WAITING_APPROVAL",
      },
      data: {
        status: "RUNNING",
        approvedAt: expect.any(Date),
        startedAt: expect.any(Date),
      },
    });
    expect(tx.delegationTaskExternalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        delegationTaskId: input.taskId,
        delegationTaskStepId: input.stepId,
        approvalRequestId: input.approvalId,
        status: "WAITING_APPROVAL",
      },
      data: {
        status: "APPROVED",
        approvedAt: expect.any(Date),
        failureReason: null,
      },
    });
    expect(tx.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delegationTaskId: input.taskId,
        eventType: "task.approval_granted",
        actorType: "OWNER",
        actorId: "owner-1",
        fromStatus: "AWAITING_APPROVAL",
        toStatus: "RUNNING",
        payload: {
          approvalId: input.approvalId,
          generationRunId: input.generationRunId,
          stepId: input.stepId,
        },
      }),
    });
  });

  it("rejects a cross-linked approval before changing task state", async () => {
    tx.approvalRequest.findUnique.mockResolvedValue({
      status: "APPROVED",
      conversationId: input.originConversationId,
      generationRunId: "run-other",
      delegationTaskId: input.taskId,
      delegationTaskStepId: input.stepId,
    });

    await expect(
      markDelegationTaskRunningAfterApprovalInTransaction(
        tx as unknown as Prisma.TransactionClient,
        input,
      ),
    ).rejects.toThrow(
      "does not match its task, step, run, and conversation",
    );

    expect(tx.delegationTask.updateMany).not.toHaveBeenCalled();
    expect(tx.delegationTaskStep.updateMany).not.toHaveBeenCalled();
    expect(tx.delegationTaskExternalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.delegationTaskEvent.create).not.toHaveBeenCalled();
  });

  it("allows an approved execution claim only after every locked state is ready", async () => {
    tx.delegationTask.findUnique.mockResolvedValue({
      originConversationId: input.originConversationId,
      status: "RUNNING",
      startedAt: new Date("2026-07-24T00:00:00.000Z"),
    });
    tx.delegationTaskStep.findUnique.mockResolvedValue({
      delegationTaskId: input.taskId,
      status: "RUNNING",
      startedAt: new Date("2026-07-24T00:00:00.000Z"),
    });

    await expect(
      validateDelegationApprovedExecutionInTransaction(
        tx as unknown as Prisma.TransactionClient,
        input,
      ),
    ).resolves.toEqual({ ready: true });

    expect(tx.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
      input.originConversationId,
      input.generationRunId,
      input.taskId,
    ]);
    expect(tx.delegationTask.updateMany).not.toHaveBeenCalled();
    expect(tx.delegationTaskStep.updateMany).not.toHaveBeenCalled();
    expect(tx.delegationTaskExternalEffect.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      "human control",
      "human",
      "delegation_conversation_human_controlled",
    ],
    [
      "a generation that left approval",
      "generation",
      "delegation_generation_not_waiting_approval",
    ],
    [
      "a task that is not running",
      "task",
      "delegation_task_not_running",
    ],
    [
      "a step that is not running",
      "step",
      "delegation_step_not_running",
    ],
    [
      "an unresolved approval",
      "approval",
      "delegation_approval_not_approved",
    ],
    [
      "a cross-linked run",
      "relationship",
      "delegation_approval_context_mismatch",
    ],
  ])("rejects %s before the approved execution claim", async (
    _description,
    scenario,
    reason,
  ) => {
    tx.delegationTask.findUnique.mockResolvedValue({
      originConversationId: input.originConversationId,
      status: scenario === "task" ? "AWAITING_APPROVAL" : "RUNNING",
      startedAt: new Date("2026-07-24T00:00:00.000Z"),
    });
    tx.delegationTaskStep.findUnique.mockResolvedValue({
      delegationTaskId: input.taskId,
      status: scenario === "step" ? "WAITING_APPROVAL" : "RUNNING",
      startedAt: new Date("2026-07-24T00:00:00.000Z"),
    });
    if (scenario === "human") {
      tx.conversation.findUnique.mockResolvedValue({
        state: "HUMAN_ACTIVE",
      });
    }
    if (scenario === "generation") {
      tx.generationRun.findUnique.mockResolvedValue({
        conversationId: input.originConversationId,
        delegationTaskId: input.taskId,
        delegationTaskStepId: input.stepId,
        status: "PROCESSING",
      });
    }
    if (scenario === "approval") {
      tx.approvalRequest.findUnique.mockResolvedValue({
        status: "PENDING",
        conversationId: input.originConversationId,
        generationRunId: input.generationRunId,
        delegationTaskId: input.taskId,
        delegationTaskStepId: input.stepId,
      });
    }
    if (scenario === "relationship") {
      tx.generationRun.findUnique.mockResolvedValue({
        conversationId: input.originConversationId,
        delegationTaskId: "task-other",
        delegationTaskStepId: input.stepId,
        status: "WAITING_APPROVAL",
      });
    }

    await expect(
      validateDelegationApprovedExecutionInTransaction(
        tx as unknown as Prisma.TransactionClient,
        input,
      ),
    ).resolves.toEqual({ ready: false, reason });
  });
});
