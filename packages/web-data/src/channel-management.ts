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
import { resolveMatrixApplicationServiceConnectionId } from "./matrix-provisioning";

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
      generatedAt: now,
      dataSource: "demo-empty",
    });
  }

  const [representatives, ingressEvents, egressEvents] = await Promise.all([
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
  ]);

  return buildOwnerChannelManagementSnapshot({
    representatives: representatives as RepresentativeRecord[],
    ingressEvents: ingressEvents as EventRecord[],
    egressEvents: egressEvents.map((event) => ({
      ...event,
      kind: (event.sourceProvider ?? event.transport ?? "WEB") as ManagedChannelKind,
    })) as EventRecord[],
    generatedAt: now,
    dataSource: "database",
  });
}

export function buildOwnerChannelManagementSnapshot(input: {
  representatives: RepresentativeRecord[];
  ingressEvents: EventRecord[];
  egressEvents: EventRecord[];
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
        type: EventType.COMPUTE_POLICY_CHANGED,
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
        type: EventType.COMPUTE_POLICY_CHANGED,
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
        type: EventType.COMPUTE_POLICY_CHANGED,
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

function requireValue(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new ChannelManagementError(`${label} is required.`, 400);
  }
  return normalized;
}

function assertDatabaseAvailable() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new ChannelManagementError(
      "Channel actions require a database connection.",
      503,
    );
  }
}

function resolveMatrixServerName() {
  const serverName = process.env.MATRIX_SERVER_NAME?.trim().toLowerCase() || "";
  if (
    !serverName
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9]\d{0,4})?$/.test(
      serverName,
    )
  ) {
    throw new ChannelManagementError(
      "MATRIX_SERVER_NAME must be configured before provisioning Matrix users.",
      503,
    );
  }
  return serverName;
}

function buildRepresentativeMatrixUserId(slug: string, serverName: string) {
  const localpart = `_delegate_rep_${slug.toLowerCase()}`
    .replace(/[^a-z0-9._=-]+/g, "_")
    .replace(/^_+/, "_")
    .slice(0, 180);
  return `@${localpart}:${serverName}`;
}
