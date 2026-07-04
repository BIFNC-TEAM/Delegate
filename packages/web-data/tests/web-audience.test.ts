import { describe, expect, it } from "vitest";

import {
  buildWebAudienceKey,
  buildWebAudienceExternalUserId,
  buildWebChannelUserId,
  linkAudienceIdentity,
  loadWebConversationRecentTurns,
  mergeAudienceIdentity,
  persistWebConversationExchange,
  resolveAnonymousAudienceIdentity,
  resolveAuthenticatedAudienceIdentity,
  resolveWebAudienceConversation,
  resolveWebAudienceContact,
} from "../src/web-audience";

describe("web audience identity resolver", () => {
  it("upserts one contact per representative/audience pair", async () => {
    const client = new FakeWebAudienceClient();

    const first = await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lao-jia",
        audienceId: "aud_123",
      },
      client,
    );
    const second = await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lao-jia",
        audienceId: "aud_123",
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(client.contacts).toHaveLength(1);
    expect(client.contacts[0]).toMatchObject({
      representativeId: "rep-1",
      audienceIdentityId: "identity-1",
      telegramUserId: "web:aud_123",
      channelUserId: "web:aud_123",
      source: "web",
      sourceChannel: "web",
    });
    expect(client.audienceIdentities).toHaveLength(1);
    expect(client.identityLinks[0]).toMatchObject({
      audienceIdentityId: "identity-1",
      provider: "WEB_ANONYMOUS",
      providerSubject: "web:aud_123",
    });
  });

  it("keeps the same anonymous audience isolated between representatives", async () => {
    const client = new FakeWebAudienceClient();

    await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lao-jia",
        audienceId: "aud_123",
      },
      client,
    );
    await resolveWebAudienceContact(
      {
        representativeId: "rep-2",
        representativeSlug: "lin",
        audienceId: "aud_123",
      },
      client,
    );

    expect(client.contacts).toHaveLength(2);
    expect(client.contacts.map((contact) => contact.representativeId)).toEqual(["rep-1", "rep-2"]);
  });

  it("normalizes web audience identifiers for contact and wallet use", () => {
    expect(buildWebAudienceKey("aud_ABC")).toBe("web:aud_abc");
    expect(buildWebChannelUserId("aud_ABC")).toBe("web:aud_abc");
    expect(buildWebAudienceExternalUserId("lao-jia", "aud_ABC")).toBe("web:lao-jia:aud_abc");
  });

  it("resolves a stable anonymous audience identity and web identity link", async () => {
    const client = new FakeWebAudienceClient();

    const first = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_123",
        now: new Date("2026-07-04T12:00:00.000Z"),
      },
      client,
    );
    const second = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "AUD_123",
        now: new Date("2026-07-04T12:05:00.000Z"),
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(client.audienceIdentities).toEqual([
      expect.objectContaining({
        id: "identity-1",
        audienceKey: "web:aud_123",
        status: "ANONYMOUS",
        lastSeenAt: new Date("2026-07-04T12:05:00.000Z"),
      }),
    ]);
    expect(client.identityLinks).toEqual([
      expect.objectContaining({
        audienceIdentityId: "identity-1",
        provider: "WEB_ANONYMOUS",
        providerSubject: "web:aud_123",
      }),
    ]);
  });

  it("links external identities to an audience identity", async () => {
    const client = new FakeWebAudienceClient();
    const identity = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_123",
      },
      client,
    );

    await linkAudienceIdentity(
      {
        audienceIdentityId: identity.id,
        provider: "EMAIL",
        providerSubject: "Ada@Example.COM ",
        verifiedAt: new Date("2026-07-04T12:00:00.000Z"),
      },
      client,
    );

    expect(client.identityLinks).toContainEqual(
      expect.objectContaining({
        audienceIdentityId: identity.id,
        provider: "EMAIL",
        providerSubject: "ada@example.com",
        verifiedAt: new Date("2026-07-04T12:00:00.000Z"),
      }),
    );
  });

  it("merges anonymous identity references into a target identity", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_source",
      },
      client,
    );
    const target = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_target",
      },
      client,
    );
    client.contacts.push(buildContactRow({ id: "contact-source", audienceIdentityId: source.id }));
    client.conversations.push(
      buildConversationRow({ id: "conversation-source", audienceIdentityId: source.id }),
    );
    client.userWallets.push({ id: "wallet-source", audienceIdentityId: source.id });
    client.sandboxIdentities.push({ id: "sandbox-source", audienceIdentityId: source.id });
    client.memoryRecords.push({ id: "memory-source", audienceIdentityId: source.id });

    await mergeAudienceIdentity(
      {
        sourceAudienceIdentityId: source.id,
        targetAudienceIdentityId: target.id,
        now: new Date("2026-07-04T12:30:00.000Z"),
      },
      client,
    );

    expect(client.contacts[0]?.audienceIdentityId).toBe(target.id);
    expect(client.conversations[0]?.audienceIdentityId).toBe(target.id);
    expect(client.userWallets[0]?.audienceIdentityId).toBe(target.id);
    expect(client.sandboxIdentities[0]?.audienceIdentityId).toBe(target.id);
    expect(client.memoryRecords[0]?.audienceIdentityId).toBe(target.id);
    expect(client.identityLinks.every((link) => link.audienceIdentityId !== source.id)).toBe(true);
    expect(client.audienceIdentities.find((identity) => identity.id === source.id)).toMatchObject({
      status: "MERGED",
      mergedIntoId: target.id,
      lastSeenAt: new Date("2026-07-04T12:30:00.000Z"),
    });
  });

  it("merges the current anonymous identity into an existing authenticated identity", async () => {
    const client = new FakeWebAudienceClient();
    const anonymous = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_anonymous",
      },
      client,
    );
    const registered = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_registered",
      },
      client,
    );
    client.identityLinks.push({
      id: "identity-link-logto",
      audienceIdentityId: registered.id,
      provider: "LOGTO",
      providerSubject: "LogtoUserA",
      verifiedAt: new Date("2026-07-04T12:00:00.000Z"),
      metadata: null,
    });
    client.contacts.push(buildContactRow({ id: "contact-anonymous", audienceIdentityId: anonymous.id }));
    client.conversations.push(
      buildConversationRow({ id: "conversation-anonymous", audienceIdentityId: anonymous.id }),
    );
    client.userWallets.push({ id: "wallet-anonymous", audienceIdentityId: anonymous.id });
    client.sandboxIdentities.push({ id: "sandbox-anonymous", audienceIdentityId: anonymous.id });
    client.memoryRecords.push({ id: "memory-anonymous", audienceIdentityId: anonymous.id });

    const result = await resolveAuthenticatedAudienceIdentity(
      {
        audienceIdentityId: anonymous.id,
        provider: "LOGTO",
        providerSubject: "LogtoUserA",
        verifiedAt: new Date("2026-07-04T13:00:00.000Z"),
        now: new Date("2026-07-04T13:00:00.000Z"),
      },
      client,
    );

    expect(result.id).toBe(registered.id);
    expect(client.contacts[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.conversations[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.userWallets[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.sandboxIdentities[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.memoryRecords[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.audienceIdentities.find((identity) => identity.id === anonymous.id)).toMatchObject({
      status: "MERGED",
      mergedIntoId: registered.id,
    });
    expect(client.audienceIdentities.find((identity) => identity.id === registered.id)).toMatchObject({
      status: "REGISTERED",
      lastSeenAt: new Date("2026-07-04T13:00:00.000Z"),
    });
  });

  it("creates one conversation per web audience contact", async () => {
    const client = new FakeWebAudienceClient();

    const first = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );
    const second = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(client.conversations).toHaveLength(1);
    expect(client.conversations[0]).toMatchObject({
      representativeId: "rep-1",
      contactId: "contact-1",
      audienceIdentityId: "identity-1",
      telegramChatId: "web:aud_123",
      channelThreadId: "web:aud_123",
      channel: "PRIVATE_CHAT",
      sourceChannel: "web",
      freeRepliesUsed: 0,
    });
  });

  it("persists each web chat exchange and increments free usage", async () => {
    const client = new FakeWebAudienceClient();
    const conversation = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );

    const updated = await persistWebConversationExchange(
      {
        conversationId: conversation.id,
        userMessage: "hello",
        assistantMessage: "hi there",
        intent: "faq",
        nextStep: "answer",
        now: new Date("2026-07-04T12:00:00.000Z"),
      },
      client,
    );

    expect(updated.freeRepliesUsed).toBe(1);
    expect(client.turns).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        direction: "inbound",
        messageText: "hello",
      }),
      expect.objectContaining({
        conversationId: conversation.id,
        direction: "outbound",
        messageText: "hi there",
        intent: "faq",
        summary: "answer",
      }),
    ]);
  });

  it("loads bounded recent turns from the current conversation only", async () => {
    const client = new FakeWebAudienceClient();
    const conversation = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );
    const other = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-2",
        audienceId: "aud_456",
      },
      client,
    );

    for (let index = 0; index < 10; index += 1) {
      client.turns.push({
        id: `turn-${index}`,
        conversationId: conversation.id,
        direction: index % 2 === 0 ? "inbound" : "outbound",
        messageText: index === 9 ? "x".repeat(300) : `message-${index}`,
        intent: null,
        summary: null,
        createdAt: new Date(`2026-07-04T12:00:${String(index).padStart(2, "0")}.000Z`),
      });
    }
    client.turns.push({
      id: "other-turn",
      conversationId: other.id,
      direction: "inbound",
      messageText: "do not leak",
      intent: null,
      summary: null,
      createdAt: new Date("2026-07-04T12:01:00.000Z"),
    });

    const turns = await loadWebConversationRecentTurns(
      {
        conversationId: conversation.id,
      },
      client,
    );

    expect(turns).toHaveLength(8);
    expect(turns[0]?.messageText).toBe("message-2");
    expect(turns.at(-1)?.messageText).toHaveLength(240);
    expect(turns.map((turn) => turn.messageText)).not.toContain("do not leak");
  });
});

type ContactRow = {
  id: string;
  representativeId: string;
  audienceIdentityId: string | null;
  telegramUserId: string;
  channelUserId: string | null;
  username: string | null;
  displayName: string | null;
  source: string | null;
  sourceChannel: string | null;
  lastSeenAt: Date;
};

type ConversationRow = {
  id: string;
  representativeId: string;
  contactId: string;
  audienceIdentityId: string | null;
  telegramChatId: string;
  channelThreadId: string | null;
  channel: string;
  sourceChannel: string | null;
  state: string;
  freeRepliesUsed: number;
  lastMessageAt: Date;
};

type TurnRow = {
  id: string;
  conversationId: string;
  direction: string;
  messageText: string;
  intent: string | null;
  summary: string | null;
  createdAt: Date;
};

type AudienceIdentityRow = {
  id: string;
  audienceKey: string;
  status: string;
  mergedIntoId: string | null;
  lastSeenAt: Date;
};

type IdentityLinkRow = {
  id: string;
  audienceIdentityId: string;
  provider: string;
  providerSubject: string;
  verifiedAt: Date | null;
  metadata: unknown;
};

class FakeWebAudienceClient {
  audienceIdentities: AudienceIdentityRow[] = [];
  identityLinks: IdentityLinkRow[] = [];
  contacts: ContactRow[] = [];
  conversations: ConversationRow[] = [];
  turns: TurnRow[] = [];
  userWallets: Array<{ id: string; audienceIdentityId: string | null }> = [];
  sandboxIdentities: Array<{ id: string; audienceIdentityId: string | null }> = [];
  memoryRecords: Array<{ id: string; audienceIdentityId: string | null }> = [];

  $transaction = async (callback: any) => callback(this);

  audienceIdentity = {
    upsert: async (args: any) => {
      const existing = this.audienceIdentities.find(
        (identity) => identity.audienceKey === args.where.audienceKey,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const identity: AudienceIdentityRow = {
        id: `identity-${this.audienceIdentities.length + 1}`,
        audienceKey: args.create.audienceKey,
        status: args.create.status,
        mergedIntoId: null,
        lastSeenAt: args.create.lastSeenAt,
      };
      this.audienceIdentities.push(identity);
      return identity;
    },
    update: async (args: any) => {
      const identity = this.audienceIdentities.find((item) => item.id === args.where.id);
      if (!identity) {
        throw new Error("identity not found");
      }
      Object.assign(identity, args.data);
      return identity;
    },
  };

  identityLink = {
    findUnique: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const link = this.identityLinks.find(
        (item) => item.provider === key.provider && item.providerSubject === key.providerSubject,
      );
      return link ? { audienceIdentityId: link.audienceIdentityId } : null;
    },
    upsert: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const existing = this.identityLinks.find(
        (link) => link.provider === key.provider && link.providerSubject === key.providerSubject,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const link: IdentityLinkRow = {
        id: `identity-link-${this.identityLinks.length + 1}`,
        audienceIdentityId: args.create.audienceIdentityId,
        provider: args.create.provider,
        providerSubject: args.create.providerSubject,
        verifiedAt: args.create.verifiedAt ?? null,
        metadata: args.create.metadata ?? null,
      };
      this.identityLinks.push(link);
      return link;
    },
    updateMany: async (args: any) => updateAudienceIdentityRows(this.identityLinks, args),
  };

  contact = {
    upsert: async (args: any) => {
      const key = args.where.representativeId_telegramUserId;
      const existing = this.contacts.find(
        (contact) =>
          contact.representativeId === key.representativeId &&
          contact.telegramUserId === key.telegramUserId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const contact: ContactRow = {
        id: `contact-${this.contacts.length + 1}`,
        representativeId: args.create.representativeId,
        audienceIdentityId: args.create.audienceIdentityId ?? null,
        telegramUserId: args.create.telegramUserId,
        channelUserId: args.create.channelUserId ?? null,
        username: args.create.username ?? null,
        displayName: args.create.displayName ?? null,
        source: args.create.source ?? null,
        sourceChannel: args.create.sourceChannel ?? null,
        lastSeenAt: args.create.lastSeenAt ?? new Date(),
      };
      this.contacts.push(contact);
      return contact;
    },
    updateMany: async (args: any) => updateAudienceIdentityRows(this.contacts, args),
  };

  conversation = {
    upsert: async (args: any) => {
      const key = args.where.representativeId_telegramChatId_contactId;
      const existing = this.conversations.find(
        (conversation) =>
          conversation.representativeId === key.representativeId &&
          conversation.telegramChatId === key.telegramChatId &&
          conversation.contactId === key.contactId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const conversation: ConversationRow = {
        id: `conversation-${this.conversations.length + 1}`,
        representativeId: args.create.representativeId,
        contactId: args.create.contactId,
        audienceIdentityId: args.create.audienceIdentityId ?? null,
        telegramChatId: args.create.telegramChatId,
        channelThreadId: args.create.channelThreadId ?? null,
        channel: args.create.channel,
        sourceChannel: args.create.sourceChannel ?? null,
        state: args.create.state ?? "ACTIVE",
        freeRepliesUsed: args.create.freeRepliesUsed ?? 0,
        lastMessageAt: args.create.lastMessageAt ?? new Date(),
      };
      this.conversations.push(conversation);
      return conversation;
    },
    updateMany: async (args: any) => updateAudienceIdentityRows(this.conversations, args),
    update: async (args: any) => {
      const conversation = this.conversations.find((item) => item.id === args.where.id);
      if (!conversation) {
        throw new Error("conversation not found");
      }
      if (args.data.freeRepliesUsed?.increment) {
        conversation.freeRepliesUsed += args.data.freeRepliesUsed.increment;
      }
      if (args.data.lastMessageAt) {
        conversation.lastMessageAt = args.data.lastMessageAt;
      }
      return conversation;
    },
  };

  userWallet = {
    updateMany: async (args: any) => updateAudienceIdentityRows(this.userWallets, args),
  };

  sandboxIdentity = {
    updateMany: async (args: any) => updateAudienceIdentityRows(this.sandboxIdentities, args),
  };

  openVikingMemoryRecord = {
    updateMany: async (args: any) => updateAudienceIdentityRows(this.memoryRecords, args),
  };

  conversationTurn = {
    create: async (args: any) => {
      const turn: TurnRow = {
        id: `turn-${this.turns.length + 1}`,
        conversationId: args.data.conversationId,
        direction: args.data.direction,
        messageText: args.data.messageText,
        intent: args.data.intent ?? null,
        summary: args.data.summary ?? null,
        createdAt: args.data.createdAt ?? new Date(),
      };
      this.turns.push(turn);
      return turn;
    },
    findMany: async (args: any) => {
      return this.turns
        .filter((turn) => turn.conversationId === args.where.conversationId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, args.take);
    },
  };
}

function updateAudienceIdentityRows<T extends { audienceIdentityId: string | null }>(
  rows: T[],
  args: any,
) {
  let count = 0;
  for (const row of rows) {
    if (row.audienceIdentityId === args.where.audienceIdentityId) {
      row.audienceIdentityId = args.data.audienceIdentityId;
      count += 1;
    }
  }
  return { count };
}

function buildContactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "contact-1",
    representativeId: "rep-1",
    audienceIdentityId: "identity-1",
    telegramUserId: "web:aud_123",
    channelUserId: "web:aud_123",
    username: null,
    displayName: "Web visitor",
    source: "web",
    sourceChannel: "web",
    lastSeenAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}

function buildConversationRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conversation-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    audienceIdentityId: "identity-1",
    telegramChatId: "web:aud_123",
    channelThreadId: "web:aud_123",
    channel: "PRIVATE_CHAT",
    sourceChannel: "web",
    state: "ACTIVE",
    freeRepliesUsed: 0,
    lastMessageAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}
