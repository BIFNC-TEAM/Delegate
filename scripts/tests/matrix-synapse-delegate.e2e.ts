import { createHash, randomBytes } from "node:crypto";

import {
  assignConversationOperator,
  createIdentityBindingChallenge,
  disconnectOwnerMatrixChannel,
  privateChannelIdentityProviders,
  prisma,
  provisionOwnerMatrixChannel,
  sendOperatorConversationMessage,
} from "@delegate/web-data";

import { sendMatrixRepresentativeMessage } from "../../apps/conversation-worker/src/matrix-outbound";
import { processNextConversationWork } from "../../apps/conversation-worker/src/processor";

const homeserverUrl =
  process.env.MATRIX_LOCAL_HOMESERVER_URL?.trim()
  || "http://127.0.0.1:8008";
const serverName = required("MATRIX_SERVER_NAME");
const asToken = required("MATRIX_AS_TOKEN");
const username = required("MATRIX_LOCAL_TEST_USERNAME");
const password = required("MATRIX_LOCAL_TEST_PASSWORD");
const connectionId =
  process.env.MATRIX_AS_CONNECTION_ID?.trim() || "delegate-matrix-as";
const suffix = randomBytes(6).toString("hex");
const representativeSlug = "lin-founder-rep";
const matrixLocalE2eLogtoIssuer =
  "https://matrix-local-e2e.delegate.invalid/oidc";

async function main() {
  try {
    const representative = await prisma.representative.findFirstOrThrow({
    where: {
      slug: representativeSlug,
      ownerId: "owner_lin_demo",
    },
    select: {
      id: true,
      ownerId: true,
      slug: true,
    },
  });
  const controlPlane = await provisionOwnerMatrixChannel({
    ownerId: representative.ownerId,
    actorId: "matrix-local-e2e",
    representativeId: representative.id,
    requestId: `matrix-local-e2e:provision:${suffix}`,
    idempotencyKey: "matrix-local-e2e:provision:lin-founder-rep",
  });
  const representativeMatrixUserId =
    controlPlane.virtualUser.matrixUserId;
  if (!representativeMatrixUserId.endsWith(`:${serverName}`)) {
    throw new Error(
      `The seeded representative is already bound to ${representativeMatrixUserId}, `
      + `which does not belong to the local ${serverName} homeserver.`,
    );
  }

  const login = await matrixJson("/_matrix/client/v3/login", {
    method: "POST",
    body: {
      type: "m.login.password",
      identifier: {
        type: "m.id.user",
        user: username,
      },
      password,
    },
  });
  const audienceAccessToken = requireString(
    login,
    "access_token",
    "Matrix audience login",
  );
  const audienceMatrixUserId = requireString(
    login,
    "user_id",
    "Matrix audience login",
  );

  const createdRoom = await matrixJson("/_matrix/client/v3/createRoom", {
    method: "POST",
    token: audienceAccessToken,
    body: {
      preset: "trusted_private_chat",
      is_direct: true,
      invite: [representativeMatrixUserId],
      name: `Delegate application E2E ${suffix}`,
    },
  });
  const roomId = requireString(
    createdRoom,
    "room_id",
    "Matrix direct-room creation",
  );

  const activeBinding = await poll(
    async () => {
      const binding = await prisma.conversationChannelBinding.findFirst({
        where: {
          kind: "MATRIX",
          externalConversationId: roomId,
        },
        select: {
          id: true,
          conversationId: true,
          metadata: true,
        },
      });
      return readSecurityState(binding?.metadata) === "ACTIVE"
        ? binding
        : null;
    },
    "Delegate Matrix room did not reach ACTIVE after the real Synapse invite.",
  );

  const members = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    { token: audienceAccessToken },
  );
  const joinedMembers = Object.keys(
    isRecord(members.joined) ? members.joined : {},
  ).sort();
  const expectedMembers = [
    audienceMatrixUserId,
    representativeMatrixUserId,
  ].sort();
  if (JSON.stringify(joinedMembers) !== JSON.stringify(expectedMembers)) {
    throw new Error(
      `Delegate room must have exactly ${expectedMembers.join(", ")}; `
      + `Synapse reported ${joinedMembers.join(", ")}.`,
    );
  }

  const webAudienceIdentity = await ensureRegisteredWebTestIdentity(username);
  const bindingGrant = await createIdentityBindingChallenge({
    audienceIdentityId: webAudienceIdentity.id,
    provider: privateChannelIdentityProviders.matrix,
    issuer: serverName,
    connectionId,
    expectedProviderSubject: audienceMatrixUserId,
    metadata: {
      source: "matrix_local_synapse_e2e",
      representativeSlug,
    },
  });
  const binding = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`
    + `/send/m.room.message/bind-${suffix}`,
    {
      method: "PUT",
      token: audienceAccessToken,
      body: {
        msgtype: "m.text",
        body: `!bind ${bindingGrant.token}`,
      },
    },
  );
  const bindingEventId = requireString(
    binding,
    "event_id",
    "Matrix identity binding command",
  );
  const bindingEvidence = await poll(
    async () => {
      const [inbox, identityLink, conversation] = await Promise.all([
        prisma.channelEventInbox.findFirst({
          where: {
            kind: "MATRIX",
            connectionId,
            externalEventId: bindingEventId,
          },
          select: {
            id: true,
            status: true,
            payload: true,
          },
        }),
        prisma.identityLink.findUnique({
          where: {
            provider_providerSubject: {
              provider: "MATRIX",
              providerSubject: audienceMatrixUserId,
            },
          },
          select: {
            audienceIdentityId: true,
            connectionProofs: {
              where: {
                issuer: serverName,
                connectionId,
                revokedAt: null,
              },
              select: {
                verifiedAt: true,
                assuranceLevel: true,
              },
            },
          },
        }),
        prisma.conversation.findUnique({
          where: { id: activeBinding.conversationId },
          select: { audienceIdentityId: true },
        }),
      ]);
      const serializedPayload = JSON.stringify(inbox?.payload ?? {});
      const proof = identityLink?.connectionProofs[0];
      return (
        inbox?.status === "PROCESSED"
        && serializedPayload.includes("!bind [redacted]")
        && !serializedPayload.includes(bindingGrant.token)
        && identityLink?.audienceIdentityId === webAudienceIdentity.id
        && proof?.verifiedAt
        && (
          proof.assuranceLevel === "PLATFORM_VERIFIED"
          || proof.assuranceLevel === "STEP_UP_VERIFIED"
        )
        && conversation?.audienceIdentityId === webAudienceIdentity.id
      )
        ? { inboxId: inbox.id }
        : null;
    },
    "The real Matrix !bind command did not produce a redacted, verified Web identity connection.",
  );
  const challenge = await prisma.identityBindingChallenge.findUnique({
    where: {
      tokenHash: createHash("sha256")
        .update(bindingGrant.token, "utf8")
        .digest("hex"),
    },
    select: {
      consumedAt: true,
      revokedAt: true,
    },
  });
  if (!challenge?.consumedAt || challenge.revokedAt) {
    throw new Error(
      "The Matrix binding command did not consume exactly the active Web-issued challenge.",
    );
  }

  const inboundText = `delegate matrix inbound e2e ${suffix}`;
  const inbound = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`
    + `/send/m.room.message/inbound-${suffix}`,
    {
      method: "PUT",
      token: audienceAccessToken,
      body: {
        msgtype: "m.text",
        body: inboundText,
      },
    },
  );
  const inboundEventId = requireString(
    inbound,
    "event_id",
    "Matrix inbound message",
  );

  const inboundEvidence = await poll(
    async () => {
      const [inbox, message] = await Promise.all([
        prisma.channelEventInbox.findFirst({
          where: {
            kind: "MATRIX",
            connectionId,
            externalEventId: inboundEventId,
          },
          select: {
            status: true,
            conversationId: true,
          },
        }),
        prisma.message.findFirst({
          where: {
            conversationId: activeBinding.conversationId,
            externalMessageId: inboundEventId,
            text: inboundText,
            senderType: "AUDIENCE",
          },
          select: {
            id: true,
            deliveryStatus: true,
          },
        }),
      ]);
      return inbox?.status === "PROCESSED"
        && inbox.conversationId === activeBinding.conversationId
        && message
        ? { inbox, message }
        : null;
    },
    "Synapse delivered the message, but Delegate did not persist its inbox/message evidence.",
  );

  const operatorId = `matrix-local-e2e-operator-${suffix}`;
  const operatorName = "Matrix E2E Operator";
  await assignConversationOperator({
    representativeSlug,
    conversationId: activeBinding.conversationId,
    operatorId,
    operatorName,
  });
  const outboundText = `delegate matrix worker outbox e2e ${suffix}`;
  const operatorMessage = await sendOperatorConversationMessage({
    representativeSlug,
    conversationId: activeBinding.conversationId,
    operatorId,
    operatorName,
    text: outboundText,
    clientMessageId: `matrix-local-e2e-operator-${suffix}`,
  });
  const workerResult = await processNextConversationWork({
    port: 4040,
    pollMs: 500,
    matrixHomeserverUrl: homeserverUrl,
    matrixApplicationServiceToken: asToken,
    telegramConversationPlatformMode: "worker",
    telegramRequestTimeoutMs: 15_000,
    outboxProcessingLeaseMs: 5 * 60_000,
  });
  if (
    !workerResult.processed
    || workerResult.runId !== operatorMessage.id
    || workerResult.status !== "completed"
  ) {
    throw new Error(
      "The conversation worker did not claim and complete the Matrix "
      + "operator-message outbox.",
    );
  }
  const deliveredOperatorMessage = await poll(
    () =>
      prisma.message.findUnique({
        where: { id: operatorMessage.id },
        select: {
          deliveryStatus: true,
          externalMessageId: true,
        },
      }).then((message) =>
        message?.deliveryStatus === "SENT" && message.externalMessageId
          ? message
          : null
      ),
    "The Matrix operator message was not marked delivered by the worker.",
  );
  const outboundEventId = deliveredOperatorMessage.externalMessageId;
  if (!outboundEventId) {
    throw new Error(
      "The Matrix outbox worker completed without a provider event id.",
    );
  }
  const outboundTransportText = `${operatorName}: ${outboundText}`;
  const timeline = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`
    + "?dir=b&limit=30",
    { token: audienceAccessToken },
  );
  const outboundVisible = Array.isArray(timeline.chunk)
    && timeline.chunk.some(
      (event) =>
        isRecord(event)
        && event.event_id === outboundEventId
        && event.sender === representativeMatrixUserId
        && isRecord(event.content)
        && event.content.body === outboundTransportText
        && event.content["com.delegate.sender_mode"] === "human_operator",
    );
  if (!outboundVisible) {
    throw new Error(
      "The Matrix outbox worker completed, but the audience could not read "
      + "its Operator event from Synapse.",
    );
  }

  const outboundInbox = await poll(
    () =>
      prisma.channelEventInbox.findFirst({
        where: {
          kind: "MATRIX",
          connectionId,
          externalEventId: outboundEventId,
          status: "PROCESSED",
        },
        select: { id: true },
      }),
    "Delegate did not idempotently consume its managed-sender echo.",
  );

  const disconnected = await disconnectOwnerMatrixChannel({
    ownerId: representative.ownerId,
    actorId: "matrix-local-e2e",
    bindingId: controlPlane.binding.id,
    requestId: `matrix-local-e2e:disconnect:${suffix}`,
    idempotencyKey: `matrix-local-e2e:disconnect:${suffix}`,
  });
  if (
    disconnected.binding.desiredState !== "DISCONNECTED"
    || disconnected.binding.status !== "DISCONNECTED"
  ) {
    throw new Error(
      "The Matrix control plane did not enter DISCONNECTED state.",
    );
  }

  const disconnectedState = await Promise.all([
    prisma.representativeChannelBinding.findUnique({
      where: { id: controlPlane.binding.id },
      select: {
        desiredState: true,
        status: true,
      },
    }),
    prisma.matrixVirtualUserBinding.findUnique({
      where: { id: controlPlane.virtualUser.id },
      select: {
        matrixUserId: true,
        enabled: true,
      },
    }),
    prisma.conversationChannelBinding.findUnique({
      where: { id: activeBinding.id },
      select: {
        conversationId: true,
        externalConversationId: true,
        metadata: true,
      },
    }),
    prisma.message.findUnique({
      where: { id: inboundEvidence.message.id },
      select: {
        conversationId: true,
        externalMessageId: true,
        text: true,
      },
    }),
  ]);
  if (
    disconnectedState[0]?.desiredState !== "DISCONNECTED"
    || disconnectedState[0].status !== "DISCONNECTED"
    || disconnectedState[1]?.enabled !== false
    || disconnectedState[1].matrixUserId !== representativeMatrixUserId
    || disconnectedState[2]?.conversationId
      !== activeBinding.conversationId
    || disconnectedState[2].externalConversationId !== roomId
    || readSecurityState(disconnectedState[2].metadata) !== "ACTIVE"
    || disconnectedState[3]?.conversationId
      !== activeBinding.conversationId
    || disconnectedState[3].externalMessageId !== inboundEventId
    || disconnectedState[3].text !== inboundText
  ) {
    throw new Error(
      "Disconnect must disable the managed Matrix channel without deleting "
      + "its verified room binding or message history.",
    );
  }

  const disconnectedInboundText =
    `delegate matrix disconnected inbound e2e ${suffix}`;
  const disconnectedInbound = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`
    + `/send/m.room.message/disconnected-inbound-${suffix}`,
    {
      method: "PUT",
      token: audienceAccessToken,
      body: {
        msgtype: "m.text",
        body: disconnectedInboundText,
      },
    },
  );
  const disconnectedInboundEventId = requireString(
    disconnectedInbound,
    "event_id",
    "Matrix inbound message while disconnected",
  );
  const disconnectedInboundEvidence = await poll(
    async () => {
      const inbox = await prisma.channelEventInbox.findFirst({
        where: {
          kind: "MATRIX",
          connectionId,
          externalEventId: disconnectedInboundEventId,
        },
        select: {
          id: true,
          status: true,
        },
      });
      if (inbox?.status !== "PROCESSED") return null;
      const [message, generation] = await Promise.all([
        prisma.message.findFirst({
          where: {
            conversationId: activeBinding.conversationId,
            externalMessageId: disconnectedInboundEventId,
          },
          select: { id: true },
        }),
        prisma.generationRun.findFirst({
          where: {
            conversationId: activeBinding.conversationId,
            inputMessage: {
              is: {
                externalMessageId: disconnectedInboundEventId,
              },
            },
          },
          select: { id: true },
        }),
      ]);
      if (message || generation) {
        throw new Error(
          "A disconnected Matrix channel persisted an inbound business "
          + "message or scheduled a generation.",
        );
      }
      return { inboxId: inbox.id };
    },
    "Synapse delivered the disconnected Matrix event, but Delegate did not "
    + "terminally consume it.",
  );

  const disconnectedOutboundText =
    `delegate matrix disconnected outbound e2e ${suffix}`;
  let disconnectedOutboundRejected = false;
  try {
    await sendMatrixRepresentativeMessage({
      config: {
        matrixHomeserverUrl: homeserverUrl,
        matrixApplicationServiceToken: asToken,
      } as Parameters<typeof sendMatrixRepresentativeMessage>[0]["config"],
      conversationId: activeBinding.conversationId,
      roomId,
      senderUserId: representativeMatrixUserId,
      deliveryId: `matrix-local-e2e-disconnected-${suffix}`,
      senderMode: "human_operator",
      text: disconnectedOutboundText,
    });
  } catch {
    disconnectedOutboundRejected = true;
  }
  if (!disconnectedOutboundRejected) {
    throw new Error(
      "The Matrix outbound adapter accepted delivery after disconnect.",
    );
  }
  const disconnectedTimeline = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`
    + "?dir=b&limit=50",
    { token: audienceAccessToken },
  );
  if (timelineContainsText(disconnectedTimeline, disconnectedOutboundText)) {
    throw new Error(
      "The Matrix outbound adapter wrote an event after disconnect.",
    );
  }

  const reconnected = await provisionOwnerMatrixChannel({
    ownerId: representative.ownerId,
    actorId: "matrix-local-e2e",
    representativeId: representative.id,
    requestId: `matrix-local-e2e:reconnect:${suffix}`,
    idempotencyKey: `matrix-local-e2e:reconnect:${suffix}`,
  });
  if (
    reconnected.binding.id !== controlPlane.binding.id
    || reconnected.binding.desiredState !== "ACTIVE"
    || reconnected.virtualUser.id !== controlPlane.virtualUser.id
    || reconnected.virtualUser.matrixUserId !== representativeMatrixUserId
    || reconnected.virtualUser.enabled !== true
  ) {
    throw new Error(
      "Re-provisioning did not reactivate the existing managed Matrix identity.",
    );
  }

  const retainedHistory = await Promise.all([
    prisma.conversationChannelBinding.findUnique({
      where: { id: activeBinding.id },
      select: {
        conversationId: true,
        externalConversationId: true,
        metadata: true,
      },
    }),
    prisma.message.findUnique({
      where: { id: inboundEvidence.message.id },
      select: {
        conversationId: true,
        externalMessageId: true,
        text: true,
      },
    }),
  ]);
  if (
    retainedHistory[0]?.conversationId !== activeBinding.conversationId
    || retainedHistory[0].externalConversationId !== roomId
    || readSecurityState(retainedHistory[0].metadata) !== "ACTIVE"
    || retainedHistory[1]?.conversationId !== activeBinding.conversationId
    || retainedHistory[1].externalMessageId !== inboundEventId
    || retainedHistory[1].text !== inboundText
  ) {
    throw new Error(
      "Reconnecting Matrix replaced or lost the existing room history.",
    );
  }

  const reconnectedInboundText =
    `delegate matrix reconnected inbound e2e ${suffix}`;
  const reconnectedInbound = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`
    + `/send/m.room.message/reconnected-inbound-${suffix}`,
    {
      method: "PUT",
      token: audienceAccessToken,
      body: {
        msgtype: "m.text",
        body: reconnectedInboundText,
      },
    },
  );
  const reconnectedInboundEventId = requireString(
    reconnectedInbound,
    "event_id",
    "Matrix inbound message after reconnect",
  );
  const reconnectedInboundEvidence = await poll(
    async () => {
      const [inbox, message] = await Promise.all([
        prisma.channelEventInbox.findFirst({
          where: {
            kind: "MATRIX",
            connectionId,
            externalEventId: reconnectedInboundEventId,
          },
          select: {
            id: true,
            status: true,
            conversationId: true,
          },
        }),
        prisma.message.findFirst({
          where: {
            conversationId: activeBinding.conversationId,
            externalMessageId: reconnectedInboundEventId,
            text: reconnectedInboundText,
            senderType: "AUDIENCE",
          },
          select: { id: true },
        }),
      ]);
      return (
        inbox?.status === "PROCESSED"
        && inbox.conversationId === activeBinding.conversationId
        && message
      )
        ? { inboxId: inbox.id, messageId: message.id }
        : null;
    },
    "Matrix inbound delivery did not resume after re-provisioning.",
  );

  const reconnectedOutboundText =
    `delegate matrix reconnected outbound e2e ${suffix}`;
  const reconnectedOutboundEventId =
    await sendMatrixRepresentativeMessage({
      config: {
        matrixHomeserverUrl: homeserverUrl,
        matrixApplicationServiceToken: asToken,
      } as Parameters<typeof sendMatrixRepresentativeMessage>[0]["config"],
      conversationId: activeBinding.conversationId,
      roomId,
      senderUserId: representativeMatrixUserId,
      deliveryId: `matrix-local-e2e-reconnected-${suffix}`,
      senderMode: "human_operator",
      text: reconnectedOutboundText,
    });
  const reconnectedTimeline = await matrixJson(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`
    + "?dir=b&limit=50",
    { token: audienceAccessToken },
  );
  if (
    !Array.isArray(reconnectedTimeline.chunk)
    || !reconnectedTimeline.chunk.some(
      (event) =>
        isRecord(event)
        && event.event_id === reconnectedOutboundEventId
        && event.sender === representativeMatrixUserId
        && isRecord(event.content)
        && event.content.body === reconnectedOutboundText
        && event.content["com.delegate.sender_mode"] === "human_operator",
    )
  ) {
    throw new Error(
      "Matrix outbound delivery did not resume after re-provisioning.",
    );
  }
  const reconnectedOutboundInbox = await poll(
    () =>
      prisma.channelEventInbox.findFirst({
        where: {
          kind: "MATRIX",
          connectionId,
          externalEventId: reconnectedOutboundEventId,
          status: "PROCESSED",
        },
        select: { id: true },
      }),
    "Delegate did not consume the post-reconnect managed-sender echo.",
  );

  console.log(
    "result=matrix_delegate_synapse_e2e_passed"
    + ` room=${roomId}`
    + ` conversation=${activeBinding.conversationId}`
    + ` binding_inbox=${bindingEvidence.inboxId}`
    + ` inbound_message=${inboundEvidence.message.id}`
    + ` outbound_echo=${outboundInbox.id}`
    + ` disconnected_inbox=${disconnectedInboundEvidence.inboxId}`
    + ` reconnected_inbox=${reconnectedInboundEvidence.inboxId}`
    + ` reconnected_message=${reconnectedInboundEvidence.messageId}`
    + ` reconnected_outbound_echo=${reconnectedOutboundInbox.id}`,
  );
  } finally {
    await prisma.$disconnect();
  }
}

async function ensureRegisteredWebTestIdentity(localUsername: string) {
  const providerSubject = `matrix-local-e2e:${localUsername}`;
  const identity = await prisma.audienceIdentity.upsert({
    where: {
      audienceKey: `registered:matrix-local-e2e:${localUsername}`,
    },
    create: {
      audienceKey: `registered:matrix-local-e2e:${localUsername}`,
      status: "REGISTERED",
    },
    update: {
      status: "REGISTERED",
      mergedIntoId: null,
      lastSeenAt: new Date(),
    },
    select: {
      id: true,
    },
  });
  await prisma.identityLink.upsert({
    where: {
      provider_providerSubject: {
        provider: "LOGTO",
        providerSubject,
      },
    },
    create: {
      audienceIdentityId: identity.id,
      provider: "LOGTO",
      providerSubject,
      issuer: matrixLocalE2eLogtoIssuer,
      verifiedAt: new Date(),
      assuranceLevel: "PLATFORM_VERIFIED",
      proofMetadata: {
        method: "matrix_local_synapse_e2e",
      },
    },
    update: {
      audienceIdentityId: identity.id,
      issuer: matrixLocalE2eLogtoIssuer,
      verifiedAt: new Date(),
      assuranceLevel: "PLATFORM_VERIFIED",
      revokedAt: null,
      proofMetadata: {
        method: "matrix_local_synapse_e2e",
      },
    },
  });
  return identity;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function matrixJson(
  resource: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
  } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  const response = await fetch(new URL(resource, homeserverUrl), {
    method: options.method || "GET",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok || !isRecord(payload)) {
    throw new Error(
      `${options.method || "GET"} ${resource} failed (${response.status}): `
      + JSON.stringify(payload),
    );
  }
  return payload;
}

async function poll<T>(
  read: () => Promise<T | null>,
  failureMessage: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(failureMessage);
}

function readSecurityState(value: unknown) {
  return isRecord(value) && typeof value.securityState === "string"
    ? value.securityState
    : null;
}

function timelineContainsText(
  timeline: Record<string, unknown>,
  text: string,
) {
  return Array.isArray(timeline.chunk)
    && timeline.chunk.some(
      (event) =>
        isRecord(event)
        && isRecord(event.content)
        && event.content.body === text,
    );
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is missing. Run \`pnpm matrix:local:init\` first.`,
    );
  }
  return value;
}

function requireString(
  payload: Record<string, unknown>,
  key: string,
  operation: string,
) {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`${operation} returned no ${key}.`);
  }
  return value;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
