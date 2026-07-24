import { describe, expect, it, vi } from "vitest";

import { resolveWebAudienceConversation } from "../src/web-audience";

describe("Web conversation channel binding", () => {
  it("atomically links a Web conversation to the representative Web binding", async () => {
    const identity = {
      id: "audience-identity-1",
      audienceKey: "web:aud_123",
      status: "ANONYMOUS",
      mergedIntoId: null,
      lastSeenAt: new Date("2026-07-24T03:00:00.000Z"),
    };
    const conversation = {
      id: "conversation-web-1",
      representativeId: "rep-1",
      contactId: "contact-1",
      audienceIdentityId: identity.id,
      telegramChatId: "web:aud_123",
      channelThreadId: "web:aud_123",
      channel: "PRIVATE_CHAT",
      sourceChannel: "web",
      state: "ACTIVE",
      freeRepliesUsed: 0,
      lastMessageAt: identity.lastSeenAt,
    };
    const channelBindingUpsert = vi.fn().mockResolvedValue({
      id: "conversation-binding-web-1",
    });
    const client: Record<string, unknown> = {
      $transaction: async (
        callback: (tx: Record<string, unknown>) => Promise<unknown>,
      ) => callback(client),
      audienceIdentity: {
        upsert: vi.fn().mockResolvedValue(identity),
        findUnique: vi.fn().mockResolvedValue(identity),
        update: vi.fn().mockResolvedValue(identity),
      },
      identityLink: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "identity-link-web-1",
          audienceIdentityId: identity.id,
        }),
      },
      conversation: {
        upsert: vi.fn().mockResolvedValue(conversation),
      },
      representativeChannelBinding: {
        findUnique: vi.fn().mockResolvedValue({
          id: "representative-binding-web-1",
          connectionId: null,
        }),
      },
      conversationChannelBinding: {
        upsert: channelBindingUpsert,
      },
    };

    await expect(
      resolveWebAudienceConversation(
        {
          representativeId: "rep-1",
          contactId: "contact-1",
          audienceId: "aud_123",
          now: identity.lastSeenAt,
        },
        client as never,
      ),
    ).resolves.toEqual(conversation);

    expect(channelBindingUpsert).toHaveBeenCalledWith({
      where: {
        bindingKey: "WEB:rep-1:web:aud_123:",
      },
      create: {
        conversationId: conversation.id,
        representativeBindingId: "representative-binding-web-1",
        kind: "WEB",
        transport: "WEB",
        sourceProvider: "WEB",
        connectionId: null,
        bindingKey: "WEB:rep-1:web:aud_123:",
        externalConversationId: "web:aud_123",
        externalThreadId: "web:aud_123",
        metadata: {
          audienceIdentityId: identity.id,
          audienceId: "aud_123",
        },
      },
      update: {
        conversationId: conversation.id,
        representativeBindingId: "representative-binding-web-1",
        connectionId: null,
        externalConversationId: "web:aud_123",
        externalThreadId: "web:aud_123",
        metadata: {
          audienceIdentityId: identity.id,
          audienceId: "aud_123",
        },
      },
    });
  });
});
