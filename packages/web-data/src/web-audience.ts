import { demoRepresentative } from "@delegate/domain";

import { prisma } from "./prisma";

const WEB_RECENT_TURN_LIMIT = 8;
const WEB_RECENT_TURN_TEXT_LIMIT = 240;

type DemoWebAudienceTurn = {
  conversationId: string;
  direction: "inbound" | "outbound";
  messageText: string;
  intent: string | null;
  summary: string | null;
  createdAt: Date;
};

type DemoWebAudienceState = {
  identities: WebAudienceIdentity[];
  contacts: WebAudienceContact[];
  conversations: WebAudienceConversation[];
  turns: DemoWebAudienceTurn[];
};

const globalForWebAudience = globalThis as typeof globalThis & {
  delegateWebAudienceDemoState?: DemoWebAudienceState | undefined;
};

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
  | "LOGTO"
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
    findUnique(args: {
      where: {
        provider_providerSubject: {
          provider: WebAudienceIdentityLinkProvider;
          providerSubject: string;
        };
      };
      select: {
        audienceIdentityId: true;
      };
    }): Promise<{ audienceIdentityId: string } | null>;
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
  const providerSubject = normalizeIdentityProviderSubject(input.provider, input.providerSubject);

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

export async function resolveAuthenticatedAudienceIdentity(
  input: {
    audienceIdentityId: string;
    provider: WebAudienceIdentityLinkProvider;
    providerSubject: string;
    verifiedAt?: Date | null | undefined;
    metadata?: unknown;
    now?: Date | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
): Promise<WebAudienceIdentity> {
  const providerSubject = normalizeIdentityProviderSubject(input.provider, input.providerSubject);
  const currentAudienceIdentityId = normalizeRequiredId(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const now = input.now ?? new Date();
  const existingLink = await client.identityLink.findUnique({
    where: {
      provider_providerSubject: {
        provider: input.provider,
        providerSubject,
      },
    },
    select: {
      audienceIdentityId: true,
    },
  });
  const targetAudienceIdentityId = existingLink?.audienceIdentityId ?? currentAudienceIdentityId;

  if (existingLink && existingLink.audienceIdentityId !== currentAudienceIdentityId) {
    await mergeAudienceIdentity(
      {
        sourceAudienceIdentityId: currentAudienceIdentityId,
        targetAudienceIdentityId: existingLink.audienceIdentityId,
        now,
      },
      client,
    );
  }

  const audienceIdentity = await client.audienceIdentity.update({
    where: { id: targetAudienceIdentityId },
    data: {
      status: "REGISTERED",
      lastSeenAt: now,
    },
  });

  await linkAudienceIdentity(
    {
      audienceIdentityId: targetAudienceIdentityId,
      provider: input.provider,
      providerSubject,
      verifiedAt: input.verifiedAt,
      metadata: input.metadata,
    },
    client,
  );

  return audienceIdentity;
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
  if (shouldUseDemoWebAudienceFallback(input.representativeSlug, client)) {
    return resolveDemoWebAudienceContact(input);
  }

  try {
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
  } catch (error) {
    if (shouldUseDemoWebAudienceErrorFallback(error, input.representativeSlug, client)) {
      return resolveDemoWebAudienceContact(input);
    }
    throw error;
  }
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
  if (shouldUseDemoConversationFallback(input.representativeId, client)) {
    return resolveDemoWebAudienceConversation(input);
  }

  try {
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
  } catch (error) {
    if (shouldUseDemoConversationErrorFallback(error, input.representativeId, client)) {
      return resolveDemoWebAudienceConversation(input);
    }
    throw error;
  }
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
  if (shouldUseDemoConversationPersistence(input.conversationId, client)) {
    return persistDemoWebConversationExchange(input);
  }

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
  if (shouldUseDemoConversationPersistence(input.conversationId, client)) {
    return loadDemoWebConversationRecentTurns(input);
  }

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

function normalizeRequiredId(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function normalizeIdentityProviderSubject(provider: WebAudienceIdentityLinkProvider, value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("providerSubject is required.");
  }
  return provider === "LOGTO" ? value.trim() : normalized;
}

function truncateRecentTurnText(value: string) {
  const normalized = value.trim();
  return normalized.length > WEB_RECENT_TURN_TEXT_LIMIT
    ? normalized.slice(0, WEB_RECENT_TURN_TEXT_LIMIT)
    : normalized;
}

function getDemoWebAudienceState(): DemoWebAudienceState {
  if (!globalForWebAudience.delegateWebAudienceDemoState) {
    globalForWebAudience.delegateWebAudienceDemoState = {
      identities: [],
      contacts: [],
      conversations: [],
      turns: [],
    };
  }

  return globalForWebAudience.delegateWebAudienceDemoState;
}

function resolveDemoWebAudienceIdentity(
  input: {
    audienceId: string;
    now: Date;
  },
): WebAudienceIdentity {
  const audienceKey = buildWebAudienceKey(input.audienceId);
  const state = getDemoWebAudienceState();
  const existing = state.identities.find((identity) => identity.audienceKey === audienceKey);
  if (existing) {
    existing.lastSeenAt = input.now;
    return existing;
  }

  const identity: WebAudienceIdentity = {
    id: `demo-web-identity-${state.identities.length + 1}`,
    audienceKey,
    status: "ANONYMOUS",
    mergedIntoId: null,
    lastSeenAt: input.now,
  };
  state.identities.push(identity);
  return identity;
}

function resolveDemoWebAudienceContact(input: {
  representativeId: string;
  audienceId: string;
  displayName?: string | null | undefined;
  username?: string | null | undefined;
  now?: Date | undefined;
}): WebAudienceContact {
  const audienceId = normalizeWebAudienceId(input.audienceId);
  const now = input.now ?? new Date();
  const identity = resolveDemoWebAudienceIdentity({ audienceId, now });
  const channelUserId = buildWebChannelUserId(audienceId);
  const state = getDemoWebAudienceState();
  const existing = state.contacts.find(
    (contact) =>
      contact.representativeId === input.representativeId &&
      contact.telegramUserId === channelUserId,
  );
  if (existing) {
    existing.audienceIdentityId = identity.id;
    existing.channelUserId = channelUserId;
    existing.displayName = normalizeOptionalString(input.displayName) ?? existing.displayName;
    existing.username = normalizeOptionalString(input.username) ?? existing.username;
    existing.lastSeenAt = now;
    return existing;
  }

  const contact: WebAudienceContact = {
    id: `demo-web-contact-${state.contacts.length + 1}`,
    representativeId: input.representativeId,
    audienceIdentityId: identity.id,
    telegramUserId: channelUserId,
    channelUserId,
    username: normalizeOptionalString(input.username) ?? null,
    displayName: normalizeOptionalString(input.displayName) ?? "Web visitor",
    source: "web",
    sourceChannel: "web",
    lastSeenAt: now,
  };
  state.contacts.push(contact);
  return contact;
}

function resolveDemoWebAudienceConversation(input: {
  representativeId: string;
  contactId: string;
  audienceId: string;
  now?: Date | undefined;
}): WebAudienceConversation {
  const audienceId = normalizeWebAudienceId(input.audienceId);
  const now = input.now ?? new Date();
  const identity = resolveDemoWebAudienceIdentity({ audienceId, now });
  const threadId = buildWebConversationThreadId(audienceId);
  const state = getDemoWebAudienceState();
  const existing = state.conversations.find(
    (conversation) =>
      conversation.representativeId === input.representativeId &&
      conversation.telegramChatId === threadId &&
      conversation.contactId === input.contactId,
  );
  if (existing) {
    existing.audienceIdentityId = identity.id;
    existing.channelThreadId = threadId;
    existing.lastMessageAt = now;
    return existing;
  }

  const conversation: WebAudienceConversation = {
    id: `demo-web-conversation-${state.conversations.length + 1}`,
    representativeId: input.representativeId,
    contactId: input.contactId,
    audienceIdentityId: identity.id,
    telegramChatId: threadId,
    channelThreadId: threadId,
    channel: "PRIVATE_CHAT",
    sourceChannel: "web",
    state: "ACTIVE",
    freeRepliesUsed: 0,
    lastMessageAt: now,
  };
  state.conversations.push(conversation);
  return conversation;
}

function persistDemoWebConversationExchange(input: {
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  intent?: string | null | undefined;
  nextStep?: string | null | undefined;
  now?: Date | undefined;
}): WebAudienceConversation {
  const state = getDemoWebAudienceState();
  const conversation = state.conversations.find((item) => item.id === input.conversationId);
  if (!conversation) {
    throw new Error("Demo web conversation not found.");
  }

  const now = input.now ?? new Date();
  state.turns.push(
    {
      conversationId: input.conversationId,
      direction: "inbound",
      messageText: input.userMessage,
      intent: null,
      summary: null,
      createdAt: now,
    },
    {
      conversationId: input.conversationId,
      direction: "outbound",
      messageText: input.assistantMessage,
      intent: input.intent ?? null,
      summary: input.nextStep ?? null,
      createdAt: now,
    },
  );
  conversation.freeRepliesUsed += 1;
  conversation.lastMessageAt = now;
  return conversation;
}

function loadDemoWebConversationRecentTurns(input: {
  conversationId: string;
  limit?: number | undefined;
}) {
  const limit = input.limit ?? WEB_RECENT_TURN_LIMIT;
  return getDemoWebAudienceState()
    .turns.filter((turn) => turn.conversationId === input.conversationId)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, limit)
    .reverse()
    .map((turn) => ({
      direction: turn.direction,
      messageText: truncateRecentTurnText(turn.messageText),
      ...(turn.intent ? { intent: turn.intent } : {}),
      ...(turn.summary ? { summary: truncateRecentTurnText(turn.summary) } : {}),
    }));
}

function shouldUseDemoWebAudienceFallback(representativeSlug: string, client: WebAudienceClient) {
  return (
    representativeSlug === demoRepresentative.slug &&
    !process.env.DATABASE_URL?.trim() &&
    isDefaultWebAudienceClient(client)
  );
}

function shouldUseDemoWebAudienceErrorFallback(
  error: unknown,
  representativeSlug: string,
  _client: WebAudienceClient,
) {
  return (
    representativeSlug === demoRepresentative.slug &&
    isPrismaUnavailableError(error)
  );
}

function shouldUseDemoConversationFallback(representativeId: string, client: WebAudienceClient) {
  return (
    representativeId === demoRepresentative.id &&
    !process.env.DATABASE_URL?.trim() &&
    isDefaultWebAudienceClient(client)
  );
}

function shouldUseDemoConversationErrorFallback(
  error: unknown,
  representativeId: string,
  _client: WebAudienceClient,
) {
  return (
    representativeId === demoRepresentative.id &&
    isPrismaUnavailableError(error)
  );
}

function shouldUseDemoConversationPersistence(conversationId: string, client: WebAudienceClient) {
  return (
    getDemoWebAudienceState().conversations.some(
      (conversation) => conversation.id === conversationId,
    )
  );
}

function isDefaultWebAudienceClient(client: WebAudienceClient) {
  return client === (prisma as unknown as WebAudienceClient);
}

function isPrismaUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Can't reach database server") ||
    error.message.includes("Environment variable not found: DATABASE_URL") ||
    error.message.includes("P1001")
  );
}
