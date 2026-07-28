import {
  ChannelDesiredState,
  ConversationParticipantKind,
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";

import { resolveChannelAvailability } from "./channel-availability";
import { prisma } from "./prisma";

export type MatrixRoomSecurityState =
  | "PENDING_REMOTE_VALIDATION"
  | "ACTIVE"
  | "ISOLATED"
  | "UNKNOWN";

export type MatrixRoomSecuritySnapshot = {
  bindingId: string;
  conversationId: string;
  representativeId: string | null;
  securityState: MatrixRoomSecurityState;
  remoteValidationAttemptCount: number;
  audienceMatrixUserId: string | null;
  representativeMatrixUserId: string | null;
  representativeChannelDesiredState: ChannelDesiredState | null;
};

export const MATRIX_ROOM_REMOTE_VALIDATION_MAX_ATTEMPTS = 5;

export type MatrixRoomRemoteValidationFailureDisposition =
  | {
      status: "retry_scheduled";
      attemptCount: number;
    }
  | {
      status: "isolated";
      attemptCount: number;
    }
  | {
      status: "ignored";
      attemptCount: number;
    };

export async function lockMatrixRoomSecurityState(
  tx: Prisma.TransactionClient,
  roomId: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`matrix-room-security:${roomId}`})
    )
  `;
}

export async function getMatrixRoomSecuritySnapshot(
  roomId: string,
): Promise<MatrixRoomSecuritySnapshot | null> {
  const binding = await prisma.conversationChannelBinding.findFirst({
    where: {
      kind: RepresentativeChannelKind.MATRIX,
      externalConversationId: roomId,
    },
    select: {
      id: true,
      conversationId: true,
      metadata: true,
      representativeBinding: {
        select: {
          representativeId: true,
          desiredState: true,
        },
      },
    },
  });
  if (!binding) return null;

  const metadata = isJsonRecord(binding.metadata) ? binding.metadata : {};
  return {
    bindingId: binding.id,
    conversationId: binding.conversationId,
    representativeId:
      binding.representativeBinding?.representativeId ?? null,
    securityState: normalizeMatrixRoomSecurityState(metadata.securityState),
    remoteValidationAttemptCount:
      normalizeRemoteValidationAttemptCount(
        metadata.remoteValidationAttemptCount,
      ),
    audienceMatrixUserId:
      typeof metadata.audienceMatrixUserId === "string"
        ? metadata.audienceMatrixUserId
        : null,
    representativeMatrixUserId:
      typeof metadata.representativeMatrixUserId === "string"
        ? metadata.representativeMatrixUserId
        : null,
    representativeChannelDesiredState:
      binding.representativeBinding?.desiredState ?? null,
  };
}

/**
 * Persists Matrix remote-validation failures under the room security lock.
 * Transient failures are allowed a finite retry budget; deterministic failures
 * and an exhausted budget isolate the room so homeserver transaction replay
 * eventually receives a terminal 2xx response.
 */
export async function recordMatrixRoomRemoteValidationFailure(input: {
  roomId: string;
  errorCode: string;
  retryable: boolean;
  expectedSecurityState: "PENDING_REMOTE_VALIDATION" | "ACTIVE";
  eventId?: string;
}): Promise<MatrixRoomRemoteValidationFailureDisposition> {
  return prisma.$transaction(async (tx) => {
    await lockMatrixRoomSecurityState(tx, input.roomId);
    const binding = await tx.conversationChannelBinding.findFirst({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalConversationId: input.roomId,
      },
      select: {
        id: true,
        conversationId: true,
        metadata: true,
      },
    });
    if (!binding) {
      return { status: "ignored", attemptCount: 0 };
    }

    const metadata = isJsonRecord(binding.metadata) ? binding.metadata : {};
    const securityState =
      normalizeMatrixRoomSecurityState(metadata.securityState);
    const previousAttemptCount =
      normalizeRemoteValidationAttemptCount(
        metadata.remoteValidationAttemptCount,
      );
    if (securityState === "ISOLATED") {
      return {
        status: "isolated",
        attemptCount: previousAttemptCount,
      };
    }
    if (securityState !== input.expectedSecurityState) {
      return {
        status: "ignored",
        attemptCount: previousAttemptCount,
      };
    }

    const attemptCount = Math.min(
      previousAttemptCount + 1,
      MATRIX_ROOM_REMOTE_VALIDATION_MAX_ATTEMPTS,
    );
    const exhausted =
      attemptCount >= MATRIX_ROOM_REMOTE_VALIDATION_MAX_ATTEMPTS;
    if (input.retryable && !exhausted) {
      await tx.conversationChannelBinding.update({
        where: { id: binding.id },
        data: {
          metadata: {
            ...metadata,
            remoteValidationAttemptCount: attemptCount,
            remoteValidationLastError: input.errorCode,
            remoteValidationLastAttemptAt: new Date().toISOString(),
            ...(input.eventId
              ? { remoteValidationEventId: input.eventId }
              : {}),
          },
        },
      });
      return { status: "retry_scheduled", attemptCount };
    }

    const now = new Date();
    await tx.conversation.update({
      where: { id: binding.conversationId },
      data: { state: "FAILED" },
    });
    await tx.conversationChannelBinding.update({
      where: { id: binding.id },
      data: {
        metadata: {
          ...metadata,
          securityState: "ISOLATED",
          isolationReason: "matrix_remote_room_validation_failed",
          isolatedAt: now.toISOString(),
          remoteValidationAttemptCount: attemptCount,
          remoteValidationLastError: input.errorCode,
          remoteValidationLastAttemptAt: now.toISOString(),
          remoteValidationTerminalAt: now.toISOString(),
          ...(input.eventId
            ? { remoteValidationEventId: input.eventId }
            : {}),
        },
      },
    });
    return { status: "isolated", attemptCount };
  });
}

/** Clears a consecutive transient-failure streak after authoritative success. */
export async function clearMatrixRoomRemoteValidationFailures(
  roomId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockMatrixRoomSecurityState(tx, roomId);
    const binding = await tx.conversationChannelBinding.findFirst({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalConversationId: roomId,
      },
      select: {
        id: true,
        metadata: true,
      },
    });
    if (!binding || !isJsonRecord(binding.metadata)) return false;
    const metadata = binding.metadata;
    const securityState =
      normalizeMatrixRoomSecurityState(metadata.securityState);
    if (
      securityState !== "ACTIVE"
      && securityState !== "PENDING_REMOTE_VALIDATION"
    ) {
      return false;
    }
    if (
      normalizeRemoteValidationAttemptCount(
        metadata.remoteValidationAttemptCount,
      ) === 0
    ) {
      return false;
    }
    await tx.conversationChannelBinding.update({
      where: { id: binding.id },
      data: {
        metadata: {
          ...metadata,
          remoteValidationAttemptCount: 0,
          remoteValidationLastError: null,
          remoteValidationLastAttemptAt: null,
          remoteValidationEventId: null,
        },
      },
    });
    return true;
  });
}

/**
 * Serializes Matrix lifecycle work for one representative. Outbound callers
 * provide a room scope so the final authorization also rechecks complete
 * channel availability and the active direct-room participant snapshot under
 * the canonical representative -> room lock order before any external send.
 */
export async function withActiveMatrixRepresentativeChannelFence<T>(
  input: {
    representativeId: string;
    representativeMatrixUserId: string;
    room?: {
      roomId: string;
      conversationId: string;
      audienceMatrixUserId: string;
    };
  },
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<
  | { executed: true; value: T }
  | {
      executed: false;
      reason:
        | "matrix_channel_not_active"
        | "matrix_room_not_active";
    }
> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${`matrix-virtual-user:${input.representativeId}`})
      )
    `;
    const [binding, virtualUser] = await Promise.all([
      tx.representativeChannelBinding.findUnique({
        where: {
          representativeId_kind: {
            representativeId: input.representativeId,
            kind: RepresentativeChannelKind.MATRIX,
          },
        },
        select: {
          desiredState: true,
          externalUserId: true,
          healthStatus: true,
          id: true,
          status: true,
          representative: {
            select: {
              activeVersionId: true,
              lifecycleState: true,
              publicMode: true,
              runtimePolicyOverlays: {
                where: { enabled: true },
                select: {
                  enabled: true,
                  priority: true,
                  startsAt: true,
                  expiresAt: true,
                  payload: true,
                },
              },
            },
          },
        },
      }),
      tx.matrixVirtualUserBinding.findUnique({
        where: {
          matrixUserId: input.representativeMatrixUserId,
        },
        select: {
          representativeId: true,
          kind: true,
          enabled: true,
        },
      }),
    ]);
    const availability = resolveChannelAvailability({
      channel: "matrix",
      lifecycleState:
        binding?.representative.lifecycleState ?? "ARCHIVED",
      activeVersionId:
        binding?.representative.activeVersionId ?? null,
      publicMode:
        binding?.representative.publicMode ?? false,
      binding: binding
        ? {
            legacyStatus: binding.status,
            desiredState: binding.desiredState,
            healthStatus: binding.healthStatus,
          }
        : null,
      overlays:
        binding?.representative.runtimePolicyOverlays.map((overlay) => ({
          ...overlay,
          payload: isJsonRecord(overlay.payload) ? overlay.payload : {},
        })) ?? [],
    });
    if (
      (input.room !== undefined && !availability.available)
      || binding?.desiredState !== ChannelDesiredState.ACTIVE
      || binding.status === "DISCONNECTED"
      || binding.externalUserId !== input.representativeMatrixUserId
      || virtualUser?.representativeId !== input.representativeId
      || virtualUser.kind !== "REPRESENTATIVE"
      || virtualUser.enabled !== true
    ) {
      return {
        executed: false,
        reason: "matrix_channel_not_active",
      } as const;
    }
    if (input.room) {
      await lockMatrixRoomSecurityState(tx, input.room.roomId);
      const roomBinding =
        await tx.conversationChannelBinding.findFirst({
          where: {
            conversationId: input.room.conversationId,
            externalConversationId: input.room.roomId,
            kind: RepresentativeChannelKind.MATRIX,
            representativeBindingId: binding.id,
          },
          select: {
            metadata: true,
            conversation: {
              select: {
                representativeId: true,
                participants: {
                  where: {
                    kind: {
                      in: [
                        ConversationParticipantKind.AUDIENCE,
                        ConversationParticipantKind.REPRESENTATIVE,
                      ],
                    },
                    leftAt: null,
                  },
                  select: {
                    kind: true,
                    participantId: true,
                    leftAt: true,
                  },
                },
              },
            },
          },
        });
      if (
        !isActiveMatrixOutboundRoomBinding(roomBinding, {
          representativeId: input.representativeId,
          representativeMatrixUserId:
            input.representativeMatrixUserId,
          audienceMatrixUserId: input.room.audienceMatrixUserId,
        })
      ) {
        return {
          executed: false,
          reason: "matrix_room_not_active",
        } as const;
      }
    }
    return {
      executed: true,
      value: await operation(tx),
    } as const;
  }, {
    // The advisory lock is the transaction's first SQL statement. Under
    // REPEATABLE READ / SERIALIZABLE PostgreSQL can establish the snapshot
    // before waiting for the lock, so a pause or disconnect that commits while
    // we wait would remain invisible to the availability query below. READ
    // COMMITTED gives that post-lock query a fresh snapshot while the advisory
    // locks still serialize every Matrix lifecycle/room mutation.
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

function isActiveMatrixOutboundRoomBinding(
  binding: {
    metadata: unknown;
    conversation: {
      representativeId: string;
      participants: Array<{
        kind: ConversationParticipantKind;
        participantId: string;
        leftAt: Date | null;
      }>;
    };
  } | null,
  expected: {
    representativeId: string;
    representativeMatrixUserId: string;
    audienceMatrixUserId: string;
  },
) {
  if (
    !binding
    || binding.conversation.representativeId
      !== expected.representativeId
    || !isJsonRecord(binding.metadata)
    || binding.metadata.directMessageOnly !== true
    || binding.metadata.encrypted !== false
    || binding.metadata.securityState !== "ACTIVE"
    || binding.metadata.audienceMatrixUserId
      !== expected.audienceMatrixUserId
    || binding.metadata.representativeMatrixUserId
      !== expected.representativeMatrixUserId
  ) {
    return false;
  }
  const participants = binding.conversation.participants;
  return participants.length === 2
    && participants.every((participant) => participant.leftAt === null)
    && participants.some((participant) => (
      participant.kind === ConversationParticipantKind.AUDIENCE
      && participant.participantId === expected.audienceMatrixUserId
    ))
    && participants.some((participant) => (
      participant.kind === ConversationParticipantKind.REPRESENTATIVE
      && participant.participantId
        === expected.representativeMatrixUserId
    ));
}

function normalizeMatrixRoomSecurityState(
  value: unknown,
): MatrixRoomSecurityState {
  return value === "PENDING_REMOTE_VALIDATION"
    || value === "ACTIVE"
    || value === "ISOLATED"
    ? value
    : "UNKNOWN";
}

function normalizeRemoteValidationAttemptCount(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : 0;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
