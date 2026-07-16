import {
  buildOpenVikingAgentId,
  buildRepresentativeKnowledgeDocuments,
  buildHandoffResolutionPatternDocument,
  buildRepresentativeResourceRootUri,
  OpenVikingClient,
  OpenVikingRequestError,
  resolveOpenVikingEnv,
  sanitizePublicSafeText,
  type OpenVikingCaptureMode,
  type OpenVikingDocumentSpec,
} from "@delegate/openviking";
import { Prisma, type Representative, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";

const representativeOpenVikingArgs = Prisma.validator<Prisma.RepresentativeDefaultArgs>()({
  include: {
    owner: true,
    knowledgePack: true,
    pricingPlans: true,
  },
});

type RepresentativeOpenVikingRecord = Prisma.RepresentativeGetPayload<{
  include: typeof representativeOpenVikingArgs.include;
}>;

const openVikingConfigSchema = z.object({
  enabled: z.boolean(),
  agentIdOverride: z.string().trim().min(1).optional(),
  autoRecall: z.boolean(),
  autoCapture: z.boolean(),
  captureMode: z.enum(["semantic", "keyword"]),
  recallLimit: z.number().int().min(1).max(20),
  recallScoreThreshold: z.number().min(0).max(1),
  targetUri: z.string().trim().min(1).optional(),
});

export type RepresentativeOpenVikingConfigInput = z.infer<typeof openVikingConfigSchema>;

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

  return {
    representativeSlug: representative.slug,
    enabled: representative.openvikingEnabled,
    agentId: defaults.agentId,
    ...(representative.openvikingAgentId ? { agentIdOverride: representative.openvikingAgentId } : {}),
    autoRecall: representative.openvikingAutoRecall,
    autoCapture: representative.openvikingAutoCapture,
    captureMode: representative.openvikingCaptureMode as OpenVikingCaptureMode,
    recallLimit: representative.openvikingRecallLimit,
    recallScoreThreshold: representative.openvikingRecallScoreThreshold,
    targetUri: representative.openvikingTargetUri ?? defaults.targetUri,
    resourceSyncEnabled: resolveOpenVikingEnv().resourceSyncEnabled,
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
}): Promise<RepresentativeOpenVikingSnapshot> {
  const input = openVikingConfigSchema.parse(params.input);

  const representative = await prisma.representative.findUnique({
    where: { slug: params.representativeSlug },
    select: { id: true, slug: true },
  });

  if (!representative) {
    throw new Error(`Representative "${params.representativeSlug}" not found.`);
  }

  await prisma.representative.update({
    where: { id: representative.id },
    data: {
      openvikingEnabled: input.enabled,
      openvikingAgentId: input.agentIdOverride ?? null,
      openvikingAutoRecall: input.autoRecall,
      openvikingAutoCapture: input.autoCapture,
      openvikingCaptureMode: input.captureMode,
      openvikingRecallLimit: input.recallLimit,
      openvikingRecallScoreThreshold: input.recallScoreThreshold,
      openvikingTargetUri: input.targetUri ?? null,
    },
  });

  const snapshot = await getRepresentativeOpenVikingSnapshot(params.representativeSlug);
  if (!snapshot) {
    throw new Error("Representative disappeared after updating OpenViking config.");
  }

  return snapshot;
}

export async function syncRepresentativeOpenVikingResources(params: {
  representativeSlug: string;
  trigger: "manual" | "create" | "setup_update" | "retry";
}): Promise<RepresentativeOpenVikingSnapshot> {
  const representative = await prisma.representative.findUnique({
    where: { slug: params.representativeSlug },
    ...representativeOpenVikingArgs,
  });

  if (!representative) {
    throw new Error(`Representative "${params.representativeSlug}" not found.`);
  }

  const env = resolveOpenVikingEnv();
  const startedAt = new Date();
  const syncDisabledReason = resolveSyncDisabledReason(representative, env);

  const syncJob = await prisma.representativeContextSync.create({
    data: {
      representativeId: representative.id,
      status: syncDisabledReason ? "disabled" : "running",
      itemCount: 0,
      startedAt,
      ...(syncDisabledReason ? { error: syncDisabledReason } : {}),
      finishedAt: syncDisabledReason ? startedAt : null,
    },
  });

  if (syncDisabledReason) {
    await prisma.representative.update({
      where: { id: representative.id },
      data: {
        openvikingLastSyncAt: startedAt,
        openvikingLastSyncStatus: "disabled",
        openvikingLastSyncError: syncDisabledReason,
        openvikingLastSyncItemCount: 0,
      },
    });

    const snapshot = await getRepresentativeOpenVikingSnapshot(params.representativeSlug);
    if (!snapshot) {
      throw new Error("Representative disappeared after OpenViking sync was skipped.");
    }
    return snapshot;
  }

  if (!env.hasModelCredentials) {
    await prisma.$transaction([
      prisma.representativeContextSync.update({
        where: { id: syncJob.id },
        data: {
          status: "blocked_missing_credentials",
          itemCount: 0,
          error: "OpenViking model credentials are not configured for this environment.",
          finishedAt: new Date(),
        },
      }),
      prisma.representative.update({
        where: { id: representative.id },
        data: {
          openvikingLastSyncAt: new Date(),
          openvikingLastSyncStatus: "blocked_missing_credentials",
          openvikingLastSyncError:
            "OpenViking model credentials are not configured for this environment.",
          openvikingLastSyncItemCount: 0,
        },
      }),
    ]);

    const snapshot = await getRepresentativeOpenVikingSnapshot(params.representativeSlug);
    if (!snapshot) {
      throw new Error("Representative disappeared after OpenViking sync was blocked.");
    }
    return snapshot;
  }

  const defaults = resolveRepresentativeDefaults(representative);
  const client = buildRepresentativeClient(representative);
  const documents = buildRepresentativeKnowledgeDocuments({
    slug: representative.slug,
    ownerName: representative.owner.displayName,
    name: representative.displayName,
    tagline: representative.roleSummary,
    tone: representative.tone,
    languages: parseStringArray(representative.languages),
    groupActivation: representative.groupActivation.toLowerCase(),
    publicMode: representative.publicMode,
    humanInLoop: representative.humanInLoop,
    freeReplyLimit: representative.freeReplyLimit,
    freeScope: parseStringArray(representative.freeScope),
    paywalledIntents: parseStringArray(representative.paywalledIntents),
    handoffWindowHours: representative.handoffWindowHours,
    skills: parseStringArray(representative.allowedSkills),
    knowledgePack: {
      identitySummary: representative.knowledgePack?.identitySummary ?? "",
      faq: parseKnowledgeDocuments(representative.knowledgePack?.faq),
      materials: parseKnowledgeDocuments(representative.knowledgePack?.materials),
      policies: parseKnowledgeDocuments(representative.knowledgePack?.policies),
    },
    pricing: representative.pricingPlans.map((plan) => ({
      tier: plan.type.toLowerCase(),
      name: plan.name,
      stars: plan.starsAmount,
      summary: plan.summary,
      includedReplies: plan.includedReplies,
      includesPriorityHandoff: plan.includesPriorityHandoff,
    })),
    handoffPrompt: representative.handoffPrompt,
  });

  try {
    for (const document of documents) {
      await syncDocumentToOpenViking({
        client,
        representativeSlug: representative.slug,
        document,
      });
    }

    await prisma.$transaction([
      prisma.representativeContextSync.update({
        where: { id: syncJob.id },
        data: {
          status: "succeeded",
          itemCount: documents.length,
          finishedAt: new Date(),
          error: null,
        },
      }),
      prisma.representative.update({
        where: { id: representative.id },
        data: {
          openvikingAgentId: representative.openvikingAgentId ?? defaults.agentId,
          openvikingTargetUri: representative.openvikingTargetUri ?? defaults.targetUri,
          openvikingLastSyncAt: new Date(),
          openvikingLastSyncStatus: "succeeded",
          openvikingLastSyncError: null,
          openvikingLastSyncItemCount: documents.length,
        },
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenViking sync failed.";
    await prisma.$transaction([
      prisma.representativeContextSync.update({
        where: { id: syncJob.id },
        data: {
          status: "failed",
          itemCount: 0,
          error: message,
          finishedAt: new Date(),
        },
      }),
      prisma.representative.update({
        where: { id: representative.id },
        data: {
          openvikingLastSyncAt: new Date(),
          openvikingLastSyncStatus: "failed",
          openvikingLastSyncError: message,
          openvikingLastSyncItemCount: 0,
        },
      }),
    ]);

    throw error;
  }

  const snapshot = await getRepresentativeOpenVikingSnapshot(params.representativeSlug);
  if (!snapshot) {
    throw new Error("Representative disappeared after OpenViking sync.");
  }

  return snapshot;
}

export async function maybeSyncRepresentativeOpenVikingResources(params: {
  representativeSlug: string;
  trigger: "create" | "setup_update";
}): Promise<void> {
  try {
    const snapshot = await getRepresentativeOpenVikingSnapshot(params.representativeSlug);
    if (!snapshot || !snapshot.enabled || !snapshot.resourceSyncEnabled) {
      return;
    }

    await syncRepresentativeOpenVikingResources({
      representativeSlug: params.representativeSlug,
      trigger: params.trigger,
    });
  } catch (error) {
    console.warn("OpenViking sync failed:", error);
  }
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

  return memories.map((memory) => ({
    id: memory.id,
    uri: memory.uri,
    scope: memory.scope,
    category: memory.category,
    summary: memory.summary,
    sourceKind: memory.sourceKind,
    createdAt: memory.createdAt.toISOString(),
    ...(memory.contact
      ? {
          contact: {
            id: memory.contact.id,
            displayName:
              memory.contact.displayName ??
              memory.contact.username ??
              memory.contact.telegramUserId,
          },
        }
      : {}),
  }));
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
  if (!["accepted", "closed"].includes(params.nextStatus)) {
    return;
  }

  const handoff = await prisma.handoffRequest.findFirst({
    where: {
      id: params.handoffId,
      representative: {
        slug: params.representativeSlug,
      },
    },
    include: {
      representative: true,
      contact: true,
    },
  });

  if (!handoff?.representative.openvikingEnabled) {
    return;
  }

  const summary = sanitizePublicSafeText(handoff.summary, 1200);
  if (!summary) {
    return;
  }

  const document = buildHandoffResolutionPatternDocument({
    representativeSlug: handoff.representative.slug,
    key: `${handoff.id}-${params.nextStatus}`,
    title: `Handoff ${params.nextStatus}`,
    summary,
    recommendedAction: handoff.recommendedOwnerAction,
    status: params.nextStatus,
  });

  if (!document) {
    return;
  }

  try {
    await syncMemoryDocumentAndRecord({
      tx: prisma,
      representativeId: handoff.representativeId,
      representativeSlug: handoff.representative.slug,
      openvikingAgentId: handoff.representative.openvikingAgentId,
      contactId: handoff.contactId,
      document,
      sourceKind: "handoff_resolution",
    });
  } catch (error) {
    console.warn("OpenViking handoff pattern sync failed:", error);
  }
}

function resolveRepresentativeDefaults(representative: Pick<
  Representative,
  "slug" | "openvikingAgentId" | "openvikingTargetUri"
>) {
  const env = resolveOpenVikingEnv();
  const agentId = representative.openvikingAgentId ?? buildOpenVikingAgentId(representative.slug, env);
  return {
    agentId,
    targetUri: representative.openvikingTargetUri ?? buildRepresentativeResourceRootUri(representative.slug),
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
      timeout: 60,
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
    timeout: 60,
  });
  await params.client.move({
    fromUri: stagingUri,
    toUri: params.document.uri,
  });
}

async function syncMemoryDocumentAndRecord(params: {
  tx: PrismaClient;
  representativeId: string;
  representativeSlug: string;
  openvikingAgentId?: string | null;
  contactId?: string;
  document: OpenVikingDocumentSpec;
  sourceKind: string;
}): Promise<void> {
  const env = resolveOpenVikingEnv();
  if (!env.enabled || !env.hasModelCredentials) {
    return;
  }

  const client = buildRepresentativeClient({
    slug: params.representativeSlug,
    openvikingAgentId: params.openvikingAgentId ?? null,
  });

  await syncDocumentToOpenViking({
    client,
    representativeSlug: params.representativeSlug,
    document: params.document,
  });
  const audienceIdentityId = await resolveContactAudienceIdentityId(params.tx, params.contactId);

  await params.tx.openVikingMemoryRecord.upsert({
    where: { uri: params.document.uri },
    create: {
      representativeId: params.representativeId,
      ...(params.contactId ? { contactId: params.contactId } : {}),
      ...(audienceIdentityId ? { audienceIdentityId } : {}),
      uri: params.document.uri,
      contextType: params.document.contextType,
      scope: params.document.scope,
      category: params.document.category,
      summary: buildSummaryFromDocument(params.document.content),
      sourceKind: params.sourceKind,
    },
    update: {
      ...(params.contactId ? { contactId: params.contactId } : {}),
      ...(audienceIdentityId ? { audienceIdentityId } : {}),
      contextType: params.document.contextType,
      scope: params.document.scope,
      category: params.document.category,
      summary: buildSummaryFromDocument(params.document.content),
      sourceKind: params.sourceKind,
    },
  });
}

async function resolveContactAudienceIdentityId(
  tx: PrismaClient,
  contactId: string | undefined,
): Promise<string | null> {
  if (!contactId) {
    return null;
  }

  const contact = await tx.contact.findUnique({
    where: { id: contactId },
    select: { audienceIdentityId: true },
  });

  return contact?.audienceIdentityId ?? null;
}

function buildSummaryFromDocument(content: string): string {
  const normalized = content
    .replace(/^# .+\n+/m, "")
    .replace(/\n+/g, " ")
    .trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
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

function parseStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseKnowledgeDocuments(
  value: Prisma.JsonValue | null | undefined,
): Array<{ title: string; summary: string; url?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const title =
        typeof (entry as { title?: unknown }).title === "string"
          ? (entry as { title: string }).title.trim()
          : "";
      const summary =
        typeof (entry as { summary?: unknown }).summary === "string"
          ? (entry as { summary: string }).summary.trim()
          : "";
      const url =
        typeof (entry as { url?: unknown }).url === "string"
          ? (entry as { url: string }).url.trim()
          : "";

      if (!title || !summary) {
        return null;
      }

      return {
        title,
        summary,
        ...(url ? { url } : {}),
      };
    })
    .filter((entry): entry is { title: string; summary: string; url?: string } => Boolean(entry));
}
