import {
  ChannelDesiredState,
  RepresentativeChannelKind,
  TelegramBotConnectionStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  listActiveTelegramBotRuntimeDescriptors,
} from "../src/telegram-bot-connections";

describe("Telegram Bot runtime descriptor discovery", () => {
  it("selects only safe metadata and never reads credential material", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "connection-a",
        botId: "1234567890",
        username: "delegate_test_bot",
        displayName: "Delegate Test Bot",
        credentialRevision: 3,
      },
    ]);
    const client = {
      telegramBotConnection: { findMany },
    };

    const descriptors = await listActiveTelegramBotRuntimeDescriptors({
      client: client as never,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: TelegramBotConnectionStatus.ACTIVE,
        revokedAt: null,
        activeCredentialId: { not: null },
        representativeBindings: {
          some: {
            kind: RepresentativeChannelKind.TELEGRAM,
            desiredState: ChannelDesiredState.ACTIVE,
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        botId: true,
        username: true,
        displayName: true,
        credentialRevision: true,
      },
    });
    expect(descriptors).toEqual([
      {
        connectionId: "connection-a",
        botId: "1234567890",
        username: "delegate_test_bot",
        displayName: "Delegate Test Bot",
        credentialRevision: 3,
      },
    ]);
    expect(descriptors[0]).not.toHaveProperty("token");
    expect(
      findMany.mock.calls[0]?.[0]?.select,
    ).not.toHaveProperty("activeCredential");
  });
});
