import { beforeEach, describe, expect, it, vi } from "vitest";

type MatrixBindingState = {
  id: string;
  conversationId: string;
  conversation: {
    representativeId: string;
    participants: Array<{
      kind: "AUDIENCE" | "REPRESENTATIVE" | "SYSTEM";
      participantId: string;
      leftAt: Date | null;
    }>;
  };
  metadata: Record<string, unknown>;
  representativeBinding: {
    desiredState: "ACTIVE" | "PAUSED" | "DISCONNECTED";
    externalUserId: string;
    healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
    representativeId: string;
    status: string;
  } | null;
};

const {
  mockPrisma,
  tx,
  getBindingState,
  setBindingState,
  setDelayIsolationUntilCompetingLock,
  resetAdvisoryLock,
} = vi.hoisted(() => {
  let bindingState: MatrixBindingState;
  let advisoryLockTails = new Map<string, Promise<void>>();
  let delayIsolationUntilCompetingLock = false;
  let roomLockAttemptCount = 0;
  let resolveCompetingLockAttempted: (() => void) | undefined;
  let competingLockAttempted = new Promise<void>((resolve) => {
    resolveCompetingLockAttempted = resolve;
  });

  const cloneBinding = () => ({
    ...bindingState,
    conversation: {
      ...bindingState.conversation,
      participants: bindingState.conversation.participants.map(
        (participant) => ({ ...participant }),
      ),
    },
    metadata: { ...bindingState.metadata },
    representativeBinding: bindingState.representativeBinding
      ? { ...bindingState.representativeBinding }
      : null,
  });
  const applyBindingUpdate = (args: {
    data: { metadata: Record<string, unknown> };
  }) => {
    bindingState = {
      ...bindingState,
      metadata: { ...args.data.metadata },
    };
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
    matrixVirtualUserBinding: {
      findUnique: vi.fn(async () => ({
        representativeId: "representative-1",
        kind: "REPRESENTATIVE",
        enabled: true,
      })),
    },
    representativeChannelBinding: {
      findUnique: vi.fn(async () => (
        bindingState.representativeBinding
          ? {
              ...bindingState.representativeBinding,
              representative: {
                activeVersionId: "version-1",
                lifecycleState: "PUBLISHED",
                publicMode: true,
                runtimePolicyOverlays: [],
              },
            }
          : null
      )),
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
        const releaseAdvisoryLocks: Array<() => void> = [];
        const client = {
          ...transactionClient,
          $executeRaw: vi.fn(async (...args: unknown[]): Promise<unknown> => {
            await transactionClient.$executeRaw(...args);
            const key = String(args[1] ?? "");
            if (key === `matrix-room-security:!room:example.org`) {
              roomLockAttemptCount += 1;
            }
            if (roomLockAttemptCount >= 2) {
              resolveCompetingLockAttempted?.();
            }
            const previousLock =
              advisoryLockTails.get(key) ?? Promise.resolve();
            let releaseAdvisoryLock: (() => void) | undefined;
            const currentLock = new Promise<void>((resolve) => {
              releaseAdvisoryLock = resolve;
            });
            advisoryLockTails.set(
              key,
              previousLock.then(() => currentLock),
            );
            await previousLock;
            releaseAdvisoryLocks.push(() => releaseAdvisoryLock?.());
            return undefined;
          }),
        };
        try {
          return await callback(client);
        } finally {
          for (const release of releaseAdvisoryLocks.reverse()) release();
        }
      },
    ),
    conversationChannelBinding: {
      findFirst: vi.fn(async () => cloneBinding()),
      update: vi.fn(async (args) => applyBindingUpdate(args)),
    },
  };

  return {
    mockPrisma: prismaClient,
    tx: transactionClient,
    getBindingState: () => cloneBinding(),
    setBindingState: (value: MatrixBindingState) => {
      bindingState = {
        ...value,
        conversation: {
          ...value.conversation,
          participants: value.conversation.participants.map(
            (participant) => ({ ...participant }),
          ),
        },
        metadata: { ...value.metadata },
        representativeBinding: value.representativeBinding
          ? { ...value.representativeBinding }
          : null,
      };
      delayIsolationUntilCompetingLock = false;
    },
    setDelayIsolationUntilCompetingLock: (value: boolean) => {
      delayIsolationUntilCompetingLock = value;
    },
    resetAdvisoryLock: () => {
      advisoryLockTails = new Map();
      roomLockAttemptCount = 0;
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
import {
  clearMatrixRoomRemoteValidationFailures,
  getMatrixRoomSecuritySnapshot,
  MATRIX_ROOM_REMOTE_VALIDATION_MAX_ATTEMPTS,
  recordMatrixRoomRemoteValidationFailure,
  withActiveMatrixRepresentativeChannelFence,
} from "../src/matrix-room-security";

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
      conversation: {
        representativeId: "representative-1",
        participants: [
          {
            kind: "AUDIENCE",
            participantId: audienceMatrixUserId,
            leftAt: null,
          },
          {
            kind: "REPRESENTATIVE",
            participantId: representativeMatrixUserId,
            leftAt: null,
          },
        ],
      },
      metadata: {
        directMessageOnly: true,
        encrypted: false,
        securityState: "PENDING_REMOTE_VALIDATION",
        audienceMatrixUserId,
        representativeMatrixUserId,
      },
      representativeBinding: {
        desiredState: "ACTIVE",
        externalUserId: representativeMatrixUserId,
        healthStatus: "HEALTHY",
        representativeId: "representative-1",
        status: "CONNECTED",
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
      representativeId: "representative-1",
      securityState: "ACTIVE",
      remoteValidationAttemptCount: 0,
      audienceMatrixUserId,
      representativeMatrixUserId,
      representativeChannelDesiredState: "ACTIVE",
    });
  });

  it("durably schedules a bounded retry for a transient remote validation failure", async () => {
    await expect(recordMatrixRoomRemoteValidationFailure({
      roomId,
      errorCode: "matrix_join_503",
      retryable: true,
      expectedSecurityState: "PENDING_REMOTE_VALIDATION",
      eventId: "$invite-1",
    })).resolves.toEqual({
      status: "retry_scheduled",
      attemptCount: 1,
    });

    expect(getBindingState().metadata).toEqual(expect.objectContaining({
      securityState: "PENDING_REMOTE_VALIDATION",
      remoteValidationAttemptCount: 1,
      remoteValidationLastError: "matrix_join_503",
      remoteValidationEventId: "$invite-1",
    }));
    expect(tx.conversation.update).not.toHaveBeenCalled();
  });

  it("isolates a deterministic remote validation failure immediately", async () => {
    await expect(recordMatrixRoomRemoteValidationFailure({
      roomId,
      errorCode: "matrix_join_403",
      retryable: false,
      expectedSecurityState: "PENDING_REMOTE_VALIDATION",
      eventId: "$invite-1",
    })).resolves.toEqual({
      status: "isolated",
      attemptCount: 1,
    });

    expect(getBindingState().metadata).toEqual(expect.objectContaining({
      securityState: "ISOLATED",
      isolationReason: "matrix_remote_room_validation_failed",
      remoteValidationAttemptCount: 1,
      remoteValidationLastError: "matrix_join_403",
    }));
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { state: "FAILED" },
    });
  });

  it("isolates a transient failure when the durable retry budget is exhausted", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        remoteValidationAttemptCount:
          MATRIX_ROOM_REMOTE_VALIDATION_MAX_ATTEMPTS - 1,
      },
    });

    await expect(recordMatrixRoomRemoteValidationFailure({
      roomId,
      errorCode: "joined_members_503",
      retryable: true,
      expectedSecurityState: "PENDING_REMOTE_VALIDATION",
    })).resolves.toEqual({
      status: "isolated",
      attemptCount: MATRIX_ROOM_REMOTE_VALIDATION_MAX_ATTEMPTS,
    });
    expect(getBindingState().metadata).toEqual(expect.objectContaining({
      securityState: "ISOLATED",
      remoteValidationAttemptCount:
        MATRIX_ROOM_REMOTE_VALIDATION_MAX_ATTEMPTS,
      remoteValidationLastError: "joined_members_503",
    }));
  });

  it("ignores a stale invite failure after another replay activates the room", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        securityState: "ACTIVE",
      },
    });

    await expect(recordMatrixRoomRemoteValidationFailure({
      roomId,
      errorCode: "matrix_join_403",
      retryable: false,
      expectedSecurityState: "PENDING_REMOTE_VALIDATION",
    })).resolves.toEqual({
      status: "ignored",
      attemptCount: 0,
    });
    expect(getBindingState().metadata.securityState).toBe("ACTIVE");
    expect(tx.conversation.update).not.toHaveBeenCalled();
  });

  it("tracks active-room content validation retries independently", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        securityState: "ACTIVE",
      },
    });

    await expect(recordMatrixRoomRemoteValidationFailure({
      roomId,
      errorCode: "joined_members_503",
      retryable: true,
      expectedSecurityState: "ACTIVE",
    })).resolves.toEqual({
      status: "retry_scheduled",
      attemptCount: 1,
    });
    expect(getBindingState().metadata).toEqual(expect.objectContaining({
      securityState: "ACTIVE",
      remoteValidationAttemptCount: 1,
    }));
  });

  it("clears a transient failure streak after authoritative validation succeeds", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        remoteValidationAttemptCount: 2,
        remoteValidationLastError: "joined_members_503",
        remoteValidationLastAttemptAt: "2026-07-28T00:00:00.000Z",
        remoteValidationEventId: "$message-1",
      },
    });

    await expect(
      clearMatrixRoomRemoteValidationFailures(roomId),
    ).resolves.toBe(true);
    expect(getBindingState().metadata).toEqual(expect.objectContaining({
      securityState: "PENDING_REMOTE_VALIDATION",
      remoteValidationAttemptCount: 0,
      remoteValidationLastError: null,
      remoteValidationLastAttemptAt: null,
      remoteValidationEventId: null,
    }));
  });

  it("executes a representative operation while the active-channel fence is held", async () => {
    const operation = vi.fn(async () => "sent");

    await expect(withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: "representative-1",
        representativeMatrixUserId,
      },
      operation,
    )).resolves.toEqual({
      executed: true,
      value: "sent",
    });

    expect(operation).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({
      $executeRaw: expect.any(Function),
    }));
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe(
      "matrix-virtual-user:representative-1",
    );
    expect(mockPrisma.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      {
        isolationLevel: "ReadCommitted",
        maxWait: 5_000,
        timeout: 30_000,
      },
    );
  });

  it("does not execute a representative operation after the channel is paused", async () => {
    setBindingState({
      ...getBindingState(),
      representativeBinding: {
        ...getBindingState().representativeBinding!,
        desiredState: "PAUSED",
      },
    });
    const operation = vi.fn(async () => "sent");

    await expect(withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: "representative-1",
        representativeMatrixUserId,
      },
      operation,
    )).resolves.toEqual({
      executed: false,
      reason: "matrix_channel_not_active",
    });

    expect(operation).not.toHaveBeenCalled();
  });

  it("does not execute a representative operation after channel health flips to unhealthy", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        securityState: "ACTIVE",
      },
      representativeBinding: {
        ...getBindingState().representativeBinding!,
        healthStatus: "UNHEALTHY",
      },
    });
    const operation = vi.fn(async () => "sent");

    await expect(withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: "representative-1",
        representativeMatrixUserId,
        room: {
          roomId,
          conversationId: "conversation-1",
          audienceMatrixUserId,
        },
      },
      operation,
    )).resolves.toEqual({
      executed: false,
      reason: "matrix_channel_not_active",
    });

    expect(operation).not.toHaveBeenCalled();
  });

  it("does not execute after the room is isolated between remote validation and fenced send", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        securityState: "ISOLATED",
        isolationReason: "matrix_remote_room_validation_failed",
      },
    });
    const operation = vi.fn(async () => "sent");

    await expect(withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: "representative-1",
        representativeMatrixUserId,
        room: {
          roomId,
          conversationId: "conversation-1",
          audienceMatrixUserId,
        },
      },
      operation,
    )).resolves.toEqual({
      executed: false,
      reason: "matrix_room_not_active",
    });

    expect(operation).not.toHaveBeenCalled();
    expect(tx.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
      "matrix-virtual-user:representative-1",
      "matrix-room-security:!room:example.org",
    ]);
  });

  it("executes a room-scoped operation only after the active participants are reread under rep then room locks", async () => {
    setBindingState({
      ...getBindingState(),
      metadata: {
        ...getBindingState().metadata,
        securityState: "ACTIVE",
      },
    });
    const operation = vi.fn(async () => "sent");

    await expect(withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: "representative-1",
        representativeMatrixUserId,
        room: {
          roomId,
          conversationId: "conversation-1",
          audienceMatrixUserId,
        },
      },
      operation,
    )).resolves.toEqual({
      executed: true,
      value: "sent",
    });

    expect(operation).toHaveBeenCalledOnce();
    expect(tx.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
      "matrix-virtual-user:representative-1",
      "matrix-room-security:!room:example.org",
    ]);
  });

  it("does not execute a room-scoped operation after an expected participant leaves", async () => {
    setBindingState({
      ...getBindingState(),
      conversation: {
        ...getBindingState().conversation,
        participants: getBindingState().conversation.participants.map(
          (participant) => participant.kind === "AUDIENCE"
            ? { ...participant, leftAt: new Date("2026-07-28T00:00:00.000Z") }
            : participant,
        ),
      },
      metadata: {
        ...getBindingState().metadata,
        securityState: "ACTIVE",
      },
    });
    const operation = vi.fn(async () => "sent");

    await expect(withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: "representative-1",
        representativeMatrixUserId,
        room: {
          roomId,
          conversationId: "conversation-1",
          audienceMatrixUserId,
        },
      },
      operation,
    )).resolves.toEqual({
      executed: false,
      reason: "matrix_room_not_active",
    });

    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps isolation terminal when activation and isolation race", async () => {
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

    expect(typeof activated).toBe("boolean");
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
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(getBindingState().metadata.securityState).toBe("ISOLATED");
  });
});
