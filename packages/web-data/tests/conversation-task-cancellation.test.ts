import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    delegationTask: {
      findFirst: mocks.findFirst,
    },
  },
}));

import { findConversationCancelableDelegationTask } from "../src/delegation-tasks";

const scope = {
  representativeId: "rep-1",
  conversationId: "conversation-1",
  contactId: "contact-1",
  audienceIdentityId: "audience-1",
};

describe("conversation task cancellation lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes cancellation to the representative, conversation, contact, and audience", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "task-1",
      status: "AWAITING_APPROVAL",
      approvalRequests: [{ id: "approval-1" }],
    });

    await expect(findConversationCancelableDelegationTask(scope)).resolves.toEqual({
      status: "cancelable",
      taskId: "task-1",
      pendingApprovalId: "approval-1",
    });
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        representativeId: "rep-1",
        originConversationId: "conversation-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
      }),
    }));
  });

  it("does not claim that an in-flight task was canceled", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "task-running",
      status: "RUNNING",
      approvalRequests: [],
    });

    await expect(findConversationCancelableDelegationTask(scope)).resolves.toEqual({
      status: "in_flight",
      taskId: "task-running",
    });
  });

  it("returns an idempotent result for an already canceled task", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "task-canceled" });

    await expect(findConversationCancelableDelegationTask(scope)).resolves.toEqual({
      status: "already_canceled",
      taskId: "task-canceled",
    });
  });
});
