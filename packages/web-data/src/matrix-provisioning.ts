import {
  Channel,
  ChannelDesiredState,
  ChannelHealthStatus,
  ChannelSourceProvider,
  ChannelTransport,
  ConversationParticipantKind,
  RepresentativeChannelKind,
} from "@prisma/client";

import { prisma } from "./prisma";
import { lockMatrixRoomSecurityState } from "./matrix-room-security";
import { resolveChannelAudienceIdentity } from "./web-audience";

export type ProvisionMatrixDirectConversationInput = {
  representativeId: string;
  roomId: string;
  audienceMatrixUserId: string;
  representativeMatrixUserId: string;
  /**
   * Matrix's invite flag is advisory, but it is the only direct-room signal
   * available to an Application Service at invite time. Callers must have
   * checked `m.room.member.content.is_direct === true` before provisioning.
   */
  directInvite: true;
  audienceDisplayName?: string;
  connectionId?: string;
};

export type ProvisionedMatrixConversation = {
  status: "ready";
  securityState: "PENDING_REMOTE_VALIDATION" | "ACTIVE" | "ISOLATED";
  representativeId: string;
  audienceIdentityId: string;
  contactId: string;
  conversationId: string;
  channelBindingId: string;
  roomId: string;
};

export type MatrixProvisioningConflict = {
  status: "isolated_conflict";
  securityState: "ISOLATED";
  reason:
    | "matrix_room_binding_participant_conflict"
    | "matrix_room_binding_invalid_security_state";
  representativeId: string;
  conversationId: string;
  channelBindingId: string;
  roomId: string;
};

export type MatrixProvisioningResult =
  | ProvisionedMatrixConversation
  | MatrixProvisioningConflict;

export function resolveMatrixApplicationServiceConnectionId(
  value: string | undefined = process.env.MATRIX_AS_CONNECTION_ID,
) {
  return value?.trim().toLowerCase() || "delegate-matrix-as";
}

/**
 * Creates the database side of a native Matrix 1:1 room. Joining the managed
 * representative user to the remote room remains the Application Service
 * adapter's responsibility.
 */
export async function provisionMatrixDirectConversation(
  input: ProvisionMatrixDirectConversationInput,
): Promise<MatrixProvisioningResult> {
  if (input.directInvite !== true) {
    throw new Error("Matrix provisioning requires an explicit direct invite.");
  }
  const representativeId = requireId(input.representativeId, "representativeId");
  const roomId = normalizeMatrixRoomId(input.roomId);
  const audienceMatrixUserId = normalizeMatrixUserId(input.audienceMatrixUserId);
  const representativeMatrixUserId = normalizeMatrixUserId(
    input.representativeMatrixUserId,
  );
  if (audienceMatrixUserId === representativeMatrixUserId) {
    throw new Error("Audience and representative Matrix users must be different.");
  }
  const connectionId = resolveMatrixApplicationServiceConnectionId(
    input.connectionId,
  );
  const now = new Date();
  const audienceIdentity = await resolveChannelAudienceIdentity({
    provider: "MATRIX",
    providerSubject: audienceMatrixUserId,
    issuer: matrixHomeserver(audienceMatrixUserId),
    connectionId,
    now,
  });

  return prisma.$transaction(async (tx) => {
    await lockMatrixRoomSecurityState(tx, roomId);
    const existingBinding = await tx.conversationChannelBinding.findFirst({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalConversationId: roomId,
      },
      select: {
        id: true,
        conversationId: true,
        metadata: true,
        conversation: {
          select: {
            representativeId: true,
            audienceIdentityId: true,
            contactId: true,
          },
        },
      },
    });
    if (existingBinding) {
      const metadata = isJsonRecord(existingBinding.metadata)
        ? existingBinding.metadata
        : {};
      const securityState = metadata.securityState;
      const knownSecurityState =
        securityState === "PENDING_REMOTE_VALIDATION"
        || securityState === "ACTIVE"
        || securityState === "ISOLATED";
      const sameParticipants =
        existingBinding.conversation.representativeId === representativeId
        && metadata.audienceMatrixUserId === audienceMatrixUserId
        && metadata.representativeMatrixUserId === representativeMatrixUserId;
      if (!sameParticipants || !knownSecurityState) {
        const isolationReason = sameParticipants
          ? "matrix_room_binding_invalid_security_state"
          : "matrix_room_binding_participant_conflict";
        await tx.conversation.update({
          where: { id: existingBinding.conversationId },
          data: { state: "FAILED" },
        });
        await tx.conversationChannelBinding.update({
          where: { id: existingBinding.id },
          data: {
            metadata: {
              ...metadata,
              securityState: "ISOLATED",
              encrypted: metadata.encrypted === true,
              isolationReason,
              isolatedAt: now.toISOString(),
              observedAudienceMatrixUserId: audienceMatrixUserId,
              observedRepresentativeMatrixUserId: representativeMatrixUserId,
              observedRepresentativeId: representativeId,
            },
          },
        });
        return {
          status: "isolated_conflict",
          securityState: "ISOLATED",
          reason: isolationReason,
          representativeId: existingBinding.conversation.representativeId,
          conversationId: existingBinding.conversationId,
          channelBindingId: existingBinding.id,
          roomId,
        };
      }

      return {
        status: "ready",
        securityState,
        representativeId,
        audienceIdentityId:
          existingBinding.conversation.audienceIdentityId
          || audienceIdentity.id,
        contactId: existingBinding.conversation.contactId,
        conversationId: existingBinding.conversationId,
        channelBindingId: existingBinding.id,
        roomId,
      };
    }

    const representative = await tx.representative.findUnique({
      where: { id: representativeId },
      select: {
        id: true,
        displayName: true,
        lifecycleState: true,
        activeVersionId: true,
      },
    });
    if (!representative) throw new Error("Representative was not found.");
    if (representative.lifecycleState !== "PUBLISHED" || !representative.activeVersionId) {
      throw new Error("Representative must be published before Matrix provisioning.");
    }

    await tx.matrixVirtualUserBinding.upsert({
      where: { matrixUserId: representativeMatrixUserId },
      create: {
        matrixUserId: representativeMatrixUserId,
        representativeId,
        kind: "REPRESENTATIVE",
        displayName: representative.displayName,
        enabled: true,
      },
      update: {
        representativeId,
        kind: "REPRESENTATIVE",
        displayName: representative.displayName,
        enabled: true,
      },
    });
    const representativeBinding = await tx.representativeChannelBinding.upsert({
      where: {
        representativeId_kind: {
          representativeId,
          kind: RepresentativeChannelKind.MATRIX,
        },
      },
      create: {
        representativeId,
        kind: RepresentativeChannelKind.MATRIX,
        transport: ChannelTransport.MATRIX,
        sourceProvider: ChannelSourceProvider.MATRIX,
        connectionId,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.HEALTHY,
        externalUserId: representativeMatrixUserId,
        status: "CONNECTED",
        displayName: representative.displayName,
        configuration: {
          managed: true,
          directMessageOnly: true,
          encrypted: false,
        },
        lastHealthCheckAt: now,
      },
      update: {
        transport: ChannelTransport.MATRIX,
        sourceProvider: ChannelSourceProvider.MATRIX,
        connectionId,
        healthStatus: ChannelHealthStatus.HEALTHY,
        externalUserId: representativeMatrixUserId,
        status: "CONNECTED",
        lastHealthCheckAt: now,
        lastError: null,
      },
    });

    let contact = await tx.contact.findFirst({
      where: {
        representativeId,
        audienceIdentityId: audienceIdentity.id,
      },
      orderBy: { createdAt: "asc" },
    });
    if (!contact) {
      contact = await tx.contact.create({
        data: {
          representativeId,
          audienceIdentityId: audienceIdentity.id,
          telegramUserId: null,
          channelUserId: audienceMatrixUserId,
          externalUserId: audienceMatrixUserId,
          displayName: input.audienceDisplayName?.trim() || audienceMatrixUserId,
          source: "matrix",
          sourceChannel: "matrix",
          lastSeenAt: now,
        },
      });
    } else {
      contact = await tx.contact.update({
        where: { id: contact.id },
        data: { lastSeenAt: now },
      });
    }

    let conversation = await tx.conversation.findFirst({
      where: {
        representativeId,
        contactId: contact.id,
        sourceChannel: "matrix",
        externalConversationId: roomId,
      },
      orderBy: { createdAt: "asc" },
    });
    if (!conversation) {
      conversation = await tx.conversation.create({
        data: {
          representativeId,
          contactId: contact.id,
          audienceIdentityId: audienceIdentity.id,
          telegramChatId: null,
          channel: Channel.PRIVATE_CHAT,
          sourceChannel: "matrix",
          externalConversationId: roomId,
          state: "ACTIVE",
          lastMessageAt: now,
        },
      });
    }

    const bindingKey = `MATRIX:${representativeId}:${roomId}:`;
    const channelBinding = await tx.conversationChannelBinding.upsert({
      where: { bindingKey },
      create: {
        conversationId: conversation.id,
        representativeBindingId: representativeBinding.id,
        kind: RepresentativeChannelKind.MATRIX,
        transport: ChannelTransport.MATRIX,
        sourceProvider: ChannelSourceProvider.MATRIX,
        connectionId,
        bindingKey,
        externalConversationId: roomId,
        metadata: {
          directMessageOnly: true,
          encrypted: false,
          audienceMatrixUserId,
          representativeMatrixUserId,
          // A direct invite is only a candidate. The Application Service must
          // join and verify the room's authoritative state before ingress can
          // queue AI work.
          securityState: "PENDING_REMOTE_VALIDATION",
        },
      },
      update: {
        conversationId: conversation.id,
        representativeBindingId: representativeBinding.id,
        connectionId,
        metadata: {
          directMessageOnly: true,
          encrypted: false,
          audienceMatrixUserId,
          representativeMatrixUserId,
          securityState: "PENDING_REMOTE_VALIDATION",
        },
      },
    });

    await tx.conversationParticipant.upsert({
      where: {
        conversationId_kind_participantId: {
          conversationId: conversation.id,
          kind: ConversationParticipantKind.AUDIENCE,
          participantId: audienceMatrixUserId,
        },
      },
      create: {
        conversationId: conversation.id,
        kind: ConversationParticipantKind.AUDIENCE,
        participantId: audienceMatrixUserId,
        displayName: input.audienceDisplayName?.trim() || audienceMatrixUserId,
        metadata: {
          provider: "MATRIX",
          matrixUserId: audienceMatrixUserId,
          directMessageOnly: true,
        },
      },
      update: {
        leftAt: null,
        displayName: input.audienceDisplayName?.trim() || audienceMatrixUserId,
      },
    });

    await tx.conversationParticipant.upsert({
      where: {
        conversationId_kind_participantId: {
          conversationId: conversation.id,
          kind: ConversationParticipantKind.REPRESENTATIVE,
          participantId: representativeMatrixUserId,
        },
      },
      create: {
        conversationId: conversation.id,
        kind: ConversationParticipantKind.REPRESENTATIVE,
        participantId: representativeMatrixUserId,
        displayName: representative.displayName,
        metadata: {
          provider: "MATRIX",
          matrixUserId: representativeMatrixUserId,
          managed: true,
          directMessageOnly: true,
        },
      },
      update: {
        leftAt: null,
        displayName: representative.displayName,
      },
    });

    return {
      status: "ready",
      securityState: "PENDING_REMOTE_VALIDATION",
      representativeId,
      audienceIdentityId: audienceIdentity.id,
      contactId: contact.id,
      conversationId: conversation.id,
      channelBindingId: channelBinding.id,
      roomId,
    };
  });
}

function normalizeMatrixUserId(value: string): string {
  const userId = requireId(value, "Matrix user id");
  if (!/^@[^\s:]+:[^\s:]+$/.test(userId)) {
    throw new Error("Matrix user id must be a full MXID.");
  }
  const separator = userId.lastIndexOf(":");
  return `${userId.slice(0, separator)}:${userId.slice(separator + 1).toLowerCase()}`;
}

function normalizeMatrixRoomId(value: string): string {
  const roomId = requireId(value, "Matrix room id");
  if (!/^![^\s:]+:[^\s:]+$/.test(roomId)) {
    throw new Error("Matrix room id must be a full room id.");
  }
  return roomId;
}

function matrixHomeserver(matrixUserId: string): string {
  return matrixUserId.slice(matrixUserId.lastIndexOf(":") + 1).toLowerCase();
}

function requireId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
