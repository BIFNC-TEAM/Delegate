import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, tx } = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(),
    conversation: { findUnique: vi.fn() },
    delegationTask: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    delegationTaskEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  return {
    tx: transactionClient,
    prisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma }));

import { createConversationServiceRequest } from "../src/delegation-tasks";

const input = {
  representativeId: "representative-1",
  representativeVersionId: "version-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  episodeId: "episode-1",
  inputMessageId: "message-1",
  intent: "refund",
  objective: "Review order-1 for a refund",
  desiredOutcome: "Owner reviews the request and responds with next steps.",
  priority: 72,
};

describe("conversation service requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.conversation.findUnique.mockResolvedValue({
      representativeId: "representative-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-identity-1",
      state: "ACTIVE",
    });
    tx.delegationTask.findUnique.mockResolvedValue(null);
    tx.delegationTask.create.mockResolvedValue({ id: "service-request-1" });
    tx.delegationTaskEvent.findFirst.mockResolvedValue(null);
    tx.delegationTaskEvent.create.mockResolvedValue({ id: "event-1" });
  });

  it("creates an owner-visible request without authorizing tools or side effects", async () => {
    await expect(createConversationServiceRequest(input)).resolves.toEqual({
      task: { id: "service-request-1" },
      skipped: null,
    });

    expect(tx.delegationTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "SERVICE_REQUEST",
        status: "WAITING_FOR_OWNER",
        nextActionBy: "OWNER",
        idempotencyKey: "service-request:message-1",
        planSummary: expect.stringContaining("尚未授权工具调用"),
      }),
    });
    expect(tx.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "service_request.created",
        toStatus: "WAITING_FOR_OWNER",
      }),
    });
  });

  it("reuses the request for the same input message", async () => {
    tx.delegationTask.findUnique.mockResolvedValue({
      id: "service-request-existing",
      representativeId: "representative-1",
      contactId: "contact-1",
      originConversationId: "conversation-1",
    });

    await expect(createConversationServiceRequest(input)).resolves.toMatchObject({
      task: { id: "service-request-existing" },
      skipped: "existing",
    });

    expect(tx.delegationTask.create).not.toHaveBeenCalled();
    expect(tx.delegationTaskEvent.create).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key owned by another conversation", async () => {
    tx.delegationTask.findUnique.mockResolvedValue({
      id: "service-request-existing",
      representativeId: "representative-2",
      contactId: "contact-2",
      originConversationId: "conversation-2",
    });

    await expect(createConversationServiceRequest(input)).rejects.toThrow(
      "Service request idempotency key belongs to another conversation.",
    );
    expect(tx.delegationTask.create).not.toHaveBeenCalled();
  });

  it.each(["NEEDS_HUMAN", "HUMAN_ACTIVE"])(
    "does not create a duplicate request while the conversation is %s",
    async (state) => {
      tx.conversation.findUnique.mockResolvedValue({
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-identity-1",
        state,
      });

      await expect(createConversationServiceRequest(input)).resolves.toEqual({
        task: null,
        skipped: "human_active",
      });
      expect(tx.delegationTask.findUnique).not.toHaveBeenCalled();
      expect(tx.delegationTask.create).not.toHaveBeenCalled();
    },
  );
});
