import { randomUUID } from "node:crypto";

import {
  buildGovernedContactChannelMemoryRootUri,
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedRepresentativeExperienceRootUri,
  buildGovernedRepresentativeExperienceVersionUri,
  buildOpenVikingAgentId,
  buildRepresentativeKnowledgeDocuments,
  buildRepresentativeKnowledgeRootUri,
  buildRepresentativeResourceRootUri,
  buildRepresentativeVersionResourceRootUri,
  OpenVikingClient,
  OpenVikingRequestError,
  resolveOpenVikingEnv,
  sanitizePublicSafeText,
  type OpenVikingCaptureMode,
  type OpenVikingDocumentSpec,
  type OpenVikingMatchedContext,
  type OpenVikingRecallItem,
} from "@delegate/openviking";
import { EventType, Prisma, type Representative } from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";

const REPRESENTATIVE_RESOURCE_SYNC_TIMEOUT_SECONDS = 300;
const OPENVIKING_MEMORY_DELETE_LEASE_MS = 60_000;
const OPENVIKING_MEMORY_DELETE_INITIAL_BACKOFF_MS = 30_000;
const OPENVIKING_MEMORY_DELETE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const OPENVIKING_SYNC_JOB_LEASE_MS =
  (REPRESENTATIVE_RESOURCE_SYNC_TIMEOUT_SECONDS + 30) * 1_000;
const OPENVIKING_SYNC_JOB_INITIAL_BACKOFF_MS = 5_000;
const OPENVIKING_SYNC_JOB_MAX_BACKOFF_MS = 5 * 60 * 1_000;
const OPENVIKING_SYNC_JOB_MAX_ATTEMPTS = 8;

export type RepresentativeOpenVikingSyncTrigger =
  | "manual"
  | "create"
  | "setup_update"
  | "publish"
  | "activate"
  | "retry";

export type OpenVikingSyncTickSummary = {
  processed: number;
  succeeded: number;
  retryScheduled: number;
  terminal: number;
};

export type OpenVikingMemoryDeletionTickSummary = {
  processed: number;
  deleted: number;
  failed: number;
  pending: number;
};

export type OpenVikingMaintenanceTickSummary = {
  sync: OpenVikingSyncTickSummary;
  memoryDeletion: OpenVikingMemoryDeletionTickSummary;
};

const representativeOpenVikingArgs = Prisma.validator<Prisma.RepresentativeDefaultArgs>()({
  include: {
    activeVersion: true,
  },
});

type RepresentativeOpenVikingRecord = Prisma.RepresentativeGetPayload<{
  include: typeof representativeOpenVikingArgs.include;
}>;

const openVikingConfigSchema = z.object({
  enabled: z.boolean(),
  autoRecall: z.boolean(),
  autoCapture: z.literal(false).optional().default(false),
  recallLimit: z.number().int().min(1).max(20),
  recallScoreThreshold: z.number().min(0).max(1),
}).strict();

const publishedKnowledgeDocumentSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string(),
  url: z.string().trim().optional(),
});

const publishedKnowledgeAssetPinSchema = z.object({
  assetId: z.string().trim().min(1),
  checksum: z.string().trim().min(1).nullable(),
  processingVersion: z.number().int().min(1),
});

const publishedRepresentativeSnapshotSchema = z.object({
  identity: z.object({
    displayName: z.string().trim().min(1),
    roleSummary: z.string(),
    tone: z.string(),
    languages: z.array(z.string()),
  }),
  publicMode: z.boolean(),
  humanInLoop: z.boolean(),
  groupActivation: z.string().trim().min(1),
  conversation: z.object({
    freeReplyLimit: z.number().int().min(0),
    freeScope: z.array(z.string()),
    paywalledIntents: z.array(z.string()),
    handoffWindowHours: z.number().int().min(0),
    handoffPrompt: z.string(),
  }),
  governance: z.object({
    allowedSkills: z.array(z.string()),
  }),
  knowledge: z.object({
    identitySummary: z.string(),
    faq: z.array(publishedKnowledgeDocumentSchema),
    materials: z.array(publishedKnowledgeDocumentSchema),
    policies: z.array(publishedKnowledgeDocumentSchema),
  }).nullable(),
  knowledgeAssets: z.array(publishedKnowledgeAssetPinSchema).default([]),
  pricing: z.array(z.object({
    tier: z.string(),
    name: z.string(),
    stars: z.number().int().min(0),
    summary: z.string(),
    includedReplies: z.number().int().min(0),
    includesPriorityHandoff: z.boolean(),
  })),
});

export type RepresentativeOpenVikingConfigInput = z.input<typeof openVikingConfigSchema>;

export type RepresentativeOpenVikingSnapshot = {
  representativeSlug: string;
  enabled: boolean;
  agentId: string;
  agentIdOverride?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  captureMode: OpenVikingCaptureMode;
  recallLimit: number;
  recallScoreThreshold: number;
  targetUri: string;
  resourceSyncEnabled: boolean;
  modelCredentialsAvailable: boolean;
  lastSyncAt?: string;
  lastSyncStatus: string;
  lastSyncItemCount: number;
  lastSyncError?: string;
  health: {
    status: "healthy" | "degraded" | "disabled";
    detail: string;
    mode: "local" | "remote";
    baseUrl: string;
    consoleUrl?: string;
  };
  recentSyncJobs: Array<{
    id: string;
    status: string;
    itemCount: number;
    error?: string;
    startedAt: string;
    finishedAt?: string;
  }>;
  recentCommitTraces: Array<{
    id: string;
    sessionId: string;
    sessionKey?: string;
    reason: string;
    status: string;
    memoriesExtracted?: number;
    createdAt: string;
    error?: string;
  }>;
};

export type RepresentativeOpenVikingMemoryPreview = {
  id: string;
  uri: string;
  scope: string;
  category: string;
  summary: string;
  sourceKind: string;
  status: "ACTIVE" | "SUPPRESSED" | "DELETE_PENDING" | "DELETED" | "DELETE_FAILED";
  suppressedAt?: string;
  deletedAt?: string;
  lastDeleteAttemptAt?: string;
  deletionAttemptCount: number;
  deletionError?: string;
  createdAt: string;
  contact?: {
    id: string;
    displayName: string;
  };
};

export type RepresentativeOpenVikingOverviewMetrics = {
  resourcesSynced: number;
  memoriesCapturedToday: number;
  sessionsCommittedToday: number;
  recallsUsedToday: number;
  syncFailures: number;
  lastHealthCheckResult: string;
};

export async function getOpenVikingHealthSnapshot(): Promise<RepresentativeOpenVikingSnapshot["health"]> {
  const env = resolveOpenVikingEnv();
  if (!env.enabled) {
    return {
      status: "disabled",
      detail: "OpenViking is disabled in this environment.",
      mode: env.mode,
      baseUrl: env.baseUrl,
      ...(env.consoleUrl ? { consoleUrl: env.consoleUrl } : {}),
    };
  }

  try {
    const client = new OpenVikingClient({
      baseUrl: env.baseUrl,
      ...(env.apiKey ? { apiKey: env.apiKey } : {}),
      timeoutMs: env.timeoutMs,
      accountId: "delegate",
      userId: "owner-dashboard",
      agentId: "delegate-dashboard",
    });
    await client.health();

    return {
      status: "healthy",
      detail: env.hasModelCredentials
        ? "OpenViking API is reachable."
        : "OpenViking API is reachable, but model credentials are not configured yet.",
      mode: env.mode,
      baseUrl: env.baseUrl,
      ...(env.consoleUrl ? { consoleUrl: env.consoleUrl } : {}),
    };
  } catch (error) {
    return {
      status: "degraded",
      detail:
        error instanceof Error ? error.message : "OpenViking health check failed.",
      mode: env.mode,
      baseUrl: env.baseUrl,
      ...(env.consoleUrl ? { consoleUrl: env.consoleUrl } : {}),
    };
  }
}

export async function getRepresentativeOpenVikingSnapshot(
  representativeSlug: string,
): Promise<RepresentativeOpenVikingSnapshot | null> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    ...representativeOpenVikingArgs,
  });

  if (!representative) {
    return null;
  }

  const [health, recentSyncJobs, recentCommitTraces] = await Promise.all([
    getOpenVikingHealthSnapshot(),
    prisma.representativeContextSync.findMany({
      where: { representativeId: representative.id },
      orderBy: [{ createdAt: "desc" }],
      take: 6,
    }),
    prisma.conversationCommitTrace.findMany({
      where: { representativeId: representative.id },
      orderBy: [{ createdAt: "desc" }],
      take: 6,
    }),
  ]);

  const defaults = resolveRepresentativeDefaults(representative);
  const env = resolveOpenVikingEnv();

  return {
    representativeSlug: representative.slug,
    enabled: representative.openvikingEnabled,
    agentId: defaults.agentId,
    ...(representative.openvikingAgentId ? { agentIdOverride: representative.openvikingAgentId } : {}),
    autoRecall: representative.openvikingAutoRecall,
    autoCapture: false,
    captureMode: representative.openvikingCaptureMode as OpenVikingCaptureMode,
    recallLimit: representative.openvikingRecallLimit,
    recallScoreThreshold: representative.openvikingRecallScoreThreshold,
    targetUri: defaults.targetUri,
    resourceSyncEnabled: env.resourceSyncEnabled,
    modelCredentialsAvailable: env.hasModelCredentials,
    ...(representative.openvikingLastSyncAt
      ? { lastSyncAt: representative.openvikingLastSyncAt.toISOString() }
      : {}),
    lastSyncStatus: representative.openvikingLastSyncStatus ?? "idle",
    lastSyncItemCount: representative.openvikingLastSyncItemCount ?? 0,
    ...(representative.openvikingLastSyncError
      ? { lastSyncError: representative.openvikingLastSyncError }
      : {}),
    health,
    recentSyncJobs: recentSyncJobs.map((job) => ({
      id: job.id,
      status: job.status,
      itemCount: job.itemCount,
      ...(job.error ? { error: job.error } : {}),
      startedAt: job.startedAt.toISOString(),
      ...(job.finishedAt ? { finishedAt: job.finishedAt.toISOString() } : {}),
    })),
    recentCommitTraces: recentCommitTraces.map((trace) => ({
      id: trace.id,
      sessionId: trace.sessionId,
      ...(trace.sessionKey ? { sessionKey: trace.sessionKey } : {}),
      reason: trace.reason,
      status: trace.status,
      ...(typeof trace.memoriesExtracted === "number"
        ? { memoriesExtracted: trace.memoriesExtracted }
        : {}),
      createdAt: trace.createdAt.toISOString(),
      ...(trace.error ? { error: trace.error } : {}),
    })),
  };
}

export async function updateRepresentativeOpenVikingConfig(params: {
  representativeSlug: string;
  input: RepresentativeOpenVikingConfigInput;
  ownerId?: string;
}): Promise<RepresentativeOpenVikingSnapshot> {
  const input = openVikingConfigSchema.parse(params.input);

  const representative = await prisma.representative.findUnique({
    where: { slug: params.representativeSlug },
    select: {
      id: true,
      slug: true,
      activeVersionId: true,
      openvikingEnabled: true,
      openvikingAutoRecall: true,
      openvikingAutoCapture: true,
      openvikingRecallLimit: true,
      openvikingRecallScoreThreshold: true,
      openvikingTargetUri: true,
      ownerId: true,
    },
  });

  if (!representative) {
    throw new Error(`Representative "${params.representativeSlug}" not found.`);
  }

  const targetUri = representative.activeVersionId
    ? buildRepresentativeVersionResourceRootUri(
        representative.slug,
        representative.activeVersionId,
      )
    : null;
  const fieldNames = [
    ...(representative.openvikingEnabled !== input.enabled ? ["enabled"] : []),
    ...(representative.openvikingAutoRecall !== input.autoRecall ? ["autoRecall"] : []),
    ...(representative.openvikingAutoCapture ? ["autoCapture"] : []),
    ...(representative.openvikingRecallLimit !== input.recallLimit ? ["recallLimit"] : []),
    ...(representative.openvikingRecallScoreThreshold !== input.recallScoreThreshold
      ? ["recallScoreThreshold"]
      : []),
    ...(representative.openvikingTargetUri !== targetUri ? ["targetUri"] : []),
  ];

  await prisma.$transaction([
    prisma.representative.update({
      where: { id: representative.id },
      data: {
        openvikingEnabled: input.enabled,
        openvikingAutoRecall: input.autoRecall,
        openvikingAutoCapture: false,
        openvikingRecallLimit: input.recallLimit,
        openvikingRecallScoreThreshold: input.recallScoreThreshold,
        openvikingTargetUri: targetUri,
      },
    }),
    prisma.eventAudit.create({
      data: {
        ...(params.ownerId === representative.ownerId
          ? { ownerId: representative.ownerId }
          : {}),
        representativeId: representative.id,
        type: EventType.OPENVIKING_CONFIG_CHANGED,
        payload: {
          status: fieldNames.length ? "updated" : "no_change",
          fieldNames,
        },
      },
    }),
  ]);

  const snapshot = await getRepresentativeOpenVikingSnapshot(params.representativeSlug);
  if (!snapshot) {
    throw new Error("Representative disappeared after updating OpenViking config.");
  }

  return snapshot;
}

export async function syncRepresentativeOpenVikingResources(params: {
  representativeSlug: string;
  trigger: RepresentativeOpenVikingSyncTrigger;
  ownerId?: string;
}): Promise<RepresentativeOpenVikingSnapshot> {
  const syncJob = await enqueueRepresentativeOpenVikingSync({
    representativeSlug: params.representativeSlug,
    trigger: params.trigger,
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
  });
  await processRepresentativeOpenVikingSyncJob({
    jobId: syncJob.id,
  });

  const snapshot = await getRepresentativeOpenVikingSnapshot(params.representativeSlug);
  if (!snapshot) {
    throw new Error("Representative disappeared after OpenViking sync.");
  }
  return snapshot;
}

export async function enqueueRepresentativeOpenVikingSync(params: {
  representativeSlug: string;
  requestedVersionId?: string | null;
  trigger: RepresentativeOpenVikingSyncTrigger;
  ownerId?: string;
}) {
  const representative = await prisma.representative.findUnique({
    where: { slug: params.representativeSlug },
    select: {
      id: true,
      ownerId: true,
      activeVersionId: true,
    },
  });

  if (!representative) {
    throw new Error(`Representative "${params.representativeSlug}" not found.`);
  }

  const requestedVersionId =
    params.requestedVersionId === undefined
      ? representative.activeVersionId
      : params.requestedVersionId;
  const requestedByOwnerId =
    params.ownerId === representative.ownerId ? representative.ownerId : null;
  const queuedAt = new Date();

  return prisma.$transaction(async (tx) => {
    const syncJob = await tx.representativeContextSync.create({
      data: {
        representativeId: representative.id,
        requestedVersionId,
        trigger: params.trigger,
        requestedByOwnerId,
        status: "queued",
        itemCount: 0,
        attemptCount: 0,
        availableAt: queuedAt,
        startedAt: queuedAt,
      },
    });
    await tx.representative.updateMany({
      where: {
        id: representative.id,
        activeVersionId: requestedVersionId,
      },
      data: {
        openvikingLastSyncJobId: syncJob.id,
        openvikingLastSyncStatus: "queued",
        openvikingLastSyncError: null,
      },
    });
    return syncJob;
  });
}

export async function processRepresentativeOpenVikingSyncJob(params: {
  jobId: string;
  now?: Date;
  leaseMs?: number;
  syncDocument?: typeof syncDocumentToOpenViking;
}): Promise<{ processed: boolean; status?: string }> {
  const now = params.now ?? new Date();
  const leaseMs = params.leaseMs ?? OPENVIKING_SYNC_JOB_LEASE_MS;
  const claimed = await claimRepresentativeOpenVikingSyncJob({
    jobId: params.jobId,
    now,
    leaseMs,
  });
  if (!claimed) {
    return { processed: false };
  }

  const { job, leaseToken } = claimed;
  const representative = job.representative;
  const env = resolveOpenVikingEnv();
  const syncDisabledReason = resolveSyncDisabledReason(representative, env);

  if (syncDisabledReason) {
    const settled = await settleRepresentativeOpenVikingSyncJob({
      job,
      leaseToken,
      status: "disabled",
      itemCount: 0,
      error: syncDisabledReason,
      now,
    });
    return settled
      ? { processed: true, status: "disabled" }
      : { processed: false };
  }

  const requestedVersion = job.requestedVersionId
    ? await prisma.representativeVersion.findFirst({
        where: {
          id: job.requestedVersionId,
          representativeId: representative.id,
        },
      })
    : null;
  const publishedSnapshot =
    requestedVersion?.status === "PUBLISHED"
      ? publishedRepresentativeSnapshotSchema.safeParse(
          requestedVersion.snapshot,
        )
      : null;

  if (!requestedVersion || !publishedSnapshot?.success) {
    const blockedReason =
      "OpenViking sync requires a valid published RepresentativeVersion snapshot.";
    const settled = await settleRepresentativeOpenVikingSyncJob({
      job,
      leaseToken,
      status: "blocked_unpublished",
      itemCount: 0,
      error: blockedReason,
      now,
    });
    return settled
      ? { processed: true, status: "blocked_unpublished" }
      : { processed: false };
  }

  if (!env.hasModelCredentials) {
    const blockedReason =
      "OpenViking model credentials are not configured for this environment.";
    const settled = await settleRepresentativeOpenVikingSyncJob({
      job,
      leaseToken,
      status: "blocked_missing_credentials",
      itemCount: 0,
      error: blockedReason,
      now,
    });
    return settled
      ? { processed: true, status: "blocked_missing_credentials" }
      : { processed: false };
  }

  const defaults = resolveRepresentativeDefaults(representative);
  const client = buildRepresentativeClient(representative);
  const runtime = publishedSnapshot.data;
  const versionResourceRoot = buildRepresentativeVersionResourceRootUri(
    representative.slug,
    requestedVersion.id,
  );
  const knowledge = runtime.knowledge ?? {
    identitySummary: "",
    faq: [],
    materials: [],
    policies: [],
  };
  const documents = buildRepresentativeKnowledgeDocuments({
    slug: representative.slug,
    representativeVersionId: requestedVersion.id,
    name: runtime.identity.displayName,
    tagline: runtime.identity.roleSummary,
    tone: runtime.identity.tone,
    languages: runtime.identity.languages,
    groupActivation: runtime.groupActivation,
    publicMode: runtime.publicMode,
    humanInLoop: runtime.humanInLoop,
    freeReplyLimit: runtime.conversation.freeReplyLimit,
    freeScope: runtime.conversation.freeScope,
    paywalledIntents: runtime.conversation.paywalledIntents,
    handoffWindowHours: runtime.conversation.handoffWindowHours,
    skills: runtime.governance.allowedSkills,
    knowledgePack: {
      identitySummary: knowledge.identitySummary,
      faq: normalizePublishedKnowledgeDocuments(knowledge.faq),
      materials: normalizePublishedKnowledgeDocuments(knowledge.materials),
      policies: normalizePublishedKnowledgeDocuments(knowledge.policies),
    },
    pricing: runtime.pricing,
    handoffPrompt: runtime.conversation.handoffPrompt,
  });

  try {
    for (const document of documents) {
      const leaseRenewed = await renewRepresentativeOpenVikingSyncJobLease({
        jobId: job.id,
        leaseToken,
        leaseMs,
      });
      if (!leaseRenewed) {
        throw new Error("OpenViking sync job lease was lost.");
      }
      await (params.syncDocument ?? syncDocumentToOpenViking)({
        client,
        representativeSlug: representative.slug,
        document,
      });
    }

    const settled = await settleRepresentativeOpenVikingSyncJob({
      job,
      leaseToken,
      status: "succeeded",
      itemCount: documents.length,
      error: null,
      now: new Date(),
      targetUri: versionResourceRoot,
      agentId: representative.openvikingAgentId ?? defaults.agentId,
    });
    return settled
      ? { processed: true, status: "succeeded" }
      : { processed: false };
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : "OpenViking sync failed."
    ).slice(0, 2_000);
    if (job.attemptCount < OPENVIKING_SYNC_JOB_MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(
        Date.now() + openVikingSyncBackoffMs(job.attemptCount),
      );
      const settled = await settleRepresentativeOpenVikingSyncJob({
        job,
        leaseToken,
        status: "retry_wait",
        itemCount: 0,
        error: message,
        now: new Date(),
        nextAttemptAt,
      });
      return settled
        ? { processed: true, status: "retry_wait" }
        : { processed: false };
    }
    const settled = await settleRepresentativeOpenVikingSyncJob({
      job,
      leaseToken,
      status: "failed",
      itemCount: 0,
      error: message,
      now: new Date(),
    });
    return settled
      ? { processed: true, status: "failed" }
      : { processed: false };
  }
}

export async function maybeSyncRepresentativeOpenVikingResources(params: {
  representativeSlug: string;
  trigger: Exclude<RepresentativeOpenVikingSyncTrigger, "manual" | "retry">;
  ownerId?: string;
}): Promise<void> {
  const representative = await prisma.representative.findUnique({
    where: { slug: params.representativeSlug },
    select: { openvikingEnabled: true },
  });
  if (
    !representative?.openvikingEnabled
    || !resolveOpenVikingEnv().resourceSyncEnabled
  ) {
    return;
  }
  await enqueueRepresentativeOpenVikingSync({
    representativeSlug: params.representativeSlug,
    trigger: params.trigger,
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
  });
}

export async function runRepresentativeOpenVikingSyncJobsTick(options?: {
  limit?: number;
  now?: Date;
  processJob?: typeof processRepresentativeOpenVikingSyncJob;
}): Promise<OpenVikingSyncTickSummary> {
  const now = options?.now ?? new Date();
  const jobs = await prisma.representativeContextSync.findMany({
    where: {
      status: {
        in: ["queued", "retry_wait", "running"],
      },
      availableAt: {
        lte: now,
      },
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lte: now } },
      ],
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, Math.min(options?.limit ?? 4, 50)),
    select: { id: true },
  });
  const summary: OpenVikingSyncTickSummary = {
    processed: 0,
    succeeded: 0,
    retryScheduled: 0,
    terminal: 0,
  };

  for (const job of jobs) {
    const result = await (options?.processJob ?? processRepresentativeOpenVikingSyncJob)({
      jobId: job.id,
      now,
    });
    if (!result.processed) continue;
    summary.processed += 1;
    if (result.status === "succeeded") summary.succeeded += 1;
    else if (result.status === "retry_wait") summary.retryScheduled += 1;
    else summary.terminal += 1;
  }
  return summary;
}

export async function runOpenVikingMaintenanceTick(options?: {
  syncLimit?: number;
  memoryDeletionLimit?: number;
  now?: Date;
}): Promise<OpenVikingMaintenanceTickSummary> {
  const now = options?.now ?? new Date();
  const [sync, memoryDeletion] = await Promise.all([
    runRepresentativeOpenVikingSyncJobsTick({
      ...(options?.syncLimit === undefined
        ? {}
        : { limit: options.syncLimit }),
      now,
    }),
    runOpenVikingMemoryDeletionRecoveryTick({
      ...(options?.memoryDeletionLimit === undefined
        ? {}
        : { limit: options.memoryDeletionLimit }),
      now,
    }),
  ]);
  return { sync, memoryDeletion };
}

async function claimRepresentativeOpenVikingSyncJob(params: {
  jobId: string;
  now: Date;
  leaseMs: number;
}) {
  const candidate = await prisma.representativeContextSync.findUnique({
    where: { id: params.jobId },
    select: {
      id: true,
      status: true,
      attemptCount: true,
      availableAt: true,
      leaseExpiresAt: true,
    },
  });
  if (
    !candidate
    || !["queued", "retry_wait", "running"].includes(candidate.status)
    || candidate.availableAt.getTime() > params.now.getTime()
    || (
      candidate.leaseExpiresAt
      && candidate.leaseExpiresAt.getTime() > params.now.getTime()
    )
  ) {
    return null;
  }

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(params.now.getTime() + params.leaseMs);
  const claimed = await prisma.representativeContextSync.updateMany({
    where: {
      id: candidate.id,
      status: {
        in: ["queued", "retry_wait", "running"],
      },
      attemptCount: candidate.attemptCount,
      availableAt: {
        lte: params.now,
      },
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lte: params.now } },
      ],
    },
    data: {
      status: "running",
      attemptCount: { increment: 1 },
      leaseToken,
      leaseExpiresAt,
      startedAt: params.now,
      finishedAt: null,
      error: null,
    },
  });
  if (!claimed.count) {
    return null;
  }

  const job = await loadRepresentativeOpenVikingSyncJob(candidate.id);
  if (!job) {
    return null;
  }
  await prisma.representative.updateMany({
    where: {
      id: job.representativeId,
      activeVersionId: job.requestedVersionId,
      openvikingLastSyncJobId: job.id,
    },
    data: {
      openvikingLastSyncStatus: "running",
      openvikingLastSyncError: null,
    },
  });
  return { job, leaseToken };
}

async function loadRepresentativeOpenVikingSyncJob(jobId: string) {
  return prisma.representativeContextSync.findUnique({
    where: { id: jobId },
    include: {
      representative: true,
    },
  });
}

async function renewRepresentativeOpenVikingSyncJobLease(params: {
  jobId: string;
  leaseToken: string;
  leaseMs: number;
}): Promise<boolean> {
  const renewed = await prisma.representativeContextSync.updateMany({
    where: {
      id: params.jobId,
      status: "running",
      leaseToken: params.leaseToken,
      leaseExpiresAt: { gt: new Date() },
    },
    data: {
      leaseExpiresAt: new Date(Date.now() + params.leaseMs),
    },
  });
  return renewed.count === 1;
}

type ClaimedRepresentativeOpenVikingSyncJob = NonNullable<
  Awaited<ReturnType<typeof loadRepresentativeOpenVikingSyncJob>>
>;

async function settleRepresentativeOpenVikingSyncJob(params: {
  job: ClaimedRepresentativeOpenVikingSyncJob;
  leaseToken: string;
  status:
    | "succeeded"
    | "retry_wait"
    | "failed"
    | "disabled"
    | "blocked_unpublished"
    | "blocked_missing_credentials";
  itemCount: number;
  error: string | null;
  now: Date;
  nextAttemptAt?: Date;
  targetUri?: string;
  agentId?: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const retryScheduled = params.status === "retry_wait";
    const jobUpdated = await tx.representativeContextSync.updateMany({
      where: {
        id: params.job.id,
        status: "running",
        leaseToken: params.leaseToken,
      },
      data: {
        status: params.status,
        itemCount: params.itemCount,
        error: params.error,
        availableAt: params.nextAttemptAt ?? params.now,
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: retryScheduled ? null : params.now,
      },
    });
    if (!jobUpdated.count) {
      return false;
    }

    const aggregateStatus = retryScheduled ? "pending" : params.status;
    const aggregateUpdated = await tx.representative.updateMany({
      where: {
        id: params.job.representativeId,
        activeVersionId: params.job.requestedVersionId,
        openvikingLastSyncJobId: params.job.id,
      },
      data: {
        ...(params.agentId ? { openvikingAgentId: params.agentId } : {}),
        ...(params.targetUri ? { openvikingTargetUri: params.targetUri } : {}),
        openvikingLastSyncAt: params.now,
        openvikingLastSyncStatus: aggregateStatus,
        openvikingLastSyncError: params.error,
        openvikingLastSyncItemCount: params.itemCount,
      },
    });
    const auditOwnerId =
      params.job.requestedByOwnerId === params.job.representative.ownerId
        ? params.job.representative.ownerId
        : undefined;
    await tx.eventAudit.create({
      data: {
        ...(auditOwnerId ? { ownerId: auditOwnerId } : {}),
        representativeId: params.job.representativeId,
        type: EventType.OPENVIKING_RESOURCE_SYNC_COMPLETED,
        payload: {
          syncJobId: params.job.id,
          status: retryScheduled ? "retry_scheduled" : params.status,
          trigger: params.job.trigger ?? "unknown",
          ...(params.job.requestedVersionId
            ? { versionId: params.job.requestedVersionId }
            : {}),
          attemptCount: params.job.attemptCount,
          aggregateUpdated: aggregateUpdated.count === 1,
          ...(params.nextAttemptAt
            ? { nextAttemptAt: params.nextAttemptAt.toISOString() }
            : {}),
        },
      },
    });
    return true;
  });
}

function openVikingSyncBackoffMs(attemptCount: number): number {
  return Math.min(
    OPENVIKING_SYNC_JOB_INITIAL_BACKOFF_MS * (2 ** Math.max(0, attemptCount - 1)),
    OPENVIKING_SYNC_JOB_MAX_BACKOFF_MS,
  );
}

function openVikingMemoryDeleteBackoffMs(attemptCount: number): number {
  return Math.min(
    OPENVIKING_MEMORY_DELETE_INITIAL_BACKOFF_MS
      * (2 ** Math.max(0, attemptCount - 1)),
    OPENVIKING_MEMORY_DELETE_MAX_BACKOFF_MS,
  );
}

export type RepresentativeRecallSourceKind =
  | "PUBLIC_KNOWLEDGE"
  | "CONTACT_MEMORY"
  | "REPRESENTATIVE_EXPERIENCE";

/**
 * Server-only authorization metadata. Public citation DTOs deliberately do
 * not include these identifiers or any OpenViking diagnostics.
 */
export type RepresentativeRecallItem = OpenVikingRecallItem & {
  internalSource: {
    sourceKind: RepresentativeRecallSourceKind;
    contentHash?: string;
    memoryVersionId?: string;
    projectionItemId?: string;
  };
};

export type RepresentativeRecallContext = {
  items: RepresentativeRecallItem[];
  citations: Array<{
    knowledgeAssetId?: string;
    title: string;
    excerpt?: string;
    score: number;
  }>;
};

type RecallSourceChannel = "web" | "matrix" | "telegram";

type GovernedMemoryRecallGrant = {
  uri: string;
  sourceKind: Exclude<RepresentativeRecallSourceKind, "PUBLIC_KNOWLEDGE">;
  memoryVersionId: string;
  projectionItemId: string;
  contentHash: string;
  safeText: string;
  summary: string;
};

type RepresentativeRecallAuthorization = {
  publishedVersionRoot?: string;
  knowledgeRoot?: string;
  allowedAssetIds: Set<string>;
  memoryRoots: string[];
  memoryGrantsByUri: Map<string, GovernedMemoryRecallGrant>;
  memorySearchConfig?: {
    limit: number;
    scoreThreshold: number;
  };
};

type AuthorizedRecallSource =
  | { sourceKind: "PUBLIC_KNOWLEDGE" }
  | GovernedMemoryRecallGrant;

type AuthorizedRemoteRecallCandidate = {
  item: OpenVikingMatchedContext;
  source: AuthorizedRecallSource;
};

const REPRESENTATIVE_RECALL_SOURCE_KINDS = [
  "PUBLIC_KNOWLEDGE",
  "CONTACT_MEMORY",
  "REPRESENTATIVE_EXPERIENCE",
] as const satisfies readonly RepresentativeRecallSourceKind[];

/**
 * Recall only the public representative resources plus memory scopes that are
 * safe for the current contact. The returned URIs are retained internally for
 * traceability, while public citations intentionally omit OpenViking URIs.
 */
export async function recallRepresentativeContext(params: {
  representativeSlug: string;
  conversationId: string;
  contactId: string;
  sourceChannel: RecallSourceChannel;
  queryText: string;
  allowedSourceKinds?: readonly RepresentativeRecallSourceKind[];
}): Promise<RepresentativeRecallContext> {
  const queryText = params.queryText.trim();
  if (!queryText || !isRecallSourceChannel(params.sourceChannel)) {
    return { items: [], citations: [] };
  }
  const allowedSourceKinds = normalizeRecallSourceKinds(params.allowedSourceKinds);
  if (!allowedSourceKinds.size) return { items: [], citations: [] };

  const conversation = await prisma.conversation.findFirst({
    where: {
      id: params.conversationId,
      contactId: params.contactId,
      sourceChannel: params.sourceChannel,
      representative: {
        slug: params.representativeSlug,
      },
    },
    select: {
      id: true,
      activeEpisodeId: true,
      representative: {
        select: {
          id: true,
          slug: true,
          lifecycleState: true,
          openvikingEnabled: true,
          openvikingAutoRecall: true,
          openvikingAgentId: true,
          openvikingRecallLimit: true,
          openvikingRecallScoreThreshold: true,
          knowledgeAssetLinks: {
            select: {
              assetId: true,
              enabled: true,
              reviewStatus: true,
              asset: {
                select: {
                  status: true,
                  archivedAt: true,
                  checksum: true,
                  processingVersion: true,
                },
              },
            },
          },
        },
      },
    },
  });
  const representative = conversation?.representative;
  const env = resolveOpenVikingEnv();
  if (
    !conversation?.activeEpisodeId ||
    !representative?.openvikingEnabled ||
    !representative.openvikingAutoRecall ||
    representative.lifecycleState !== "PUBLISHED" ||
    !env.enabled ||
    !env.hasModelCredentials
  ) {
    return { items: [], citations: [] };
  }

  const episode = await prisma.conversationEpisode.findFirst({
    where: {
      id: conversation.activeEpisodeId,
      conversationId: conversation.id,
    },
    select: {
      representativeVersion: {
        select: {
          id: true,
          representativeId: true,
          status: true,
          snapshot: true,
        },
      },
    },
  });
  const pinnedVersion = episode?.representativeVersion;
  const pinnedSnapshot = pinnedVersion
    ? publishedRepresentativeSnapshotSchema.safeParse(pinnedVersion.snapshot)
    : null;
  if (
    !pinnedVersion ||
    pinnedVersion.representativeId !== representative.id ||
    pinnedVersion.status !== "PUBLISHED" ||
    !pinnedSnapshot?.success
  ) {
    return { items: [], citations: [] };
  }

  const allowedAssetIds = allowedSourceKinds.has("PUBLIC_KNOWLEDGE")
    ? resolveAllowedPublishedKnowledgeAssetIds({
        pins: pinnedSnapshot.data.knowledgeAssets,
        currentLinks: representative.knowledgeAssetLinks,
      })
    : new Set<string>();
  const memoryAuthorization = await loadGovernedMemoryRecallAuthorization({
    representativeId: representative.id,
    contactId: params.contactId,
    sourceChannel: params.sourceChannel,
    allowedSourceKinds,
  });
  const authorization: RepresentativeRecallAuthorization = {
    ...(allowedSourceKinds.has("PUBLIC_KNOWLEDGE")
      ? {
          publishedVersionRoot: buildRepresentativeVersionResourceRootUri(
            representative.slug,
            pinnedVersion.id,
          ),
          knowledgeRoot: buildRepresentativeKnowledgeRootUri(representative.slug),
        }
      : {}),
    allowedAssetIds,
    memoryRoots: memoryAuthorization.memoryRoots,
    memoryGrantsByUri: memoryAuthorization.memoryGrantsByUri,
    ...(memoryAuthorization.memorySearchConfig
      ? { memorySearchConfig: memoryAuthorization.memorySearchConfig }
      : {}),
  };
  const client = buildRepresentativeClient(representative);
  const publicSearchConfig = {
    limit: representative.openvikingRecallLimit,
    scoreThreshold: representative.openvikingRecallScoreThreshold,
  };
  const searchTargets = [
    ...uniqueRecallRoots([
      authorization.publishedVersionRoot,
      authorization.knowledgeRoot,
    ]).map((targetUri) => ({
      targetUri,
      lane: "PUBLIC_KNOWLEDGE" as const,
      ...publicSearchConfig,
    })),
    ...(authorization.memorySearchConfig
      ? authorization.memoryRoots.map((targetUri) => ({
          targetUri,
          lane: "GOVERNED_MEMORY" as const,
          ...authorization.memorySearchConfig!,
        }))
      : []),
  ];
  if (!searchTargets.length) return { items: [], citations: [] };
  const searchResults = await Promise.allSettled(
    searchTargets.map((target) => client.search({
      query: queryText,
      targetUri: target.targetUri,
      limit: target.limit,
      scoreThreshold: target.scoreThreshold,
    })),
  );
  const candidates = searchResults.flatMap((result, targetIndex) => {
    if (result.status !== "fulfilled") return [];
    const target = searchTargets[targetIndex];
    if (!target) return [];
    return ([
      ...result.value.resources,
      ...result.value.memories,
    ]).map((item) => ({ item, target }));
  })
    .flatMap(({ item, target }) => {
      const source = authorizeRecallUri(item.uri, authorization);
      if (!source || (item.score ?? 0) < target.scoreThreshold) return [];
      const sourceIsPublic = source.sourceKind === "PUBLIC_KNOWLEDGE";
      if (
        (target.lane === "PUBLIC_KNOWLEDGE" && !sourceIsPublic)
        || (target.lane === "GOVERNED_MEMORY" && sourceIsPublic)
      ) {
        return [];
      }
      return [{ item, source }];
    })
    .filter(({ item }) => !/\/(?:\.overview|\.abstract)\.md$/i.test(item.uri));
  const selected = [
    ...rankAuthorizedRecallCandidates(
      candidates.filter(({ source }) => source.sourceKind === "PUBLIC_KNOWLEDGE"),
      publicSearchConfig,
    ),
    ...rankAuthorizedRecallCandidates(
      candidates.filter(({ source }) => source.sourceKind !== "PUBLIC_KNOWLEDGE"),
      authorization.memorySearchConfig ?? { limit: 0, scoreThreshold: 1 },
    ),
  ].sort((left, right) => (right.item.score ?? 0) - (left.item.score ?? 0));
  const hydrated = await Promise.all(selected.map(async ({ item, source }) => {
    if (source.sourceKind !== "PUBLIC_KNOWLEDGE") {
      return hydrateGovernedMemoryRecall(item, source);
    }

    const content = await client.read(item.uri, 100).catch(() => "");
    const abstract = sanitizePublicSafeText(item.abstract || "", 800) ?? "";
    const safeContent = sanitizePublicSafeText(content, 4_000) ?? "";
    const score = item.score ?? 0;
    return {
      item: {
        uri: item.uri,
        contextType: item.context_type,
        layer: safeContent ? ("L2" as const) : ("L0" as const),
        score,
        abstract,
        ...(safeContent ? { content: safeContent } : {}),
        internalSource: { sourceKind: "PUBLIC_KNOWLEDGE" },
      } satisfies RepresentativeRecallItem,
      citation: {
        ...resolveKnowledgeAssetId(item.uri),
        title: resolveRecallTitle(content, item.uri),
        ...(abstract || safeContent ? { excerpt: (abstract || safeContent).slice(0, 480) } : {}),
        score,
      },
    };
  }));

  const revalidatedAuthorization = await revalidateRepresentativeRecallAuthorization({
    representativeSlug: params.representativeSlug,
    conversationId: params.conversationId,
    contactId: params.contactId,
    activeEpisodeId: conversation.activeEpisodeId,
    representativeVersionId: pinnedVersion.id,
    knowledgeAssetPins: pinnedSnapshot.data.knowledgeAssets,
    sourceChannel: params.sourceChannel,
    allowedSourceKinds,
  });
  const revalidatedHydrated = revalidatedAuthorization
    ? hydrated.flatMap(({ item, citation }) => {
        const revalidatedSource = authorizeRecallUri(item.uri, revalidatedAuthorization);
        if (!revalidatedSource) return [];
        if (revalidatedSource.sourceKind === "PUBLIC_KNOWLEDGE") {
          return item.internalSource.sourceKind === "PUBLIC_KNOWLEDGE"
            ? [{ item, citation }]
            : [];
        }
        return [hydrateGovernedMemoryRecall(item, revalidatedSource)];
      })
    : [];
  const authorizedHydrated = [
    ...revalidatedHydrated.filter(
      ({ item }) => item.internalSource.sourceKind === "PUBLIC_KNOWLEDGE",
    ),
    ...(revalidatedAuthorization?.memorySearchConfig
      ? rankHydratedRecallResults(
          revalidatedHydrated.filter(
            ({ item }) => item.internalSource.sourceKind !== "PUBLIC_KNOWLEDGE",
          ),
          revalidatedAuthorization.memorySearchConfig,
        )
      : []),
  ].sort((left, right) => right.item.score - left.item.score);

  if (authorizedHydrated.length) {
    try {
      await prisma.conversationRecallTrace.createMany({
        data: authorizedHydrated.map(({ item }) => ({
          representativeId: representative.id,
          conversationId: params.conversationId,
          contactId: params.contactId,
          queryText,
          recalledUri: item.uri,
          contextType: item.contextType,
          layer: item.layer,
          score: item.score,
        })),
      });
    } catch {
      // Diagnostics are best-effort and must not turn an already-authorized
      // answer into an availability failure. Do not log query text or URIs.
      console.warn("Recall diagnostics persistence failed; authorized context will continue.");
    }
  }

  return {
    items: authorizedHydrated.map(({ item }) => item),
    citations: authorizedHydrated.map(({ citation }) => citation),
  };
}

async function revalidateRepresentativeRecallAuthorization(params: {
  representativeSlug: string;
  conversationId: string;
  contactId: string;
  sourceChannel: RecallSourceChannel;
  activeEpisodeId: string;
  representativeVersionId: string;
  allowedSourceKinds: ReadonlySet<RepresentativeRecallSourceKind>;
  knowledgeAssetPins: Array<{
    assetId: string;
    checksum: string | null;
    processingVersion: number;
  }>;
}): Promise<{
  publishedVersionRoot?: string;
  knowledgeRoot?: string;
  allowedAssetIds: Set<string>;
  memoryRoots: string[];
  memoryGrantsByUri: Map<string, GovernedMemoryRecallGrant>;
  memorySearchConfig?: { limit: number; scoreThreshold: number };
} | null> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: params.conversationId,
      contactId: params.contactId,
      sourceChannel: params.sourceChannel,
      activeEpisodeId: params.activeEpisodeId,
      representative: {
        slug: params.representativeSlug,
      },
    },
    select: {
      id: true,
      representative: {
        select: {
          id: true,
          slug: true,
          lifecycleState: true,
          openvikingEnabled: true,
          openvikingAutoRecall: true,
          knowledgeAssetLinks: {
            select: {
              assetId: true,
              enabled: true,
              reviewStatus: true,
              asset: {
                select: {
                  status: true,
                  archivedAt: true,
                  checksum: true,
                  processingVersion: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (
    !conversation ||
    conversation.representative.lifecycleState !== "PUBLISHED" ||
    !conversation.representative.openvikingEnabled ||
    !conversation.representative.openvikingAutoRecall
  ) {
    return null;
  }

  const episode = await prisma.conversationEpisode.findFirst({
      where: {
        id: params.activeEpisodeId,
        conversationId: conversation.id,
      },
      select: {
        representativeVersion: {
          select: {
            id: true,
            representativeId: true,
            status: true,
          },
        },
      },
    });
  if (
    episode?.representativeVersion?.id !== params.representativeVersionId ||
    episode.representativeVersion.representativeId !== conversation.representative.id ||
    episode.representativeVersion.status !== "PUBLISHED"
  ) {
    return null;
  }

  const memoryAuthorization = await loadGovernedMemoryRecallAuthorization({
    representativeId: conversation.representative.id,
    contactId: params.contactId,
    sourceChannel: params.sourceChannel,
    allowedSourceKinds: params.allowedSourceKinds,
  });
  return {
    ...(params.allowedSourceKinds.has("PUBLIC_KNOWLEDGE")
      ? {
          publishedVersionRoot: buildRepresentativeVersionResourceRootUri(
            conversation.representative.slug,
            params.representativeVersionId,
          ),
          knowledgeRoot: buildRepresentativeKnowledgeRootUri(
            conversation.representative.slug,
          ),
        }
      : {}),
    allowedAssetIds: params.allowedSourceKinds.has("PUBLIC_KNOWLEDGE")
      ? resolveAllowedPublishedKnowledgeAssetIds({
          pins: params.knowledgeAssetPins,
          currentLinks: conversation.representative.knowledgeAssetLinks,
        })
      : new Set<string>(),
    memoryRoots: memoryAuthorization.memoryRoots,
    memoryGrantsByUri: memoryAuthorization.memoryGrantsByUri,
    ...(memoryAuthorization.memorySearchConfig
      ? { memorySearchConfig: memoryAuthorization.memorySearchConfig }
      : {}),
  };
}

async function loadGovernedMemoryRecallAuthorization(params: {
  representativeId: string;
  contactId: string;
  sourceChannel: RecallSourceChannel;
  allowedSourceKinds: ReadonlySet<RepresentativeRecallSourceKind>;
}): Promise<Pick<
  RepresentativeRecallAuthorization,
  "memoryRoots" | "memoryGrantsByUri" | "memorySearchConfig"
>> {
  const empty = {
    memoryRoots: [],
    memoryGrantsByUri: new Map<string, GovernedMemoryRecallGrant>(),
  };
  if (
    !params.allowedSourceKinds.has("CONTACT_MEMORY")
    && !params.allowedSourceKinds.has("REPRESENTATIVE_EXPERIENCE")
  ) {
    return empty;
  }

  try {
    const policy = await prisma.representativeMemoryPolicy.findUnique({
      where: { representativeId: params.representativeId },
      select: {
        namespaceKey: true,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        representativeExperienceEnabled: true,
        webRecallEnabled: true,
        matrixRecallEnabled: true,
        telegramRecallEnabled: true,
        provider: true,
        recallLimit: true,
        recallScoreThreshold: true,
      },
    });
    if (
      !policy?.longTermMemoryEnabled
      || policy.provider !== "openviking"
      || !isMemoryRecallEnabledForChannel(policy, params.sourceChannel)
      || !Number.isInteger(policy.recallLimit)
      || policy.recallLimit < 1
      || policy.recallLimit > 50
      || !Number.isFinite(policy.recallScoreThreshold)
      || policy.recallScoreThreshold < 0
      || policy.recallScoreThreshold > 1
    ) {
      return empty;
    }

    const allowContact =
      params.allowedSourceKinds.has("CONTACT_MEMORY")
      && policy.contactMemoryEnabled;
    const allowExperience =
      params.allowedSourceKinds.has("REPRESENTATIVE_EXPERIENCE")
      && policy.representativeExperienceEnabled;
    const scopeFilters: Prisma.GovernedMemoryWhereInput[] = [];
    if (allowContact) {
      scopeFilters.push({
        scope: "CONTACT_CHANNEL",
        contactId: params.contactId,
        sourceChannel: toRepresentativeMemoryChannel(params.sourceChannel),
      });
    }
    if (allowExperience) {
      scopeFilters.push({
        scope: "REPRESENTATIVE",
        contactId: null,
        sourceChannel: null,
      });
    }
    if (!scopeFilters.length) return empty;

    const now = new Date();
    const memories = await prisma.governedMemory.findMany({
      where: {
        representativeId: params.representativeId,
        status: "ACTIVE",
        currentVersionId: { not: null },
        recallDisabledAt: null,
        OR: scopeFilters,
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      select: {
        id: true,
        representativeId: true,
        scope: true,
        contactId: true,
        sourceChannel: true,
        category: true,
        status: true,
        recallDisabledAt: true,
        expiresAt: true,
        currentVersionId: true,
        currentVersion: {
          select: {
            id: true,
            representativeId: true,
            scope: true,
            safeText: true,
            summary: true,
            contentHash: true,
            purgedAt: true,
            deidentifiedAt: true,
            deidentificationMethod: true,
            sourceCandidate: {
              select: {
                representativeId: true,
                contactId: true,
                scope: true,
                scopeChannel: true,
                status: true,
                contentPurgedAt: true,
                deidentifiedAt: true,
              },
            },
            reviewDecisions: {
              select: { id: true, representativeId: true, outcome: true },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
            projectionItems: {
              where: {
                provider: policy.provider,
                lane: "RECALL",
                status: "ACTIVE",
              },
              select: {
                id: true,
                representativeId: true,
                provider: true,
                lane: true,
                status: true,
                contentHash: true,
                remoteUri: true,
                projectedAt: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });

    const memoryRoots: string[] = [];
    if (allowContact) {
      memoryRoots.push(buildGovernedContactChannelMemoryRootUri({
        namespaceKey: policy.namespaceKey,
        contactId: params.contactId,
        channel: params.sourceChannel,
      }));
    }
    if (allowExperience) {
      memoryRoots.push(buildGovernedRepresentativeExperienceRootUri(policy.namespaceKey));
    }

    const memoryGrantsByUri = new Map<string, GovernedMemoryRecallGrant>();
    for (const memory of memories) {
      const version = memory.currentVersion;
      if (
        memory.representativeId !== params.representativeId
        || memory.status !== "ACTIVE"
        || memory.recallDisabledAt !== null
        || (memory.expiresAt !== null && memory.expiresAt <= now)
        || !version
        || version.representativeId !== params.representativeId
        || memory.currentVersionId !== version.id
        || version.purgedAt
        || !version.safeText?.trim()
        || version.reviewDecisions[0]?.outcome !== "APPROVED"
        || version.reviewDecisions[0]?.representativeId !== params.representativeId
        || (version.sourceCandidate
          && (
            version.sourceCandidate.representativeId !== params.representativeId
            || version.sourceCandidate.status !== "APPROVED"
            || version.sourceCandidate.contentPurgedAt !== null
          ))
      ) {
        continue;
      }

      let sourceKind: GovernedMemoryRecallGrant["sourceKind"];
      let expectedUri: string;
      if (memory.scope === "CONTACT_CHANNEL") {
        if (
          !allowContact
          || memory.contactId !== params.contactId
          || memory.sourceChannel !== toRepresentativeMemoryChannel(params.sourceChannel)
          || version.scope !== "CONTACT_CHANNEL"
          || !memory.category.startsWith("CONTACT_")
          || (version.sourceCandidate
            && (
              version.sourceCandidate.scope !== "CONTACT_CHANNEL"
              || version.sourceCandidate.contactId !== params.contactId
              || version.sourceCandidate.scopeChannel
                !== toRepresentativeMemoryChannel(params.sourceChannel)
            ))
        ) {
          continue;
        }
        sourceKind = "CONTACT_MEMORY";
        expectedUri = buildGovernedContactChannelMemoryVersionUri({
          namespaceKey: policy.namespaceKey,
          contactId: params.contactId,
          channel: params.sourceChannel,
          memoryId: memory.id,
          memoryVersionId: version.id,
        });
      } else {
        if (
          !allowExperience
          || memory.scope !== "REPRESENTATIVE"
          || memory.contactId !== null
          || memory.sourceChannel !== null
          || version.scope !== "REPRESENTATIVE"
          || !memory.category.startsWith("REPRESENTATIVE_")
          || !version.deidentifiedAt
          || !version.deidentificationMethod?.trim()
          || (version.sourceCandidate
            && (
              version.sourceCandidate.scope !== "REPRESENTATIVE"
              || version.sourceCandidate.contactId !== null
              || version.sourceCandidate.scopeChannel !== null
              || !version.sourceCandidate.deidentifiedAt
            ))
        ) {
          continue;
        }
        sourceKind = "REPRESENTATIVE_EXPERIENCE";
        expectedUri = buildGovernedRepresentativeExperienceVersionUri({
          namespaceKey: policy.namespaceKey,
          memoryId: memory.id,
          memoryVersionId: version.id,
        });
      }

      for (const projection of version.projectionItems) {
        if (
          projection.representativeId !== params.representativeId
          || projection.provider !== policy.provider
          || projection.lane !== "RECALL"
          || projection.status !== "ACTIVE"
          || projection.remoteUri !== expectedUri
          || projection.contentHash !== version.contentHash
          || !projection.projectedAt
          || projection.deletedAt
        ) {
          continue;
        }
        memoryGrantsByUri.set(expectedUri, {
          uri: expectedUri,
          sourceKind,
          memoryVersionId: version.id,
          projectionItemId: projection.id,
          contentHash: version.contentHash,
          safeText: version.safeText.trim(),
          summary: version.summary?.trim() || version.safeText.trim(),
        });
        break;
      }
    }
    return {
      memoryRoots,
      memoryGrantsByUri,
      memorySearchConfig: {
        limit: policy.recallLimit,
        scoreThreshold: policy.recallScoreThreshold,
      },
    };
  } catch {
    // Memory governance is fail-closed. Public, version-pinned knowledge is
    // intentionally resolved independently and remains available.
    return empty;
  }
}

function hydrateGovernedMemoryRecall(
  remoteItem: {
    uri: string;
    context_type?: OpenVikingRecallItem["contextType"] | undefined;
    contextType?: OpenVikingRecallItem["contextType"] | undefined;
    score?: number | undefined;
  },
  grant: GovernedMemoryRecallGrant,
): {
  item: RepresentativeRecallItem;
  citation: RepresentativeRecallContext["citations"][number];
} {
  const safeContent = sanitizePublicSafeText(grant.safeText, 4_000) ?? "";
  const abstract = sanitizePublicSafeText(grant.summary, 800) ?? "";
  const score = remoteItem.score ?? 0;
  const item: RepresentativeRecallItem = {
    uri: grant.uri,
    contextType: remoteItem.contextType ?? remoteItem.context_type ?? "memory",
    layer: safeContent ? "L2" : "L0",
    score,
    abstract,
    ...(safeContent ? { content: safeContent } : {}),
    internalSource: {
      sourceKind: grant.sourceKind,
      contentHash: grant.contentHash,
      memoryVersionId: grant.memoryVersionId,
      projectionItemId: grant.projectionItemId,
    },
  };
  return {
    item,
    citation: {
      title: grant.sourceKind === "CONTACT_MEMORY"
        ? "Remembered preference"
        : "Approved representative experience",
      ...(abstract || safeContent ? { excerpt: (abstract || safeContent).slice(0, 480) } : {}),
      score,
    },
  };
}

function authorizeRecallUri(
  uri: string,
  authorization: RepresentativeRecallAuthorization,
): AuthorizedRecallSource | null {
  if (
    authorization.publishedVersionRoot
    && uri.startsWith(authorization.publishedVersionRoot)
  ) {
    return { sourceKind: "PUBLIC_KNOWLEDGE" };
  }

  if (authorization.knowledgeRoot && uri.startsWith(authorization.knowledgeRoot)) {
    const assetId = resolveKnowledgeAssetId(uri).knowledgeAssetId;
    return assetId && authorization.allowedAssetIds.has(assetId)
      ? { sourceKind: "PUBLIC_KNOWLEDGE" }
      : null;
  }

  return authorization.memoryGrantsByUri.get(uri) ?? null;
}

function rankAuthorizedRecallCandidates(
  candidates: AuthorizedRemoteRecallCandidate[],
  config: { limit: number; scoreThreshold: number },
): AuthorizedRemoteRecallCandidate[] {
  if (config.limit < 1) return [];
  const unique = new Map<string, AuthorizedRemoteRecallCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.item.uri);
    if (!existing || (candidate.item.score ?? 0) > (existing.item.score ?? 0)) {
      unique.set(candidate.item.uri, candidate);
    }
  }
  const ranked = [...unique.values()]
    .sort((left, right) => (right.item.score ?? 0) - (left.item.score ?? 0));
  const topScore = ranked[0]?.item.score ?? 0;
  const relativeScoreFloor = Math.max(config.scoreThreshold, topScore * 0.72);
  return ranked
    .filter((candidate) => (candidate.item.score ?? 0) >= relativeScoreFloor)
    .slice(0, config.limit);
}

function rankHydratedRecallResults(
  results: Array<{
    item: RepresentativeRecallItem;
    citation: RepresentativeRecallContext["citations"][number];
  }>,
  config: { limit: number; scoreThreshold: number },
) {
  const unique = new Map<string, (typeof results)[number]>();
  for (const result of results) {
    const existing = unique.get(result.item.uri);
    if (!existing || result.item.score > existing.item.score) {
      unique.set(result.item.uri, result);
    }
  }
  const ranked = [...unique.values()].sort(
    (left, right) => right.item.score - left.item.score,
  );
  const topScore = ranked[0]?.item.score ?? 0;
  const relativeScoreFloor = Math.max(config.scoreThreshold, topScore * 0.72);
  return ranked
    .filter(({ item }) => item.score >= relativeScoreFloor)
    .slice(0, config.limit);
}

function normalizeRecallSourceKinds(
  sourceKinds?: readonly RepresentativeRecallSourceKind[],
): ReadonlySet<RepresentativeRecallSourceKind> {
  const requested = sourceKinds ?? REPRESENTATIVE_RECALL_SOURCE_KINDS;
  return new Set(
    requested.filter((sourceKind): sourceKind is RepresentativeRecallSourceKind => (
      REPRESENTATIVE_RECALL_SOURCE_KINDS.includes(sourceKind)
    )),
  );
}

function uniqueRecallRoots(roots: Array<string | undefined>): string[] {
  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}

function isRecallSourceChannel(channel: string): channel is RecallSourceChannel {
  return channel === "web" || channel === "matrix" || channel === "telegram";
}

function toRepresentativeMemoryChannel(channel: RecallSourceChannel) {
  if (channel === "web") return "WEB" as const;
  if (channel === "matrix") return "MATRIX" as const;
  return "TELEGRAM" as const;
}

function isMemoryRecallEnabledForChannel(
  policy: {
    webRecallEnabled: boolean;
    matrixRecallEnabled: boolean;
    telegramRecallEnabled: boolean;
  },
  channel: RecallSourceChannel,
): boolean {
  if (channel === "web") return policy.webRecallEnabled;
  if (channel === "matrix") return policy.matrixRecallEnabled;
  return policy.telegramRecallEnabled;
}

export async function getRepresentativeOpenVikingRecallTraces(
  representativeSlug: string,
): Promise<
  Array<{
    id: string;
    queryText: string;
    recalledUri: string;
    contextType: string;
    layer: string;
    score: number;
    createdAt: string;
  }>
> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: { id: true },
  });

  if (!representative) {
    return [];
  }

  const traces = await prisma.conversationRecallTrace.findMany({
    where: { representativeId: representative.id },
    orderBy: [{ createdAt: "desc" }],
    take: 40,
  });

  return traces.map((trace) => ({
    id: trace.id,
    queryText: trace.queryText,
    recalledUri: trace.recalledUri,
    contextType: trace.contextType,
    layer: trace.layer,
    score: trace.score,
    createdAt: trace.createdAt.toISOString(),
  }));
}

export async function getRepresentativeOpenVikingRecallUsage(
  representativeSlug: string,
): Promise<{ today: number; total: number }> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: { id: true },
  });

  if (!representative) {
    return { today: 0, total: 0 };
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const where = { representativeId: representative.id };
  const [today, total] = await Promise.all([
    prisma.conversationRecallTrace.count({
      where: {
        ...where,
        createdAt: { gte: startOfToday },
      },
    }),
    prisma.conversationRecallTrace.count({ where }),
  ]);

  return { today, total };
}

/** @deprecated Legacy-ledger compatibility only; governed recall never calls this helper. */
export function isOpenVikingMemoryRecallEligible(memory: {
  status: string;
  scope: string;
  category: string;
  sourceKind: string;
}): boolean {
  if (memory.status !== "ACTIVE" || memory.scope !== "contact") {
    return false;
  }

  const category = memory.category.trim().toLowerCase();
  const sourceKind = memory.sourceKind.trim().toLowerCase();
  return (
    category !== "payment" &&
    sourceKind !== "payment_unlock" &&
    sourceKind !== "handoff_resolution"
  );
}

export function resolveAllowedPublishedKnowledgeAssetIds(params: {
  pins: Array<{
    assetId: string;
    checksum: string | null;
    processingVersion: number;
  }>;
  currentLinks: Array<{
    assetId: string;
    enabled: boolean;
    reviewStatus: string;
    asset: {
      status: string;
      archivedAt: Date | null;
      checksum: string | null;
      processingVersion: number;
    };
  }>;
}): Set<string> {
  const pinsByAssetId = new Map(params.pins.map((pin) => [pin.assetId, pin]));
  return new Set(
    params.currentLinks.flatMap((link) => {
      const pin = pinsByAssetId.get(link.assetId);
      if (
        !pin ||
        !link.enabled ||
        link.reviewStatus !== "APPROVED" ||
        link.asset.status !== "READY" ||
        link.asset.archivedAt !== null ||
        !pin.checksum ||
        pin.checksum !== link.asset.checksum ||
        pin.processingVersion !== link.asset.processingVersion
      ) {
        return [];
      }
      return [link.assetId];
    }),
  );
}

/** @deprecated Legacy-ledger compatibility only; governed recall uses exact projection grants. */
export function isOpenVikingMemoryUriAllowed(
  uri: string,
  allowedMemoryUris: ReadonlySet<string>,
): boolean {
  return allowedMemoryUris.has(uri);
}

function resolveKnowledgeAssetId(uri: string): { knowledgeAssetId?: string } {
  const match = uri.match(/\/knowledge\/([^/]+?)\.md(?:\/|$)/i);
  return match?.[1] ? { knowledgeAssetId: match[1] } : {};
}

function resolveRecallTitle(content: string, uri: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return sanitizePublicSafeText(heading, 160) || "Knowledge source";
  const fileName = uri.split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "");
  return sanitizePublicSafeText(fileName || "Knowledge source", 160) || "Knowledge source";
}

export async function getRepresentativeOpenVikingMemoryPreview(
  representativeSlug: string,
): Promise<RepresentativeOpenVikingMemoryPreview[]> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: { id: true },
  });

  if (!representative) {
    return [];
  }

  const memories = await prisma.openVikingMemoryRecord.findMany({
    where: { representativeId: representative.id },
    include: {
      contact: true,
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 24,
  });

  return memories.map(serializeRepresentativeOpenVikingMemory);
}

export async function suppressRepresentativeOpenVikingMemory(params: {
  representativeSlug: string;
  memoryId: string;
  ownerId?: string;
}): Promise<RepresentativeOpenVikingMemoryPreview | null> {
  const memory = await findRepresentativeOpenVikingMemory(params);
  if (!memory) {
    return null;
  }

  if (memory.status === "ACTIVE") {
    await prisma.$transaction(async (tx) => {
      const changed = await tx.openVikingMemoryRecord.updateMany({
        where: {
          id: memory.id,
          representativeId: memory.representativeId,
          status: "ACTIVE",
        },
        data: {
          status: "SUPPRESSED",
          suppressedAt: new Date(),
          deletionError: null,
        },
      });
      if (changed.count > 0) {
        await tx.eventAudit.create({
          data: {
            ...(params.ownerId === memory.representative.ownerId
              ? { ownerId: memory.representative.ownerId }
              : {}),
            representativeId: memory.representativeId,
            type: EventType.OPENVIKING_MEMORY_STATUS_CHANGED,
            payload: {
              memoryId: memory.id,
              status: "SUPPRESSED",
            },
          },
        });
      }
    });
  }

  return loadRepresentativeOpenVikingMemoryPreview(memory.id);
}

export async function deleteRepresentativeOpenVikingMemory(params: {
  representativeSlug: string;
  memoryId: string;
  ownerId?: string;
}): Promise<RepresentativeOpenVikingMemoryPreview | null> {
  const memory = await findRepresentativeOpenVikingMemory(params);
  if (!memory) {
    return null;
  }
  if (memory.status === "DELETED") {
    return serializeRepresentativeOpenVikingMemory(memory);
  }
  const auditOwnerId =
    params.ownerId === memory.representative.ownerId
      ? memory.representative.ownerId
      : undefined;
  const deletionRequestedByOwnerId =
    auditOwnerId ?? memory.deletionRequestedByOwnerId ?? undefined;

  let expectedLastDeleteAttemptAt = memory.lastDeleteAttemptAt;
  if (memory.status !== "DELETE_PENDING") {
    const claimed = await prisma.$transaction(async (tx) => {
      const result = await tx.openVikingMemoryRecord.updateMany({
        where: {
          id: memory.id,
          representativeId: memory.representativeId,
          status: {
            in: ["ACTIVE", "SUPPRESSED", "DELETE_FAILED"],
          },
        },
        data: {
          status: "DELETE_PENDING",
          summary: "",
          suppressedAt: memory.suppressedAt ?? new Date(),
          lastDeleteAttemptAt: null,
          nextDeleteAttemptAt: null,
          deletionError: null,
          ...(auditOwnerId
            ? { deletionRequestedByOwnerId: auditOwnerId }
            : {}),
        },
      });
      if (result.count > 0) {
        await tx.eventAudit.create({
          data: {
            ...(auditOwnerId ? { ownerId: auditOwnerId } : {}),
            representativeId: memory.representativeId,
            type: EventType.OPENVIKING_MEMORY_STATUS_CHANGED,
            payload: {
              memoryId: memory.id,
              status: "DELETE_PENDING",
            },
          },
        });
      }
      return result;
    });
    if (claimed.count === 0) {
      return loadRepresentativeOpenVikingMemoryPreview(memory.id);
    }
    expectedLastDeleteAttemptAt = null;
  }

  return attemptRepresentativeOpenVikingMemoryDeletion({
    memoryId: memory.id,
    representativeId: memory.representativeId,
    representativeSlug: memory.representative.slug,
    openvikingAgentId: memory.representative.openvikingAgentId,
    uri: memory.uri,
    expectedLastDeleteAttemptAt,
    expectedDeletionAttemptCount: memory.deletionAttemptCount,
    ...(deletionRequestedByOwnerId
      ? { requestedByOwnerId: deletionRequestedByOwnerId }
      : {}),
  });
}

export async function retryRepresentativeOpenVikingMemoryDeletion(params: {
  representativeSlug: string;
  memoryId: string;
  ownerId?: string;
}): Promise<RepresentativeOpenVikingMemoryPreview | null> {
  const memory = await findRepresentativeOpenVikingMemory(params);
  if (!memory) {
    return null;
  }
  if (memory.status === "DELETED") {
    return serializeRepresentativeOpenVikingMemory(memory);
  }
  if (memory.status !== "DELETE_FAILED" && memory.status !== "DELETE_PENDING") {
    return serializeRepresentativeOpenVikingMemory(memory);
  }
  const auditOwnerId =
    params.ownerId === memory.representative.ownerId
      ? memory.representative.ownerId
      : undefined;
  const deletionRequestedByOwnerId =
    auditOwnerId ?? memory.deletionRequestedByOwnerId ?? undefined;

  let expectedLastDeleteAttemptAt = memory.lastDeleteAttemptAt;
  if (memory.status === "DELETE_FAILED") {
    const claimed = await prisma.$transaction(async (tx) => {
      const result = await tx.openVikingMemoryRecord.updateMany({
        where: {
          id: memory.id,
          representativeId: memory.representativeId,
          status: "DELETE_FAILED",
        },
        data: {
          status: "DELETE_PENDING",
          summary: "",
          lastDeleteAttemptAt: null,
          nextDeleteAttemptAt: null,
          deletionError: null,
          ...(auditOwnerId
            ? { deletionRequestedByOwnerId: auditOwnerId }
            : {}),
        },
      });
      if (result.count > 0) {
        await tx.eventAudit.create({
          data: {
            ...(auditOwnerId ? { ownerId: auditOwnerId } : {}),
            representativeId: memory.representativeId,
            type: EventType.OPENVIKING_MEMORY_STATUS_CHANGED,
            payload: {
              memoryId: memory.id,
              status: "DELETE_PENDING",
            },
          },
        });
      }
      return result;
    });
    if (claimed.count === 0) {
      return loadRepresentativeOpenVikingMemoryPreview(memory.id);
    }
    expectedLastDeleteAttemptAt = null;
  }

  return attemptRepresentativeOpenVikingMemoryDeletion({
    memoryId: memory.id,
    representativeId: memory.representativeId,
    representativeSlug: memory.representative.slug,
    openvikingAgentId: memory.representative.openvikingAgentId,
    uri: memory.uri,
    expectedLastDeleteAttemptAt,
    expectedDeletionAttemptCount: memory.deletionAttemptCount,
    ...(deletionRequestedByOwnerId
      ? { requestedByOwnerId: deletionRequestedByOwnerId }
      : {}),
  });
}

export async function runOpenVikingMemoryDeletionRecoveryTick(options?: {
  limit?: number;
  now?: Date;
}): Promise<OpenVikingMemoryDeletionTickSummary> {
  const now = options?.now ?? new Date();
  const staleLeaseCutoff = new Date(
    now.getTime() - OPENVIKING_MEMORY_DELETE_LEASE_MS,
  );
  const memories = await prisma.openVikingMemoryRecord.findMany({
    where: {
      OR: [
        {
          status: "DELETE_PENDING",
          OR: [
            { lastDeleteAttemptAt: null },
            { lastDeleteAttemptAt: { lte: staleLeaseCutoff } },
          ],
        },
        {
          status: "DELETE_FAILED",
          nextDeleteAttemptAt: { lte: now },
        },
      ],
    },
    orderBy: [
      {
        nextDeleteAttemptAt: {
          sort: "asc",
          nulls: "first",
        },
      },
      { updatedAt: "asc" },
    ],
    take: Math.max(1, Math.min(options?.limit ?? 12, 100)),
    include: {
      representative: {
        select: {
          id: true,
          slug: true,
          ownerId: true,
          openvikingAgentId: true,
        },
      },
    },
  });
  const summary: OpenVikingMemoryDeletionTickSummary = {
    processed: 0,
    deleted: 0,
    failed: 0,
    pending: 0,
  };

  for (const memory of memories) {
    let expectedLastDeleteAttemptAt = memory.lastDeleteAttemptAt;
    if (memory.status === "DELETE_FAILED") {
      const reclaimed = await prisma.openVikingMemoryRecord.updateMany({
        where: {
          id: memory.id,
          representativeId: memory.representativeId,
          status: "DELETE_FAILED",
          nextDeleteAttemptAt: memory.nextDeleteAttemptAt,
        },
        data: {
          status: "DELETE_PENDING",
          summary: "",
          lastDeleteAttemptAt: null,
          nextDeleteAttemptAt: null,
          deletionError: null,
        },
      });
      if (!reclaimed.count) continue;
      expectedLastDeleteAttemptAt = null;
    }

    const result = await attemptRepresentativeOpenVikingMemoryDeletion({
      memoryId: memory.id,
      representativeId: memory.representativeId,
      representativeSlug: memory.representative.slug,
      openvikingAgentId: memory.representative.openvikingAgentId,
      uri: memory.uri,
      expectedLastDeleteAttemptAt,
      expectedDeletionAttemptCount: memory.deletionAttemptCount,
      ...(memory.deletionRequestedByOwnerId === memory.representative.ownerId
        ? { requestedByOwnerId: memory.representative.ownerId }
        : {}),
      now,
    });
    if (!result) continue;
    summary.processed += 1;
    if (result.status === "DELETED") summary.deleted += 1;
    else if (result.status === "DELETE_FAILED") summary.failed += 1;
    else summary.pending += 1;
  }

  return summary;
}

function serializeRepresentativeOpenVikingMemory(memory: {
  id: string;
  uri: string;
  scope: string;
  category: string;
  summary: string;
  sourceKind: string;
  status: "ACTIVE" | "SUPPRESSED" | "DELETE_PENDING" | "DELETED" | "DELETE_FAILED";
  suppressedAt: Date | null;
  deletedAt: Date | null;
  lastDeleteAttemptAt: Date | null;
  deletionAttemptCount: number;
  deletionError: string | null;
  createdAt: Date;
  contact: {
    id: string;
    displayName: string | null;
    username: string | null;
    telegramUserId: string | null;
    channelUserId: string | null;
  } | null;
}): RepresentativeOpenVikingMemoryPreview {
  return {
    id: memory.id,
    uri: memory.uri,
    scope: memory.scope,
    category: memory.category,
    summary: memory.summary,
    sourceKind: memory.sourceKind,
    status: memory.status,
    ...(memory.suppressedAt ? { suppressedAt: memory.suppressedAt.toISOString() } : {}),
    ...(memory.deletedAt ? { deletedAt: memory.deletedAt.toISOString() } : {}),
    ...(memory.lastDeleteAttemptAt
      ? { lastDeleteAttemptAt: memory.lastDeleteAttemptAt.toISOString() }
      : {}),
    deletionAttemptCount: memory.deletionAttemptCount,
    ...(memory.deletionError ? { deletionError: "REMOTE_DELETE_FAILED" } : {}),
    createdAt: memory.createdAt.toISOString(),
    ...(memory.contact
      ? {
          contact: {
            id: memory.contact.id,
            displayName:
              memory.contact.displayName ??
              memory.contact.username ??
              memory.contact.telegramUserId ??
              memory.contact.channelUserId ??
              "Unknown audience",
          },
        }
      : {}),
  };
}

async function findRepresentativeOpenVikingMemory(params: {
  representativeSlug: string;
  memoryId: string;
}) {
  return prisma.openVikingMemoryRecord.findFirst({
    where: {
      id: params.memoryId,
      representative: {
        slug: params.representativeSlug,
      },
    },
    include: {
      contact: true,
      representative: {
        select: {
          ownerId: true,
          slug: true,
          openvikingAgentId: true,
        },
      },
    },
  });
}

async function loadRepresentativeOpenVikingMemoryPreview(
  memoryId: string,
): Promise<RepresentativeOpenVikingMemoryPreview | null> {
  const memory = await prisma.openVikingMemoryRecord.findUnique({
    where: { id: memoryId },
    include: { contact: true },
  });
  return memory ? serializeRepresentativeOpenVikingMemory(memory) : null;
}

async function attemptRepresentativeOpenVikingMemoryDeletion(params: {
  memoryId: string;
  representativeId: string;
  representativeSlug: string;
  openvikingAgentId: string | null;
  uri: string;
  expectedLastDeleteAttemptAt: Date | null;
  expectedDeletionAttemptCount: number;
  requestedByOwnerId?: string;
  now?: Date;
}): Promise<RepresentativeOpenVikingMemoryPreview | null> {
  const now = params.now ?? new Date();
  if (
    params.expectedLastDeleteAttemptAt &&
    now.getTime() - params.expectedLastDeleteAttemptAt.getTime()
      < OPENVIKING_MEMORY_DELETE_LEASE_MS
  ) {
    return loadRepresentativeOpenVikingMemoryPreview(params.memoryId);
  }

  const attemptAt = new Date(Math.max(
    now.getTime(),
    (params.expectedLastDeleteAttemptAt?.getTime() ?? 0) + 1,
  ));
  const claimed = await prisma.openVikingMemoryRecord.updateMany({
    where: {
      id: params.memoryId,
      representativeId: params.representativeId,
      status: "DELETE_PENDING",
      lastDeleteAttemptAt: params.expectedLastDeleteAttemptAt,
      deletionAttemptCount: params.expectedDeletionAttemptCount,
    },
    data: {
      summary: "",
      lastDeleteAttemptAt: attemptAt,
      nextDeleteAttemptAt: null,
      deletionAttemptCount: { increment: 1 },
      deletionError: null,
      ...(params.requestedByOwnerId
        ? { deletionRequestedByOwnerId: params.requestedByOwnerId }
        : {}),
    },
  });
  if (claimed.count === 0) {
    return loadRepresentativeOpenVikingMemoryPreview(params.memoryId);
  }

  try {
    const env = resolveOpenVikingEnv();
    if (!env.enabled) {
      throw new Error("OpenViking is disabled at the environment level.");
    }

    const client = buildRepresentativeClient({
      slug: params.representativeSlug,
      openvikingAgentId: params.openvikingAgentId,
    });
    try {
      await client.remove(params.uri, true);
    } catch (error) {
      if (!(error instanceof OpenVikingRequestError && error.status === 404)) {
        throw error;
      }
    }

    await prisma.$transaction(async (tx) => {
      const deleted = await tx.openVikingMemoryRecord.updateMany({
        where: {
          id: params.memoryId,
          representativeId: params.representativeId,
          status: "DELETE_PENDING",
          lastDeleteAttemptAt: attemptAt,
        },
        data: {
          status: "DELETED",
          deletedAt: new Date(),
          nextDeleteAttemptAt: null,
          deletionError: null,
        },
      });
      if (deleted.count > 0) {
        await tx.eventAudit.create({
          data: {
            ...(params.requestedByOwnerId
              ? { ownerId: params.requestedByOwnerId }
              : {}),
            representativeId: params.representativeId,
            type: EventType.OPENVIKING_MEMORY_STATUS_CHANGED,
            payload: {
              memoryId: params.memoryId,
              status: "DELETED",
            },
          },
        });
      }
    });
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : "OpenViking memory deletion failed."
    ).slice(0, 2_000);
    const nextDeleteAttemptAt = new Date(
      Date.now() + openVikingMemoryDeleteBackoffMs(
        params.expectedDeletionAttemptCount + 1,
      ),
    );
    await prisma.$transaction(async (tx) => {
      const failed = await tx.openVikingMemoryRecord.updateMany({
        where: {
          id: params.memoryId,
          representativeId: params.representativeId,
          status: "DELETE_PENDING",
          lastDeleteAttemptAt: attemptAt,
        },
        data: {
          status: "DELETE_FAILED",
          deletionError: message,
          nextDeleteAttemptAt,
        },
      });
      if (failed.count > 0) {
        await tx.eventAudit.create({
          data: {
            ...(params.requestedByOwnerId
              ? { ownerId: params.requestedByOwnerId }
              : {}),
            representativeId: params.representativeId,
            type: EventType.OPENVIKING_MEMORY_STATUS_CHANGED,
            payload: {
              memoryId: params.memoryId,
              status: "DELETE_FAILED",
              nextAttemptAt: nextDeleteAttemptAt.toISOString(),
            },
          },
        });
      }
    });
  }

  return loadRepresentativeOpenVikingMemoryPreview(params.memoryId);
}

export async function getRepresentativeOpenVikingOverviewMetrics(
  representativeSlug: string,
): Promise<RepresentativeOpenVikingOverviewMetrics | null> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      openvikingLastSyncItemCount: true,
    },
  });

  if (!representative) {
    return null;
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [memoriesCapturedToday, sessionsCommittedToday, recallsUsedToday, syncFailures, health] =
    await Promise.all([
      prisma.openVikingMemoryRecord.count({
        where: {
          representativeId: representative.id,
          createdAt: {
            gte: startOfToday,
          },
        },
      }),
      prisma.conversationCommitTrace.count({
        where: {
          representativeId: representative.id,
          createdAt: {
            gte: startOfToday,
          },
          status: "succeeded",
        },
      }),
      prisma.conversationRecallTrace.count({
        where: {
          representativeId: representative.id,
          createdAt: {
            gte: startOfToday,
          },
        },
      }),
      prisma.representativeContextSync.count({
        where: {
          representativeId: representative.id,
          status: "failed",
        },
      }),
      getOpenVikingHealthSnapshot(),
    ]);

  return {
    resourcesSynced: representative.openvikingLastSyncItemCount ?? 0,
    memoriesCapturedToday,
    sessionsCommittedToday,
    recallsUsedToday,
    syncFailures,
    lastHealthCheckResult: health.status,
  };
}

export async function maybeStoreHandoffPatternFromStatusChange(params: {
  representativeSlug: string;
  handoffId: string;
  nextStatus: string;
}): Promise<void> {
  // Representative-wide learned patterns are intentionally disabled. Any
  // future promotion from a single conversation must go through explicit
  // review and publication instead of entering recall automatically.
  void params;
}

function resolveRepresentativeDefaults(representative: Pick<
  Representative,
  "slug" | "openvikingAgentId" | "activeVersionId"
>) {
  const env = resolveOpenVikingEnv();
  const agentId = representative.openvikingAgentId ?? buildOpenVikingAgentId(representative.slug, env);
  return {
    agentId,
    targetUri: representative.activeVersionId
      ? buildRepresentativeVersionResourceRootUri(
          representative.slug,
          representative.activeVersionId,
        )
      : buildRepresentativeResourceRootUri(representative.slug),
  };
}

function buildRepresentativeClient(representative: Pick<
  Representative,
  "slug" | "openvikingAgentId"
>): OpenVikingClient {
  const env = resolveOpenVikingEnv();
  const agentId = representative.openvikingAgentId ?? buildOpenVikingAgentId(representative.slug, env);
  return new OpenVikingClient({
    baseUrl: env.baseUrl,
    ...(env.apiKey ? { apiKey: env.apiKey } : {}),
    timeoutMs: env.timeoutMs,
    accountId: "delegate",
    userId: `rep-${representative.slug}`,
    agentId,
  });
}

async function syncDocumentToOpenViking(params: {
  client: OpenVikingClient;
  representativeSlug: string;
  document: OpenVikingDocumentSpec;
}): Promise<void> {
  const temp = await params.client.tempUpload({
    filename: params.document.filename,
    content: params.document.content,
  });

  if (params.document.contextType === "resource") {
    await params.client.addResource({
      ...(temp.temp_file_id ? { tempFileId: temp.temp_file_id } : {}),
      ...(temp.temp_path ? { tempPath: temp.temp_path } : {}),
      to: params.document.uri,
      reason: params.document.reason,
      instruction: "Delegate representative public knowledge sync",
      wait: true,
      timeout: REPRESENTATIVE_RESOURCE_SYNC_TIMEOUT_SECONDS,
    });
    return;
  }

  const stagingUri = `${buildRepresentativeResourceRootUri(params.representativeSlug)}sync/${params.document.filename}`;
  await params.client.addResource({
    ...(temp.temp_file_id ? { tempFileId: temp.temp_file_id } : {}),
    ...(temp.temp_path ? { tempPath: temp.temp_path } : {}),
    to: stagingUri,
    reason: params.document.reason,
    instruction: "Delegate memory staging sync",
    wait: true,
    timeout: REPRESENTATIVE_RESOURCE_SYNC_TIMEOUT_SECONDS,
  });
  await params.client.move({
    fromUri: stagingUri,
    toUri: params.document.uri,
  });
}

function resolveSyncDisabledReason(
  representative: Pick<Representative, "openvikingEnabled">,
  env: ReturnType<typeof resolveOpenVikingEnv>,
): string | null {
  if (!representative.openvikingEnabled) {
    return "OpenViking is disabled for this representative.";
  }

  if (!env.enabled) {
    return "OpenViking is disabled at the environment level.";
  }

  if (!env.resourceSyncEnabled) {
    return "OpenViking resource sync is disabled by OPENVIKING_RESOURCE_SYNC_ENABLED.";
  }

  return null;
}

function normalizePublishedKnowledgeDocuments(
  documents: Array<z.infer<typeof publishedKnowledgeDocumentSchema>>,
): Array<{ title: string; summary: string; url?: string }> {
  return documents.map((document) => ({
    title: document.title,
    summary: document.summary,
    ...(document.url ? { url: document.url } : {}),
  }));
}
