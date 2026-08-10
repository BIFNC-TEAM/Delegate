import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { editConversationMessage } from "../src/conversation-platform";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Telegram edited_message update-id concurrency", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps the higher update_id when an older edit is delayed", async () => {
    const fixture = await createFixture();
    const newest = editConversationMessage({
      representativeSlug: fixture.representativeSlug,
      conversationId: fixture.conversationId,
      messageId: fixture.messageId,
      text: "newest provider body",
      editedBy: `telegram:${fixture.senderId}`,
      telegramGuard: {
        connectionId: fixture.botId,
        chatId: fixture.chatId,
        senderId: fixture.senderId,
        externalMessageId: fixture.externalMessageId,
        updateId: 43,
        // Provider edit time is deliberately earlier: it is audit data, not
        // the ordering authority.
        editedAt: "2026-08-06T12:00:00.000Z",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const delayedOlder = editConversationMessage({
      representativeSlug: fixture.representativeSlug,
      conversationId: fixture.conversationId,
      messageId: fixture.messageId,
      text: "delayed older provider body",
      editedBy: `telegram:${fixture.senderId}`,
      telegramGuard: {
        connectionId: fixture.botId,
        chatId: fixture.chatId,
        senderId: fixture.senderId,
        externalMessageId: fixture.externalMessageId,
        updateId: 42,
        editedAt: "2026-08-06T12:05:00.000Z",
      },
    });

    const [newestResult, olderResult] = await Promise.all([
      newest,
      delayedOlder,
    ]);
    expect(newestResult.providerEditStatus).toBe("applied");
    expect(olderResult.providerEditStatus).toBe("superseded");
    await expect(prisma.message.findUniqueOrThrow({
      where: { id: fixture.messageId },
      select: {
        text: true,
        telegramLastEditUpdateId: true,
        telegramLastEditAt: true,
      },
    })).resolves.toEqual({
      text: "newest provider body",
      telegramLastEditUpdateId: 43n,
      telegramLastEditAt: new Date("2026-08-06T12:00:00.000Z"),
    });
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID();
  const botId = "777000";
  const chatId = `chat-${suffix}`;
  const senderId = `sender-${suffix}`;
  const externalMessageId = "77";
  const representativeSlug = `telegram-edit-race-${suffix}`;
  const owner = await prisma.owner.create({
    data: { displayName: `Telegram edit owner ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: representativeSlug,
      displayName: "Telegram edit representative",
      roleSummary: "Exercises Telegram provider edit ordering.",
      tone: "clear",
      languages: ["en", "zh"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const contact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      sourceChannel: "TELEGRAM",
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      channel: "PRIVATE_CHAT",
      sourceChannel: "telegram",
    },
  });
  const binding = await prisma.conversationChannelBinding.create({
    data: {
      conversationId: conversation.id,
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: botId,
      externalConversationId: chatId,
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      channelBindingId: binding.id,
      senderType: "AUDIENCE",
      senderId,
      text: "original provider body",
      externalMessageId,
    },
  });
  return {
    representativeSlug,
    conversationId: conversation.id,
    messageId: message.id,
    botId,
    chatId,
    senderId,
    externalMessageId,
  };
}

function assertSafePostgresE2eTarget() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL E2E.");
  const databaseName = new URL(value).pathname.replace(/^\//u, "").toLowerCase();
  if (!/(?:test|e2e)/u.test(databaseName)) {
    throw new Error(
      `Refusing to run PostgreSQL E2E against non-test database ${databaseName}.`,
    );
  }
}
