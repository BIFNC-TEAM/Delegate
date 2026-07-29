import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, tx, setState } = vi.hoisted(() => {
  let state: {
    conversationRevision: number | null;
    representativeRevision: number;
    connectionId: string;
    botStatus: string;
  };
  const transactionClient = {
    $executeRaw: vi.fn(),
    conversationChannelBinding: {
      findFirst: vi.fn(async () => ({
        connectionId: state.connectionId,
        representativeAssignmentRevision:
          state.conversationRevision,
        representativeBinding: {
          connectionId: state.connectionId,
          telegramBotConnectionId: "telegram-connection-1",
          endpointAssignmentRevision:
            state.representativeRevision,
          status: "CONFIGURED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          telegramBotConnection: {
            id: "telegram-connection-1",
            botId: state.connectionId,
            status: state.botStatus,
          },
          representative: {
            lifecycleState: "PUBLISHED",
            activeVersionId: "version-1",
            publicMode: true,
            runtimePolicyOverlays: [],
          },
        },
      })),
    },
  };
  return {
    tx: transactionClient,
    mockPrisma: {
      conversationChannelBinding: {
        findFirst: vi.fn(async () => ({
          representativeBinding: {
            representativeId: "representative-1",
          },
        })),
      },
      $transaction: vi.fn(
        async <T>(
          callback: (
            client: typeof transactionClient,
          ) => Promise<T>,
        ) => callback(transactionClient),
      ),
    },
    setState: (next: typeof state) => {
      state = next;
    },
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

import {
  withActiveTelegramRepresentativeChannelFence,
} from "../src/telegram-channel-security";

describe("Telegram representative channel fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({
      conversationRevision: 3,
      representativeRevision: 3,
      connectionId: "8718299151",
      botStatus: "ACTIVE",
    });
  });

  it("runs the provider call only under the current positive epoch", async () => {
    const operation = vi.fn(async () => "message-1");

    await expect(
      withActiveTelegramRepresentativeChannelFence(
        {
          conversationId: "conversation-3",
          expectedConnectionId: "8718299151",
        },
        operation,
      ),
    ).resolves.toEqual({
      executed: true,
      value: "message-1",
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("permanently rejects an old A epoch after an A -> B -> A cycle", async () => {
    setState({
      conversationRevision: 1,
      representativeRevision: 3,
      connectionId: "8718299151",
      botStatus: "ACTIVE",
    });
    const operation = vi.fn();

    await expect(
      withActiveTelegramRepresentativeChannelFence(
        {
          conversationId: "conversation-1",
          expectedConnectionId: "8718299151",
        },
        operation,
      ),
    ).resolves.toEqual({
      executed: false,
      reason: "telegram_channel_not_active",
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    {
      conversationRevision: null,
      representativeRevision: 3,
      botStatus: "ACTIVE",
    },
    {
      conversationRevision: 3,
      representativeRevision: 3,
      botStatus: "DISABLED",
    },
  ])(
    "fails closed for legacy NULL epochs and inactive Bots",
    async (state) => {
      setState({
        ...state,
        connectionId: "8718299151",
      });
      const operation = vi.fn();

      const result =
        await withActiveTelegramRepresentativeChannelFence(
          {
            conversationId: "conversation-unsafe",
            expectedConnectionId: "8718299151",
          },
          operation,
        );
      expect(result).toEqual({
        executed: false,
        reason: "telegram_channel_not_active",
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );
});
