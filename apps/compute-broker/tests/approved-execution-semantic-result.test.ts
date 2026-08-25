import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvalFindMany: vi.fn(),
  executionFindUnique: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    approvalRequest: { findMany: mocks.approvalFindMany },
    toolExecution: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: mocks.executionFindUnique,
      updateMany: vi.fn(),
    },
    computeSession: { updateMany: vi.fn() },
  },
}));

vi.mock("../src/executions", () => ({
  processNextApprovedExecution: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  finalizeComputeApprovalConversation: mocks.finalize,
}));

describe("approved V3 execution semantic result fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.approvalFindMany.mockResolvedValue([{
      id: "approval-1",
      status: "APPROVED",
      toolExecutionId: "execution-1",
    }]);
  });

  it("does not publish completion for a crash window without ActionResult", async () => {
    mocks.executionFindUnique.mockResolvedValue(
      execution({ status: "SUCCEEDED", actionResult: null }),
    );
    const { reconcileApprovalConversationResults } = await import(
      "../src/approved-execution-loop"
    );

    await reconcileApprovalConversationResults();

    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("does not publish completion when SuccessContract is missing", async () => {
    mocks.executionFindUnique.mockResolvedValue(execution({
      status: "FAILED",
      actionResult: {
        semanticOutcome: "unknown",
        failure: { code: "success_contract_missing" },
      },
    }));
    const { reconcileApprovalConversationResults } = await import(
      "../src/approved-execution-loop"
    );

    await reconcileApprovalConversationResults();

    expect(mocks.finalize).toHaveBeenCalledWith({
      approvalId: "approval-1",
      outcome: "failed",
      failureReason: "external_tool_success_contract_missing",
    });
    expect(mocks.finalize).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("publishes completion only after semantic success converges", async () => {
    mocks.executionFindUnique.mockResolvedValue(execution({
      status: "SUCCEEDED",
      actionResult: { semanticOutcome: "succeeded", failure: null },
    }));
    const { reconcileApprovalConversationResults } = await import(
      "../src/approved-execution-loop"
    );

    await reconcileApprovalConversationResults();

    expect(mocks.finalize).toHaveBeenCalledWith({
      approvalId: "approval-1",
      outcome: "completed",
    });
  });
});

function execution(input: {
  status: "SUCCEEDED" | "FAILED" | "CANCELED";
  actionResult: null | {
    semanticOutcome: string;
    failure: unknown;
  };
}) {
  return {
    planActionId: "action-1",
    status: input.status,
    actionResult: input.actionResult,
    requestedPath: null,
    session: { failureReason: null },
    artifacts: [],
  };
}
