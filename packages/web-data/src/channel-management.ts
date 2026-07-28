import {
  ChannelDesiredState,
  ChannelHealthStatus,
  ChannelSourceProvider,
  ChannelTransport,
  EventType,
  RepresentativeChannelKind,
} from "@prisma/client";
import { demoRepresentative } from "@delegate/domain";

import { prisma } from "./prisma";
import {
  isValidMatrixServerName,
  matrixServerNameFromUserId,
  normalizeMatrixServerName,
  normalizeMatrixUserId,
} from "./matrix-identifiers";
import { resolveMatrixApplicationServiceConnectionId } from "./matrix-provisioning";
import {
  listOwnerTelegramBotConnections,
  type OwnerTelegramBotConnectionSummary,
} from "./telegram-bot-connections";

const channelKinds = [
  RepresentativeChannelKind.WEB,
  RepresentativeChannelKind.MATRIX,
  RepresentativeChannelKind.TELEGRAM,
] as const;
const healthyLegacyStatuses = new Set([
  "CONFIGURED",
  "CONNECTED",
  "ACTIVE",
  "HEALTHY",
  "DEGRADED",
]);
const recentEventLimit = 1_000;
const healthFailureWindowMs = 24 * 60 * 60 * 1_000;

export type ManagedChannelKind = (typeof channelKinds)[number];

export type ChannelActivitySummary = {
  id: string;
  eventType: string;
  status: string;
  occurredAt: string;
  error: string | null;
};

export type ManagedChannelBinding = {
  bindingId: string | null;
  kind: ManagedChannelKind;
  sourceProvider: ManagedChannelKind;
  transport: ManagedChannelKind;
  routedViaMatrix: boolean;
  desiredState: "ACTIVE" | "PAUSED" | "DISCONNECTED";
  healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  legacyStatus: string | null;
  externalIdentity: {
    id: string | null;
    displayName: string | null;
  };
  telegramBotConnectionId: string | null;
  telegramBot: {
    botId: string;
    username: string | null;
    displayName: string | null;
  } | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  recentIngress: ChannelActivitySummary | null;
  recentEgress: ChannelActivitySummary | null;
};

export type ManagedRepresentativeChannels = {
  id: string;
  slug: string;
  name: string;
  lifecycleState: string;
  activeVersionId: string | null;
  publicMode: boolean;
  channels: ManagedChannelBinding[];
};

export type OwnerChannelManagementSnapshot = {
  generatedAt: string;
  dataSource: "database" | "demo-empty";
  metrics: {
    representatives: number;
    connectedBindings: number;
    pausedBindings: number;
    attentionBindings: number;
  };
  telegramBots: OwnerTelegramBotConnectionSummary[];
  representatives: ManagedRepresentativeChannels[];
};

export class ChannelManagementError extends Error {
  statusCode: 400 | 404 | 409 | 503;

  constructor(message: string, statusCode: 400 | 404 | 409 | 503) {
    super(message);
    this.name = "ChannelManagementError";
    this.statusCode = statusCode;
  }
}

export async function resolveRepresentativeChannelConnectionId(input: {
  representativeSlug: string;
  kind: ManagedChannelKind;
  transport?: ManagedChannelKind;
}): Promise<string | null> {
  const representativeSlug = requireValue(
    input.representativeSlug,
    "representativeSlug",
  );
  if (!process.env.DATABASE_URL?.trim()) {
    return null;
  }

  const binding = await prisma.representativeChannelBinding.findFirst({
    where: {
      kind: input.kind,
      ...(input.transport ? { transport: input.transport } : {}),
      desiredState: ChannelDesiredState.ACTIVE,
      status: { in: [...healthyLegacyStatuses] },
      connectionId: { not: null },
      representative: { slug: representativeSlug },
    },
    select: { connectionId: true },
  });
  const connectionId = binding?.connectionId?.trim();
  return connectionId || null;
}

export type RepresentativeTelegramBotEndpoint = {
  botId: string;
  username: string | null;
};

export async function resolveRepresentativeTelegramBotEndpoint(
  representativeSlug: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  client: Pick<typeof prisma, "representativeChannelBinding"> = prisma,
): Promise<RepresentativeTelegramBotEndpoint | null> {
  const normalizedRepresentativeSlug = requireValue(
    representativeSlug,
    "representativeSlug",
  );
  if (
    client === prisma
    && !process.env.DATABASE_URL?.trim()
  ) {
    return null;
  }

  const configuredId = env.TELEGRAM_BOT_ID?.trim();
  const tokenId = env.TELEGRAM_BOT_TOKEN?.trim().match(/^([1-9]\d*):/)?.[1];
  const configuredUsername =
    env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || null;
  const binding = await client.representativeChannelBinding.findFirst({
    where: {
      kind: RepresentativeChannelKind.TELEGRAM,
      representative: { slug: normalizedRepresentativeSlug },
      AND: [
        {
          OR: [
            { transport: null },
            { transport: ChannelTransport.TELEGRAM },
          ],
        },
        {
          OR: [
            { sourceProvider: null },
            { sourceProvider: ChannelSourceProvider.TELEGRAM },
          ],
        },
      ],
    },
    select: {
      connectionId: true,
      telegramBotConnectionId: true,
      desiredState: true,
      healthStatus: true,
      status: true,
      telegramBotConnection: {
        select: {
          botId: true,
          username: true,
          status: true,
          revokedAt: true,
          activeCredentialId: true,
        },
      },
    },
  });
  if (
    !binding
    || binding.desiredState !== ChannelDesiredState.ACTIVE
    || !healthyLegacyStatuses.has(binding.status)
    || binding.healthStatus === ChannelHealthStatus.UNHEALTHY
  ) {
    return null;
  }

  // Once a binding has been migrated to a managed connection, that relation
  // is the only routing authority. An unavailable, revoked, or credential-less
  // managed Bot must fail closed instead of silently using deployment env.
  if (binding.telegramBotConnectionId !== null) {
    const connection = binding.telegramBotConnection;
    const botId = connection?.botId.trim() ?? "";
    if (
      !connection
      || connection.status !== "ACTIVE"
      || connection.revokedAt !== null
      || !connection.activeCredentialId?.trim()
      || !/^[1-9]\d*$/.test(botId)
    ) {
      return null;
    }
    return {
      botId,
      username: connection.username?.trim().replace(/^@/, "") || null,
    };
  }

  const persistedId = binding.connectionId?.trim() || null;
  if (
    [configuredId, persistedId].some(
      (candidate) => candidate && !/^[1-9]\d*$/.test(candidate),
    )
  ) {
    return null;
  }
  // Deployment-level values remain only as a cold-start fallback for truly
  // legacy bindings that have not yet been attached to a managed connection.
  if (persistedId) {
    return {
      botId: persistedId,
      username:
        !configuredId || configuredId === persistedId
          ? configuredUsername
          : null,
    };
  }
  if (configuredId && tokenId && configuredId !== tokenId) return null;
  const botId = configuredId || tokenId || null;
  return botId ? { botId, username: configuredUsername } : null;
}

export async function resolveRepresentativeTelegramBotConnectionId(
  representativeSlug: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  client: Pick<typeof prisma, "representativeChannelBinding"> = prisma,
): Promise<string | null> {
  return (
    await resolveRepresentativeTelegramBotEndpoint(
      representativeSlug,
      env,
      client,
    )
  )?.botId ?? null;
}

export type RepresentativeMatrixEndpoint = {
  matrixUserId: string;
  connectionId: string;
};

/**
 * Resolves the exact managed Matrix destination exposed on a representative's
 * public page. Deployment configuration alone is insufficient: the
 * representative binding and its virtual user must both still be routable.
 */
export async function resolveRepresentativeMatrixEndpoint(
  representativeSlug: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  client: Pick<
    typeof prisma,
    "representativeChannelBinding" | "matrixVirtualUserBinding"
  > = prisma,
): Promise<RepresentativeMatrixEndpoint | null> {
  const normalizedRepresentativeSlug = requireValue(
    representativeSlug,
    "representativeSlug",
  );
  if (client === prisma && !env.DATABASE_URL?.trim()) {
    return null;
  }

  const homeserverUrl = env.MATRIX_HOMESERVER_URL?.trim();
  const serverName = env.MATRIX_SERVER_NAME?.trim();
  const configuredConnectionId = env.MATRIX_AS_CONNECTION_ID?.trim();
  if (
    !homeserverUrl
    || !serverName
    || !isHttpUrl(homeserverUrl)
    || !isValidMatrixServerName(serverName)
  ) {
    return null;
  }
  const connectionId = resolveMatrixApplicationServiceConnectionId(
    configuredConnectionId,
  );

  const binding = await client.representativeChannelBinding.findFirst({
    where: {
      kind: RepresentativeChannelKind.MATRIX,
      representative: { slug: normalizedRepresentativeSlug },
      AND: [
        {
          OR: [
            { transport: null },
            { transport: ChannelTransport.MATRIX },
          ],
        },
        {
          OR: [
            { sourceProvider: null },
            { sourceProvider: ChannelSourceProvider.MATRIX },
          ],
        },
      ],
    },
    select: {
      representativeId: true,
      connectionId: true,
      externalUserId: true,
      desiredState: true,
      healthStatus: true,
      status: true,
    },
  });
  const matrixUserId = binding?.externalUserId
    ? normalizeMatrixUserIdOrNull(binding.externalUserId)
    : null;
  const persistedConnectionId = binding?.connectionId?.trim();
  if (
    !binding
    || binding.desiredState !== ChannelDesiredState.ACTIVE
    || !healthyLegacyStatuses.has(binding.status)
    || binding.healthStatus === ChannelHealthStatus.UNHEALTHY
    || !persistedConnectionId
    || resolveMatrixApplicationServiceConnectionId(
      persistedConnectionId,
    ) !== connectionId
    || !matrixUserId
    || matrixServerNameFromUserId(matrixUserId) !== serverName
  ) {
    return null;
  }

  const virtualUser = await client.matrixVirtualUserBinding.findFirst({
    where: {
      matrixUserId,
      representativeId: binding.representativeId,
      kind: "REPRESENTATIVE",
      enabled: true,
    },
    select: {
      matrixUserId: true,
      enabled: true,
    },
  });
  if (
    !virtualUser?.enabled
    || normalizeMatrixUserIdOrNull(virtualUser.matrixUserId) !== matrixUserId
  ) {
    return null;
  }

  return { matrixUserId, connectionId };
}

type RepresentativeRecord = {
  id: string;
  slug: string;
  displayName: string;
  lifecycleState: string;
  activeVersionId: string | null;
  publicMode: boolean;
  channelBindings: BindingRecord[];
};

type BindingRecord = {
  id: string;
  kind: ManagedChannelKind;
  transport: ManagedChannelKind | null;
  sourceProvider: ManagedChannelKind | null;
  desiredState: "ACTIVE" | "PAUSED" | "DISCONNECTED";
  healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  externalUserId: string | null;
  status: string;
  displayName: string | null;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  telegramBotConnectionId?: string | null;
  telegramBotConnection?: {
    botId: string;
    username: string | null;
    displayName: string | null;
  } | null;
};

type EventRecord = {
  id: string;
  kind: ManagedChannelKind;
  transport: ManagedChannelKind | null;
  sourceProvider: ManagedChannelKind | null;
  eventType: string;
  status: string;
  lastError: string | null;
  createdAt: Date;
  conversation: { representativeId: string } | null;
};

export async function getOwnerChannelManagementSnapshot(input: {
  ownerId: string;
  now?: Date;
}): Promise<OwnerChannelManagementSnapshot> {
  const ownerId = requireValue(input.ownerId, "ownerId");
  const now = input.now ?? new Date();
  if (!process.env.DATABASE_URL?.trim()) {
    return buildOwnerChannelManagementSnapshot({
      representatives: [
        {
          id: demoRepresentative.id,
          slug: demoRepresentative.slug,
          displayName: demoRepresentative.name,
          lifecycleState: "DRAFT",
          activeVersionId: null,
          publicMode: false,
          channelBindings: [],
        },
      ],
      ingressEvents: [],
      egressEvents: [],
      telegramBots: [],
      generatedAt: now,
      dataSource: "demo-empty",
    });
  }

  const [representatives, ingressEvents, egressEvents, telegramBots] = await Promise.all([
    prisma.representative.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        slug: true,
        displayName: true,
        lifecycleState: true,
        activeVersionId: true,
        publicMode: true,
        channelBindings: {
          orderBy: { kind: "asc" },
          select: {
            id: true,
            kind: true,
            transport: true,
            sourceProvider: true,
            desiredState: true,
            healthStatus: true,
            externalUserId: true,
            status: true,
            displayName: true,
            lastHealthCheckAt: true,
            lastError: true,
            telegramBotConnectionId: true,
            telegramBotConnection: {
              select: {
                botId: true,
                username: true,
                displayName: true,
              },
            },
          },
        },
      },
    }),
    prisma.channelEventInbox.findMany({
      where: {
        conversation: {
          representative: { ownerId },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: recentEventLimit,
      select: {
        id: true,
        kind: true,
        transport: true,
        sourceProvider: true,
        eventType: true,
        status: true,
        lastError: true,
        createdAt: true,
        conversation: {
          select: { representativeId: true },
        },
      },
    }),
    prisma.outboxEvent.findMany({
      where: {
        conversation: {
          representative: { ownerId },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: recentEventLimit,
      select: {
        id: true,
        transport: true,
        sourceProvider: true,
        eventType: true,
        status: true,
        lastError: true,
        createdAt: true,
        conversation: {
          select: { representativeId: true },
        },
      },
    }),
    listOwnerTelegramBotConnections({ ownerId }),
  ]);

  return buildOwnerChannelManagementSnapshot({
    representatives: representatives as RepresentativeRecord[],
    ingressEvents: ingressEvents as EventRecord[],
    egressEvents: egressEvents.map((event) => ({
      ...event,
      kind: (event.sourceProvider ?? event.transport ?? "WEB") as ManagedChannelKind,
    })) as EventRecord[],
    telegramBots,
    generatedAt: now,
    dataSource: "database",
  });
}

export function buildOwnerChannelManagementSnapshot(input: {
  representatives: RepresentativeRecord[];
  ingressEvents: EventRecord[];
  egressEvents: EventRecord[];
  telegramBots?: OwnerTelegramBotConnectionSummary[];
  generatedAt: Date;
  dataSource: OwnerChannelManagementSnapshot["dataSource"];
}): OwnerChannelManagementSnapshot {
  const ingressByRepresentativeAndSource = indexLatestActivity(input.ingressEvents);
  const egressByRepresentativeAndSource = indexLatestActivity(input.egressEvents);
  const representatives = input.representatives.map((representative) => {
    const bindingBySource = new Map(
      representative.channelBindings.map((binding) => [
        binding.sourceProvider ?? binding.kind,
        binding,
      ]),
    );
    const channels = channelKinds.map((kind) => {
      const binding = bindingBySource.get(kind) ?? null;
      const sourceProvider = binding?.sourceProvider ?? kind;
      const transport = binding?.transport ?? kind;
      const activityKey = channelActivityKey(representative.id, sourceProvider);
      return {
        bindingId: binding?.id ?? null,
        kind,
        sourceProvider,
        transport,
        routedViaMatrix:
          sourceProvider === RepresentativeChannelKind.TELEGRAM
          && transport === RepresentativeChannelKind.MATRIX,
        desiredState: binding?.desiredState ?? ChannelDesiredState.DISCONNECTED,
        healthStatus: binding?.healthStatus ?? ChannelHealthStatus.UNKNOWN,
        legacyStatus: binding?.status ?? null,
        externalIdentity: {
          id: binding?.externalUserId ?? null,
          displayName: binding?.displayName ?? null,
        },
        telegramBotConnectionId:
          binding?.telegramBotConnectionId ?? null,
        telegramBot: binding?.telegramBotConnection
          ? {
              botId: binding.telegramBotConnection.botId,
              username: binding.telegramBotConnection.username,
              displayName: binding.telegramBotConnection.displayName,
            }
          : null,
        lastHealthCheckAt: binding?.lastHealthCheckAt?.toISOString() ?? null,
        lastError: sanitizeChannelError(binding?.lastError),
        recentIngress: ingressByRepresentativeAndSource.get(activityKey) ?? null,
        recentEgress: egressByRepresentativeAndSource.get(activityKey) ?? null,
      } satisfies ManagedChannelBinding;
    });
    return {
      id: representative.id,
      slug: representative.slug,
      name: representative.displayName,
      lifecycleState: representative.lifecycleState,
      activeVersionId: representative.activeVersionId,
      publicMode: representative.publicMode,
      channels,
    };
  });
  const bindings = representatives.flatMap((representative) =>
    representative.channels.filter((channel) => channel.bindingId),
  );

  return {
    generatedAt: input.generatedAt.toISOString(),
    dataSource: input.dataSource,
    metrics: {
      representatives: representatives.length,
      connectedBindings: bindings.filter(
        (binding) => binding.desiredState !== ChannelDesiredState.DISCONNECTED,
      ).length,
      pausedBindings: bindings.filter(
        (binding) => binding.desiredState === ChannelDesiredState.PAUSED,
      ).length,
      attentionBindings: bindings.filter(
        (binding) =>
          binding.healthStatus === ChannelHealthStatus.DEGRADED
          || binding.healthStatus === ChannelHealthStatus.UNHEALTHY
          || Boolean(binding.lastError),
      ).length,
    },
    telegramBots: input.telegramBots ?? [],
    representatives,
  };
}

export async function setOwnerChannelDesiredState(input: {
  ownerId: string;
  actorId: string;
  bindingId: string;
  desiredState: "ACTIVE" | "PAUSED";
  requestId: string;
  idempotencyKey: string;
}) {
  assertDatabaseAvailable();
  const ownerId = requireValue(input.ownerId, "ownerId");
  const actorId = requireValue(input.actorId, "actorId");
  const bindingId = requireValue(input.bindingId, "bindingId");
  const requestId = requireValue(input.requestId, "requestId");
  const idempotencyKey = requireValue(input.idempotencyKey, "idempotencyKey");
  if (
    input.desiredState !== ChannelDesiredState.ACTIVE
    && input.desiredState !== ChannelDesiredState.PAUSED
  ) {
    throw new ChannelManagementError("desiredState must be ACTIVE or PAUSED.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.representativeChannelBinding.findFirst({
      where: {
        id: bindingId,
        representative: { ownerId },
      },
      select: {
        representativeId: true,
        kind: true,
      },
    });
    if (!candidate) {
      throw new ChannelManagementError("Channel binding not found.", 404);
    }
    const stateLockKey =
      candidate.kind === RepresentativeChannelKind.MATRIX
        ? `matrix-virtual-user:${candidate.representativeId}`
        : `channel-binding-state:${bindingId}`;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${stateLockKey})
      )
    `;
    const binding = await tx.representativeChannelBinding.findFirst({
      where: {
        id: bindingId,
        representative: { ownerId },
      },
      select: {
        id: true,
        representativeId: true,
        kind: true,
        transport: true,
        sourceProvider: true,
        desiredState: true,
      },
    });
    if (!binding) {
      throw new ChannelManagementError("Channel binding not found.", 404);
    }
    if (binding.desiredState === ChannelDesiredState.DISCONNECTED) {
      throw new ChannelManagementError(
        "Disconnected channels must be reconnected before they can be paused or resumed.",
        409,
      );
    }
    const repeatedAudit = await tx.eventAudit.findFirst({
      where: {
        representativeId: binding.representativeId,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        AND: [
          {
            payload: {
              path: ["bindingId"],
              equals: binding.id,
            },
          },
          {
            payload: {
              path: ["idempotencyKey"],
              equals: idempotencyKey,
            },
          },
        ],
      },
      select: { payload: true },
    });
    if (repeatedAudit) {
      const payload = isJsonRecord(repeatedAudit.payload)
        ? repeatedAudit.payload
        : null;
      if (
        payload?.action !== "CHANNEL_DESIRED_STATE_CHANGED"
        || payload.desiredState !== input.desiredState
      ) {
        throw new ChannelManagementError(
          "Idempotency key was already used for a different channel request on this binding.",
          409,
        );
      }
      return binding;
    }
    const updated = binding.desiredState === input.desiredState
      ? binding
      : await tx.representativeChannelBinding.update({
          where: { id: binding.id },
          data: { desiredState: input.desiredState },
          select: {
            id: true,
            representativeId: true,
            kind: true,
            transport: true,
            sourceProvider: true,
            desiredState: true,
          },
        });
    await tx.eventAudit.create({
      data: {
        representativeId: binding.representativeId,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        payload: {
          kind: "channel_desired_state_changed",
          action: "CHANNEL_DESIRED_STATE_CHANGED",
          actorId,
          requestId,
          idempotencyKey,
          bindingId: binding.id,
          channelKind: binding.kind,
          sourceProvider: binding.sourceProvider ?? binding.kind,
          transport: binding.transport ?? binding.kind,
          previousDesiredState: binding.desiredState,
          desiredState: input.desiredState,
          before: {
            desiredState: binding.desiredState,
          },
          after: {
            desiredState: input.desiredState,
          },
          changed: binding.desiredState !== input.desiredState,
        },
      },
    });
    return updated;
  });
}

export async function provisionOwnerTelegramChannel(
  input: {
    ownerId: string;
    actorId: string;
    representativeId: string;
    requestId: string;
    idempotencyKey: string;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  assertDatabaseAvailable();
  const ownerId = requireValue(input.ownerId, "ownerId");
  const actorId = requireValue(input.actorId, "actorId");
  const representativeId = requireValue(
    input.representativeId,
    "representativeId",
  );
  const requestId = requireValue(input.requestId, "requestId");
  const idempotencyKey = requireValue(input.idempotencyKey, "idempotencyKey");
  const telegramBot = resolveConfiguredTelegramBotIdentity(env);

  return prisma.$transaction(async (tx) => {
    const representative = await tx.representative.findFirst({
      where: {
        id: representativeId,
        ownerId,
      },
      select: {
        id: true,
        slug: true,
        displayName: true,
      },
    });
    if (!representative) {
      throw new ChannelManagementError("Representative not found.", 404);
    }
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${"telegram-bot-channel:" + representative.id})
      )
    `;

    const candidate = await tx.representativeChannelBinding.upsert({
      where: {
        representativeId_kind: {
          representativeId: representative.id,
          kind: RepresentativeChannelKind.TELEGRAM,
        },
      },
      create: {
        representativeId: representative.id,
        kind: RepresentativeChannelKind.TELEGRAM,
        transport: ChannelTransport.TELEGRAM,
        sourceProvider: ChannelSourceProvider.TELEGRAM,
        connectionId: telegramBot.connectionId,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.UNKNOWN,
        externalUserId: telegramBot.externalUserId,
        status: "CONFIGURED",
        displayName: representative.displayName,
        configuration: {
          managed: true,
          directMessageOnly: true,
          botUsername: telegramBot.username,
        },
      },
      update: {},
      select: {
        id: true,
        representativeId: true,
        kind: true,
        transport: true,
        sourceProvider: true,
        connectionId: true,
        desiredState: true,
        healthStatus: true,
        externalUserId: true,
        status: true,
      },
    });
    if (
      (
        candidate.transport !== null
        && candidate.transport !== ChannelTransport.TELEGRAM
      )
      || (
        candidate.sourceProvider !== null
        && candidate.sourceProvider !== ChannelSourceProvider.TELEGRAM
      )
    ) {
      throw new ChannelManagementError(
        "Existing Telegram channel uses a different transport and cannot be replaced.",
        409,
      );
    }
    if (
      candidate.connectionId
      && candidate.connectionId !== telegramBot.connectionId
    ) {
      throw new ChannelManagementError(
        "Existing Telegram channel is assigned to a different Bot.",
        409,
      );
    }

    const updated = await tx.representativeChannelBinding.updateMany({
      where: {
        id: candidate.id,
        AND: [
          {
            OR: [
              { transport: null },
              { transport: ChannelTransport.TELEGRAM },
            ],
          },
          {
            OR: [
              { sourceProvider: null },
              { sourceProvider: ChannelSourceProvider.TELEGRAM },
            ],
          },
          {
            OR: [
              { connectionId: null },
              { connectionId: "" },
              { connectionId: telegramBot.connectionId },
            ],
          },
        ],
      },
      data: {
        transport: ChannelTransport.TELEGRAM,
        sourceProvider: ChannelSourceProvider.TELEGRAM,
        connectionId: telegramBot.connectionId,
        externalUserId: telegramBot.externalUserId,
        displayName: representative.displayName,
        configuration: {
          managed: true,
          directMessageOnly: true,
          botUsername: telegramBot.username,
        },
      },
    });
    if (updated.count !== 1) {
      throw new ChannelManagementError(
        "Telegram channel changed while it was being configured. Refresh and try again.",
        409,
      );
    }
    const binding = await tx.representativeChannelBinding.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        representativeId: true,
        kind: true,
        desiredState: true,
        healthStatus: true,
        externalUserId: true,
        status: true,
      },
    });
    if (!binding) {
      throw new ChannelManagementError(
        "Telegram channel no longer exists. Refresh and try again.",
        409,
      );
    }
    const repeatedAudit = await tx.eventAudit.findFirst({
      where: {
        representativeId: representative.id,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        AND: [
          {
            payload: {
              path: ["action"],
              equals: "TELEGRAM_BOT_CHANNEL_PROVISIONED",
            },
          },
          {
            payload: {
              path: ["idempotencyKey"],
              equals: idempotencyKey,
            },
          },
        ],
      },
      select: { id: true },
    });
    if (!repeatedAudit) {
      await tx.eventAudit.create({
        data: {
          representativeId: representative.id,
          type: EventType.CHANNEL_CONFIGURATION_CHANGED,
          payload: {
            kind: "telegram_bot_channel_provisioned",
            action: "TELEGRAM_BOT_CHANNEL_PROVISIONED",
            actorId,
            requestId,
            idempotencyKey,
            bindingId: binding.id,
            connectionId: telegramBot.connectionId,
            externalUserId: telegramBot.externalUserId,
          },
        },
      });
    }
    return { binding };
  });
}

/**
 * Assigns one owner-managed Telegram Bot connection to a representative.
 * A connection may be reused by multiple representatives owned by the same
 * workspace; switching this representative never mutates the other bindings.
 */
export async function assignOwnerTelegramBotConnection(input: {
  ownerId: string;
  actorId: string;
  representativeId: string;
  telegramBotConnectionId: string;
  requestId: string;
  idempotencyKey: string;
}) {
  assertDatabaseAvailable();
  const ownerId = requireValue(input.ownerId, "ownerId");
  const actorId = requireValue(input.actorId, "actorId");
  const representativeId = requireValue(
    input.representativeId,
    "representativeId",
  );
  const telegramBotConnectionId = requireValue(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const requestId = requireValue(input.requestId, "requestId");
  const idempotencyKey = requireValue(input.idempotencyKey, "idempotencyKey");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${"telegram-bot-channel:" + representativeId})
      )
    `;
    const telegramBotLockTarget =
      await tx.telegramBotConnection.findFirst({
        where: {
          id: telegramBotConnectionId,
          ownerId,
        },
        select: { botId: true },
      });
    if (!telegramBotLockTarget) {
      throw new ChannelManagementError(
        "Telegram Bot connection not found.",
        404,
      );
    }
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${"telegram-bot-connection:" + telegramBotLockTarget.botId})
      )
    `;
    const [representative, telegramBot] = await Promise.all([
      tx.representative.findFirst({
        where: { id: representativeId, ownerId },
        select: {
          id: true,
          displayName: true,
        },
      }),
      tx.telegramBotConnection.findFirst({
        where: {
          id: telegramBotConnectionId,
          ownerId,
          revokedAt: null,
          status: "ACTIVE",
        },
        select: {
          id: true,
          botId: true,
          username: true,
          displayName: true,
          status: true,
          healthStatus: true,
        },
      }),
    ]);
    if (!representative) {
      throw new ChannelManagementError("Representative not found.", 404);
    }
    if (!telegramBot) {
      throw new ChannelManagementError("Telegram Bot connection not found.", 404);
    }

    const existing = await tx.representativeChannelBinding.findUnique({
      where: {
        representativeId_kind: {
          representativeId,
          kind: RepresentativeChannelKind.TELEGRAM,
        },
      },
      select: {
        id: true,
        representativeId: true,
        kind: true,
        transport: true,
        sourceProvider: true,
        connectionId: true,
        telegramBotConnectionId: true,
        desiredState: true,
        healthStatus: true,
        externalUserId: true,
        status: true,
      },
    });
    if (existing) {
      const repeatedAssignment = await tx.eventAudit.findFirst({
        where: {
          representativeId,
          type: EventType.CHANNEL_CONFIGURATION_CHANGED,
          AND: [
            {
              payload: {
                path: ["bindingId"],
                equals: existing.id,
              },
            },
            {
              payload: {
                path: ["idempotencyKey"],
                equals: idempotencyKey,
              },
            },
          ],
        },
        select: { payload: true },
      });
      if (repeatedAssignment) {
        assertTelegramAssignmentIdempotencyReplay(
          repeatedAssignment.payload,
          telegramBot.id,
        );
        return {
          binding: existing,
          telegramBot: {
            id: telegramBot.id,
            botId: telegramBot.botId,
            username: telegramBot.username,
            displayName: telegramBot.displayName,
            status: telegramBot.status,
            healthStatus: telegramBot.healthStatus,
          },
        };
      }
    }
    if (
      existing
      && (
        (
          existing.transport !== null
          && existing.transport !== ChannelTransport.TELEGRAM
        )
        || (
          existing.sourceProvider !== null
          && existing.sourceProvider !== ChannelSourceProvider.TELEGRAM
        )
      )
    ) {
      throw new ChannelManagementError(
        "Existing Telegram channel uses a different transport and cannot be replaced.",
        409,
      );
    }

    const changed =
      existing?.telegramBotConnectionId !== telegramBot.id
      || existing.connectionId !== telegramBot.botId;
    const nextDesiredState = changed
      ? ChannelDesiredState.ACTIVE
      : existing?.desiredState ?? ChannelDesiredState.ACTIVE;
    const externalUserId = telegramBot.username
      ? `@${telegramBot.username}`
      : `telegram-bot:${telegramBot.botId}`;
    const binding = await tx.representativeChannelBinding.upsert({
      where: {
        representativeId_kind: {
          representativeId,
          kind: RepresentativeChannelKind.TELEGRAM,
        },
      },
      create: {
        representativeId,
        kind: RepresentativeChannelKind.TELEGRAM,
        transport: ChannelTransport.TELEGRAM,
        sourceProvider: ChannelSourceProvider.TELEGRAM,
        connectionId: telegramBot.botId,
        telegramBotConnectionId: telegramBot.id,
        desiredState: nextDesiredState,
        healthStatus: telegramBot.healthStatus,
        externalUserId,
        status: "CONFIGURED",
        displayName: representative.displayName,
        configuration: {
          managed: true,
          directMessageOnly: true,
          botUsername: telegramBot.username,
        },
        lastError: null,
      },
      update: changed
        ? {
            transport: ChannelTransport.TELEGRAM,
            sourceProvider: ChannelSourceProvider.TELEGRAM,
            connectionId: telegramBot.botId,
            telegramBotConnectionId: telegramBot.id,
            desiredState: nextDesiredState,
              healthStatus: telegramBot.healthStatus,
              lastHealthCheckAt: null,
            externalUserId,
            status: "CONFIGURED",
            displayName: representative.displayName,
            configuration: {
              managed: true,
              directMessageOnly: true,
              botUsername: telegramBot.username,
            },
            lastError: null,
          }
        : {},
      select: {
        id: true,
        representativeId: true,
        kind: true,
        transport: true,
        sourceProvider: true,
        connectionId: true,
        telegramBotConnectionId: true,
        desiredState: true,
        healthStatus: true,
        externalUserId: true,
        status: true,
      },
    });

    const repeatedAudit = await tx.eventAudit.findFirst({
      where: {
        representativeId,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        AND: [
          {
            payload: {
              path: ["bindingId"],
              equals: binding.id,
            },
          },
          {
            payload: {
              path: ["idempotencyKey"],
              equals: idempotencyKey,
            },
          },
        ],
      },
      select: { payload: true },
    });
    if (repeatedAudit) {
      assertTelegramAssignmentIdempotencyReplay(
        repeatedAudit.payload,
        telegramBot.id,
      );
    } else {
      await tx.eventAudit.create({
        data: {
          representativeId,
          type: EventType.CHANNEL_CONFIGURATION_CHANGED,
          payload: {
            kind: "representative_telegram_bot_assigned",
            action: "REPRESENTATIVE_TELEGRAM_BOT_ASSIGNED",
            actorId,
            requestId,
            idempotencyKey,
            bindingId: binding.id,
            telegramBotConnectionId: telegramBot.id,
            botId: telegramBot.botId,
            botUsername: telegramBot.username,
            before: {
              telegramBotConnectionId:
                existing?.telegramBotConnectionId ?? null,
              connectionId: existing?.connectionId ?? null,
              desiredState:
                existing?.desiredState ?? ChannelDesiredState.DISCONNECTED,
            },
            after: {
              telegramBotConnectionId: telegramBot.id,
              connectionId: telegramBot.botId,
              desiredState: nextDesiredState,
            },
            changed,
          },
        },
      });
    }
    return {
      binding,
      telegramBot: {
        id: telegramBot.id,
        botId: telegramBot.botId,
        username: telegramBot.username,
        displayName: telegramBot.displayName,
        status: telegramBot.status,
        healthStatus: telegramBot.healthStatus,
      },
    };
  });
}

export async function provisionOwnerMatrixChannel(input: {
  ownerId: string;
  actorId: string;
  representativeId: string;
  requestId: string;
  idempotencyKey: string;
}) {
  assertDatabaseAvailable();
  const ownerId = requireValue(input.ownerId, "ownerId");
  const actorId = requireValue(input.actorId, "actorId");
  const representativeId = requireValue(
    input.representativeId,
    "representativeId",
  );
  const requestId = requireValue(input.requestId, "requestId");
  const idempotencyKey = requireValue(input.idempotencyKey, "idempotencyKey");
  const serverName = resolveMatrixServerName();
  const connectionId = resolveMatrixApplicationServiceConnectionId();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${"matrix-virtual-user:" + representativeId})
      )
    `;
    const representative = await tx.representative.findFirst({
      where: {
        id: representativeId,
        ownerId,
      },
      select: {
        id: true,
        slug: true,
        displayName: true,
      },
    });
    if (!representative) {
      throw new ChannelManagementError("Representative not found.", 404);
    }
    const existingChannel =
      await tx.representativeChannelBinding.findUnique({
        where: {
          representativeId_kind: {
            representativeId: representative.id,
            kind: RepresentativeChannelKind.MATRIX,
          },
        },
        select: {
          id: true,
          representativeId: true,
          kind: true,
          desiredState: true,
          healthStatus: true,
          externalUserId: true,
          status: true,
        },
      });
    const repeatedAudit = await tx.eventAudit.findFirst({
      where: {
        representativeId: representative.id,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        payload: {
          path: ["idempotencyKey"],
          equals: idempotencyKey,
        },
      },
      select: { payload: true },
    });
    if (repeatedAudit) {
      const payload = isJsonRecord(repeatedAudit.payload)
        ? repeatedAudit.payload
        : null;
      const replayMatrixUserId =
        typeof payload?.matrixUserId === "string"
          ? payload.matrixUserId
          : null;
      if (
        payload?.action !== "MATRIX_VIRTUAL_USER_PROVISIONED"
        || !existingChannel
        || payload.bindingId !== existingChannel.id
        || payload.connectionId !== connectionId
        || payload.matrixUserId !== existingChannel.externalUserId
        || !replayMatrixUserId
      ) {
        throw new ChannelManagementError(
          "Idempotency key was already used for a different Matrix channel request on this representative.",
          409,
        );
      }
      const replayVirtualUser =
        await tx.matrixVirtualUserBinding.findUnique({
          where: { matrixUserId: replayMatrixUserId },
          select: {
            id: true,
            matrixUserId: true,
            representativeId: true,
            kind: true,
            displayName: true,
            enabled: true,
          },
        });
      if (
        existingChannel.desiredState !== ChannelDesiredState.ACTIVE
        || !replayVirtualUser?.enabled
        || replayVirtualUser.id !== payload.matrixVirtualUserBindingId
        || replayVirtualUser.representativeId !== representative.id
        || replayVirtualUser.kind !== "REPRESENTATIVE"
      ) {
        throw new ChannelManagementError(
          "This Matrix provisioning request was already completed, but the channel state has since changed. Use a new idempotency key to reconnect.",
          409,
        );
      }
      return {
        binding: existingChannel,
        virtualUser: {
          id: replayVirtualUser.id,
          matrixUserId: replayVirtualUser.matrixUserId,
          displayName: replayVirtualUser.displayName,
          enabled: replayVirtualUser.enabled,
        },
      };
    }
    const existingVirtualUser = await tx.matrixVirtualUserBinding.findFirst({
      where: {
        representativeId: representative.id,
        kind: "REPRESENTATIVE",
        enabled: true,
      },
      select: {
        id: true,
        matrixUserId: true,
      },
    });
    if (
      existingVirtualUser
      && matrixServerNameOrNull(existingVirtualUser.matrixUserId) !== serverName
    ) {
      throw new ChannelManagementError(
        "The representative already has a managed Matrix user on a different homeserver. Disable and migrate that identity before changing MATRIX_SERVER_NAME.",
        409,
      );
    }
    const matrixUserId =
      existingVirtualUser?.matrixUserId
      || buildRepresentativeMatrixUserId(representative.slug, serverName);
    const collision = await tx.matrixVirtualUserBinding.findUnique({
      where: { matrixUserId },
      select: {
        id: true,
        representativeId: true,
        kind: true,
      },
    });
    if (
      collision
      && (
        collision.representativeId !== representative.id
        || collision.kind !== "REPRESENTATIVE"
      )
    ) {
      throw new ChannelManagementError(
        "Managed Matrix user is already assigned to another principal.",
        409,
      );
    }

    const virtualUser = await tx.matrixVirtualUserBinding.upsert({
      where: { matrixUserId },
      create: {
        matrixUserId,
        representativeId: representative.id,
        ownerId,
        kind: "REPRESENTATIVE",
        displayName: representative.displayName,
        enabled: true,
      },
      update: {
        representativeId: representative.id,
        ownerId,
        kind: "REPRESENTATIVE",
        displayName: representative.displayName,
        enabled: true,
      },
      select: {
        id: true,
        matrixUserId: true,
        displayName: true,
        enabled: true,
      },
    });
    const reconnecting =
      existingChannel?.desiredState === ChannelDesiredState.DISCONNECTED;
    const binding = await tx.representativeChannelBinding.upsert({
      where: {
        representativeId_kind: {
          representativeId: representative.id,
          kind: RepresentativeChannelKind.MATRIX,
        },
      },
      create: {
        representativeId: representative.id,
        kind: RepresentativeChannelKind.MATRIX,
        transport: ChannelTransport.MATRIX,
        sourceProvider: ChannelSourceProvider.MATRIX,
        connectionId,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.UNKNOWN,
        externalUserId: matrixUserId,
        status: "CONFIGURED",
        displayName: representative.displayName,
        configuration: {
          managed: true,
          directMessageOnly: true,
          encrypted: false,
          serverName,
        },
      },
      update: {
        transport: ChannelTransport.MATRIX,
        sourceProvider: ChannelSourceProvider.MATRIX,
        connectionId,
        externalUserId: matrixUserId,
        displayName: representative.displayName,
        ...(reconnecting
          ? {
              desiredState: ChannelDesiredState.ACTIVE,
              healthStatus: ChannelHealthStatus.UNKNOWN,
              status: "CONFIGURED",
              lastHealthCheckAt: null,
              lastError: null,
            }
          : {}),
        configuration: {
          managed: true,
          directMessageOnly: true,
          encrypted: false,
          serverName,
        },
      },
      select: {
        id: true,
        representativeId: true,
        kind: true,
        desiredState: true,
        healthStatus: true,
        externalUserId: true,
        status: true,
      },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: representative.id,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        payload: {
          kind: "matrix_virtual_user_provisioned",
          action: "MATRIX_VIRTUAL_USER_PROVISIONED",
          actorId,
          requestId,
          idempotencyKey,
          bindingId: binding.id,
          matrixVirtualUserBindingId: virtualUser.id,
          matrixUserId,
          connectionId,
        },
      },
    });
    return { binding, virtualUser };
  });
}

export async function disconnectOwnerMatrixChannel(input: {
  ownerId: string;
  actorId: string;
  bindingId: string;
  requestId: string;
  idempotencyKey: string;
}) {
  assertDatabaseAvailable();
  const ownerId = requireValue(input.ownerId, "ownerId");
  const actorId = requireValue(input.actorId, "actorId");
  const bindingId = requireValue(input.bindingId, "bindingId");
  const requestId = requireValue(input.requestId, "requestId");
  const idempotencyKey = requireValue(input.idempotencyKey, "idempotencyKey");

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.representativeChannelBinding.findFirst({
      where: {
        id: bindingId,
        kind: RepresentativeChannelKind.MATRIX,
        representative: { ownerId },
      },
      select: {
        representativeId: true,
      },
    });
    if (!candidate) {
      throw new ChannelManagementError("Matrix channel binding not found.", 404);
    }
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${"matrix-virtual-user:" + candidate.representativeId})
      )
    `;
    const binding = await tx.representativeChannelBinding.findFirst({
      where: {
        id: bindingId,
        kind: RepresentativeChannelKind.MATRIX,
        representative: { ownerId },
      },
      select: {
        id: true,
        representativeId: true,
        kind: true,
        transport: true,
        sourceProvider: true,
        connectionId: true,
        desiredState: true,
        healthStatus: true,
        externalUserId: true,
        status: true,
      },
    });
    if (!binding) {
      throw new ChannelManagementError("Matrix channel binding not found.", 404);
    }

    const repeatedAudit = await tx.eventAudit.findFirst({
      where: {
        representativeId: binding.representativeId,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        AND: [
          {
            payload: {
              path: ["bindingId"],
              equals: binding.id,
            },
          },
          {
            payload: {
              path: ["idempotencyKey"],
              equals: idempotencyKey,
            },
          },
        ],
      },
      select: { payload: true },
    });
    if (repeatedAudit) {
      const payload = isJsonRecord(repeatedAudit.payload)
        ? repeatedAudit.payload
        : null;
      if (payload?.action !== "MATRIX_CHANNEL_DISCONNECTED") {
        throw new ChannelManagementError(
          "Idempotency key was already used for a different channel request on this binding.",
          409,
        );
      }
      return {
        binding,
        changed: payload.changed === true,
        replayed: true,
      };
    }

    const changed =
      binding.desiredState !== ChannelDesiredState.DISCONNECTED
      || binding.status !== "DISCONNECTED";
    const updated = changed
      ? await tx.representativeChannelBinding.update({
          where: { id: binding.id },
          data: {
            desiredState: ChannelDesiredState.DISCONNECTED,
            healthStatus: ChannelHealthStatus.UNKNOWN,
            status: "DISCONNECTED",
            lastHealthCheckAt: null,
            lastError: null,
          },
          select: {
            id: true,
            representativeId: true,
            kind: true,
            transport: true,
            sourceProvider: true,
            connectionId: true,
            desiredState: true,
            healthStatus: true,
            externalUserId: true,
            status: true,
          },
        })
      : binding;

    await tx.matrixVirtualUserBinding.updateMany({
      where: {
        representativeId: binding.representativeId,
        kind: "REPRESENTATIVE",
        enabled: true,
      },
      data: { enabled: false },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: binding.representativeId,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        payload: {
          kind: "matrix_channel_disconnected",
          action: "MATRIX_CHANNEL_DISCONNECTED",
          actorId,
          requestId,
          idempotencyKey,
          bindingId: binding.id,
          matrixUserId: binding.externalUserId,
          connectionId: binding.connectionId,
          before: {
            desiredState: binding.desiredState,
            healthStatus: binding.healthStatus,
            status: binding.status,
          },
          after: {
            desiredState: ChannelDesiredState.DISCONNECTED,
            healthStatus: ChannelHealthStatus.UNKNOWN,
            status: "DISCONNECTED",
          },
          changed,
        },
      },
    });
    return {
      binding: updated,
      changed,
      replayed: false,
    };
  });
}

export async function refreshOwnerChannelHealth(input: {
  ownerId: string;
  actorId: string;
  bindingId: string;
  requestId: string;
  idempotencyKey: string;
  now?: Date;
}) {
  assertDatabaseAvailable();
  const ownerId = requireValue(input.ownerId, "ownerId");
  const actorId = requireValue(input.actorId, "actorId");
  const bindingId = requireValue(input.bindingId, "bindingId");
  const requestId = requireValue(input.requestId, "requestId");
  const idempotencyKey = requireValue(input.idempotencyKey, "idempotencyKey");
  const now = input.now ?? new Date();
  const failureCutoff = new Date(now.getTime() - healthFailureWindowMs);

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.representativeChannelBinding.findFirst({
      where: {
        id: bindingId,
        representative: { ownerId },
      },
      select: {
        representativeId: true,
        kind: true,
      },
    });
    if (!candidate) {
      throw new ChannelManagementError("Channel binding not found.", 404);
    }
    const stateLockKey =
      candidate.kind === RepresentativeChannelKind.MATRIX
        ? `matrix-virtual-user:${candidate.representativeId}`
        : `channel-binding-state:${bindingId}`;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${stateLockKey})
      )
    `;
    const binding = await tx.representativeChannelBinding.findFirst({
      where: {
        id: bindingId,
        representative: { ownerId },
      },
      select: {
        id: true,
        representativeId: true,
        kind: true,
        transport: true,
        sourceProvider: true,
        desiredState: true,
        healthStatus: true,
        externalUserId: true,
        status: true,
        lastError: true,
      },
    });
    if (!binding) {
      throw new ChannelManagementError("Channel binding not found.", 404);
    }
    const sourceProvider = binding.sourceProvider ?? binding.kind;
    const [failedIngress, failedEgress] = await Promise.all([
      tx.channelEventInbox.findFirst({
        where: {
          sourceProvider,
          createdAt: { gte: failureCutoff },
          status: { in: ["FAILED", "DEAD_LETTER"] },
          conversation: { representativeId: binding.representativeId },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, lastError: true, createdAt: true },
      }),
      tx.outboxEvent.findFirst({
        where: {
          sourceProvider,
          createdAt: { gte: failureCutoff },
          status: { in: ["FAILED", "DEAD_LETTER"] },
          conversation: { representativeId: binding.representativeId },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, lastError: true, createdAt: true },
      }),
    ]);
    const latestFailure = [failedIngress, failedEgress]
      .filter((event): event is NonNullable<typeof event> => Boolean(event))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
    const health = evaluateChannelControlPlaneHealth({
      kind: binding.kind,
      transport: binding.transport,
      sourceProvider: binding.sourceProvider,
      externalUserId: binding.externalUserId,
      legacyStatus: binding.status,
      currentHealthStatus: binding.healthStatus,
      currentLastError: binding.lastError,
      latestFailure,
    });
    const updated = await tx.representativeChannelBinding.update({
      where: { id: binding.id },
      data: {
        healthStatus: health.healthStatus,
        lastHealthCheckAt: now,
        lastError: health.lastError,
      },
      select: {
        id: true,
        healthStatus: true,
        lastHealthCheckAt: true,
        lastError: true,
      },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: binding.representativeId,
        type: EventType.CHANNEL_CONFIGURATION_CHANGED,
        payload: {
          kind: "channel_health_checked",
          action: "CHANNEL_HEALTH_CHECKED",
          actorId,
          requestId,
          idempotencyKey,
          bindingId: binding.id,
          channelKind: binding.kind,
          sourceProvider,
          transport: binding.transport ?? binding.kind,
          healthStatus: health.healthStatus,
          before: {
            healthStatus: binding.healthStatus,
          },
          after: {
            healthStatus: health.healthStatus,
          },
          checkScope: "configuration_and_recent_delivery_history",
        },
      },
    });
    return updated;
  });
}

export function evaluateChannelControlPlaneHealth(input: {
  kind: ManagedChannelKind;
  transport: ManagedChannelKind | null;
  sourceProvider: ManagedChannelKind | null;
  externalUserId: string | null;
  legacyStatus: string;
  currentHealthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  currentLastError: string | null;
  latestFailure: { status: string; lastError: string | null } | null;
}): {
  healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  lastError: string | null;
} {
  const legacyStatus = input.legacyStatus.trim().toUpperCase();
  if (!healthyLegacyStatuses.has(legacyStatus)) {
    return {
      healthStatus: ChannelHealthStatus.UNHEALTHY,
      lastError: `Legacy connection status is ${legacyStatus || "EMPTY"}.`,
    };
  }
  if (!input.transport || !input.sourceProvider) {
    return {
      healthStatus: ChannelHealthStatus.DEGRADED,
      lastError: "Transport or source-provider metadata is missing.",
    };
  }
  if (
    input.kind !== RepresentativeChannelKind.WEB
    && !input.externalUserId?.trim()
  ) {
    return {
      healthStatus: ChannelHealthStatus.DEGRADED,
      lastError: "External channel identity is not configured.",
    };
  }
  if (input.latestFailure) {
    return {
      healthStatus:
        input.latestFailure.status === "DEAD_LETTER"
          ? ChannelHealthStatus.UNHEALTHY
          : ChannelHealthStatus.DEGRADED,
      lastError:
        sanitizeChannelError(input.latestFailure.lastError)
        ?? `Recent ${input.latestFailure.status.toLowerCase()} delivery event.`,
    };
  }
  if (
    input.kind === RepresentativeChannelKind.MATRIX
    && (
      input.currentHealthStatus === ChannelHealthStatus.DEGRADED
      || input.currentHealthStatus === ChannelHealthStatus.UNHEALTHY
    )
    && input.currentLastError?.trim().toLowerCase().startsWith("matrix_")
  ) {
    // Matrix bridge runtime checks are stronger than this database-only
    // control-plane refresh. Only a later successful bridge registration,
    // room validation, or delivery may clear this protocol-level error.
    return {
      healthStatus: input.currentHealthStatus,
      lastError: sanitizeChannelError(input.currentLastError),
    };
  }

  // Reaching this branch means the control-plane refresh completed with valid
  // binding metadata and no failed ingress or egress inside the health window.
  // Do not carry a historical DEGRADED/UNHEALTHY state forward after the
  // failure that caused it has aged out.
  return {
    healthStatus: ChannelHealthStatus.HEALTHY,
    lastError: null,
  };
}

function indexLatestActivity(events: EventRecord[]) {
  const indexed = new Map<string, ChannelActivitySummary>();
  for (const event of events) {
    const representativeId = event.conversation?.representativeId;
    if (!representativeId) continue;
    const sourceProvider = event.sourceProvider ?? event.kind;
    const key = channelActivityKey(representativeId, sourceProvider);
    if (indexed.has(key)) continue;
    indexed.set(key, {
      id: event.id,
      eventType: event.eventType,
      status: event.status,
      occurredAt: event.createdAt.toISOString(),
      error: sanitizeChannelError(event.lastError),
    });
  }
  return indexed;
}

function channelActivityKey(
  representativeId: string,
  sourceProvider: ManagedChannelKind,
) {
  return `${representativeId}:${sourceProvider}`;
}

function sanitizeChannelError(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")
    .replace(
      /\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 240);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function assertTelegramAssignmentIdempotencyReplay(
  payloadValue: unknown,
  telegramBotConnectionId: string,
) {
  const payload = isJsonRecord(payloadValue) ? payloadValue : null;
  if (
    payload?.action !== "REPRESENTATIVE_TELEGRAM_BOT_ASSIGNED"
    || payload.telegramBotConnectionId !== telegramBotConnectionId
  ) {
    throw new ChannelManagementError(
      "Idempotency key was already used for a different Telegram Bot assignment on this representative.",
      409,
    );
  }
}

function requireValue(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new ChannelManagementError(`${label} is required.`, 400);
  }
  return normalized;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeMatrixUserIdOrNull(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  try {
    return normalizeMatrixUserId(value);
  } catch {
    return null;
  }
}

function matrixServerNameOrNull(value: string): string | null {
  try {
    return matrixServerNameFromUserId(value);
  } catch {
    return null;
  }
}

function assertDatabaseAvailable() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new ChannelManagementError(
      "Channel actions require a database connection.",
      503,
    );
  }
}

function resolveConfiguredTelegramBotIdentity(
  env: Readonly<Record<string, string | undefined>>,
) {
  const configuredId = env.TELEGRAM_BOT_ID?.trim();
  const tokenId = env.TELEGRAM_BOT_TOKEN?.trim().match(/^([1-9]\d*):/)?.[1];
  if (configuredId && tokenId && configuredId !== tokenId) {
    throw new ChannelManagementError(
      "TELEGRAM_BOT_ID must match the Bot token prefix.",
      503,
    );
  }
  const connectionId = configuredId || tokenId;
  if (!connectionId || !/^[1-9]\d*$/.test(connectionId)) {
    throw new ChannelManagementError(
      "TELEGRAM_BOT_ID must be configured before connecting Telegram channels.",
      503,
    );
  }

  const username = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || null;
  if (username && !/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new ChannelManagementError(
      "TELEGRAM_BOT_USERNAME is invalid.",
      503,
    );
  }
  return {
    connectionId,
    username,
    externalUserId: username ? `@${username}` : `telegram-bot:${connectionId}`,
  };
}

function resolveMatrixServerName() {
  const serverName = process.env.MATRIX_SERVER_NAME?.trim() || "";
  if (
    !serverName
    || !isValidMatrixServerName(serverName)
  ) {
    throw new ChannelManagementError(
      "MATRIX_SERVER_NAME must be configured before provisioning Matrix users.",
      503,
    );
  }
  return normalizeMatrixServerName(serverName);
}

function buildRepresentativeMatrixUserId(slug: string, serverName: string) {
  const localpart = `_delegate_rep_${slug.toLowerCase()}`
    .replace(/[^a-z0-9._=-]+/g, "_")
    .replace(/^_+/, "_")
    .slice(0, 180);
  return `@${localpart}:${serverName}`;
}
