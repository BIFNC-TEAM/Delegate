import {
  Channel,
  IdentityAssuranceLevel,
  IdentityLinkProvider,
  PaymentProvider,
  RepresentativeChannelKind,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getConversationContext } from "../../apps/bot/src/runtime-store";
import {
  acceptInboundConversationMessage,
  activateVerifiedMatrixDirectConversation,
  assertConversationChannelDeliveryAvailable,
  ingestMatrixApplicationServiceTransaction,
} from "../../packages/web-data/src/conversation-platform";
import {
  provisionOwnerMatrixChannel,
  setOwnerChannelDesiredState,
} from "../../packages/web-data/src/channel-management";
import {
  consumeIdentityBindingChallenge,
  createIdentityBindingChallenge,
} from "../../packages/web-data/src/audience-identity-binding";
import { prisma } from "../../packages/web-data/src/prisma";
import {
  createServicePaymentOrder,
  fulfillServicePaymentOrder,
  hasUnifiedConversationEntitlement,
} from "../../packages/web-data/src/service-entitlements";

const describePostgres =
  process.env.DELEGATE_CHANNEL_POSTGRES_E2E === "1"
    ? describe
    : describe.skip;

if (process.env.DELEGATE_CHANNEL_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("channel platform PostgreSQL 16 closure", () => {
  beforeAll(async () => {
    process.env.TELEGRAM_BOT_ID = "777001";
    process.env.TELEGRAM_BOT_USERNAME = "delegate_channel_fixture_bot";
    process.env.MATRIX_SERVER_NAME = "matrix.local.test";
    process.env.MATRIX_AS_CONNECTION_ID = "delegate-channel-fixture-as";

    const [version] = await prisma.$queryRaw<
      Array<{ server_version_num: string }>
    >`SELECT current_setting('server_version_num') AS server_version_num`;
    const versionNumber = Number(version?.server_version_num);
    if (versionNumber < 160_000 || versionNumber >= 170_000) {
      throw new Error(
        `Channel platform E2E requires PostgreSQL 16; received ${version?.server_version_num ?? "unknown"}.`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("unifies Web identity and entitlement while preserving native Matrix and Telegram routing", async () => {
    const fixture = await createFixture();

    const telegramBeforeBinding = await getConversationContext(
      fixture.representativeSlug,
      {
        telegramUserId: fixture.telegramUserId,
        username: "channel_fixture",
        displayName: "Channel Fixture",
        chatId: fixture.telegramChatId,
        channel: Channel.PRIVATE_CHAT,
      },
    );
    expect(telegramBeforeBinding.audienceIdentityId).not.toBe(
      fixture.webAudienceIdentityId,
    );

    const telegramGrant = await createIdentityBindingChallenge({
      audienceIdentityId: fixture.webAudienceIdentityId,
      provider: IdentityLinkProvider.TELEGRAM,
      issuer: "delegate-managed-bot",
      connectionId: process.env.TELEGRAM_BOT_ID!,
      expectedProviderSubject: String(fixture.telegramUserId),
    });
    await expect(
      consumeIdentityBindingChallenge({
        token: telegramGrant.token,
        provider: IdentityLinkProvider.TELEGRAM,
        providerSubject: String(fixture.telegramUserId),
        issuer: "delegate-managed-bot",
        connectionId: process.env.TELEGRAM_BOT_ID!,
      }),
    ).resolves.toMatchObject({
      audienceIdentityId: fixture.webAudienceIdentityId,
      provider: IdentityLinkProvider.TELEGRAM,
    });

    const telegram = await getConversationContext(
      fixture.representativeSlug,
      {
        telegramUserId: fixture.telegramUserId,
        chatId: fixture.telegramChatId,
        channel: Channel.PRIVATE_CHAT,
      },
    );
    expect(telegram.audienceIdentityId).toBe(fixture.webAudienceIdentityId);

    const matrixControlPlane = await provisionOwnerMatrixChannel({
      ownerId: fixture.ownerId,
      actorId: fixture.ownerId,
      representativeId: fixture.representativeId,
      requestId: `${fixture.suffix}:matrix-provision`,
      idempotencyKey: `${fixture.suffix}:matrix-provision`,
    });
    const representativeMatrixUserId =
      matrixControlPlane.virtualUser.matrixUserId;
    const audienceMatrixUserId = `@audience_${fixture.suffix}:matrix.local.test`;
    const roomId = `!room_${fixture.suffix}:matrix.local.test`;

    await expect(
      ingestMatrixApplicationServiceTransaction({
        transactionId: `${fixture.suffix}:matrix-invite-transaction`,
        events: [
          {
            event_id: `$invite_${fixture.suffix}`,
            type: "m.room.member",
            room_id: roomId,
            sender: audienceMatrixUserId,
            state_key: representativeMatrixUserId,
            content: { membership: "invite", is_direct: true },
          },
        ],
      }),
    ).resolves.toEqual([
      { eventId: `$invite_${fixture.suffix}`, status: "processed" },
    ]);

    const matrixConversation = await prisma.conversation.findFirstOrThrow({
      where: {
        representativeId: fixture.representativeId,
        channelBindings: {
          some: {
            kind: RepresentativeChannelKind.MATRIX,
            externalConversationId: roomId,
          },
        },
      },
      select: { id: true, audienceIdentityId: true },
    });
    expect(matrixConversation.audienceIdentityId).not.toBe(
      fixture.webAudienceIdentityId,
    );
    await expect(
      activateVerifiedMatrixDirectConversation({
        roomId,
        audienceMatrixUserId,
        representativeMatrixUserId,
      }),
    ).resolves.toBe(true);

    const matrixGrant = await createIdentityBindingChallenge({
      audienceIdentityId: fixture.webAudienceIdentityId,
      provider: IdentityLinkProvider.MATRIX,
      issuer: "matrix.local.test",
      connectionId: process.env.MATRIX_AS_CONNECTION_ID!,
      expectedProviderSubject: audienceMatrixUserId,
    });
    await expect(
      ingestMatrixApplicationServiceTransaction({
        transactionId: `${fixture.suffix}:matrix-bind-transaction`,
        events: [
          matrixTextEvent({
            eventId: `$bind_${fixture.suffix}`,
            roomId,
            sender: audienceMatrixUserId,
            body: `!bind ${matrixGrant.token}`,
          }),
        ],
      }),
    ).resolves.toEqual([
      { eventId: `$bind_${fixture.suffix}`, status: "processed" },
    ]);

    const [telegramLink, matrixLink, linkedConversations] = await Promise.all([
      prisma.identityLink.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: IdentityLinkProvider.TELEGRAM,
            providerSubject: String(fixture.telegramUserId),
          },
        },
      }),
      prisma.identityLink.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: IdentityLinkProvider.MATRIX,
            providerSubject: audienceMatrixUserId,
          },
        },
      }),
      prisma.conversation.findMany({
        where: {
          id: { in: [telegram.conversationId, matrixConversation.id] },
        },
        select: {
          id: true,
          audienceIdentityId: true,
          sourceChannel: true,
        },
      }),
    ]);
    expect(telegramLink.audienceIdentityId).toBe(
      fixture.webAudienceIdentityId,
    );
    expect(matrixLink.audienceIdentityId).toBe(fixture.webAudienceIdentityId);
    expect(
      linkedConversations.map((conversation) => ({
        audienceIdentityId: conversation.audienceIdentityId,
        sourceChannel: conversation.sourceChannel,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          audienceIdentityId: fixture.webAudienceIdentityId,
          sourceChannel: "telegram",
        },
        {
          audienceIdentityId: fixture.webAudienceIdentityId,
          sourceChannel: "matrix",
        },
      ]),
    );

    const telegramClientMessageId = `telegram:${fixture.telegramChatId}:1`;
    await acceptInboundConversationMessage({
      representativeSlug: fixture.representativeSlug,
      conversationId: telegram.conversationId,
      text: "hello from Telegram",
      senderId: String(fixture.telegramUserId),
      clientMessageId: telegramClientMessageId,
      externalMessageId: "1",
      channel: "telegram",
    });
    await acceptInboundConversationMessage({
      representativeSlug: fixture.representativeSlug,
      conversationId: telegram.conversationId,
      text: "hello from Telegram",
      senderId: String(fixture.telegramUserId),
      clientMessageId: telegramClientMessageId,
      externalMessageId: "1",
      channel: "telegram",
    });

    const matrixMessageId = `$message_${fixture.suffix}`;
    const matrixMessage = matrixTextEvent({
      eventId: matrixMessageId,
      roomId,
      sender: audienceMatrixUserId,
      body: "hello from Matrix",
    });
    await expect(
      ingestMatrixApplicationServiceTransaction({
        transactionId: `${fixture.suffix}:matrix-message-transaction`,
        events: [matrixMessage],
      }),
    ).resolves.toEqual([
      { eventId: matrixMessageId, status: "processed" },
    ]);
    await expect(
      ingestMatrixApplicationServiceTransaction({
        transactionId: `${fixture.suffix}:matrix-message-replay`,
        events: [matrixMessage],
      }),
    ).resolves.toEqual([
      { eventId: matrixMessageId, status: "duplicate" },
    ]);

    await expectSingleGeneration({
      conversationId: telegram.conversationId,
      clientMessageId: telegramClientMessageId,
    });
    await expectSingleGeneration({
      conversationId: matrixConversation.id,
      clientMessageId: matrixMessageId,
    });

    const paymentOrderId = `${fixture.suffix}:web-mock-order`;
    const providerOrderId = `${fixture.suffix}:web-mock-provider-order`;
    await createServicePaymentOrder({
      id: paymentOrderId,
      payerAudienceIdentityId: fixture.webAudienceIdentityId,
      representativeId: fixture.representativeId,
      provider: PaymentProvider.MOCK,
      providerAccountId: "delegate-web-mock",
      providerOrderId,
      productCode: "pass",
      amountMinor: 1_000,
      currency: "CNY",
      entitlementUnits: 5,
      priceSnapshot: {
        source: "web_mock_recharge",
        amountMinor: 1_000,
        currency: "CNY",
      },
    });
    await fulfillServicePaymentOrder({
      paymentOrderId,
      provider: PaymentProvider.MOCK,
      providerAccountId: "delegate-web-mock",
      providerOrderId,
      providerEventId: `${fixture.suffix}:web-mock-paid`,
      payerAudienceIdentityId: fixture.webAudienceIdentityId,
      amountMinor: 1_000,
      currency: "CNY",
      verifiedAt: new Date(),
      rawPayload: { fixture: true, source: "web_mock_recharge" },
    });
    await expect(
      hasUnifiedConversationEntitlement({
        audienceIdentityId: telegram.audienceIdentityId,
        representativeId: fixture.representativeId,
        productCodes: ["pass"],
      }),
    ).resolves.toBe(true);
    await expect(
      hasUnifiedConversationEntitlement({
        audienceIdentityId:
          (
            await prisma.conversation.findUniqueOrThrow({
              where: { id: matrixConversation.id },
              select: { audienceIdentityId: true },
            })
          ).audienceIdentityId!,
        representativeId: fixture.representativeId,
        productCodes: ["pass"],
      }),
    ).resolves.toBe(true);

    await setOwnerChannelDesiredState({
      ownerId: fixture.ownerId,
      actorId: fixture.ownerId,
      bindingId: matrixControlPlane.binding.id,
      desiredState: "PAUSED",
      requestId: `${fixture.suffix}:matrix-pause`,
      idempotencyKey: `${fixture.suffix}:matrix-pause`,
    });
    await expect(
      assertConversationChannelDeliveryAvailable({
        conversationId: matrixConversation.id,
        channel: "matrix",
      }),
    ).rejects.toMatchObject({ code: "channel_paused" });

    const pausedMessageId = `$paused_${fixture.suffix}`;
    const pausedResult = await ingestMatrixApplicationServiceTransaction({
      transactionId: `${fixture.suffix}:matrix-paused-transaction`,
      events: [
        matrixTextEvent({
          eventId: pausedMessageId,
          roomId,
          sender: audienceMatrixUserId,
          body: "defer while paused",
        }),
      ],
    });
    expect(pausedResult).toEqual([
      {
        eventId: pausedMessageId,
        status: "failed",
        reason: expect.stringContaining("channel_paused"),
      },
    ]);
    expect(
      await prisma.message.count({
        where: {
          conversationId: matrixConversation.id,
          clientMessageId: pausedMessageId,
        },
      }),
    ).toBe(0);

    await setOwnerChannelDesiredState({
      ownerId: fixture.ownerId,
      actorId: fixture.ownerId,
      bindingId: matrixControlPlane.binding.id,
      desiredState: "ACTIVE",
      requestId: `${fixture.suffix}:matrix-resume`,
      idempotencyKey: `${fixture.suffix}:matrix-resume`,
    });
    await expect(
      assertConversationChannelDeliveryAvailable({
        conversationId: matrixConversation.id,
        channel: "matrix",
      }),
    ).resolves.toBeUndefined();
    await prisma.channelEventInbox.updateMany({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalEventId: pausedMessageId,
      },
      data: { availableAt: new Date(0) },
    });
    await expect(
      ingestMatrixApplicationServiceTransaction({
        transactionId: `${fixture.suffix}:matrix-resumed-retry`,
        events: [
          matrixTextEvent({
            eventId: pausedMessageId,
            roomId,
            sender: audienceMatrixUserId,
            body: "defer while paused",
          }),
        ],
      }),
    ).resolves.toEqual([
      { eventId: pausedMessageId, status: "processed" },
    ]);
    await expectSingleGeneration({
      conversationId: matrixConversation.id,
      clientMessageId: pausedMessageId,
    });

    expect(
      await prisma.serviceEntitlementAccount.count({
        where: {
          audienceIdentityId: fixture.webAudienceIdentityId,
          representativeId: fixture.representativeId,
          productCode: "pass",
        },
      }),
    ).toBe(1);
  });
});

async function createFixture() {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const ownerId = `owner_${suffix}`;
  const representativeId = `rep_${suffix}`;
  const representativeSlug = `channel-fixture-${suffix.replaceAll("_", "-")}`;
  const webAudienceIdentityId = `audience_web_${suffix}`;

  await prisma.owner.create({
    data: {
      id: ownerId,
      displayName: "Channel fixture owner",
    },
  });
  await prisma.representative.create({
    data: {
      id: representativeId,
      ownerId,
      slug: representativeSlug,
      displayName: "Channel fixture representative",
      roleSummary: "Channel fixture",
      tone: "neutral",
      languages: ["en"],
      freeScope: ["fixture"],
      paywalledIntents: ["deep_help"],
      handoffPrompt: "Escalate to the fixture owner.",
      allowedSkills: [],
      actionGate: {},
      lifecycleState: "DRAFT",
      publicMode: true,
    },
  });
  const version = await prisma.representativeVersion.create({
    data: {
      representativeId,
      versionNumber: 1,
      status: "PUBLISHED",
      snapshot: {
        displayName: "Channel fixture representative",
        roleSummary: "Channel fixture",
      },
      publishedBy: ownerId,
    },
  });
  await prisma.representative.update({
    where: { id: representativeId },
    data: {
      lifecycleState: "PUBLISHED",
      activeVersionId: version.id,
    },
  });
  await prisma.audienceIdentity.create({
    data: {
      id: webAudienceIdentityId,
      audienceKey: `web:registered:${suffix}`,
      status: "REGISTERED",
    },
  });
  await prisma.identityLink.create({
    data: {
      audienceIdentityId: webAudienceIdentityId,
      provider: IdentityLinkProvider.LOGTO,
      providerSubject: `logto_${suffix}`,
      issuer: "delegate-test-logto",
      connectionId: "delegate-test-web",
      verifiedAt: new Date(),
      assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
      proofMetadata: { method: "authenticated_web_session" },
    },
  });

  return {
    suffix,
    ownerId,
    representativeId,
    representativeSlug,
    webAudienceIdentityId,
    telegramUserId: 8_000_000 + Math.floor(Math.random() * 900_000),
    telegramChatId: 9_000_000 + Math.floor(Math.random() * 900_000),
  };
}

function matrixTextEvent(input: {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
}) {
  return {
    event_id: input.eventId,
    type: "m.room.message",
    room_id: input.roomId,
    sender: input.sender,
    content: {
      msgtype: "m.text",
      body: input.body,
    },
  };
}

async function expectSingleGeneration(input: {
  conversationId: string;
  clientMessageId: string;
}) {
  const message = await prisma.message.findUniqueOrThrow({
    where: {
      conversationId_clientMessageId: {
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
      },
    },
    select: { id: true },
  });
  const runs = await prisma.generationRun.findMany({
    where: {
      conversationId: input.conversationId,
      inputMessageId: message.id,
    },
    select: { id: true },
  });
  expect(runs).toHaveLength(1);
  expect(
    await prisma.outboxEvent.count({
      where: {
        aggregateType: "generation_run",
        aggregateId: runs[0]!.id,
        eventType: "generation.requested",
      },
    }),
  ).toBe(1);
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for the channel platform PostgreSQL E2E.",
    );
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
  ) {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote channel E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
