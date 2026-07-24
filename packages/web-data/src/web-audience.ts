import { demoRepresentative } from "@delegate/domain";

import { prisma } from "./prisma";

const WEB_RECENT_TURN_LIMIT = 8;
const WEB_RECENT_TURN_TEXT_LIMIT = 240;
const MAX_AUDIENCE_IDENTITY_MERGE_DEPTH = 64;

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
  | "MATRIX"
  | "PAYMENT_EXTERNAL_USER";

type WebAudienceClient = {
  $transaction?: <T>(
    callback: (client: WebAudienceClient) => Promise<T>,
    options?: { isolationLevel: "Serializable" },
  ) => Promise<T>;
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
    updateMany(args: {
      where: {
        id: string;
        status?: "MERGED" | "ANONYMOUS" | "REGISTERED" | "DISABLED";
        mergedIntoId?: string | null;
      };
      data: {
        status?: "MERGED" | "ANONYMOUS" | "REGISTERED" | "DISABLED";
        mergedIntoId?: string | null;
        lastSeenAt?: Date;
      };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: {
        id: string;
      };
    }): Promise<WebAudienceIdentity | null>;
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
        issuer: true;
        connectionId: true;
        revokedAt: true;
      };
    }): Promise<{
      audienceIdentityId: string;
      issuer?: string;
      connectionId?: string | null;
      revokedAt?: Date | null;
    } | null>;
    create(args: {
      data: {
        audienceIdentityId: string;
        provider: WebAudienceIdentityLinkProvider;
        providerSubject: string;
        issuer?: string;
        connectionId?: string | null;
        verifiedAt?: Date | null;
        assuranceLevel?: "UNVERIFIED" | "PLATFORM_VERIFIED" | "STEP_UP_VERIFIED";
        proofMetadata?: unknown;
        metadata?: unknown;
      };
    }): Promise<unknown>;
    upsert(args: {
      where: {
        provider_providerSubject: {
          provider: WebAudienceIdentityLinkProvider;
          providerSubject: string;
        };
      };
      update: {
        audienceIdentityId: string;
        issuer?: string;
        connectionId?: string | null;
        verifiedAt?: Date | null;
        assuranceLevel?: "UNVERIFIED" | "PLATFORM_VERIFIED" | "STEP_UP_VERIFIED";
        proofMetadata?: unknown;
        metadata?: unknown;
      };
      create: {
        audienceIdentityId: string;
        provider: WebAudienceIdentityLinkProvider;
        providerSubject: string;
        issuer?: string;
        connectionId?: string | null;
        verifiedAt?: Date | null;
        assuranceLevel?: "UNVERIFIED" | "PLATFORM_VERIFIED" | "STEP_UP_VERIFIED";
        proofMetadata?: unknown;
        metadata?: unknown;
      };
    }): Promise<unknown>;
    updateMany(args: {
      where: {
        audienceIdentityId?: string;
        provider?: WebAudienceIdentityLinkProvider;
        providerSubject?: string;
      };
      data: {
        audienceIdentityId?: string;
        issuer?: string;
        connectionId?: string | null;
        verifiedAt?: Date | null;
        assuranceLevel?: "UNVERIFIED" | "PLATFORM_VERIFIED" | "STEP_UP_VERIFIED";
        proofMetadata?: unknown;
        metadata?: unknown;
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
  representativeChannelBinding?: {
    findUnique(args: {
      where: {
        representativeId_kind: {
          representativeId: string;
          kind: "WEB";
        };
      };
      select: {
        id: true;
        connectionId: true;
      };
    }): Promise<{
      id: string;
      connectionId: string | null;
    } | null>;
  };
  conversationChannelBinding?: {
    upsert(args: {
      where: {
        bindingKey: string;
      };
      create: {
        conversationId: string;
        representativeBindingId: string;
        kind: "WEB";
        transport: "WEB";
        sourceProvider: "WEB";
        connectionId: string | null;
        bindingKey: string;
        externalConversationId: string;
        externalThreadId: string;
        metadata: {
          audienceIdentityId: string;
          audienceId: string;
        };
      };
      update: {
        conversationId: string;
        representativeBindingId: string;
        connectionId: string | null;
        externalConversationId: string;
        externalThreadId: string;
        metadata: {
          audienceIdentityId: string;
          audienceId: string;
        };
      };
    }): Promise<unknown>;
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
    count(args: {
      where: { audienceIdentityId: string };
    }): Promise<number>;
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
  delegationTask: {
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  identityBindingChallenge?: {
    updateMany(args: {
      where: {
        audienceIdentityId: string;
        consumedAt?: null;
        revokedAt?: null;
      };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
  };
  bridgeIdentityMapping?: {
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  serviceEntitlementAccount?: {
    count(args: {
      where: { audienceIdentityId: string };
    }): Promise<number>;
    findMany(args: {
      where: { audienceIdentityId: string };
      select: {
        id: true;
        representativeId: true;
        productCode: true;
      };
    }): Promise<
      Array<{
        id: string;
        representativeId: string;
        productCode: string;
      }>
    >;
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  servicePaymentOrder?: {
    count(args: {
      where: { payerAudienceIdentityId: string };
    }): Promise<number>;
    updateMany(args: {
      where: { payerAudienceIdentityId: string };
      data: { payerAudienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  agentTokenPurchase?: {
    count(args: {
      where: { audienceIdentityId: string };
    }): Promise<number>;
    updateMany(args: {
      where: { audienceIdentityId: string };
      data: { audienceIdentityId: string };
    }): Promise<{ count: number }>;
  };
  agentUsageCharge?: {
    count(args: {
      where: { audienceIdentityId: string };
    }): Promise<number>;
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

  const canonicalIdentity = await resolveCanonicalAudienceIdentity(
    {
      audienceIdentityId: identity.id,
    },
    client,
  );
  const resolvedIdentity =
    canonicalIdentity.id === identity.id
      ? identity
      : await client.audienceIdentity.update({
          where: {
            id: canonicalIdentity.id,
          },
          data: {
            lastSeenAt: now,
          },
        });

  await linkAudienceIdentity(
    {
      audienceIdentityId: resolvedIdentity.id,
      provider: "WEB_ANONYMOUS",
      providerSubject: audienceKey,
    },
    client,
  );

  return resolvedIdentity;
}

/**
 * Resolves a provider-authenticated channel user to a provisional canonical
 * identity. The identity remains ANONYMOUS until the user proves ownership of
 * a registered Web account through a private binding challenge.
 */
export async function resolveChannelAudienceIdentity(
  input: {
    provider: "TELEGRAM" | "MATRIX";
    providerSubject: string;
    issuer?: string;
    connectionId?: string;
    now?: Date;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
): Promise<WebAudienceIdentity> {
  const providerSubject = normalizeIdentityProviderSubject(
    input.provider,
    input.providerSubject,
  );
  const issuer = input.issuer?.trim().toLowerCase() || "delegate";
  const connectionId = input.connectionId?.trim().toLowerCase();
  if (!connectionId) {
    throw new Error("Channel identity resolution requires a connection id.");
  }
  const now = input.now ?? new Date();
  const existingLink = await findIdentityLink(client, input.provider, providerSubject);
  if (existingLink) {
    if (existingLink.revokedAt) {
      throw new Error("Channel identity link has been revoked.");
    }
    if (existingLink.issuer && existingLink.issuer !== issuer) {
      throw new Error("Channel identity belongs to a different issuer realm.");
    }
    if (!existingLink.connectionId) {
      throw new Error(
        "Channel identity is missing verified connection scope and requires reconciliation.",
      );
    }
    if (existingLink.connectionId.toLowerCase() !== connectionId) {
      throw new Error("Channel identity belongs to a different provider connection.");
    }
    const identity = await resolveCanonicalAudienceIdentity(
      { audienceIdentityId: existingLink.audienceIdentityId },
      client,
    );
    return client.audienceIdentity.update({
      where: { id: identity.id },
      data: { lastSeenAt: now },
    });
  }

  const audienceKey = `channel:${input.provider.toLowerCase()}:${encodeURIComponent(issuer)}:${encodeURIComponent(providerSubject)}`;
  const provisional = await client.audienceIdentity.upsert({
    where: { audienceKey },
    update: { lastSeenAt: now },
    create: {
      audienceKey,
      status: "ANONYMOUS",
      lastSeenAt: now,
    },
  });
  await linkAudienceIdentity(
    {
      audienceIdentityId: provisional.id,
      provider: input.provider,
      providerSubject,
      issuer,
      connectionId,
      verifiedAt: now,
      assuranceLevel: "PLATFORM_VERIFIED",
      proofMetadata: {
        method: "authenticated_channel_adapter",
        issuer,
      },
      metadata: { provisional: true },
    },
    client,
  );
  return provisional;
}

export async function linkAudienceIdentity(
  input: {
    audienceIdentityId: string;
    provider: WebAudienceIdentityLinkProvider;
    providerSubject: string;
    issuer?: string;
    connectionId?: string | null;
    verifiedAt?: Date | null | undefined;
    assuranceLevel?: "UNVERIFIED" | "PLATFORM_VERIFIED" | "STEP_UP_VERIFIED";
    proofMetadata?: unknown;
    metadata?: unknown;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
) {
  const providerSubject = normalizeIdentityProviderSubject(input.provider, input.providerSubject);
  const requestedIdentity = await resolveCanonicalAudienceIdentity(
    {
      audienceIdentityId: input.audienceIdentityId,
    },
    client,
  );
  const existingLink = await findIdentityLink(client, input.provider, providerSubject);

  if (existingLink) {
    return updateOwnedIdentityLink({
      client,
      existingAudienceIdentityId: existingLink.audienceIdentityId,
      requestedAudienceIdentityId: requestedIdentity.id,
      provider: input.provider,
      providerSubject,
      ...(existingLink.issuer !== undefined
        ? { existingIssuer: existingLink.issuer }
        : {}),
      ...(existingLink.connectionId !== undefined
        ? { existingConnectionId: existingLink.connectionId }
        : {}),
      ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
      ...(input.connectionId !== undefined
        ? { connectionId: input.connectionId }
        : {}),
      ...(input.verifiedAt !== undefined ? { verifiedAt: input.verifiedAt } : {}),
      ...(input.assuranceLevel !== undefined
        ? { assuranceLevel: input.assuranceLevel }
        : {}),
      ...(input.proofMetadata !== undefined
        ? { proofMetadata: input.proofMetadata }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  }

  try {
    return await client.identityLink.create({
      data: {
        audienceIdentityId: requestedIdentity.id,
        provider: input.provider,
        providerSubject,
        ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
        ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
        ...(input.verifiedAt !== undefined ? { verifiedAt: input.verifiedAt } : {}),
        ...(input.assuranceLevel !== undefined
          ? { assuranceLevel: input.assuranceLevel }
          : {}),
        ...(input.proofMetadata !== undefined
          ? { proofMetadata: input.proofMetadata }
          : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const concurrentLink = await findIdentityLink(client, input.provider, providerSubject);
    if (!concurrentLink) {
      throw error;
    }
    return updateOwnedIdentityLink({
      client,
      existingAudienceIdentityId: concurrentLink.audienceIdentityId,
      requestedAudienceIdentityId: requestedIdentity.id,
      provider: input.provider,
      providerSubject,
      ...(concurrentLink.issuer !== undefined
        ? { existingIssuer: concurrentLink.issuer }
        : {}),
      ...(concurrentLink.connectionId !== undefined
        ? { existingConnectionId: concurrentLink.connectionId }
        : {}),
      ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
      ...(input.connectionId !== undefined
        ? { connectionId: input.connectionId }
        : {}),
      ...(input.verifiedAt !== undefined ? { verifiedAt: input.verifiedAt } : {}),
      ...(input.assuranceLevel !== undefined
        ? { assuranceLevel: input.assuranceLevel }
        : {}),
      ...(input.proofMetadata !== undefined
        ? { proofMetadata: input.proofMetadata }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  }
}

export async function resolveCanonicalAudienceIdentity(
  input: {
    audienceIdentityId: string;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
): Promise<WebAudienceIdentity> {
  const initialAudienceIdentityId = normalizeRequiredId(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const visited = new Set<string>();
  let currentAudienceIdentityId = initialAudienceIdentityId;

  for (let depth = 0; depth < MAX_AUDIENCE_IDENTITY_MERGE_DEPTH; depth += 1) {
    if (visited.has(currentAudienceIdentityId)) {
      throw new Error(
        `Audience identity merge cycle detected while resolving ${initialAudienceIdentityId}.`,
      );
    }
    visited.add(currentAudienceIdentityId);

    const identity = await client.audienceIdentity.findUnique({
      where: {
        id: currentAudienceIdentityId,
      },
    });
    if (!identity) {
      throw new Error(`Audience identity ${currentAudienceIdentityId} was not found.`);
    }
    if (identity.status === "DISABLED") {
      throw new Error(`Audience identity ${currentAudienceIdentityId} is disabled.`);
    }
    if (identity.status !== "MERGED") {
      return identity;
    }

    const mergedIntoId = identity.mergedIntoId?.trim();
    if (!mergedIntoId) {
      throw new Error(
        `Merged audience identity ${currentAudienceIdentityId} has no canonical target.`,
      );
    }
    currentAudienceIdentityId = mergedIntoId;
  }

  throw new Error(
    `Audience identity merge chain exceeded ${MAX_AUDIENCE_IDENTITY_MERGE_DEPTH} hops.`,
  );
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
  const run = async (tx: WebAudienceClient) => {
    const currentIdentity = await resolveCanonicalAudienceIdentity(
      {
        audienceIdentityId: currentAudienceIdentityId,
      },
      tx,
    );
    const existingLink = await findIdentityLink(tx, input.provider, providerSubject);
    let targetIdentity = currentIdentity;

    if (existingLink) {
      targetIdentity = await resolveCanonicalAudienceIdentity(
        {
          audienceIdentityId: existingLink.audienceIdentityId,
        },
        tx,
      );

      if (targetIdentity.id !== currentIdentity.id) {
        if (currentIdentity.status !== "ANONYMOUS") {
          throw new Error(
            "Authenticated identity conflict: automatic registered-to-registered merge is not allowed.",
          );
        }

        if (targetIdentity.status === "ANONYMOUS") {
          targetIdentity = await tx.audienceIdentity.update({
            where: { id: targetIdentity.id },
            data: {
              status: "REGISTERED",
              lastSeenAt: now,
            },
          });
        }

        await mergeAudienceIdentity(
          {
            sourceAudienceIdentityId: currentIdentity.id,
            targetAudienceIdentityId: targetIdentity.id,
            now,
          },
          tx,
        );
      }
    }

    await linkAudienceIdentity(
      {
        audienceIdentityId: targetIdentity.id,
        provider: input.provider,
        providerSubject,
        verifiedAt: input.verifiedAt ?? now,
        assuranceLevel: "PLATFORM_VERIFIED",
        proofMetadata: {
          method: "authenticated_web_session",
          provider: input.provider,
        },
        metadata: input.metadata,
      },
      tx,
    );

    return tx.audienceIdentity.update({
      where: { id: targetIdentity.id },
      data: {
        status: "REGISTERED",
        lastSeenAt: now,
      },
    });
  };

  return client.$transaction
    ? client.$transaction(run, { isolationLevel: "Serializable" })
    : run(client);
}

export async function mergeAudienceIdentity(
  input: {
    sourceAudienceIdentityId: string;
    targetAudienceIdentityId: string;
    /**
     * Enables a proof-gated transfer of a provisional channel identity's
     * financial records. This must only be set after the same private-channel
     * account has consumed a binding challenge for the registered target.
     */
    transferVerifiedProvisionalAssets?: boolean;
    now?: Date | undefined;
  },
  client: WebAudienceClient = prisma as unknown as WebAudienceClient,
) {
  const sourceAudienceIdentityId = normalizeRequiredId(
    input.sourceAudienceIdentityId,
    "sourceAudienceIdentityId",
  );
  const targetAudienceIdentityId = normalizeRequiredId(
    input.targetAudienceIdentityId,
    "targetAudienceIdentityId",
  );
  if (!sourceAudienceIdentityId || !targetAudienceIdentityId) {
    throw new Error("sourceAudienceIdentityId and targetAudienceIdentityId are required.");
  }
  if (sourceAudienceIdentityId === targetAudienceIdentityId) {
    throw new Error("Cannot merge an audience identity into itself.");
  }

  const now = input.now ?? new Date();
  const run = async (tx: WebAudienceClient) => {
    const sourceIdentity = await resolveCanonicalAudienceIdentity(
      {
        audienceIdentityId: sourceAudienceIdentityId,
      },
      tx,
    );
    const targetIdentity = await resolveCanonicalAudienceIdentity(
      {
        audienceIdentityId: targetAudienceIdentityId,
      },
      tx,
    );

    if (sourceIdentity.id === targetIdentity.id) {
      if (sourceIdentity.id === sourceAudienceIdentityId) {
        throw new Error("Cannot merge an audience identity into one of its merged descendants.");
      }
      return sourceIdentity;
    }
    if (sourceIdentity.status !== "ANONYMOUS") {
      throw new Error(
        "Only an anonymous audience identity can be merged automatically.",
      );
    }
    if (targetIdentity.status !== "REGISTERED") {
      throw new Error(
        "An anonymous audience identity can only be merged into a registered identity.",
      );
    }

    const [
      sourceWalletCount,
      targetWalletCount,
      sourceEntitlementCount,
      sourcePaymentOrderCount,
      sourceTokenPurchaseCount,
      sourceUsageChargeCount,
    ] = await Promise.all([
      tx.userWallet.count({
        where: { audienceIdentityId: sourceIdentity.id },
      }),
      tx.userWallet.count({
        where: { audienceIdentityId: targetIdentity.id },
      }),
      tx.serviceEntitlementAccount?.count({
        where: { audienceIdentityId: sourceIdentity.id },
      }) ?? Promise.resolve(0),
      tx.servicePaymentOrder?.count({
        where: { payerAudienceIdentityId: sourceIdentity.id },
      }) ?? Promise.resolve(0),
      tx.agentTokenPurchase?.count({
        where: { audienceIdentityId: sourceIdentity.id },
      }) ?? Promise.resolve(0),
      tx.agentUsageCharge?.count({
        where: { audienceIdentityId: sourceIdentity.id },
      }) ?? Promise.resolve(0),
    ]);
    if (sourceWalletCount > 0 && targetWalletCount > 0) {
      throw new Error(
        "Audience identity wallet conflict: both identities own wallets and require explicit reconciliation.",
      );
    }
    if (
      sourceEntitlementCount > 0
      || sourcePaymentOrderCount > 0
      || sourceTokenPurchaseCount > 0
      || sourceUsageChargeCount > 0
    ) {
      if (!input.transferVerifiedProvisionalAssets) {
        throw new Error(
          "Audience identity financial conflict: the anonymous identity owns entitlements or payment history and requires explicit reconciliation.",
        );
      }
      await assertProvisionalFinancialTransferIsConflictFree({
        sourceAudienceIdentityId: sourceIdentity.id,
        targetAudienceIdentityId: targetIdentity.id,
        sourceEntitlementCount,
        tx,
      });
    }

    const claimed = await tx.audienceIdentity.updateMany({
      where: {
        id: sourceIdentity.id,
        status: "ANONYMOUS",
        mergedIntoId: null,
      },
      data: {
        status: "MERGED",
        mergedIntoId: targetIdentity.id,
        lastSeenAt: now,
      },
    });
    if (claimed.count !== 1) {
      throw new Error(
        "Audience identity merge conflict: the source identity changed concurrently.",
      );
    }

    await tx.contact.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });
    await tx.conversation.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });
    await tx.userWallet.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });
    if (input.transferVerifiedProvisionalAssets) {
      await transferProvisionalFinancialRecords({
        sourceAudienceIdentityId: sourceIdentity.id,
        targetAudienceIdentityId: targetIdentity.id,
        sourceEntitlementCount,
        sourcePaymentOrderCount,
        sourceTokenPurchaseCount,
        sourceUsageChargeCount,
        tx,
      });
    }
    await tx.sandboxIdentity.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });
    await tx.openVikingMemoryRecord.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });
    await tx.delegationTask.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });
    await tx.identityBindingChallenge?.updateMany({
      where: {
        audienceIdentityId: sourceIdentity.id,
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    await tx.bridgeIdentityMapping?.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });
    await tx.identityLink.updateMany({
      where: { audienceIdentityId: sourceIdentity.id },
      data: { audienceIdentityId: targetIdentity.id },
    });

    const mergedIdentity = await tx.audienceIdentity.findUnique({
      where: { id: sourceIdentity.id },
    });
    if (!mergedIdentity) {
      throw new Error(`Audience identity ${sourceIdentity.id} was not found after merge.`);
    }
    return mergedIdentity;
  };

  return client.$transaction
    ? client.$transaction(run, { isolationLevel: "Serializable" })
    : run(client);
}

async function assertProvisionalFinancialTransferIsConflictFree(input: {
  sourceAudienceIdentityId: string;
  targetAudienceIdentityId: string;
  sourceEntitlementCount: number;
  tx: WebAudienceClient;
}) {
  if (input.sourceEntitlementCount === 0) return;
  const accountClient = input.tx.serviceEntitlementAccount;
  if (!accountClient) {
    throw new Error(
      "Audience identity financial transfer is unavailable for this persistence client.",
    );
  }

  const [sourceAccounts, targetAccounts] = await Promise.all([
    accountClient.findMany({
      where: { audienceIdentityId: input.sourceAudienceIdentityId },
      select: {
        id: true,
        representativeId: true,
        productCode: true,
      },
    }),
    accountClient.findMany({
      where: { audienceIdentityId: input.targetAudienceIdentityId },
      select: {
        id: true,
        representativeId: true,
        productCode: true,
      },
    }),
  ]);
  const targetKeys = new Set(
    targetAccounts.map(
      (account) => `${account.representativeId}\u0000${account.productCode}`,
    ),
  );
  const conflict = sourceAccounts.find((account) =>
    targetKeys.has(`${account.representativeId}\u0000${account.productCode}`),
  );
  if (conflict) {
    throw new Error(
      `Audience identity entitlement conflict for representative ${conflict.representativeId} and product ${conflict.productCode}; explicit balance consolidation is required.`,
    );
  }
}

async function transferProvisionalFinancialRecords(input: {
  sourceAudienceIdentityId: string;
  targetAudienceIdentityId: string;
  sourceEntitlementCount: number;
  sourcePaymentOrderCount: number;
  sourceTokenPurchaseCount: number;
  sourceUsageChargeCount: number;
  tx: WebAudienceClient;
}) {
  if (input.sourceEntitlementCount > 0) {
    const result = await input.tx.serviceEntitlementAccount?.updateMany({
      where: { audienceIdentityId: input.sourceAudienceIdentityId },
      data: { audienceIdentityId: input.targetAudienceIdentityId },
    });
    assertTransferredCount("entitlement accounts", result?.count, input.sourceEntitlementCount);
  }
  if (input.sourcePaymentOrderCount > 0) {
    const result = await input.tx.servicePaymentOrder?.updateMany({
      where: { payerAudienceIdentityId: input.sourceAudienceIdentityId },
      data: { payerAudienceIdentityId: input.targetAudienceIdentityId },
    });
    assertTransferredCount("payment orders", result?.count, input.sourcePaymentOrderCount);
  }
  if (input.sourceTokenPurchaseCount > 0) {
    const result = await input.tx.agentTokenPurchase?.updateMany({
      where: { audienceIdentityId: input.sourceAudienceIdentityId },
      data: { audienceIdentityId: input.targetAudienceIdentityId },
    });
    assertTransferredCount("token purchases", result?.count, input.sourceTokenPurchaseCount);
  }
  if (input.sourceUsageChargeCount > 0) {
    const result = await input.tx.agentUsageCharge?.updateMany({
      where: { audienceIdentityId: input.sourceAudienceIdentityId },
      data: { audienceIdentityId: input.targetAudienceIdentityId },
    });
    assertTransferredCount("usage charges", result?.count, input.sourceUsageChargeCount);
  }
}

function assertTransferredCount(label: string, actual: number | undefined, expected: number) {
  if (actual !== expected) {
    throw new Error(
      `Audience identity financial transfer moved ${actual ?? 0} of ${expected} ${label}.`,
    );
  }
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
    const persistConversation = async (tx: WebAudienceClient) => {
      const identity = await resolveAnonymousAudienceIdentity(
        { audienceId, now },
        tx,
      );
      const conversation = await tx.conversation.upsert({
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

      await ensureWebConversationChannelBinding(
        {
          representativeId: input.representativeId,
          conversationId: conversation.id,
          audienceIdentityId: identity.id,
          audienceId,
          threadId,
        },
        tx,
      );
      return conversation;
    };

    return client.$transaction
      ? client.$transaction(persistConversation)
      : persistConversation(client);
  } catch (error) {
    if (shouldUseDemoConversationErrorFallback(error, input.representativeId, client)) {
      return resolveDemoWebAudienceConversation(input);
    }
    throw error;
  }
}

async function ensureWebConversationChannelBinding(
  input: {
    representativeId: string;
    conversationId: string;
    audienceIdentityId: string;
    audienceId: string;
    threadId: string;
  },
  client: WebAudienceClient,
) {
  if (
    !client.representativeChannelBinding
    || !client.conversationChannelBinding
  ) {
    return;
  }

  const representativeBinding =
    await client.representativeChannelBinding.findUnique({
      where: {
        representativeId_kind: {
          representativeId: input.representativeId,
          kind: "WEB",
        },
      },
      select: {
        id: true,
        connectionId: true,
      },
    });
  if (!representativeBinding) {
    throw new Error("Representative Web channel binding was not found.");
  }

  const bindingKey =
    `WEB:${input.representativeId}:${input.threadId}:`;
  const bindingMetadata = {
    audienceIdentityId: input.audienceIdentityId,
    audienceId: input.audienceId,
  };
  await client.conversationChannelBinding.upsert({
    where: { bindingKey },
    create: {
      conversationId: input.conversationId,
      representativeBindingId: representativeBinding.id,
      kind: "WEB",
      transport: "WEB",
      sourceProvider: "WEB",
      connectionId: representativeBinding.connectionId,
      bindingKey,
      externalConversationId: input.threadId,
      externalThreadId: input.threadId,
      metadata: bindingMetadata,
    },
    update: {
      conversationId: input.conversationId,
      representativeBindingId: representativeBinding.id,
      connectionId: representativeBinding.connectionId,
      externalConversationId: input.threadId,
      externalThreadId: input.threadId,
      metadata: bindingMetadata,
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
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("providerSubject is required.");
  }
  if (provider === "LOGTO") return trimmed;
  if (provider === "MATRIX") {
    const separator = trimmed.lastIndexOf(":");
    return separator > 0
      ? `${trimmed.slice(0, separator)}:${trimmed.slice(separator + 1).toLowerCase()}`
      : trimmed;
  }
  return trimmed.toLowerCase();
}

async function findIdentityLink(
  client: WebAudienceClient,
  provider: WebAudienceIdentityLinkProvider,
  providerSubject: string,
) {
  return client.identityLink.findUnique({
    where: {
      provider_providerSubject: {
        provider,
        providerSubject,
      },
    },
    select: {
      audienceIdentityId: true,
      issuer: true,
      connectionId: true,
      revokedAt: true,
    },
  });
}

async function updateOwnedIdentityLink(input: {
  client: WebAudienceClient;
  existingAudienceIdentityId: string;
  requestedAudienceIdentityId: string;
  provider: WebAudienceIdentityLinkProvider;
  providerSubject: string;
  existingIssuer?: string;
  existingConnectionId?: string | null;
  issuer?: string;
  connectionId?: string | null;
  verifiedAt?: Date | null | undefined;
  assuranceLevel?: "UNVERIFIED" | "PLATFORM_VERIFIED" | "STEP_UP_VERIFIED";
  proofMetadata?: unknown;
  metadata?: unknown;
}) {
  const existingIdentity = await resolveCanonicalAudienceIdentity(
    {
      audienceIdentityId: input.existingAudienceIdentityId,
    },
    input.client,
  );
  if (existingIdentity.id !== input.requestedAudienceIdentityId) {
    throw new Error(
      `Identity link conflict: ${input.provider} subject is already linked to another audience identity.`,
    );
  }
  if (
    input.issuer !== undefined
    && input.existingIssuer !== undefined
    && input.existingIssuer !== input.issuer
  ) {
    throw new Error(
      `Identity link conflict: ${input.provider} subject belongs to a different issuer realm.`,
    );
  }
  if (
    typeof input.connectionId === "string"
    && input.existingConnectionId
    && input.existingConnectionId.toLowerCase() !== input.connectionId.toLowerCase()
  ) {
    throw new Error(
      `Identity link conflict: ${input.provider} subject belongs to a different provider connection.`,
    );
  }

  const updated = await input.client.identityLink.updateMany({
    where: {
      audienceIdentityId: input.existingAudienceIdentityId,
      provider: input.provider,
      providerSubject: input.providerSubject,
    },
    data: {
      audienceIdentityId: input.requestedAudienceIdentityId,
      ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
      ...(input.verifiedAt !== undefined ? { verifiedAt: input.verifiedAt } : {}),
      ...(input.assuranceLevel !== undefined
        ? { assuranceLevel: input.assuranceLevel }
        : {}),
      ...(input.proofMetadata !== undefined
        ? { proofMetadata: input.proofMetadata }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
  });
  if (updated.count !== 1) {
    throw new Error(
      `Identity link conflict: ${input.provider} subject changed concurrently.`,
    );
  }
  return updated;
}

function isUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "P2002" ||
    (typeof candidate.message === "string" &&
      candidate.message.toLowerCase().includes("unique constraint"))
  );
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
    error.message.includes("resolved to an empty string") ||
    error.message.includes("P1001")
  );
}
