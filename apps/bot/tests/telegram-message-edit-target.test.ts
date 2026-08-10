import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    message: { findFirst: vi.fn() },
  },
}));

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import { findTelegramInboundMessageEditTarget } from "../src/runtime-store";
import { runWithTelegramRuntimeContext } from "../src/telegram-runtime-context";

describe("Telegram message edit target", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("resolves the original message by exact Bot, chat, sender, and provider message id", async () => {
    mockPrisma.message.findFirst.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      conversation: {
        representative: { slug: "representative-at-ingest" },
      },
    });

    await expect(runWithTelegramRuntimeContext(
      { internalConnectionId: "connection-1", botId: "777000" },
      () => findTelegramInboundMessageEditTarget({
        chatId: "123456",
        externalMessageId: "77",
        senderId: "123456",
      }),
    )).resolves.toEqual({
      messageId: "message-1",
      conversationId: "conversation-1",
      representativeSlug: "representative-at-ingest",
    });

    expect(mockPrisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        externalMessageId: "77",
        senderId: "123456",
        senderType: "AUDIENCE",
        channelBinding: {
          kind: "TELEGRAM",
          connectionId: "777000",
          externalConversationId: "123456",
        },
      },
      select: {
        id: true,
        conversationId: true,
        conversation: {
          select: {
            representative: { select: { slug: true } },
          },
        },
      },
    });
  });
});
