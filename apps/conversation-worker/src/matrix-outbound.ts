import type { ConversationWorkerConfig } from "./config";
import {
  getMatrixRoomSecuritySnapshot,
  isolateMatrixConversationRoom,
  withActiveMatrixRepresentativeChannelFence,
} from "@delegate/web-data";

export async function sendMatrixRepresentativeMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  roomId: string;
  senderUserId: string;
  deliveryId: string;
  senderMode: "ai" | "human_operator";
  generationRunId?: string;
  text: string;
}) {
  if (!input.config.matrixHomeserverUrl || !input.config.matrixApplicationServiceToken) {
    throw new Error("Matrix outbound delivery is not configured.");
  }

  const snapshot = await assertMatrixOutboundRoomSafe({
    config: input.config,
    conversationId: input.conversationId,
    roomId: input.roomId,
    senderUserId: input.senderUserId,
  });

  const transactionId = `delegate-${input.deliveryId}`;
  const url = new URL(
    `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
    input.config.matrixHomeserverUrl,
  );
  url.searchParams.set("user_id", input.senderUserId);

  if (!snapshot.representativeId) {
    throw new Error("Matrix room has no active representative channel.");
  }
  if (!snapshot.audienceMatrixUserId) {
    throw new Error("Matrix room has no active audience participant.");
  }
  const fencedDelivery =
    await withActiveMatrixRepresentativeChannelFence(
      {
        representativeId: snapshot.representativeId,
        representativeMatrixUserId: input.senderUserId,
        room: {
          roomId: input.roomId,
          conversationId: input.conversationId,
          audienceMatrixUserId:
            snapshot.audienceMatrixUserId,
        },
      },
      () => fetch(url, {
        method: "PUT",
        headers: {
          Authorization:
            `Bearer ${input.config.matrixApplicationServiceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "m.text",
          body: input.text,
          "com.delegate.sender_mode": input.senderMode,
          ...(input.generationRunId
            ? { "com.delegate.generation_run_id": input.generationRunId }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      }),
    );
  if (!fencedDelivery.executed) {
    throw new Error(fencedDelivery.reason === "matrix_room_not_active"
      ? "Matrix room was isolated before outbound delivery."
      : "Matrix channel became unavailable before outbound delivery.");
  }
  const response = fencedDelivery.value;
  const payload = (await response.json().catch(() => ({}))) as { event_id?: string; error?: string };
  if (!response.ok || !payload.event_id) {
    throw new Error(payload.error || `Matrix delivery failed with HTTP ${response.status}.`);
  }
  return payload.event_id;
}

async function assertMatrixOutboundRoomSafe(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  roomId: string;
  senderUserId: string;
}) {
  const homeserverUrl = input.config.matrixHomeserverUrl;
  const applicationServiceToken =
    input.config.matrixApplicationServiceToken;
  if (!homeserverUrl || !applicationServiceToken) {
    throw new Error("Matrix outbound delivery is not configured.");
  }

  const snapshot = await getMatrixRoomSecuritySnapshot(input.roomId);
  if (
    !snapshot
    || snapshot.conversationId !== input.conversationId
    || snapshot.securityState !== "ACTIVE"
    || !snapshot.audienceMatrixUserId
    || snapshot.representativeMatrixUserId !== input.senderUserId
    || snapshot.representativeChannelDesiredState !== "ACTIVE"
  ) {
    throw new Error("Matrix room is not an active verified direct room.");
  }

  const membersUrl = matrixClientUrl({
    homeserverUrl,
    path:
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}`
      + "/joined_members",
    senderUserId: input.senderUserId,
  });
  const membersResponse = await matrixFetch(
    membersUrl,
    applicationServiceToken,
  );
  if (!membersResponse.ok) {
    throw new Error("Matrix room membership validation is unavailable.");
  }
  const membersPayload: unknown = await membersResponse.json().catch(
    () => null,
  );
  const joined =
    isRecord(membersPayload) && isRecord(membersPayload.joined)
      ? Object.keys(membersPayload.joined)
      : [];
  const expectedMembers = new Set([
    snapshot.audienceMatrixUserId,
    snapshot.representativeMatrixUserId,
  ]);
  if (
    joined.length !== expectedMembers.size
    || joined.some((member) => !expectedMembers.has(member))
  ) {
    await isolateMatrixConversationRoom({
      roomId: input.roomId,
      reason: "matrix_remote_room_validation_failed",
    });
    throw new Error(
      "Matrix room membership changed; outbound delivery was isolated.",
    );
  }

  const encryptionUrl = matrixClientUrl({
    homeserverUrl,
    path:
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}`
      + "/state/m.room.encryption/",
    senderUserId: input.senderUserId,
  });
  const encryptionResponse = await matrixFetch(
    encryptionUrl,
    applicationServiceToken,
  );
  if (encryptionResponse.ok) {
    await isolateMatrixConversationRoom({
      roomId: input.roomId,
      reason: "matrix_room_encrypted",
    });
    throw new Error(
      "Matrix room encryption was enabled; outbound delivery was isolated.",
    );
  }
  if (encryptionResponse.status !== 404) {
    throw new Error("Matrix room encryption validation is unavailable.");
  }
  return snapshot;
}

function matrixClientUrl(input: {
  homeserverUrl: string;
  path: string;
  senderUserId: string;
}) {
  const url = new URL(input.path, input.homeserverUrl);
  url.searchParams.set("user_id", input.senderUserId);
  return url;
}

function matrixFetch(
  url: URL,
  applicationServiceToken: string,
) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${applicationServiceToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(5_000),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
