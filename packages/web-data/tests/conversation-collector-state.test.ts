import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, tx } = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(),
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
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

import {
  clearConversationCollectorState,
  setConversationCollectorState,
} from "../src/conversation-platform";

describe("conversation collector state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
  });

  it.each(["HUMAN_ACTIVE", "NEEDS_HUMAN"])(
    "does not start or advance collection while the conversation is %s",
    async (state) => {
      tx.conversation.findUnique.mockResolvedValue({ state });

      await expect(
        setConversationCollectorState({
          conversationId: "conversation-1",
          collectorState: { kind: "service_request", stepIndex: 1 },
        }),
      ).rejects.toMatchObject({ code: "CONVERSATION_HUMAN_ACTIVE" });

      expect(tx.conversation.update).not.toHaveBeenCalled();
    },
  );

  it("clears collector data without overwriting active human control", async () => {
    tx.conversation.findUnique.mockResolvedValue({ state: "HUMAN_ACTIVE" });

    await clearConversationCollectorState({ conversationId: "conversation-1" });

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: expect.not.objectContaining({ state: "ACTIVE" }),
    });
  });

  it("returns an AI-controlled collector conversation to ACTIVE", async () => {
    tx.conversation.findUnique.mockResolvedValue({ state: "COLLECTING" });

    await clearConversationCollectorState({ conversationId: "conversation-1" });

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: expect.objectContaining({ state: "ACTIVE" }),
    });
  });
});
