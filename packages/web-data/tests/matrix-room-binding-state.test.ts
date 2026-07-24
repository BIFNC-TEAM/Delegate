import { beforeEach, describe, expect, it, vi } from "vitest";

type MatrixBindingState = {
  id: string;
  conversationId: string;
  metadata: Record<string, unknown>;
};

const {
  mockPrisma,
  tx,
  getBindingState,
  setBindingState,
  setDelayRootActivationUntilIsolation,
  setDelayIsolationUntilCompetingLock,
  resetAdvisoryLock,
} = vi.hoisted(() => {
  let bindingState: MatrixBindingState;
  let advisoryLockTail: Promise<void> = Promise.resolve();
  let delayRootActivationUntilIsolation = false;
  let delayIsolationUntilCompetingLock = false;
  let advisoryLockAttemptCount = 0;
  let resolveIsolationWritten: (() => void) | undefined;
  let isolationWritten = new Promise<void>((resolve) => {
    resolveIsolationWritten = resolve;
  });
  let resolveCompetingLockAttempted: (() => void) | undefined;
  let competingLockAttempted = new Promise<void>((resolve) => {
    resolveCompetingLockAttempted = resolve;
  });

  const cloneBinding = () => ({
    ...bindingState,
    metadata: { ...bindingState.metadata },
  });
  const applyBindingUpdate = (args: {
    data: { metadata: Record<string, unknown> };
  }) => {
    bindingState = {
      ...bindingState,
      metadata: { ...args.data.metadata },
    };
    if (bindingState.metadata.securityState === "ISOLATED") {
      resolveIsolationWritten?.();
    }
    return cloneBinding();
  };

  const transactionClient = {
    $executeRaw: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    conversation: {
      update: vi.fn(),
    },
    conversationParticipant: {
      upsert: vi.fn(),
    },
    conversationChannelBinding: {
      findFirst: vi.fn(async () => cloneBinding()),
      update: vi.fn(async (args) => {
        if (
          delayIsolationUntilCompetingLock
          && args.data.metadata.securityState === "ISOLATED"
        ) {
          await competingLockAttempted;
        }
        return applyBindingUpdate(args);
      }),
    },
  };
  const prismaClient = {
    $transaction: vi.fn(
      async <T>(callback: (client: typeof transactionClient) => Promise<T>) => {
        let releaseAdvisoryLock: (() => void) | undefined;
        const client = {
          ...transactionClient,
          $executeRaw: vi.fn(async (...args: unknown[]): Promise<unknown> => {
            await transactionClient.$executeRaw(...args);
            advisoryLockAttemptCount += 1;
            if (advisoryLockAttemptCount >= 2) {
              resolveCompetingLockAttempted?.();
            }
            const previousLock = advisoryLockTail;
            advisoryLockTail = new Promise<void>((resolve) => {
              releaseAdvisoryLock = resolve;
            });
            await previousLock;
            return undefined;
          }),
        };
        try {
          return await callback(client);
        } finally {
          releaseAdvisoryLock?.();
        }
      },
    ),
    conversationChannelBinding: {
      findFirst: vi.fn(async () => cloneBinding()),
      update: vi.fn(async (args) => {
        if (
          delayRootActivationUntilIsolation
          && args.data.metadata.securityState === "ACTIVE"
        ) {
          await isolationWritten;
        }
        return applyBindingUpdate(args);
      }),
    },
  };

  return {
    mockPrisma: prismaClient,
    tx: transactionClient,
    getBindingState: () => cloneBinding(),
    setBindingState: (value: MatrixBindingState) => {
      bindingState = {
        ...value,
        metadata: { ...value.metadata },
      };
      delayRootActivationUntilIsolation = false;
      delayIsolationUntilCompetingLock = false;
      isolationWritten = new Promise<void>((resolve) => {
        resolveIsolationWritten = resolve;
      });
    },
    setDelayRootActivationUntilIsolation: (value: boolean) => {
      delayRootActivationUntilIsolation = value;
    },
    setDelayIsolationUntilCompetingLock: (value: boolean) => {
      delayIsolationUntilCompetingLock = value;
    },
    resetAdvisoryLock: () => {
      advisoryLockTail = Promise.resolve();
      advisoryLockAttemptCount = 0;
      competingLockAttempted = new Promise<void>((resolve) => {
        resolveCompetingLockAttempted = resolve;
      });
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import {
  activateVerifiedMatrixDirectConversation,
  isolateMatrixConversationRoom,
} from "../src/conversation-platform";
import { getMatrixRoomSecuritySnapshot } from "../src/matrix-room-security";

const roomId = "!room:example.org";
const audienceMatrixUserId = "@alice:example.org";
const representativeMatrixUserId = "@_delegate_rep:example.org";

describe("Matrix room binding security state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAdvisoryLock();
    setBindingState({
      id: "matrix-binding-1",
      conversationId: "conversation-1",
      metadata: {
        directMessageOnly: true,
        encrypted: false,
        securityState: "PENDING_REMOTE_VALIDATION",
        audienceMatrixUserId,
        representativeMatrixUserId,
      },
    });
    tx.$executeRaw.mockResolvedValue(0);
    tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
  });

  it.each([
    "ACTIVE",
    "ISOLATED",
    "UNKNOWN",
  ])("refuses to activate from %s", async (securityState) => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        securityState,
      },
    });

    await expect(activateVerifiedMatrixDirectConversation({
      roomId,
      audienceMatrixUserId,
      representativeMatrixUserId,
    })).resolves.toBe(false);

    expect(getBindingState().metadata.securityState).toBe(securityState);
  });

  it("reports the persisted room state and bound participants to the bridge", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        securityState: "ACTIVE",
      },
    });

    await expect(getMatrixRoomSecuritySnapshot(roomId)).resolves.toEqual({
      bindingId: "matrix-binding-1",
      conversationId: "conversation-1",
      securityState: "ACTIVE",
      audienceMatrixUserId,
      representativeMatrixUserId,
    });
  });

  it("keeps isolation terminal when activation and isolation race", async () => {
    // Reproduces the old read-then-write race: pause the non-transactional
    // activation write until isolation has committed.
    setDelayRootActivationUntilIsolation(true);

    const [activated, isolated] = await Promise.all([
      activateVerifiedMatrixDirectConversation({
        roomId,
        audienceMatrixUserId,
        representativeMatrixUserId,
      }),
      isolateMatrixConversationRoom({
        roomId,
        reason: "matrix_remote_room_validation_failed",
      }),
    ]);

    expect(activated).toBe(true);
    expect(isolated).toBe(true);
    expect(getBindingState().metadata).toEqual(expect.objectContaining({
      securityState: "ISOLATED",
      isolationReason: "matrix_remote_room_validation_failed",
    }));
  });

  it("rejects activation when isolation acquires the room lock first", async () => {
    setDelayIsolationUntilCompetingLock(true);
    const isolation = isolateMatrixConversationRoom({
      roomId,
      reason: "matrix_remote_room_validation_failed",
    });
    await vi.waitFor(() => {
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    const activation = activateVerifiedMatrixDirectConversation({
      roomId,
      audienceMatrixUserId,
      representativeMatrixUserId,
    });

    await expect(isolation).resolves.toBe(true);
    await expect(activation).resolves.toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(getBindingState().metadata.securityState).toBe("ISOLATED");
  });
});
