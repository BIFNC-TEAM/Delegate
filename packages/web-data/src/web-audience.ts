import { prisma } from "./prisma";

const WEB_RECENT_TURN_LIMIT = 8;
const WEB_RECENT_TURN_TEXT_LIMIT = 240;

export type WebAudienceContact = {
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

export type WebAudienceIdentityLinkProvider =
  | "WEB_ANONYMOUS"
  | "EMAIL"
  | "PHONE"
  | "TELEGRAM"
  | "PAYMENT_EXTERNAL_USER";

type WebAudienceClient = {
  $transaction?: <T>(callback: (client: WebAudienceClient) => Promise<T>) => Promise<T>;
  audienceIdentity: {
    upsert(args: {
      where: {
        audienceKey: string;
      };
      update: {
        lastSeenAt: Date;
      };
      create: {
        audienceKey: string;
        status: "ANONYMOUS";
        lastSeenAt: Date;
      };
    }): Promise<WebAudienceIdentity>;
    update(args: {
      where: {
        id: string;
      };
      data: {
        status?: "MERGED" | "ANONYMOUS" | "REGISTERED" | "DISABLED";
        mergedIntoId?: string | null;
        lastSeenAt?: Date;
      };
    }): Promise<WebAudienceIdentity>;
  };
  identityLink: {
    upsert(args: {
      where: {
        provider_providerSubject: {
          provider: WebAudienceIdentityLinkProvider;
          providerSubject: string;
        };
      };
      update: {
        audienceIdentityId: string;
        verifiedAt?: Date | null;
        metadata?: unknown;
      };
      create: {
        audienceIdentityId: string;
        provider: WebAudienceIdentityLinkProvider;
        providerSubject: string;
        verifiedAt?: Date | null;
        metadata?: unknown;
      };
    }): Promise<unknown>;
    updateMany(args: {
      where: {
        audienceIdentityId: string;
      };
      data: {
        audienceIdentityId: string;
      };
    }): Promise<{ count: number }>;
  };
  contact: {
    upsert(args: {
      where: {
        representativeId_telegramUserId: {
          representativeId: string;
          telegramUserId: string;
        };
      };
      update: {
        lastSeenAt: Date;
        source: string;
        sourceChannel: string;
        audienceIdentityId: string;
        channelUserId: string;
        username?: string | null;
        displayName?: string | null;
      };
      create: {
        representativeId: string;
        audienceIdentityId: string;
        telegramUserId: string;
        channelUserId: string;
        username?: string | null;
        displayName: string;
        source: string;
        sourceChannel: string;
        lastSeenAt: Date;
      };
    }): Promise<WebAudienceContact>;
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  conversation: {
    upsert(args: {
      where: {
        representativeId_telegramChatId_contactId: {
          representativeId: string;
          telegramChatId: string;
          contactId: string;
        };
      };
      update: {
        lastMessageAt: Date;
        audienceIdentityId: string;
        channelThreadId: string;
        sourceChannel: string;
      };
      create: {
        representativeId: string;
        contactId: string;
        audienceIdentityId: string;
        telegramChatId: string;
        channelThreadId: string;
        channel: "PRIVATE_CHAT";
        sourceChannel: string;
        state: "ACTIVE";
        lastMessageAt: Date;
      };
    }): Promise<WebAudienceConversation>;
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
    update(args: {
      where: { id: string };
      data: {
        freeRepliesUsed: { increment: number };
        lastMessageAt: Date;
      };
    }): Promise<WebAudienceConversation>;
  };
  conversationTurn: {
    create(args: {
      data: {
        conversationId: string;
        direction: "inbound" | "outbound";
        messageText: string;
        intent?: string | null | undefined;
        summary?: string | null | undefined;
        createdAt: Date;
      };
    }): Promise<unknown>;
    findMany(args: {
      where: {
        conversationId: string;
      };
      orderBy: Array<{ createdAt: "desc" }>;
      take: number;
      select: {
        direction: true;
        messageText: true;
        intent: true;
        summary: true;
        createdAt: true;
      };
    }): Promise<Array<{
      direction: string;
      messageText: string;
      intent: string | null;
      summary: string | null;
      createdAt: Date;
    }>>;
  };
  userWallet: {
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  sandboxIdentity: {
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  openVikingMemoryRecord: {
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
};

export type WebAudienceIdentity = {
  id: string;
  audienceKey: string;
  status: string;
  mergedIntoId?: string | null;
  lastSeenAt: Date;
};

export type WebAudienceConversation = {
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

export async function resolveAnonymousAudienceIdentity(
  input: {
    audienceId: string;
    now?: Date | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
): Promise<WebAudienceIdentity> {
  const audienceKey = buildWebAudienceKey(input.audienceId);
  const now = input.now ?? new Date();
  const identity = await client.audienceIdentity.upsert({
    where: {
      audienceKey,
    },
    update: {
      lastSeenAt: now,
    },
    create: {
      audienceKey,
      status: "ANONYMOUS",
      lastSeenAt: now,
    },
  });

  await client.identityLink.upsert({
    where: {
      provider_providerSubject: {
        provider: "WEB_ANONYMOUS",
        providerSubject: audienceKey,
      },
    },
    update: {
      audienceIdentityId: identity.id,
    },
    create: {
      audienceIdentityId: identity.id,
      provider: "WEB_ANONYMOUS",
      providerSubject: audienceKey,
    },
  });

  return identity;
}

export async function linkAudienceIdentity(
  input: {
    audienceIdentityId: string;
    provider: WebAudienceIdentityLinkProvider;
    providerSubject: string;
    verifiedAt?: Date | null | undefined;
    metadata?: unknown;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
) {
  const providerSubject = normalizeIdentityProviderSubject(input.providerSubject);

  return client.identityLink.upsert({
    where: {
      provider_providerSubject: {
        provider: input.provider,
        providerSubject,
      },
    },
    update: {
      audienceIdentityId: input.audienceIdentityId,
      ...(input.verifiedAt !== undefined ? { verifiedAt: input.verifiedAt } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
    create: {
      audienceIdentityId: input.audienceIdentityId,
      provider: input.provider,
      providerSubject,
      ...(input.verifiedAt !== undefined ? { verifiedAt: input.verifiedAt } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
  });
}

export async function mergeAudienceIdentity(
  input: {
    sourceAudienceIdentityId: string;
    targetAudienceIdentityId: string;
    now?: Date | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
) {
  const sourceAudienceIdentityId = input.sourceAudienceIdentityId.trim();
  const targetAudienceIdentityId = input.targetAudienceIdentityId.trim();
  if (!sourceAudienceIdentityId || !targetAudienceIdentityId) {
    throw new Error("sourceAudienceIdentityId and targetAudienceIdentityId are required.");
  }
  if (sourceAudienceIdentityId === targetAudienceIdentityId) {
    throw new Error("Cannot merge an audience identity into itself.");
  }

  const now = input.now ?? new Date();
  const run = async (tx: WebAudienceClient) => {
    await tx.contact.updateMany({
      where: { audienceIdentityId: sourceAudienceIdentityId },
      data: { audienceIdentityId: targetAudienceIdentityId },
    });
    await tx.conversation.updateMany({
      where: { audienceIdentityId: sourceAudienceIdentityId },
      data: { audienceIdentityId: targetAudienceIdentityId },
    });
    await tx.userWallet.updateMany({
      where: { audienceIdentityId: sourceAudienceIdentityId },
      data: { audienceIdentityId: targetAudienceIdentityId },
    });
    await tx.sandboxIdentity.updateMany({
      where: { audienceIdentityId: sourceAudienceIdentityId },
      data: { audienceIdentityId: targetAudienceIdentityId },
    });
    await tx.openVikingMemoryRecord.updateMany({
      where: { audienceIdentityId: sourceAudienceIdentityId },
      data: { audienceIdentityId: targetAudienceIdentityId },
    });
    await tx.identityLink.updateMany({
      where: { audienceIdentityId: sourceAudienceIdentityId },
      data: { audienceIdentityId: targetAudienceIdentityId },
    });

    return tx.audienceIdentity.update({
      where: { id: sourceAudienceIdentityId },
      data: {
        status: "MERGED",
        mergedIntoId: targetAudienceIdentityId,
        lastSeenAt: now,
      },
    });
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

export async function resolveWebAudienceContact(
  input: {
    representativeId: string;
    representativeSlug: string;
    audienceId: string;
    displayName?: string | null | undefined;
    username?: string | null | undefined;
    now?: Date | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
): Promise<WebAudienceContact> {
  const audienceId = normalizeWebAudienceId(input.audienceId);
  const channelUserId = buildWebChannelUserId(audienceId);
  const now = input.now ?? new Date();
  const displayName = normalizeOptionalString(input.displayName) ?? "Web visitor";
  const username = normalizeOptionalString(input.username);
  const identity = await resolveAnonymousAudienceIdentity({ audienceId, now }, client);

  return client.contact.upsert({
    where: {
      representativeId_telegramUserId: {
        representativeId: input.representativeId,
        telegramUserId: channelUserId,
      },
    },
    update: {
      lastSeenAt: now,
      source: "web",
      sourceChannel: "web",
      audienceIdentityId: identity.id,
      channelUserId,
      ...(username ? { username } : {}),
      ...(displayName ? { displayName } : {}),
    },
    create: {
      representativeId: input.representativeId,
      audienceIdentityId: identity.id,
      telegramUserId: channelUserId,
      channelUserId,
      ...(username ? { username } : {}),
      displayName,
      source: "web",
      sourceChannel: "web",
      lastSeenAt: now,
    },
  });
}

export async function resolveWebAudienceConversation(
  input: {
    representativeId: string;
    contactId: string;
    audienceId: string;
    now?: Date | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
): Promise<WebAudienceConversation> {
  const audienceId = normalizeWebAudienceId(input.audienceId);
  const threadId = buildWebConversationThreadId(audienceId);
  const now = input.now ?? new Date();
  const identity = await resolveAnonymousAudienceIdentity({ audienceId, now }, client);

  return client.conversation.upsert({
    where: {
      representativeId_telegramChatId_contactId: {
        representativeId: input.representativeId,
        telegramChatId: threadId,
        contactId: input.contactId,
      },
    },
    update: {
      lastMessageAt: now,
      audienceIdentityId: identity.id,
      channelThreadId: threadId,
      sourceChannel: "web",
    },
    create: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      audienceIdentityId: identity.id,
      telegramChatId: threadId,
      channelThreadId: threadId,
      channel: "PRIVATE_CHAT",
      sourceChannel: "web",
      state: "ACTIVE",
      lastMessageAt: now,
    },
  });
}

export async function persistWebConversationExchange(
  input: {
    conversationId: string;
    userMessage: string;
    assistantMessage: string;
    intent?: string | null | undefined;
    nextStep?: string | null | undefined;
    now?: Date | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
): Promise<WebAudienceConversation> {
  const now = input.now ?? new Date();
  const run = async (tx: WebAudienceClient) => {
    await tx.conversationTurn.create({
      data: {
        conversationId: input.conversationId,
        direction: "inbound",
        messageText: input.userMessage,
        createdAt: now,
      },
    });
    await tx.conversationTurn.create({
      data: {
        conversationId: input.conversationId,
        direction: "outbound",
        messageText: input.assistantMessage,
        ...(input.intent ? { intent: input.intent } : {}),
        ...(input.nextStep ? { summary: input.nextStep } : {}),
        createdAt: now,
      },
    });

    return tx.conversation.update({
      where: { id: input.conversationId },
      data: {
        freeRepliesUsed: { increment: 1 },
        lastMessageAt: now,
      },
    });
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

export async function loadWebConversationRecentTurns(
  input: {
    conversationId: string;
    limit?: number | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
) {
  const limit = input.limit ?? WEB_RECENT_TURN_LIMIT;
  const rows = await client.conversationTurn.findMany({
    where: {
      conversationId: input.conversationId,
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
    select: {
      direction: true,
      messageText: true,
      intent: true,
      summary: true,
      createdAt: true,
    },
  });

  return rows
    .slice()
    .reverse()
    .map((turn) => ({
      direction:
        turn.direction === "outbound" || turn.direction === "OUTBOUND"
          ? ("outbound" as const)
          : ("inbound" as const),
      messageText: truncateRecentTurnText(turn.messageText),
      ...(turn.intent ? { intent: turn.intent } : {}),
      ...(turn.summary ? { summary: truncateRecentTurnText(turn.summary) } : {}),
    }));
}

export function buildWebChannelUserId(audienceId: string) {
  return `web:${normalizeWebAudienceId(audienceId)}`;
}

export function buildWebConversationThreadId(audienceId: string) {
  return `web:${normalizeWebAudienceId(audienceId)}`;
}

export function buildWebAudienceExternalUserId(representativeSlug: string, audienceId: string) {
  return `web:${representativeSlug}:${normalizeWebAudienceId(audienceId)}`;
}

export function buildWebAudienceKey(audienceId: string) {
  return `web:${normalizeWebAudienceId(audienceId)}`;
}

export function normalizeWebAudienceId(audienceId: string) {
  const normalized = audienceId.trim().toLowerCase();
  if (!normalized) {
    throw new Error("audienceId is required.");
  }
  return normalized;
}

function normalizeOptionalString(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeIdentityProviderSubject(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("providerSubject is required.");
  }
  return normalized;
}

function truncateRecentTurnText(value: string) {
  const normalized = value.trim();
  return normalized.length > WEB_RECENT_TURN_TEXT_LIMIT
    ? normalized.slice(0, WEB_RECENT_TURN_TEXT_LIMIT)
    : normalized;
}
