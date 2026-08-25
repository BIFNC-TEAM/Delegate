import { createHash, randomUUID } from "node:crypto";

import {
  buildGovernedContactChannelMemoryRootUri,
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedMemoryManagedUserId,
  buildGovernedRepresentativeExperienceRootUri,
  buildGovernedRepresentativeExperienceVersionUri,
  buildGovernedSharedContactMemoryRootUri,
  buildGovernedSharedContactMemoryVersionUri,
  buildOpenVikingAgentId,
  buildRepresentativeKnowledgeDocuments,
  buildRepresentativeResourceRootUri,
  buildRepresentativeVersionResourceRootUri,
  buildRepresentativeVersionKnowledgeAssetUri,
  OpenVikingClient,
  OpenVikingRequestError,
  resolveOpenVikingEnv,
  sanitizePublicSafeText,
  type OpenVikingDocumentSpec,
  type OpenVikingMatchedContext,
  type OpenVikingRecallItem,
} from "@delegate/openviking";
import {
  EventType,
  KnowledgeAssetStatus,
  MemoryPolicyDecisionOutcome,
  MemoryUseSourceKind,
  Prisma,
  PublicKnowledgeProjectionSourceKind,
  RepresentativeChannelKind,
  type Representative,
} from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";
import { hasCurrentMemoryChannelDisclosureForMessage } from "./memory-disclosure";
import { resolveContactMemorySharingEligibility } from "./memory-extraction";
import { lockAndResolveExactMessageIdentityEvidence } from "./contact-memory-source-evidence";
import {
  isContactChannelMemorySourceAfterForgetBoundary,
  loadLatestContactChannelMemoryForgetBoundary,
  lockContactChannelMemoryCoordinate,
} from "./memory-forget-boundary";
import { lockContactSharedMemoryCoordinate } from "./memory-governance";
import {
  failMemoryUseRun,
  markMemoryUseRunDegraded,
  recordMemoryUseSearchHits,
  startOrReuseMemoryUseRun,
} from "./memory-use-execution";
import {
  assertLegacyOpenVikingMemoryUriForRepresentative,
  LegacyOpenVikingMemoryUriError,
  syncRepresentativeResourceDocumentToOpenViking,
  type VerifiedRepresentativeResourceProjection,
} from "./openviking-boundaries";

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

type RepresentativeOpenVikingDocumentSync = (params: {
  client: OpenVikingClient;
  document: OpenVikingDocumentSpec;
}) => Promise<VerifiedRepresentativeResourceProjection>;

type PublishedResourceProjectionSpec = {
  document: OpenVikingDocumentSpec;
  sourceKind: PublicKnowledgeProjectionSourceKind;
  resourceKey: string;
  knowledgeAssetId?: string;
  citationTitle?: string;
};

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
});

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
  syncDocument?: RepresentativeOpenVikingDocumentSync;
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
  let verifiedItemCount = 0;
  try {
    const projectionSpecs = await buildPublishedResourceProjectionSpecs({
      representative: {
        id: representative.id,
        ownerId: representative.ownerId,
        slug: representative.slug,
      },
      publishedVersionId: requestedVersion.id,
      snapshot: runtime,
    });
    await ensurePublishedResourceManifest({
      representativeId: representative.id,
      publishedVersionId: requestedVersion.id,
      specs: projectionSpecs,
    });
    for (const spec of projectionSpecs) {
      const leaseRenewed = await renewRepresentativeOpenVikingSyncJobLease({
        jobId: job.id,
        leaseToken,
        leaseMs,
      });
      if (!leaseRenewed) {
        throw new Error("OpenViking sync job lease was lost.");
      }
      const receipt = params.syncDocument
        ? await params.syncDocument({ client, document: spec.document })
        : await syncRepresentativeResourceDocumentToOpenViking({
          client,
          document: spec.document,
          expectedRootUri: versionResourceRoot,
          timeoutSeconds: REPRESENTATIVE_RESOURCE_SYNC_TIMEOUT_SECONDS,
        });
      assertVerifiedPublishedResourceReceipt({
        document: spec.document,
        receipt,
      });
      await recordVerifiedPublicKnowledgeProjection({
        representativeId: representative.id,
        publishedVersionId: requestedVersion.id,
        spec,
        receipt,
        projectedAt: new Date(),
      });
      verifiedItemCount += 1;
    }

    const settled = await settleRepresentativeOpenVikingSyncJob({
      job,
      leaseToken,
      status: "succeeded",
      itemCount: projectionSpecs.length,
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
        itemCount: verifiedItemCount,
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
      itemCount: verifiedItemCount,
      error: message,
      now: new Date(),
    });
    return settled
      ? { processed: true, status: "failed" }
      : { processed: false };
  }
}

const REPRESENTATIVE_AGGREGATE_RESOURCE_KEYS = {
  identity: "identity/profile.md",
  faq: "faq/index.md",
  materials: "materials/index.md",
  policies: "policies/index.md",
} as const;

async function buildPublishedResourceProjectionSpecs(params: {
  representative: { id: string; ownerId: string; slug: string };
  publishedVersionId: string;
  snapshot: z.output<typeof publishedRepresentativeSnapshotSchema>;
}): Promise<PublishedResourceProjectionSpec[]> {
  const aggregateSpecs = buildPublishedAggregateProjectionSpecs(params);
  const pins = [...params.snapshot.knowledgeAssets].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
  if (new Set(pins.map(({ assetId }) => assetId)).size !== pins.length) {
    throw new Error("Published representative snapshot contains duplicate knowledge asset pins.");
  }
  const storedResources = pins.length
    ? await prisma.representativeVersionResource.findMany({
        where: {
          publishedVersionId: params.publishedVersionId,
          representativeId: params.representative.id,
          sourceKind: PublicKnowledgeProjectionSourceKind.KNOWLEDGE_ASSET,
        },
        select: {
          publishedVersionId: true,
          representativeId: true,
          sourceKind: true,
          resourceKey: true,
          knowledgeAssetId: true,
          contentHash: true,
          safeText: true,
          citationTitle: true,
        },
      })
    : [];
  const storedByAssetId = new Map(
    storedResources.flatMap((resource) =>
      resource.knowledgeAssetId ? [[resource.knowledgeAssetId, resource] as const] : []),
  );
  const missingPins = pins.filter((pin) => !storedByAssetId.has(pin.assetId));
  const assets = missingPins.length
    ? await prisma.knowledgeAsset.findMany({
        where: {
          id: { in: missingPins.map(({ assetId }) => assetId) },
          representativeLinks: {
            some: {
              representativeId: params.representative.id,
              enabled: true,
              reviewStatus: "APPROVED",
            },
          },
        },
        select: {
          id: true,
          ownerId: true,
          title: true,
          status: true,
          archivedAt: true,
          checksum: true,
          processingVersion: true,
          extractedText: true,
        },
      })
    : [];
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const assetSpecs = pins.flatMap((pin): PublishedResourceProjectionSpec[] => {
    const expectedResourceKey = `knowledge/${pin.assetId}.md`;
    const stored = storedByAssetId.get(pin.assetId);
    if (stored) {
      if (
        stored.publishedVersionId !== params.publishedVersionId
        || stored.representativeId !== params.representative.id
        || stored.sourceKind !== PublicKnowledgeProjectionSourceKind.KNOWLEDGE_ASSET
        || stored.resourceKey !== expectedResourceKey
        || stored.knowledgeAssetId !== pin.assetId
        || stored.contentHash !== pin.checksum
        || !stored.safeText
        || sha256Text(stored.safeText) !== stored.contentHash
      ) {
        // A malformed immutable row is isolated to this resource. Never fall
        // back to current mutable KnowledgeAsset bytes for the same pin.
        return [];
      }
      return [{
        document: {
          uri: buildRepresentativeVersionKnowledgeAssetUri(
            params.representative.slug,
            params.publishedVersionId,
            pin.assetId,
          ),
          filename: `${pin.assetId}.md`,
          content: stored.safeText,
          reason: "Immutable KnowledgeAsset snapshot pinned to a RepresentativeVersion",
          contextType: "resource",
          scope: "representative",
          category: "knowledge_asset",
        },
        sourceKind: PublicKnowledgeProjectionSourceKind.KNOWLEDGE_ASSET,
        resourceKey: expectedResourceKey,
        knowledgeAssetId: pin.assetId,
        citationTitle: sanitizePublicSafeText(stored.citationTitle ?? "", 200)
          ?? "Published knowledge",
      }];
    }

    // Compatibility path for releases created before atomic resource
    // snapshots existed. Capture only an exact still-current pin; otherwise
    // omit this resource while allowing unrelated published resources to sync.
    const asset = assetsById.get(pin.assetId);
    if (
      !asset
      || asset.ownerId !== params.representative.ownerId
      || asset.status !== KnowledgeAssetStatus.READY
      || asset.archivedAt !== null
      || !asset.extractedText
      || !pin.checksum
      || !/^[0-9a-f]{64}$/u.test(pin.checksum)
      || asset.checksum !== pin.checksum
      || asset.processingVersion !== pin.processingVersion
      || sha256Text(asset.extractedText) !== pin.checksum
    ) {
      return [];
    }
    return [{
      document: {
        uri: buildRepresentativeVersionKnowledgeAssetUri(
          params.representative.slug,
          params.publishedVersionId,
          asset.id,
        ),
        filename: `${asset.id}.md`,
        content: asset.extractedText,
        reason: "Published KnowledgeAsset pinned to a RepresentativeVersion",
        contextType: "resource",
        scope: "representative",
        category: "knowledge_asset",
      },
      sourceKind: PublicKnowledgeProjectionSourceKind.KNOWLEDGE_ASSET,
      resourceKey: expectedResourceKey,
      knowledgeAssetId: asset.id,
      citationTitle: sanitizePublicSafeText(asset.title, 200) ?? "Published knowledge",
    }];
  });
  return [...aggregateSpecs, ...assetSpecs];
}

function buildPublishedAggregateProjectionSpecs(params: {
  representative: { slug: string };
  publishedVersionId: string;
  snapshot: z.output<typeof publishedRepresentativeSnapshotSchema>;
}): PublishedResourceProjectionSpec[] {
  const knowledge = params.snapshot.knowledge ?? {
    identitySummary: "",
    faq: [],
    materials: [],
    policies: [],
  };
  const aggregateDocuments = buildRepresentativeKnowledgeDocuments({
    slug: params.representative.slug,
    representativeVersionId: params.publishedVersionId,
    name: params.snapshot.identity.displayName,
    tagline: params.snapshot.identity.roleSummary,
    tone: params.snapshot.identity.tone,
    languages: params.snapshot.identity.languages,
    groupActivation: params.snapshot.groupActivation,
    publicMode: params.snapshot.publicMode,
    humanInLoop: params.snapshot.humanInLoop,
    freeReplyLimit: params.snapshot.conversation.freeReplyLimit,
    handoffWindowHours: params.snapshot.conversation.handoffWindowHours,
    skills: params.snapshot.governance.allowedSkills,
    knowledgePack: {
      identitySummary: knowledge.identitySummary,
      faq: normalizePublishedKnowledgeDocuments(knowledge.faq),
      materials: normalizePublishedKnowledgeDocuments(knowledge.materials),
      policies: normalizePublishedKnowledgeDocuments(knowledge.policies),
    },
    handoffPrompt: params.snapshot.conversation.handoffPrompt,
  });
  const aggregateSpecs = aggregateDocuments.map((document) => {
    const resourceKey = REPRESENTATIVE_AGGREGATE_RESOURCE_KEYS[
      document.category as keyof typeof REPRESENTATIVE_AGGREGATE_RESOURCE_KEYS
    ];
    if (!resourceKey) {
      throw new Error(`Unexpected published representative resource category: ${document.category}.`);
    }
    return {
      document,
      sourceKind: PublicKnowledgeProjectionSourceKind.REPRESENTATIVE_VERSION_RESOURCE,
      resourceKey,
    } satisfies PublishedResourceProjectionSpec;
  });
  if (
    aggregateSpecs.length !== Object.keys(REPRESENTATIVE_AGGREGATE_RESOURCE_KEYS).length
    || new Set(aggregateSpecs.map(({ resourceKey }) => resourceKey)).size
      !== aggregateSpecs.length
  ) {
    throw new Error("Published representative snapshot did not produce the five canonical resources.");
  }
  return aggregateSpecs;
}

async function ensurePublishedResourceManifest(params: {
  representativeId: string;
  publishedVersionId: string;
  specs: PublishedResourceProjectionSpec[];
}): Promise<void> {
  const expected = params.specs.map((spec) => ({
    publishedVersionId: params.publishedVersionId,
    representativeId: params.representativeId,
    sourceKind: spec.sourceKind,
    resourceKey: spec.resourceKey,
    knowledgeAssetId: spec.knowledgeAssetId ?? null,
    contentHash: sha256Text(spec.document.content),
    safeText: spec.document.content,
    citationTitle: spec.citationTitle
      ?? resolveRecallTitle(spec.document.content, spec.document.uri),
  }));
  await prisma.$transaction(async (tx) => {
    await tx.representativeVersionResource.createMany({
      data: expected,
      skipDuplicates: true,
    });
    const stored = await tx.representativeVersionResource.findMany({
      where: {
        publishedVersionId: params.publishedVersionId,
        resourceKey: { in: expected.map(({ resourceKey }) => resourceKey) },
      },
    });
    const storedByKey = new Map(stored.map((item) => [item.resourceKey, item]));
    for (const item of expected) {
      const persisted = storedByKey.get(item.resourceKey);
      if (
        !persisted
        || persisted.representativeId !== item.representativeId
        || persisted.sourceKind !== item.sourceKind
        || persisted.knowledgeAssetId !== item.knowledgeAssetId
        || persisted.contentHash !== item.contentHash
        || persisted.safeText !== item.safeText
        || persisted.citationTitle !== item.citationTitle
      ) {
        throw new Error(
          "Published representative resource manifest conflicts with the immutable version snapshot.",
        );
      }
    }
  });
}

function assertVerifiedPublishedResourceReceipt(params: {
  document: OpenVikingDocumentSpec;
  receipt: VerifiedRepresentativeResourceProjection;
}): void {
  const contentHash = sha256Text(params.document.content);
  if (
    params.receipt.remoteUri !== params.document.uri
    || params.receipt.contentHash !== contentHash
  ) {
    throw new Error(
      "Published representative knowledge sync returned an unverified URI or content hash.",
    );
  }
}

async function recordVerifiedPublicKnowledgeProjection(params: {
  representativeId: string;
  publishedVersionId: string;
  spec: PublishedResourceProjectionSpec;
  receipt: VerifiedRepresentativeResourceProjection;
  projectedAt: Date;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.publicKnowledgeProjectionItem.findFirst({
      where: {
        publishedVersionId: params.publishedVersionId,
        resourceKey: params.spec.resourceKey,
      },
    });
    const expected = {
      representativeId: params.representativeId,
      publishedVersionId: params.publishedVersionId,
      sourceKind: params.spec.sourceKind,
      resourceKey: params.spec.resourceKey,
      knowledgeAssetId: params.spec.knowledgeAssetId ?? null,
      provider: "openviking",
      contentHash: params.receipt.contentHash,
      remoteUri: params.receipt.remoteUri,
    };
    if (existing) {
      if (
        existing.representativeId !== expected.representativeId
        || existing.publishedVersionId !== expected.publishedVersionId
        || existing.sourceKind !== expected.sourceKind
        || existing.resourceKey !== expected.resourceKey
        || existing.knowledgeAssetId !== expected.knowledgeAssetId
        || existing.provider !== expected.provider
        || existing.contentHash !== expected.contentHash
        || existing.remoteUri !== expected.remoteUri
      ) {
        throw new Error(
          "Published knowledge projection ledger conflicts with the verified immutable resource.",
        );
      }
      // Projection rows are immutable evidence. A matching retry is already
      // idempotently complete; the sync job records the new attempt time.
      return;
    }
    await tx.publicKnowledgeProjectionItem.create({
      data: {
        ...expected,
        projectedAt: params.projectedAt,
      },
    });
  });
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
  memoryUseItemId: string;
  internalSource: {
    sourceKind: RepresentativeRecallSourceKind;
    contentHash?: string;
    memoryVersionId?: string;
    projectionItemId?: string;
    publicKnowledgeProjectionId?: string;
    publicResourceKey?: string;
    memoryUseItemId?: string;
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
  memoryUseRunId?: string;
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

type PublicKnowledgeRecallGrant = {
  uri: string;
  sourceKind: "PUBLIC_KNOWLEDGE";
  publicKnowledgeProjectionId: string;
  contentHash: string;
  resourceKey: string;
  safeText: string;
  title: string;
  knowledgeAssetId?: string;
};

type RepresentativeRecallAuthorization = {
  publishedVersionRoot?: string;
  publicKnowledgeGrantsByUri: Map<string, PublicKnowledgeRecallGrant>;
  memoryManagedUserId?: string;
  memoryRoots: string[];
  memoryGrantsByUri: Map<string, GovernedMemoryRecallGrant>;
  memorySearchConfig?: {
    limit: number;
    scoreThreshold: number;
  };
};

type AuthorizedRecallSource =
  | PublicKnowledgeRecallGrant
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

const MEMORY_RECALL_QUERY_BLOCKED_REASON = "memory_recall_query_blocked";

const SAFE_RECALL_QUERIES = {
  pricing: "published pricing and service terms",
  refund: "published refund and cancellation policy",
  materials: "published materials and case studies",
  scheduling: "published scheduling and availability policy",
  contact: "published collaboration and contact process",
  identity: "published representative identity and services",
  preferences: "approved communication preferences",
  general: "published representative knowledge and approved communication preferences",
} as const;

type RecallQueryClassification =
  | { kind: "empty" }
  | { kind: "blocked" }
  | {
      kind: "safe";
      publicKnowledgeBaseQuery: string;
      publicKnowledgeTopicQuery?: string;
      governedMemoryQuery: (typeof SAFE_RECALL_QUERIES)[keyof typeof SAFE_RECALL_QUERIES];
    };

const SAFE_PUBLIC_KNOWLEDGE_QUERY_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "at", "be", "can", "could", "did",
  "answer", "audience", "beginner", "beginners", "clearly", "define", "describe",
  "do", "does", "explain", "explicit", "explicitly", "find", "first", "for",
  "from", "guide", "how", "i", "in", "internal", "internals", "introduction",
  "is", "it", "know", "knowledge", "learn", "learning", "list", "lookup",
  "material", "materials", "method", "methods",
  "may", "me", "my", "of", "on", "or", "our", "please", "should", "tell",
  "representative", "retrieval", "retrieve", "search", "source", "sources", "step",
  "steps", "student", "students", "summarize", "summary", "that", "the", "this",
  "to", "tutorial", "us", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "you", "your",
  "一下", "为什么", "什么", "多少", "你", "你是", "你们", "谁", "自己", "告诉", "告诉我", "呢", "吗", "哪个",
  "哪些", "如何", "帮", "帮忙", "帮我", "怎么", "怎样", "我们", "我", "是否", "是",
  "有", "有没有", "的", "地", "得", "和", "或", "及", "与", "能", "能否", "解释",
  "请", "请问", "说明", "关于", "可以", "您", "应该", "知道", "了解", "学习", "学会",
  "掌握", "使用", "中文", "英文", "介绍", "讲解", "回答", "给", "给出", "列出", "总结",
  "概括", "分析", "查询", "查找", "搜索", "三步", "步骤", "方法", "方式", "建议", "教程",
  "入门", "相关", "内容", "知识", "问题", "答案", "方面", "对于", "针对", "想", "想要",
  "需要", "会", "在", "为", "把", "被", "从", "到", "上", "下", "中", "里", "了", "吧",
  "啊", "呀", "么", "出", "并", "先", "查", "查不到", "找", "找不到", "检索", "命中",
  "未命中", "代表", "代表知识", "资料", "要", "明确", "初中生", "小学生", "高中生",
  "大学生", "学生", "儿童", "孩子", "新手", "初学者", "受众", "用户", "读者",
]);

const PUBLIC_KNOWLEDGE_TOPIC_PREFIX = "published knowledge about ";
const MAX_PUBLIC_KNOWLEDGE_TOPIC_TERMS = 16;

/**
 * Convert untrusted audience text into a sanitized published-knowledge query
 * while keeping governed-memory retrieval on a small, fixed vocabulary.
 * OpenViking never receives the original message. Dynamic topic terms are
 * admitted later only when they also occur in an authorized published corpus;
 * visitor-only text stays inside the conversation privacy boundary.
 */
function classifyRecallQuery(rawQueryText: string): RecallQueryClassification {
  const queryText = rawQueryText.trim();
  if (!queryText) return { kind: "empty" };
  if (recallQueryContainsRestrictedData(queryText)) return { kind: "blocked" };

  const normalized = queryText.toLocaleLowerCase("en-US");
  const topicQuery = buildSanitizedPublicKnowledgeQuery(queryText);
  if (/refund|cancel|cancellation|退款|退费|取消/u.test(normalized)) {
    return safeRecallQuery(SAFE_RECALL_QUERIES.refund, undefined, topicQuery);
  }
  if (/price|pricing|cost|quote|plan|多少钱|价格|报价|套餐|收费/u.test(normalized)) {
    return safeRecallQuery(SAFE_RECALL_QUERIES.pricing, undefined, topicQuery);
  }
  if (/case stud|portfolio|material|guide|download|案例|作品|材料|资料|指南/u.test(normalized)) {
    return safeRecallQuery(SAFE_RECALL_QUERIES.materials, undefined, topicQuery);
  }
  if (/schedule|availability|appointment|meeting|calendar|时间|日程|预约|会议/u.test(normalized)) {
    return safeRecallQuery(SAFE_RECALL_QUERIES.scheduling, undefined, topicQuery);
  }
  if (/contact|collaborat|handoff|human|owner|联系|合作|人工|转接/u.test(normalized)) {
    return safeRecallQuery(SAFE_RECALL_QUERIES.contact, undefined, topicQuery);
  }
  if (/remember|preference|prefer|previous|last time|记得|偏好|上次|此前/u.test(normalized)) {
    return safeRecallQuery(
      SAFE_RECALL_QUERIES.general,
      SAFE_RECALL_QUERIES.preferences,
      topicQuery,
    );
  }
  if (
    /who are|what do you|about you|your services?|你是谁|做什么|服务/u.test(normalized)
    || /(?:介绍|说明).{0,6}(?:你自己|数字代表|这个代表)/u.test(normalized)
    || /(?:代表).{0,6}(?:是谁|会什么|能做什么)/u.test(normalized)
  ) {
    return safeRecallQuery(SAFE_RECALL_QUERIES.identity, undefined, topicQuery);
  }
  return safeRecallQuery(
    SAFE_RECALL_QUERIES.general,
    SAFE_RECALL_QUERIES.general,
    topicQuery,
  );
}

function safeRecallQuery(
  publicKnowledgeBaseQuery: string,
  governedMemoryQuery: (typeof SAFE_RECALL_QUERIES)[keyof typeof SAFE_RECALL_QUERIES]
    = SAFE_RECALL_QUERIES.general,
  publicKnowledgeTopicQuery?: string,
): Extract<RecallQueryClassification, { kind: "safe" }> {
  return {
    kind: "safe",
    publicKnowledgeBaseQuery,
    ...(publicKnowledgeTopicQuery ? { publicKnowledgeTopicQuery } : {}),
    governedMemoryQuery,
  };
}

/**
 * Preserve low-risk topic semantics for published-knowledge retrieval without
 * forwarding the audience's original sentence. High-risk queries are blocked
 * before this helper runs; this second layer removes question scaffolding,
 * punctuation, identifier-like tokens, duplicates, and excess length.
 */
function buildSanitizedPublicKnowledgeQuery(queryText: string): string {
  const semanticTerms = extractPublicKnowledgeTopicTerms(queryText);
  return semanticTerms.length
    ? `${PUBLIC_KNOWLEDGE_TOPIC_PREFIX}${semanticTerms.join(" ")}`
    : SAFE_RECALL_QUERIES.general;
}

/**
 * Derive a small deterministic set of topic anchors. Chinese segments are
 * folded into the longest non-generic 2-4 character phrase available so a
 * single character such as `线` cannot authorize a different concept such as
 * `等高线` for an `等温线` question. Latin terms are retained as complete
 * identifiers/words and must later be covered exactly by the authorized body.
 */
function extractPublicKnowledgeTopicTerms(queryText: string): string[] {
  const normalized = queryText.normalize("NFKC");
  const segmenter = new Intl.Segmenter(
    /\p{Script=Han}/u.test(normalized) ? "zh-CN" : "en-US",
    { granularity: "word" },
  );
  const topicTerms: string[] = [];
  let hanBuffer = "";
  const flushHanBuffer = () => {
    if (hanBuffer.length >= 2) topicTerms.push(hanBuffer);
    hanBuffer = "";
  };
  const appendHanToken = (token: string) => {
    if (token.length <= 4) {
      if (hanBuffer && hanBuffer.length + token.length > 4) flushHanBuffer();
      hanBuffer += token;
      if (hanBuffer.length === 4) flushHanBuffer();
      return;
    }
    flushHanBuffer();
    let remaining = token;
    while (remaining) {
      const take = Math.min(4, remaining.length);
      hanBuffer = remaining.slice(0, take);
      remaining = remaining.slice(take);
      if (hanBuffer.length === 4) flushHanBuffer();
    }
  };
  for (const segment of segmenter.segment(normalized)) {
    if (!segment.isWordLike) {
      flushHanBuffer();
      continue;
    }
    const token = segment.segment.toLocaleLowerCase("en-US").trim();
    if (
      !token
      || token.length > 64
      || /[_@]/u.test(token)
      || /^\d{5,}$/u.test(token)
      || /^[a-z]*\d[a-z\d-]{7,}$/iu.test(token)
    ) {
      flushHanBuffer();
      continue;
    }
    if (isPublicKnowledgeTopicStopWord(token)) {
      flushHanBuffer();
      continue;
    }
    if (/^\p{Script=Han}+$/u.test(token)) {
      appendHanToken(token);
      continue;
    }
    flushHanBuffer();
    if (/^[a-z][a-z\d-]*$/iu.test(token) && token.length >= 3) {
      topicTerms.push(token);
    }
    if (topicTerms.length >= MAX_PUBLIC_KNOWLEDGE_TOPIC_TERMS) break;
  }
  flushHanBuffer();
  return normalizePublicKnowledgeTopicTerms(topicTerms)
    .slice(0, MAX_PUBLIC_KNOWLEDGE_TOPIC_TERMS);
}

function isPublicKnowledgeTopicStopWord(token: string) {
  return SAFE_PUBLIC_KNOWLEDGE_QUERY_STOP_WORDS.has(token)
    || /^[一二三四五六七八九十百\d]+步$/u.test(token);
}

function normalizePublicKnowledgeTopicTerms(terms: readonly string[]) {
  const normalized = new Set<string>();
  for (const rawTerm of terms) {
    const term = rawTerm.normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if (
      !term
      || term.length > 64
      || isPublicKnowledgeTopicStopWord(term)
      || /[_@]/u.test(term)
    ) continue;
    if (/^\p{Script=Han}+$/u.test(term)) {
      if (term.length >= 2 && term.length <= 4) normalized.add(term);
      continue;
    }
    if (/^[a-z][a-z\d-]*$/iu.test(term) && term.length >= 3) {
      normalized.add(term);
    }
  }
  return [...normalized];
}

/**
 * Dynamic topic terms may leave the conversation boundary only when the same
 * normalized term already exists in an authorized, immutable published
 * resource. This corpus-derived allowlist keeps visitor-only names, private
 * project codes, health facts, and other arbitrary text out of OpenViking
 * without reducing known product intents to a generic query.
 */
function authorizePublicKnowledgeQueryAgainstPublishedCorpus(params: {
  baseQuery: string;
  topicQuery?: string;
  grants: ReadonlyMap<string, PublicKnowledgeRecallGrant>;
}): {
  query: string | null;
  authorizedTopicTerms: string[];
  topicMatchTerms: string[];
} {
  if (!params.topicQuery) {
    return { query: params.baseQuery, authorizedTopicTerms: [], topicMatchTerms: [] };
  }
  if (!params.topicQuery.startsWith(PUBLIC_KNOWLEDGE_TOPIC_PREFIX)) {
    return { query: params.baseQuery, authorizedTopicTerms: [], topicMatchTerms: [] };
  }
  const queryTerms = normalizePublicKnowledgeTopicTerms(
    params.topicQuery.slice(PUBLIC_KNOWLEDGE_TOPIC_PREFIX.length)
      .split(/\s+/u)
      .filter(Boolean),
  );
  if (!queryTerms.length) {
    return { query: params.baseQuery, authorizedTopicTerms: [], topicMatchTerms: [] };
  }
  const authorizedResources = [...params.grants.values()].map((grant) =>
    grant.safeText.normalize("NFKC").toLocaleLowerCase("en-US")
  );
  const authorizedTerms = queryTerms.filter((term) =>
    authorizedResources.some((resource) => resource.includes(term))
  );
  const corpusMatchesTopic = publicKnowledgeSourceMatchesAuthorizedTopic(
    authorizedResources.join("\n"),
    queryTerms,
  );
  if (!corpusMatchesTopic) {
    return { query: null, authorizedTopicTerms: [], topicMatchTerms: queryTerms };
  }
  const authorizedTopic = authorizedTerms.join(" ");
  return {
    query: params.baseQuery === SAFE_RECALL_QUERIES.general
      ? `${PUBLIC_KNOWLEDGE_TOPIC_PREFIX}${authorizedTopic}`
      : `${params.baseQuery}; authorized published topic: ${authorizedTopic}`,
    authorizedTopicTerms: authorizedTerms,
    topicMatchTerms: queryTerms,
  };
}

function recallQueryContainsRestrictedData(queryText: string): boolean {
  if (queryText.length > 4_000) return true;

  const restrictedPatterns = [
    // Prompt-injection instructions are not converted into recall semantics.
    /(?:ignore|disregard|override|forget)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions?/iu,
    /(?:ignore|disregard|override|forget)\s+(?:all\s+)?instructions?/iu,
    /(?:reveal|show|print|repeat|expose)\s+(?:the\s+)?(?:system|developer)\s+prompt/iu,
    /(?:system|developer)\s*prompt\s*[:：]/iu,
    /(?:忽略|无视|覆盖|绕过|忘掉).{0,16}(?:之前|以上|系统|开发者).{0,8}(?:指令|提示词|规则)/u,
    /(?:忽略|无视|覆盖|绕过|忘掉).{0,8}(?:全部|所有)?.{0,4}(?:指令|提示词|规则)/u,
    /(?:泄露|显示|输出|复述).{0,12}(?:系统|开发者).{0,6}(?:提示词|指令)/u,
    /(?:永久|长期).{0,8}(?:记住|保存).{0,12}(?:指令|提示词|规则)/u,

    // Credentials and common machine-secret formats.
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|private[_ -]?key|client[_ -]?secret|secret|credential|bearer)\s*(?:[:=]|\bis\b)\s*\S+/iu,
    /(?:密码|口令|密钥|令牌|私钥|访问令牌|凭据)\s*(?:[:：=]|是|为)\s*\S+/u,
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/u,

    // Direct contact identifiers and high-risk identity fields.
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    /(?:^|[^\d])(?:\+?\d[\d\s().-]{7,}\d)(?:$|[^\d])/u,
    /\b\d{15}(?:\d{2}[\dXx])?\b/u,
    /\b\d{3}-?\d{2}-?\d{4}\b/u,
    /\b(?:my|full)\s+name\s+is\s+[\p{L}][\p{L}\p{M}' -]{0,80}/iu,
    /(?:我叫|我的名字是|姓名\s*[:：=]?)[\p{Script=Han}A-Za-z·]{1,40}/u,
    /(?:身份证|护照|社保号|住址|家庭地址|passport|social security|ssn|home address)\s*(?:[:：=]|\bis\b|是|为)\s*\S+/iu,

    // Special-category personal data and private organizational context.
    /\b(?:my\s+)?(?:diagnosis|medical\s+(?:history|record)|health\s+condition|disability\s+status|religion|religious\s+belief|race|ethnicity|political\s+(?:view|affiliation)|sexual\s+orientation|gender\s+identity|trade\s+union)\s*(?:is|are|:)/iu,
    /\bi\s+(?:have\s+been|was)\s+diagnosed\s+with\b|\bi\s+(?:have|suffer\s+from|live\s+with)\s+(?:diabetes|cancer|hiv|aids|autism|epilepsy|depression|bipolar\s+disorder|multiple\s+sclerosis)\b/iu,
    /(?:我的?)?(?:诊断|病历|病史|健康状况|残疾情况|宗教信仰|种族|民族|族裔|政治立场|党派归属|性取向|性别认同|工会归属)\s*(?:是|为|[:：])/u,
    /我(?:患有|被诊断为|被确诊为)|我是(?:残疾人|残障人士|聋人|盲人|基督徒|穆斯林|共产党员|同性恋|双性恋|跨性别)/u,
    /(?:trade\s+secret|commercial\s+secret|confidential|strictly\s+internal|under\s+nda|proprietary|internal\s+project|unpublished\s+project|project\s+codename|商业机密|商业秘密|保密信息|严格保密|仅限内部|内部机密|内部项目|未发布项目|项目代号)/iu,

    // Payment facts and monetary values are always read from the live system,
    // never searched in long-term memory. Generic pricing questions remain
    // eligible and are mapped to the fixed pricing query above.
    /(?:[$€£¥￥]\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:usd|cny|rmb|eur|gbp|dollars?|元|人民币|美元)\b)/iu,
    /(?:balance|余额|card number|银行卡号|信用卡号|payment id|transaction id|支付单号|交易单号|订单号)\s*(?:[:：=]|\bis\b|是|为)\s*\S+/iu,
    /(?:\bpaid\b|\bpayment\b|付款|支付|消费|充值).{0,12}\d+(?:\.\d{1,2})?/iu,
  ];
  return restrictedPatterns.some((pattern) => pattern.test(queryText));
}

export type RepresentativeKnowledgeMetadataProbe = {
  status: "hit" | "miss" | "unavailable" | "denied";
  candidateCount: number;
  matchedTopics: string[];
  probeRevision: string;
};

/**
 * Probe the same immutable public-knowledge authorization manifest used by
 * recall, without calling OpenViking or creating a MemoryUseRun. The result is
 * a routing signal only; it never becomes evidence for the Composer.
 */
export async function probeRepresentativeKnowledgeMetadata(params: {
  representativeSlug: string;
  representativeVersionId: string;
  conversationId: string;
  contactId: string;
  sourceChannel: RecallSourceChannel;
  queryText: string;
  allowedSourceKinds?: readonly RepresentativeRecallSourceKind[];
}): Promise<RepresentativeKnowledgeMetadataProbe> {
  const baseRevision = `knowledge-probe:${params.representativeVersionId}`;
  if (!isRecallSourceChannel(params.sourceChannel)) {
    return emptyKnowledgeMetadataProbe("denied", baseRevision);
  }
  const allowedSourceKinds = normalizeRecallSourceKinds(params.allowedSourceKinds);
  if (!allowedSourceKinds.has("PUBLIC_KNOWLEDGE")) {
    return emptyKnowledgeMetadataProbe("denied", baseRevision);
  }
  const recallQuery = classifyRecallQuery(params.queryText);
  if (recallQuery.kind === "empty") {
    return emptyKnowledgeMetadataProbe("miss", baseRevision);
  }
  if (recallQuery.kind === "blocked") {
    return emptyKnowledgeMetadataProbe("denied", baseRevision);
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      id: params.conversationId,
      contactId: params.contactId,
      sourceChannel: params.sourceChannel,
      representative: { slug: params.representativeSlug },
    },
    select: {
      activeEpisodeId: true,
      representative: {
        select: {
          id: true,
          ownerId: true,
          slug: true,
          lifecycleState: true,
          openvikingEnabled: true,
          openvikingAutoRecall: true,
        },
      },
    },
  });
  if (
    !conversation?.activeEpisodeId
    || conversation.representative.lifecycleState !== "PUBLISHED"
  ) {
    return emptyKnowledgeMetadataProbe("denied", baseRevision);
  }
  if (
    !conversation.representative.openvikingEnabled
    || !conversation.representative.openvikingAutoRecall
  ) {
    return emptyKnowledgeMetadataProbe("unavailable", baseRevision);
  }
  const episode = await prisma.conversationEpisode.findFirst({
    where: {
      id: conversation.activeEpisodeId,
      conversationId: params.conversationId,
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
    !pinnedVersion
    || pinnedVersion.id !== params.representativeVersionId
    || pinnedVersion.representativeId !== conversation.representative.id
    || pinnedVersion.status !== "PUBLISHED"
    || !pinnedSnapshot?.success
  ) {
    return emptyKnowledgeMetadataProbe("denied", baseRevision);
  }
  const authorization = await loadPublicKnowledgeRecallAuthorization({
    representative: conversation.representative,
    publishedVersionId: pinnedVersion.id,
    snapshot: pinnedSnapshot.data,
  });
  const resources = [...authorization.publicKnowledgeGrantsByUri.values()];
  if (!resources.length) {
    return emptyKnowledgeMetadataProbe("unavailable", baseRevision);
  }
  const authorizedQuery = authorizePublicKnowledgeQueryAgainstPublishedCorpus({
    baseQuery: recallQuery.publicKnowledgeBaseQuery,
    ...(recallQuery.publicKnowledgeTopicQuery
      ? { topicQuery: recallQuery.publicKnowledgeTopicQuery }
      : {}),
    grants: authorization.publicKnowledgeGrantsByUri,
  });
  const revision = `knowledge-probe:${pinnedVersion.id}:${sha256Text(resources
    .map((resource) => `${resource.resourceKey}:${resource.contentHash}`)
    .sort()
    .join("|"))}`;
  if (!authorizedQuery.query) {
    return emptyKnowledgeMetadataProbe("miss", revision);
  }
  const matchedResources = authorizedQuery.topicMatchTerms.length
    ? resources.filter((resource) =>
        publicKnowledgeSourceMatchesAuthorizedTopic(
          resource.safeText,
          authorizedQuery.topicMatchTerms,
        ))
    : resources;
  return {
    status: matchedResources.length ? "hit" : "miss",
    candidateCount: matchedResources.length,
    // These are sanitized terms already present in both the user query and
    // the authorized corpus; no document body or private metadata is exposed.
    matchedTopics: authorizedQuery.authorizedTopicTerms.slice(0, 16),
    probeRevision: revision,
  };
}

function emptyKnowledgeMetadataProbe(
  status: RepresentativeKnowledgeMetadataProbe["status"],
  probeRevision: string,
): RepresentativeKnowledgeMetadataProbe {
  return { status, candidateCount: 0, matchedTopics: [], probeRevision };
}

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
  generationRunId: string;
  queryText: string;
  allowedSourceKinds?: readonly RepresentativeRecallSourceKind[];
}): Promise<RepresentativeRecallContext> {
  const recallQuery = classifyRecallQuery(params.queryText);
  if (recallQuery.kind === "empty" || !isRecallSourceChannel(params.sourceChannel)) {
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
      generationRuns: {
        where: { id: params.generationRunId },
        take: 1,
        select: { inputMessageId: true },
      },
      representative: {
        select: {
          id: true,
          ownerId: true,
          slug: true,
          lifecycleState: true,
          openvikingEnabled: true,
          openvikingAutoRecall: true,
          openvikingAgentId: true,
          openvikingRecallLimit: true,
          openvikingRecallScoreThreshold: true,
        },
      },
    },
  });
  const representative = conversation?.representative;
  const inputMessageId = conversation?.generationRuns?.[0]?.inputMessageId
    ?? null;
  const env = resolveOpenVikingEnv();
  if (
    !conversation?.activeEpisodeId ||
    (params.sourceChannel !== "web" && !inputMessageId) ||
    !representative ||
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

  const publicKnowledgeLaneEnabled =
    allowedSourceKinds.has("PUBLIC_KNOWLEDGE")
    && representative.openvikingEnabled
    && representative.openvikingAutoRecall;
  const publicAuthorization = publicKnowledgeLaneEnabled
    ? await loadPublicKnowledgeRecallAuthorization({
        representative: {
          id: representative.id,
          ownerId: representative.ownerId,
          slug: representative.slug,
        },
        publishedVersionId: pinnedVersion.id,
        snapshot: pinnedSnapshot.data,
      })
      : {
        publicKnowledgeGrantsByUri: new Map<string, PublicKnowledgeRecallGrant>(),
      };
  const governedAuthorizationInput = {
    representativeId: representative.id,
    contactId: params.contactId,
    conversationId: conversation.id,
    inputMessageId: inputMessageId ?? "web-request-bound-disclosure",
    sourceChannel: params.sourceChannel,
    allowedSourceKinds,
  };
  const preflightMemoryAuthorization = await prisma.$transaction((tx) =>
    loadGovernedMemoryRecallAuthorization(governedAuthorizationInput, tx),
  ).catch(() => emptyGovernedMemoryRecallAuthorization());
  const hasPublicSearchLane = publicKnowledgeLaneEnabled
    && publicAuthorization.publicKnowledgeGrantsByUri.size > 0;
  const hasGovernedMemorySearchLane = Boolean(
    preflightMemoryAuthorization.memoryManagedUserId
    && preflightMemoryAuthorization.memorySearchConfig
    && preflightMemoryAuthorization.memoryRoots.length > 0,
  );
  if (!hasPublicSearchLane && !hasGovernedMemorySearchLane) {
    return { items: [], citations: [] };
  }

  let memoryUseRunId: string;
  try {
    const started = await startOrReuseMemoryUseRun({
      generationRunId: params.generationRunId,
      sourceChannel: params.sourceChannel,
    });
    if (
      started.run.representativeId !== representative.id
      || started.run.conversationId !== conversation.id
      || started.run.contactId !== params.contactId
      || started.run.representativeVersionId !== pinnedVersion.id
    ) {
      await failMemoryUseRun(started.run.id, "memory_ledger_failed")
        .catch(() => undefined);
      return { items: [], citations: [] };
    }
    memoryUseRunId = started.run.id;
  } catch {
    return { items: [], citations: [] };
  }
  if (recallQuery.kind === "blocked") {
    try {
      await markMemoryUseRunDegraded(
        memoryUseRunId,
        MEMORY_RECALL_QUERY_BLOCKED_REASON,
      );
    } catch {
      await failMemoryUseRun(memoryUseRunId, "memory_ledger_failed")
        .catch(() => undefined);
      return { items: [], citations: [] };
    }
    return { items: [], citations: [], memoryUseRunId };
  }

  const publicKnowledgeQuery = recallQuery.kind === "safe"
    ? authorizePublicKnowledgeQueryAgainstPublishedCorpus({
        baseQuery: recallQuery.publicKnowledgeBaseQuery,
        ...(recallQuery.publicKnowledgeTopicQuery
          ? { topicQuery: recallQuery.publicKnowledgeTopicQuery }
          : {}),
        grants: publicAuthorization.publicKnowledgeGrantsByUri,
      })
    : {
        query: SAFE_RECALL_QUERIES.general,
        authorizedTopicTerms: [],
        topicMatchTerms: [],
      };
  const governedMemoryRecall = await loadAndSearchGovernedMemoryRecall({
    authorization: governedAuthorizationInput,
    representative,
    query:
      recallQuery.kind === "safe"
        ? recallQuery.governedMemoryQuery
        : null,
  });
  const memoryAuthorization = governedMemoryRecall.authorization;
  const authorization: RepresentativeRecallAuthorization = {
    ...(publicKnowledgeLaneEnabled
      ? {
          publishedVersionRoot: buildRepresentativeVersionResourceRootUri(
            representative.slug,
            pinnedVersion.id,
          ),
        }
      : {}),
    publicKnowledgeGrantsByUri: publicAuthorization.publicKnowledgeGrantsByUri,
    ...(memoryAuthorization.memoryManagedUserId
      ? { memoryManagedUserId: memoryAuthorization.memoryManagedUserId }
      : {}),
    memoryRoots: memoryAuthorization.memoryRoots,
    memoryGrantsByUri: memoryAuthorization.memoryGrantsByUri,
    ...(memoryAuthorization.memorySearchConfig
      ? { memorySearchConfig: memoryAuthorization.memorySearchConfig }
      : {}),
  };
  const publicClient = publicKnowledgeLaneEnabled
    && publicAuthorization.publicKnowledgeGrantsByUri.size > 0
    ? buildRepresentativeClient(representative)
    : null;
  const publicSearchConfig = {
    limit: representative.openvikingRecallLimit,
    scoreThreshold: representative.openvikingRecallScoreThreshold,
  };
  const searchTargets: Array<{
    targetUri: string;
    lane: "PUBLIC_KNOWLEDGE" | "GOVERNED_MEMORY";
    client: OpenVikingClient | null;
    limit: number;
    scoreThreshold: number;
    query?: string;
    topicMatchTerms?: string[];
    precomputedResult?: PromiseSettledResult<
      Awaited<ReturnType<OpenVikingClient["search"]>>
    >;
  }> = [];
  const authorizedPublicQuery = publicKnowledgeQuery.query;
  if (publicClient && authorizedPublicQuery) {
    searchTargets.push(...uniqueRecallRoots([
      authorization.publishedVersionRoot,
    ]).map((targetUri) => ({
      targetUri,
      lane: "PUBLIC_KNOWLEDGE" as const,
      client: publicClient,
      query: authorizedPublicQuery,
      topicMatchTerms: publicKnowledgeQuery.topicMatchTerms,
      ...publicSearchConfig,
    })));
  }
  const memorySearchConfig = authorization.memorySearchConfig;
  if (authorization.memoryManagedUserId && memorySearchConfig) {
    searchTargets.push(...authorization.memoryRoots.map((targetUri) => ({
      targetUri,
      lane: "GOVERNED_MEMORY" as const,
      client: null,
      precomputedResult:
        governedMemoryRecall.resultsByRoot.get(targetUri)
        ?? {
          status: "rejected" as const,
          reason: new Error("Governed memory search was not fenced."),
        },
      ...memorySearchConfig,
    })));
  }
  if (!searchTargets.length) {
    return { items: [], citations: [], memoryUseRunId };
  }
  const searchResults = await Promise.allSettled(
    searchTargets.map((target) => {
      if (target.precomputedResult) {
        return target.precomputedResult.status === "fulfilled"
          ? Promise.resolve(target.precomputedResult.value)
          : Promise.reject(target.precomputedResult.reason);
      }
      if (!target.client) {
        return Promise.reject(new Error("Recall client is unavailable."));
      }
      return target.client.search({
        query: target.query ?? SAFE_RECALL_QUERIES.general,
        targetUri: target.targetUri,
        limit: target.limit,
        scoreThreshold: target.scoreThreshold,
      });
    }),
  );
  const rejectedSearchCount = searchResults.filter(
    (result) => result.status === "rejected",
  ).length;
  if (rejectedSearchCount > 0) {
    try {
      await markMemoryUseRunDegraded(
        memoryUseRunId,
        rejectedSearchCount === searchResults.length
          ? "memory_recall_provider_unavailable"
          : "memory_recall_partial",
      );
    } catch {
      await failMemoryUseRun(memoryUseRunId, "memory_ledger_failed").catch(() => undefined);
      return { items: [], citations: [] };
    }
  }
  let observedUnmappedCandidateCount = 0;
  const mappedCandidates: AuthorizedRemoteRecallCandidate[] = [];
  for (const [targetIndex, result] of searchResults.entries()) {
    if (result.status !== "fulfilled") continue;
    const target = searchTargets[targetIndex];
    if (!target) continue;
    for (const item of [...result.value.resources, ...result.value.memories]) {
      const source = authorizeRecallUri(item.uri, authorization);
      const sourceIsPublic = source?.sourceKind === "PUBLIC_KNOWLEDGE";
      if (
        !source
        || (target.lane === "PUBLIC_KNOWLEDGE" && !sourceIsPublic)
        || (target.lane === "GOVERNED_MEMORY" && sourceIsPublic)
        || !authorizedRecallSourceHasSafeText(source)
        || (
          target.lane === "PUBLIC_KNOWLEDGE"
          && (target.topicMatchTerms?.length ?? 0) > 0
          && !publicKnowledgeSourceMatchesAuthorizedTopic(
            source.safeText,
            target.topicMatchTerms!,
          )
        )
      ) {
        observedUnmappedCandidateCount += 1;
        continue;
      }
      mappedCandidates.push({ item, source });
    }
  }
  const auditedCandidates = deduplicateAuthorizedRecallCandidates(mappedCandidates);
  const boundedAuditedCandidates = auditedCandidates.slice(0, 100);
  observedUnmappedCandidateCount += Math.max(
    0,
    auditedCandidates.length - boundedAuditedCandidates.length,
  );
  let eligibleMemoryUseItems: Awaited<ReturnType<typeof recordMemoryUseSearchHits>>;
  try {
    eligibleMemoryUseItems = await recordMemoryUseSearchHits({
      useRunId: memoryUseRunId,
      hits: boundedAuditedCandidates.map(({ item, source }, index) => ({
        ...memoryUseSearchCoordinate(source),
        searchRank: index + 1,
        ...(typeof item.score === "number" ? { searchScore: item.score } : {}),
      })),
      observedUnmappedCandidateCount,
    });
  } catch {
    await failMemoryUseRun(memoryUseRunId, "memory_ledger_failed").catch(() => undefined);
    return { items: [], citations: [] };
  }
  const eligibleMemoryUseItemIds = new Map(
    eligibleMemoryUseItems.eligibleItems.map((eligible) => [
      memoryUseSourceCoordinateKey(eligible),
      eligible.memoryUseItemId,
    ]),
  );
  const candidates = boundedAuditedCandidates.flatMap((candidate) => {
    const memoryUseItemId = eligibleMemoryUseItemIds.get(
      recallSourceCoordinateKey(candidate.source),
    );
    return memoryUseItemId ? [{ ...candidate, memoryUseItemId }] : [];
  });
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

  let revalidatedAuthorization: RepresentativeRecallAuthorization | null;
  try {
    revalidatedAuthorization = await revalidateRepresentativeRecallAuthorization({
      representativeSlug: params.representativeSlug,
      conversationId: params.conversationId,
      contactId: params.contactId,
      activeEpisodeId: conversation.activeEpisodeId,
      representativeVersionId: pinnedVersion.id,
      sourceChannel: params.sourceChannel,
      inputMessageId: inputMessageId ?? "web-request-bound-disclosure",
      allowedSourceKinds,
    });
  } catch {
    await markMemoryUseRunDegraded(
      memoryUseRunId,
      "memory_recall_source_changed",
    ).catch(() => undefined);
    return { items: [], citations: [], memoryUseRunId };
  }
  const revalidatedHydrated = revalidatedAuthorization
    ? selected.flatMap(({ item, source, memoryUseItemId }) => {
        const revalidatedSource = authorizeRecallUri(item.uri, revalidatedAuthorization);
        if (
          !revalidatedSource
          || recallSourceCoordinateKey(revalidatedSource)
            !== recallSourceCoordinateKey(source)
          || revalidatedSource.contentHash !== source.contentHash
          || !authorizedRecallSourceHasSafeText(revalidatedSource)
        ) return [];
        if (revalidatedSource.sourceKind === "PUBLIC_KNOWLEDGE") {
          return [hydratePublicKnowledgeRecall(item, revalidatedSource, memoryUseItemId)];
        }
        return [hydrateGovernedMemoryRecall(item, revalidatedSource, memoryUseItemId)];
      })
    : [];
  if (
    revalidatedHydrated.length < selected.length
    && rejectedSearchCount === 0
  ) {
    try {
      await markMemoryUseRunDegraded(
        memoryUseRunId,
        "memory_recall_source_changed",
      );
    } catch {
      await failMemoryUseRun(memoryUseRunId, "memory_ledger_failed").catch(() => undefined);
      return { items: [], citations: [] };
    }
  }
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

  return {
    items: authorizedHydrated.map(({ item }) => item),
    // Sources become public citations only after the model cites injected
    // aliases and the output transaction binds them to the reply.
    citations: [],
    memoryUseRunId,
  };
}

export function publicKnowledgeSourceMatchesAuthorizedTopic(
  safeText: string,
  authorizedTopicTerms: readonly string[],
) {
  const topicTerms = normalizePublicKnowledgeTopicTerms(authorizedTopicTerms);
  if (!topicTerms.length) return true;
  const normalizedSource = safeText.normalize("NFKC").toLocaleLowerCase("en-US");
  const matchedTerms = new Set(
    topicTerms.filter((term) => normalizedSource.includes(term)),
  );
  // Topic extraction preserves semantic order after removing request
  // scaffolding. The first surviving term is the primary subject and is a
  // mandatory fence; audience, retrieval, and formatting terms can never
  // substitute for it even if they happen to occur in the published corpus.
  const primaryTopicTerm = topicTerms[0]!;
  if (!matchedTerms.has(primaryTopicTerm)) return false;

  const latinTerms = topicTerms.filter((term) => /[a-z]/iu.test(term));
  if (latinTerms.some((term) => !matchedTerms.has(term))) return false;

  const hanTerms = topicTerms.filter((term) => /^\p{Script=Han}+$/u.test(term));
  if (!hanTerms.length) return latinTerms.length > 0;
  const requiredHanCoverage = Math.max(1, Math.ceil(hanTerms.length * 2 / 3));
  const matchedHanTerms = hanTerms.filter((term) => matchedTerms.has(term));
  return matchedHanTerms.length >= requiredHanCoverage;
}

async function revalidateRepresentativeRecallAuthorization(params: {
  representativeSlug: string;
  conversationId: string;
  contactId: string;
  sourceChannel: RecallSourceChannel;
  inputMessageId: string;
  activeEpisodeId: string;
  representativeVersionId: string;
  allowedSourceKinds: ReadonlySet<RepresentativeRecallSourceKind>;
}): Promise<RepresentativeRecallAuthorization | null> {
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
          ownerId: true,
          slug: true,
          lifecycleState: true,
          openvikingEnabled: true,
          openvikingAutoRecall: true,
        },
      },
    },
  });
  if (
    !conversation ||
    conversation.representative.lifecycleState !== "PUBLISHED"
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
            snapshot: true,
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
  const pinnedSnapshot = publishedRepresentativeSnapshotSchema.safeParse(
    episode.representativeVersion.snapshot,
  );
  if (!pinnedSnapshot.success) return null;

  const publicKnowledgeLaneEnabled =
    params.allowedSourceKinds.has("PUBLIC_KNOWLEDGE")
    && conversation.representative.openvikingEnabled
    && conversation.representative.openvikingAutoRecall;
  const publicAuthorization = publicKnowledgeLaneEnabled
    ? await loadPublicKnowledgeRecallAuthorization({
        representative: {
          id: conversation.representative.id,
          ownerId: conversation.representative.ownerId,
          slug: conversation.representative.slug,
        },
        publishedVersionId: params.representativeVersionId,
        snapshot: pinnedSnapshot.data,
      })
    : {
        publicKnowledgeGrantsByUri: new Map<string, PublicKnowledgeRecallGrant>(),
      };
  const memoryAuthorization = await prisma.$transaction((tx) =>
    loadGovernedMemoryRecallAuthorization({
      representativeId: conversation.representative.id,
      contactId: params.contactId,
      conversationId: conversation.id,
      inputMessageId: params.inputMessageId,
      sourceChannel: params.sourceChannel,
      allowedSourceKinds: params.allowedSourceKinds,
    }, tx),
  );
  return {
    ...(publicKnowledgeLaneEnabled
      ? {
          publishedVersionRoot: buildRepresentativeVersionResourceRootUri(
            conversation.representative.slug,
            params.representativeVersionId,
          ),
        }
      : {}),
    publicKnowledgeGrantsByUri: publicAuthorization.publicKnowledgeGrantsByUri,
    ...(memoryAuthorization.memoryManagedUserId
      ? { memoryManagedUserId: memoryAuthorization.memoryManagedUserId }
      : {}),
    memoryRoots: memoryAuthorization.memoryRoots,
    memoryGrantsByUri: memoryAuthorization.memoryGrantsByUri,
    ...(memoryAuthorization.memorySearchConfig
      ? { memorySearchConfig: memoryAuthorization.memorySearchConfig }
      : {}),
  };
}

async function loadPublicKnowledgeRecallAuthorization(params: {
  representative: { id: string; ownerId: string; slug: string };
  publishedVersionId: string;
  snapshot: z.output<typeof publishedRepresentativeSnapshotSchema>;
}): Promise<Pick<RepresentativeRecallAuthorization, "publicKnowledgeGrantsByUri">> {
  const empty = {
    publicKnowledgeGrantsByUri: new Map<string, PublicKnowledgeRecallGrant>(),
  };
  try {
    const aggregateByKey = new Map(
      buildPublishedAggregateProjectionSpecs(params).map((spec) => [spec.resourceKey, spec]),
    );
    const pinByAssetId = new Map(
      params.snapshot.knowledgeAssets.map((pin) => [pin.assetId, pin]),
    );
    const [manifestItems, ledgerItems] = await Promise.all([
      prisma.representativeVersionResource.findMany({
        where: {
          representativeId: params.representative.id,
          publishedVersionId: params.publishedVersionId,
        },
        select: {
          publishedVersionId: true,
          representativeId: true,
          sourceKind: true,
          resourceKey: true,
          knowledgeAssetId: true,
          contentHash: true,
          safeText: true,
          citationTitle: true,
        },
      }),
      prisma.publicKnowledgeProjectionItem.findMany({
        where: {
          representativeId: params.representative.id,
          publishedVersionId: params.publishedVersionId,
          provider: "openviking",
        },
        select: {
          id: true,
          representativeId: true,
          publishedVersionId: true,
          sourceKind: true,
          resourceKey: true,
          knowledgeAssetId: true,
          provider: true,
          contentHash: true,
          remoteUri: true,
          projectedAt: true,
        },
      }),
    ]);
    const ledgerByResourceKey = new Map(
      ledgerItems.map((item) => [item.resourceKey, item]),
    );
    const publicKnowledgeGrantsByUri = new Map<string, PublicKnowledgeRecallGrant>();
    const expectedRoot = buildRepresentativeVersionResourceRootUri(
      params.representative.slug,
      params.publishedVersionId,
    );
    for (const manifest of manifestItems) {
      if (
        manifest.representativeId !== params.representative.id
        || manifest.publishedVersionId !== params.publishedVersionId
        || !manifest.safeText
        || sha256Text(manifest.safeText) !== manifest.contentHash
      ) {
        continue;
      }
      let title: string;
      if (
        manifest.sourceKind
          === PublicKnowledgeProjectionSourceKind.REPRESENTATIVE_VERSION_RESOURCE
      ) {
        const expected = aggregateByKey.get(manifest.resourceKey);
        if (
          !expected
          || manifest.knowledgeAssetId !== null
          || expected.document.content !== manifest.safeText
          || sha256Text(expected.document.content) !== manifest.contentHash
        ) {
          continue;
        }
        title = sanitizePublicSafeText(manifest.citationTitle ?? "", 200)
          ?? resolveRecallTitle(manifest.safeText, `${expectedRoot}${manifest.resourceKey}`);
      } else {
        const assetId = manifest.knowledgeAssetId;
        const pin = assetId ? pinByAssetId.get(assetId) : undefined;
        if (
          !assetId
          || !pin
          || manifest.resourceKey !== `knowledge/${assetId}.md`
          || manifest.contentHash !== pin.checksum
        ) {
          continue;
        }
        title = sanitizePublicSafeText(manifest.citationTitle ?? "", 200)
          ?? "Published knowledge";
      }

      const ledger = ledgerByResourceKey.get(manifest.resourceKey);
      const expectedUri = `${expectedRoot}${manifest.resourceKey}`;
      if (
        !ledger
        || ledger.representativeId !== params.representative.id
        || ledger.publishedVersionId !== params.publishedVersionId
        || ledger.sourceKind !== manifest.sourceKind
        || ledger.knowledgeAssetId !== manifest.knowledgeAssetId
        || ledger.provider !== "openviking"
        || ledger.contentHash !== manifest.contentHash
        || ledger.remoteUri !== expectedUri
        || !ledger.projectedAt
      ) {
        continue;
      }
      publicKnowledgeGrantsByUri.set(ledger.remoteUri, {
        uri: ledger.remoteUri,
        sourceKind: "PUBLIC_KNOWLEDGE",
        publicKnowledgeProjectionId: ledger.id,
        contentHash: manifest.contentHash,
        resourceKey: ledger.resourceKey,
        safeText: manifest.safeText,
        title,
        ...(manifest.knowledgeAssetId
          ? { knowledgeAssetId: manifest.knowledgeAssetId }
          : {}),
      });
    }
    return { publicKnowledgeGrantsByUri };
  } catch {
    // A missing or changed authoritative snapshot removes only public
    // knowledge from this recall. Remote bytes are never used as fallback.
    return empty;
  }
}

async function loadAndSearchGovernedMemoryRecall(input: {
  authorization: {
    representativeId: string;
    contactId: string;
    conversationId: string;
    inputMessageId: string;
    sourceChannel: RecallSourceChannel;
    allowedSourceKinds: ReadonlySet<RepresentativeRecallSourceKind>;
  };
  representative: Pick<Representative, "slug" | "openvikingAgentId">;
  query: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const authorization = await loadGovernedMemoryRecallAuthorization(
      input.authorization,
      tx,
    );
    const resultsByRoot = new Map<
      string,
      PromiseSettledResult<Awaited<ReturnType<OpenVikingClient["search"]>>>
    >();
    if (
      !input.query
      || !authorization.memoryManagedUserId
      || !authorization.memorySearchConfig
    ) {
      return { authorization, resultsByRoot };
    }
    const client = buildGovernedMemoryClient(
      input.representative,
      authorization.memoryManagedUserId,
    );
    const roots = authorization.memoryRoots;
    const results = await Promise.allSettled(roots.map((targetUri) =>
      client.search({
        query: input.query!,
        targetUri,
        limit: authorization.memorySearchConfig!.limit,
        scoreThreshold:
          authorization.memorySearchConfig!.scoreThreshold,
      }),
    ));
    roots.forEach((root, index) => {
      const result = results[index];
      if (result) resultsByRoot.set(root, result);
    });
    return { authorization, resultsByRoot };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

function emptyGovernedMemoryRecallAuthorization(): Pick<
  RepresentativeRecallAuthorization,
  "memoryManagedUserId" | "memoryRoots" | "memoryGrantsByUri" | "memorySearchConfig"
> {
  return {
    memoryRoots: [],
    memoryGrantsByUri: new Map<string, GovernedMemoryRecallGrant>(),
  };
}

async function loadGovernedMemoryRecallAuthorization(params: {
  representativeId: string;
  contactId: string;
  conversationId: string;
  inputMessageId: string;
  sourceChannel: RecallSourceChannel;
  allowedSourceKinds: ReadonlySet<RepresentativeRecallSourceKind>;
}, tx: Prisma.TransactionClient): Promise<Pick<
  RepresentativeRecallAuthorization,
  "memoryManagedUserId" | "memoryRoots" | "memoryGrantsByUri" | "memorySearchConfig"
>> {
  const empty = emptyGovernedMemoryRecallAuthorization();
  if (
    !params.allowedSourceKinds.has("CONTACT_MEMORY")
    && !params.allowedSourceKinds.has("REPRESENTATIVE_EXPERIENCE")
  ) {
    return empty;
  }

  try {
    const sourceChannel = toRepresentativeMemoryChannel(params.sourceChannel);
    const sourceEvidence = await lockAndResolveExactMessageIdentityEvidence(
      tx,
      {
        representativeId: params.representativeId,
        contactId: params.contactId,
        conversationId: params.conversationId,
        messageId: params.inputMessageId,
        sourceChannel,
      },
    );
    if (sourceEvidence) {
      await lockContactSharedMemoryCoordinate(tx, {
        representativeId: params.representativeId,
        audienceIdentityId: sourceEvidence.canonicalAudienceIdentityId,
      });
    }
    await lockContactChannelMemoryCoordinate(tx, {
      representativeId: params.representativeId,
      contactId: params.contactId,
      sourceChannel,
    });
    if (!await hasCurrentMemoryChannelDisclosureForMessage(tx, {
      representativeId: params.representativeId,
      contactId: params.contactId,
      conversationId: params.conversationId,
      messageId: params.inputMessageId,
      channel: params.sourceChannel,
      capability: "recall",
    })) {
      return empty;
    }
    const [policy, forgetBoundary] = await Promise.all([
      tx.representativeMemoryPolicy.findUnique({
        where: { representativeId: params.representativeId },
        select: {
          namespaceKey: true,
          revision: true,
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: true,
          representativeExperienceEnabled: true,
          webRecallEnabled: true,
          matrixRecallEnabled: true,
          telegramRecallEnabled: true,
          provider: true,
          recallLimit: true,
          recallScoreThreshold: true,
        },
      }),
      loadLatestContactChannelMemoryForgetBoundary(tx, {
        representativeId: params.representativeId,
        contactId: params.contactId,
        sourceChannel,
      }),
    ]);
    const inputMessage = forgetBoundary
      ? await tx.message.findFirst({
          where: {
            id: params.inputMessageId,
            conversationId: params.conversationId,
            senderType: "AUDIENCE",
          },
          select: { memoryIngressOrdinal: true },
        })
      : null;
    const contactRecallAfterForget = !forgetBoundary || Boolean(
      inputMessage?.memoryIngressOrdinal
      && inputMessage.memoryIngressOrdinal
        > forgetBoundary.cutoffMemoryIngressOrdinal
    );
    if (
      !policy?.longTermMemoryEnabled
      || policy.provider !== "openviking"
      || !recallEnabledForChannel(policy, params.sourceChannel)
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
    let sharedAudienceIdentityId: string | null = null;
    if (allowContact && policy.contactMemoryCrossChannelEnabled) {
      try {
        const eligibility = await resolveContactMemorySharingEligibility(tx, {
          representativeId: params.representativeId,
          contactId: params.contactId,
          policy,
          sourceChannel,
          sourceEvidence,
        });
        sharedAudienceIdentityId = eligibility.eligible
          ? eligibility.audienceIdentityId
          : null;
      } catch {
        // Shared admission is an independent fail-closed lane. An unavailable
        // identity/consent lookup must not suppress already-authorized
        // channel-local memory or deidentified representative experience.
        sharedAudienceIdentityId = null;
      }
    }
    const scopeFilters: Prisma.GovernedMemoryWhereInput[] = [];
    if (allowContact) {
      scopeFilters.push({
        scope: "CONTACT_CHANNEL",
        contactId: params.contactId,
        sourceChannel,
      });
    }
    if (allowContact && sharedAudienceIdentityId) {
      scopeFilters.push({
        scope: "CONTACT_SHARED",
        contactId: null,
        audienceIdentityId: sharedAudienceIdentityId,
        sourceChannel: null,
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
    const memories = await tx.governedMemory.findMany({
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
        audienceIdentityId: true,
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
                audienceIdentityId: true,
                scope: true,
                scopeChannel: true,
                sourceKind: true,
                status: true,
                contentPurgedAt: true,
                deidentifiedAt: true,
                sourceMessage: {
                  select: { memoryIngressOrdinal: true },
                },
                extractionRun: {
                  select: { contactChannelMemoryEpoch: true },
                },
                policyDecision: {
                  select: {
                    representativeId: true,
                    memoryId: true,
                    resultVersionId: true,
                    outcome: true,
                    outputHash: true,
                    policyRevision: true,
                  },
                },
              },
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
                writeVerifiedAt: true,
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
    if (allowContact && sharedAudienceIdentityId) {
      memoryRoots.push(buildGovernedSharedContactMemoryRootUri({
        namespaceKey: policy.namespaceKey,
        audienceIdentityId: sharedAudienceIdentityId,
      }));
    }
    if (allowExperience) {
      memoryRoots.push(buildGovernedRepresentativeExperienceRootUri(policy.namespaceKey));
    }

    const memoryGrantsByUri = new Map<string, GovernedMemoryRecallGrant>();
    for (const memory of memories) {
      const version = memory.currentVersion;
      const automaticDecision = version?.sourceCandidate?.policyDecision;
      const hasValidAutomaticDecision = Boolean(
        version
        && automaticDecision
        && automaticDecision.representativeId === params.representativeId
        && automaticDecision.memoryId === memory.id
        && automaticDecision.resultVersionId === version.id
        && automaticDecision.outputHash === version.contentHash
        && (
          memory.scope !== "CONTACT_SHARED"
          || automaticDecision.policyRevision === policy.revision
        )
        && (
          automaticDecision.outcome === MemoryPolicyDecisionOutcome.ACTIVATED
          || automaticDecision.outcome === MemoryPolicyDecisionOutcome.UPDATED
        )
      );
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
        || !hasValidAutomaticDecision
        || (version.sourceCandidate
          && (
            version.sourceCandidate.representativeId !== params.representativeId
            || version.sourceCandidate.sourceKind === "OWNER_VERIFIED_CORRECTION"
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
          || !contactRecallAfterForget
          || memory.contactId !== params.contactId
          || memory.sourceChannel !== sourceChannel
          || version.scope !== "CONTACT_CHANNEL"
          || !memory.category.startsWith("CONTACT_")
          || (version.sourceCandidate
            && (
              version.sourceCandidate.scope !== "CONTACT_CHANNEL"
              || version.sourceCandidate.contactId !== params.contactId
              || version.sourceCandidate.scopeChannel
                !== sourceChannel
              || !isContactChannelMemorySourceAfterForgetBoundary(
                forgetBoundary,
                {
                  contactChannelMemoryEpoch:
                    version.sourceCandidate.extractionRun
                      ?.contactChannelMemoryEpoch ?? 0,
                  memoryIngressOrdinal:
                    version.sourceCandidate.sourceMessage
                      ?.memoryIngressOrdinal ?? null,
                },
              )
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
      } else if (memory.scope === "CONTACT_SHARED") {
        if (
          !allowContact
          || !sharedAudienceIdentityId
          || memory.audienceIdentityId !== sharedAudienceIdentityId
          || memory.contactId !== null
          || memory.sourceChannel !== null
          || version.scope !== "CONTACT_SHARED"
          || !memory.category.startsWith("CONTACT_")
          || !version.sourceCandidate
          || version.sourceCandidate.scope !== "CONTACT_SHARED"
          || version.sourceCandidate.contactId !== null
          || version.sourceCandidate.scopeChannel !== null
          || version.sourceCandidate.audienceIdentityId
            !== sharedAudienceIdentityId
          || version.sourceCandidate.policyDecision?.policyRevision
            !== policy.revision
        ) {
          continue;
        }
        sourceKind = "CONTACT_MEMORY";
        expectedUri = buildGovernedSharedContactMemoryVersionUri({
          namespaceKey: policy.namespaceKey,
          audienceIdentityId: sharedAudienceIdentityId,
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
          || !projection.writeVerifiedAt
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
      memoryManagedUserId: buildGovernedMemoryManagedUserId(policy.namespaceKey),
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
  memoryUseItemId: string,
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
    memoryUseItemId,
    internalSource: {
      sourceKind: grant.sourceKind,
      contentHash: grant.contentHash,
      memoryVersionId: grant.memoryVersionId,
      projectionItemId: grant.projectionItemId,
      memoryUseItemId,
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

function hydratePublicKnowledgeRecall(
  remoteItem: OpenVikingMatchedContext,
  grant: PublicKnowledgeRecallGrant,
  memoryUseItemId: string,
): {
  item: RepresentativeRecallItem;
  citation: RepresentativeRecallContext["citations"][number];
} {
  // Both prompt text and citation excerpts are derived from the PostgreSQL
  // snapshot/KnowledgeAsset bytes captured in the exact projection grant.
  // OpenViking's remote body and generated abstract are intentionally ignored.
  const safeContent = sanitizePublicSafeText(grant.safeText, 4_000) ?? "";
  const abstract = sanitizePublicSafeText(grant.safeText, 800) ?? "";
  const score = remoteItem.score ?? 0;
  return {
    item: {
      uri: grant.uri,
      contextType: remoteItem.context_type,
      layer: safeContent ? "L2" : "L0",
      score,
      abstract,
      ...(safeContent ? { content: safeContent } : {}),
      memoryUseItemId,
      internalSource: {
        sourceKind: "PUBLIC_KNOWLEDGE",
        contentHash: grant.contentHash,
        publicKnowledgeProjectionId: grant.publicKnowledgeProjectionId,
        publicResourceKey: grant.resourceKey,
        memoryUseItemId,
      },
    },
    citation: {
      ...(grant.knowledgeAssetId
        ? { knowledgeAssetId: grant.knowledgeAssetId }
        : {}),
      title: grant.title,
      ...(abstract || safeContent
        ? { excerpt: (abstract || safeContent).slice(0, 480) }
        : {}),
      score,
    },
  };
}

function authorizeRecallUri(
  uri: string,
  authorization: RepresentativeRecallAuthorization,
): AuthorizedRecallSource | null {
  return authorization.publicKnowledgeGrantsByUri.get(uri)
    ?? authorization.memoryGrantsByUri.get(uri)
    ?? null;
}

function authorizedRecallSourceHasSafeText(source: AuthorizedRecallSource) {
  return Boolean(sanitizePublicSafeText(source.safeText, 4_000)?.trim());
}

function recallSourceCoordinateKey(source: AuthorizedRecallSource): string {
  return source.sourceKind === "PUBLIC_KNOWLEDGE"
    ? `${source.sourceKind}:${source.publicKnowledgeProjectionId}`
    : `${source.sourceKind}:${source.projectionItemId}`;
}

function memoryUseSourceCoordinateKey(source:
  | { sourceKind: typeof MemoryUseSourceKind.PUBLIC_KNOWLEDGE; publicKnowledgeProjectionId: string }
  | {
      sourceKind:
        | typeof MemoryUseSourceKind.CONTACT_MEMORY
        | typeof MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE;
      projectionItemId: string;
    }
): string {
  return source.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE
    ? `${source.sourceKind}:${source.publicKnowledgeProjectionId}`
    : `${source.sourceKind}:${source.projectionItemId}`;
}

function memoryUseSearchCoordinate(source: AuthorizedRecallSource) {
  if (source.sourceKind === "PUBLIC_KNOWLEDGE") {
    return {
      sourceKind: MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
      publicKnowledgeProjectionId: source.publicKnowledgeProjectionId,
    } as const;
  }
  return {
    sourceKind: source.sourceKind === "CONTACT_MEMORY"
      ? MemoryUseSourceKind.CONTACT_MEMORY
      : MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE,
    projectionItemId: source.projectionItemId,
  } as const;
}

function deduplicateAuthorizedRecallCandidates(
  candidates: AuthorizedRemoteRecallCandidate[],
): AuthorizedRemoteRecallCandidate[] {
  const unique = new Map<string, AuthorizedRemoteRecallCandidate>();
  for (const candidate of candidates) {
    const key = recallSourceCoordinateKey(candidate.source);
    const existing = unique.get(key);
    if (!existing || (candidate.item.score ?? 0) > (existing.item.score ?? 0)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()].sort(
    (left, right) => (right.item.score ?? 0) - (left.item.score ?? 0),
  );
}

function rankAuthorizedRecallCandidates<T extends AuthorizedRemoteRecallCandidate>(
  candidates: T[],
  config: { limit: number; scoreThreshold: number },
): T[] {
  if (config.limit < 1) return [];
  const unique = new Map<string, T>();
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
  if (channel === "web") return RepresentativeChannelKind.WEB;
  if (channel === "matrix") return RepresentativeChannelKind.MATRIX;
  return RepresentativeChannelKind.TELEGRAM;
}

function recallEnabledForChannel(
  policy: {
    webRecallEnabled: boolean;
    matrixRecallEnabled: boolean;
    telegramRecallEnabled: boolean;
  },
  channel: RecallSourceChannel,
) {
  if (channel === "web") return policy.webRecallEnabled;
  if (channel === "matrix") return policy.matrixRecallEnabled;
  return policy.telegramRecallEnabled;
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

function resolveRecallTitle(content: string, uri: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return sanitizePublicSafeText(heading, 160) || "Knowledge source";
  const fileName = uri.split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "");
  return sanitizePublicSafeText(fileName || "Knowledge source", 160) || "Knowledge source";
}

/** @deprecated Legacy OpenVikingMemoryRecord recovery worker for cleanup only. */
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

async function loadLegacyOpenVikingMemoryDeletionStatus(
  memoryId: string,
): Promise<{
  status: "ACTIVE" | "SUPPRESSED" | "DELETE_PENDING" | "DELETED" | "DELETE_FAILED";
} | null> {
  return prisma.openVikingMemoryRecord.findUnique({
    where: { id: memoryId },
    select: { status: true },
  });
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
}): Promise<Awaited<ReturnType<typeof loadLegacyOpenVikingMemoryDeletionStatus>>> {
  const now = params.now ?? new Date();
  if (
    params.expectedLastDeleteAttemptAt &&
    now.getTime() - params.expectedLastDeleteAttemptAt.getTime()
      < OPENVIKING_MEMORY_DELETE_LEASE_MS
  ) {
    return loadLegacyOpenVikingMemoryDeletionStatus(params.memoryId);
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
    return loadLegacyOpenVikingMemoryDeletionStatus(params.memoryId);
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
    assertLegacyOpenVikingMemoryUriForRepresentative({
      representativeSlug: params.representativeSlug,
      uri: params.uri,
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
    const errorCode =
      error instanceof LegacyOpenVikingMemoryUriError
        ? "LEGACY_MEMORY_URI_REJECTED"
        : "REMOTE_DELETE_FAILED";
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
              errorCode,
              nextAttemptAt: nextDeleteAttemptAt.toISOString(),
            },
          },
        });
      }
    });
  }

  return loadLegacyOpenVikingMemoryDeletionStatus(params.memoryId);
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

function buildGovernedMemoryClient(
  representative: Pick<Representative, "slug" | "openvikingAgentId">,
  managedUserId: string,
): OpenVikingClient {
  const env = resolveOpenVikingEnv();
  const agentId = representative.openvikingAgentId
    ?? buildOpenVikingAgentId(representative.slug, env);
  return new OpenVikingClient({
    baseUrl: env.baseUrl,
    ...(env.apiKey ? { apiKey: env.apiKey } : {}),
    timeoutMs: env.timeoutMs,
    accountId: "delegate",
    userId: managedUserId,
    agentId,
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

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
