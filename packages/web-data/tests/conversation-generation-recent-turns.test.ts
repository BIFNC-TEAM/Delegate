import { MessageSenderType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  message: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: { message: mocks.message },
}));

import { loadGenerationRecentTurns } from "../src/conversation-platform";

describe("generation recent-turn recall boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.message.findUnique.mockResolvedValue({
      createdAt: new Date("2026-08-04T10:05:00.000Z"),
    });
    mocks.message.findMany.mockResolvedValue([
      {
        senderType: MessageSenderType.AUDIENCE,
        text: "First audience question",
      },
      {
        senderType: MessageSenderType.AUDIENCE,
        text: "Second audience question",
      },
    ]);
  });

  it("queries only audience-authored messages and emits inbound turns", async () => {
    const recentTurns = await loadGenerationRecentTurns({
      conversationId: "conversation-1",
      beforeMessageId: "message-current",
      limit: 6,
    });

    expect(mocks.message.findMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        redactedAt: null,
        text: { not: null },
        createdAt: { lt: new Date("2026-08-04T10:05:00.000Z") },
        senderType: MessageSenderType.AUDIENCE,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 6,
      select: { senderType: true, text: true },
    });
    expect(recentTurns).toEqual([
      { direction: "inbound", messageText: "Second audience question" },
      { direction: "inbound", messageText: "First audience question" },
    ]);
    expect(recentTurns.every((turn) => turn.direction === "inbound")).toBe(true);
  });
});
