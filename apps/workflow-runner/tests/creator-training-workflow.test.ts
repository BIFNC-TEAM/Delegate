import {
  WorkflowEngine,
  WorkflowEnginePhase,
  WorkflowKind,
  WorkflowStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockBuildCreatorTrainingSuggestions } = vi.hoisted(() => {
  const prismaMock = {
    workflowRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
  };

  return {
    mockPrisma: prismaMock,
    mockBuildCreatorTrainingSuggestions: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@delegate/web-data", () => ({
  buildCreatorTrainingSuggestions: mockBuildCreatorTrainingSuggestions,
}));

import { processWorkflowRunById } from "../src/runner";

describe("creator training review workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "event-1" });
    mockBuildCreatorTrainingSuggestions.mockResolvedValue([
      { id: "suggestion-1" },
      { id: "suggestion-2" },
    ]);
  });

  it("builds suggestions and completes the workflow run", async () => {
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
      input: {
        representativeSlug: "lin",
        feedbackLimit: 25,
        unknownQuestionLimit: 40,
      },
      approvalRequest: null,
      handoffRequest: null,
      representative: {
        slug: "lin",
      },
    });

    await processWorkflowRunById("workflow-training-1");

    expect(mockBuildCreatorTrainingSuggestions).toHaveBeenCalledWith("lin", {
      feedbackLimit: 25,
      unknownQuestionLimit: 40,
    });
    expect(mockPrisma.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        type: "WORKFLOW_COMPLETED",
        payload: expect.objectContaining({
          workflowRunId: "workflow-training-1",
          workflowKind: "creator_training_review",
          suggestionCount: 2,
          action: "creator_training_suggestions_built",
        }),
      }),
    });
    expect(mockPrisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "workflow-training-1",
        status: {
          not: WorkflowStatus.CANCELED,
        },
      },
      data: expect.objectContaining({
        status: WorkflowStatus.COMPLETED,
        enginePhase: WorkflowEnginePhase.COMPLETED,
        output: {
          outcome: "creator_training_suggestions_built",
          representativeSlug: "lin",
          suggestionCount: 2,
        },
      }),
    });
  });
});
