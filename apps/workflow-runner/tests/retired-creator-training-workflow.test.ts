import {
  WorkflowEngine,
  WorkflowEnginePhase,
  WorkflowKind,
  WorkflowStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workflowRun: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@delegate/web-data", () => ({
  finalizeComputeApprovalConversation: vi.fn(),
}));

import { processWorkflowRunById } from "../src/runner";

describe("retired creator training workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
  });

  it("drains a historical row without generating knowledge suggestions", async () => {
    mockPrisma.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-training-1",
      representativeId: "rep-1",
      contactId: null,
      conversationId: null,
      subagentId: null,
      kind: WorkflowKind.CREATOR_TRAINING_REVIEW,
      engine: WorkflowEngine.LOCAL_RUNNER,
      status: WorkflowStatus.RUNNING,
      enginePhase: WorkflowEnginePhase.ACTIVITY_RUNNING,
      input: { representativeSlug: "legacy-representative" },
      approvalRequest: null,
      handoffRequest: null,
      representative: { slug: "legacy-representative" },
    });

    await processWorkflowRunById("workflow-training-1");

    expect(mockPrisma.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        type: "WORKFLOW_COMPLETED",
        payload: expect.objectContaining({
          workflowRunId: "workflow-training-1",
          action: "creator_training_workflow_retired",
        }),
      }),
    });
    expect(mockPrisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "workflow-training-1",
        status: { not: WorkflowStatus.CANCELED },
      },
      data: expect.objectContaining({
        status: WorkflowStatus.COMPLETED,
        enginePhase: WorkflowEnginePhase.COMPLETED,
        output: { outcome: "creator_training_workflow_retired" },
      }),
    });
  });
});
