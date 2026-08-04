import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enqueueRepresentativeOpenVikingSync,
  processRepresentativeOpenVikingSyncJob,
  runOpenVikingMemoryDeletionRecoveryTick,
} from "../src/openviking";
import { publishRepresentativeVersion } from "../src/conversation-platform";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("OpenViking durable PostgreSQL operations", () => {
  beforeEach(() => {
    process.env.OPENVIKING_ENABLED = "true";
    process.env.OPENVIKING_RESOURCE_SYNC_ENABLED = "true";
    process.env.OPENVIKING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "postgres-openviking-test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("commits a version and its durable sync job atomically", async () => {
    const fixture = await createFixture();

    try {
      const version = await publishRepresentativeVersion({
        representativeSlug: fixture.representativeSlug,
        publishedBy: fixture.ownerId,
        ownerId: fixture.ownerId,
      });
      const [job, representative] = await Promise.all([
        prisma.representativeContextSync.findFirstOrThrow({
          where: {
            representativeId: fixture.representativeId,
            requestedVersionId: version.id,
            trigger: "publish",
          },
        }),
        prisma.representative.findUniqueOrThrow({
          where: { id: fixture.representativeId },
          select: {
            activeVersionId: true,
            openvikingLastSyncJobId: true,
            openvikingLastSyncStatus: true,
          },
        }),
      ]);

      expect(job).toMatchObject({
        status: "queued",
        requestedByOwnerId: fixture.ownerId,
        attemptCount: 0,
      });
      expect(representative).toEqual({
        activeVersionId: version.id,
        openvikingLastSyncJobId: job.id,
        openvikingLastSyncStatus: "queued",
      });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("does not let an older version job overwrite a newer completed sync", async () => {
    const fixture = await createFixture();
    const syncDocument = vi.fn().mockImplementation(async ({ document }) => ({
      remoteUri: document.uri,
      contentHash: crypto.createHash("sha256").update(document.content).digest("hex"),
    }));

    try {
      const versionOne = await publishRepresentativeVersion({
        representativeSlug: fixture.representativeSlug,
        publishedBy: fixture.ownerId,
        ownerId: fixture.ownerId,
      });
      const versionTwo = await publishRepresentativeVersion({
        representativeSlug: fixture.representativeSlug,
        publishedBy: fixture.ownerId,
        ownerId: fixture.ownerId,
      });
      const [jobOne, jobTwo] = await Promise.all([
        prisma.representativeContextSync.findFirstOrThrow({
          where: {
            representativeId: fixture.representativeId,
            requestedVersionId: versionOne.id,
          },
        }),
        prisma.representativeContextSync.findFirstOrThrow({
          where: {
            representativeId: fixture.representativeId,
            requestedVersionId: versionTwo.id,
          },
        }),
      ]);

      await expect(
        processRepresentativeOpenVikingSyncJob({
          jobId: jobTwo.id,
          syncDocument,
        }),
      ).resolves.toEqual({ processed: true, status: "succeeded" });
      const idempotentRetry = await enqueueRepresentativeOpenVikingSync({
        representativeSlug: fixture.representativeSlug,
        requestedVersionId: versionTwo.id,
        trigger: "retry",
        ownerId: fixture.ownerId,
      });
      await expect(processRepresentativeOpenVikingSyncJob({
        jobId: idempotentRetry.id,
        syncDocument,
      })).resolves.toEqual({ processed: true, status: "succeeded" });
      const afterNewer = await prisma.representative.findUniqueOrThrow({
        where: { id: fixture.representativeId },
        select: {
          activeVersionId: true,
          openvikingLastSyncJobId: true,
          openvikingTargetUri: true,
          openvikingLastSyncAt: true,
          openvikingLastSyncStatus: true,
          openvikingLastSyncItemCount: true,
        },
      });

      await expect(
        processRepresentativeOpenVikingSyncJob({
          jobId: jobOne.id,
          syncDocument,
        }),
      ).resolves.toEqual({ processed: true, status: "succeeded" });
      const afterOlder = await prisma.representative.findUniqueOrThrow({
        where: { id: fixture.representativeId },
        select: {
          activeVersionId: true,
          openvikingLastSyncJobId: true,
          openvikingTargetUri: true,
          openvikingLastSyncAt: true,
          openvikingLastSyncStatus: true,
          openvikingLastSyncItemCount: true,
        },
      });
      const oldAudit = await prisma.eventAudit.findFirstOrThrow({
        where: {
          representativeId: fixture.representativeId,
          type: "OPENVIKING_RESOURCE_SYNC_COMPLETED",
          payload: {
            path: ["syncJobId"],
            equals: jobOne.id,
          },
        },
        orderBy: { createdAt: "desc" },
      });
      const projectedResources = await prisma.publicKnowledgeProjectionItem.findMany({
        where: {
          representativeId: fixture.representativeId,
          publishedVersionId: versionTwo.id,
        },
        orderBy: { resourceKey: "asc" },
      });

      expect(afterOlder).toEqual(afterNewer);
      expect(afterOlder.activeVersionId).toBe(versionTwo.id);
      expect(afterOlder.openvikingLastSyncJobId).toBe(idempotentRetry.id);
      expect(afterOlder.openvikingTargetUri).toContain(versionTwo.id);
      expect(oldAudit.ownerId).toBe(fixture.ownerId);
      expect(oldAudit.payload).toMatchObject({
        syncJobId: jobOne.id,
        versionId: versionOne.id,
        trigger: "publish",
        aggregateUpdated: false,
      });
      expect(projectedResources).toHaveLength(6);
      expect(projectedResources.map((item) => item.resourceKey)).toEqual([
        "faq/index.md",
        "identity/profile.md",
        `knowledge/${fixture.knowledgeAssetId}.md`,
        "materials/index.md",
        "policies/index.md",
        "pricing/index.md",
      ]);
      expect(projectedResources.every((item) =>
        item.remoteUri.includes(`/versions/${versionTwo.id}/`)
        && /^[0-9a-f]{64}$/u.test(item.contentHash)
      )).toBe(true);
      expect(projectedResources.find(
        (item) => item.knowledgeAssetId === fixture.knowledgeAssetId,
      )).toMatchObject({
        sourceKind: "KNOWLEDGE_ASSET",
        contentHash: fixture.knowledgeAssetChecksum,
      });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("reclaims an expired DELETE_PENDING lease after a worker crash", async () => {
    const fixture = await createFixture();
    const crashedAt = new Date(Date.now() - 5 * 60_000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ status: "ok", result: {} }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )));

    try {
      const memory = await prisma.openVikingMemoryRecord.create({
        data: {
          representativeId: fixture.representativeId,
          uri: `viking://user/memories/delegate/${fixture.representativeSlug}/contact/preferences/crash.md`,
          contextType: "memory",
          scope: "contact",
          category: "preference",
          summary: "",
          sourceKind: "collector",
          status: "DELETE_PENDING",
          suppressedAt: crashedAt,
          lastDeleteAttemptAt: crashedAt,
          deletionAttemptCount: 1,
          deletionRequestedByOwnerId: fixture.ownerId,
        },
      });

      const result = await runOpenVikingMemoryDeletionRecoveryTick({
        limit: 4,
      });
      const persisted = await prisma.openVikingMemoryRecord.findUniqueOrThrow({
        where: { id: memory.id },
      });
      const audit = await prisma.eventAudit.findFirstOrThrow({
        where: {
          representativeId: fixture.representativeId,
          type: "OPENVIKING_MEMORY_STATUS_CHANGED",
          payload: {
            path: ["memoryId"],
            equals: memory.id,
          },
        },
        orderBy: { createdAt: "desc" },
      });

      expect(result).toMatchObject({
        processed: 1,
        deleted: 1,
      });
      expect(persisted.status).toBe("DELETED");
      expect(persisted.deletionAttemptCount).toBe(2);
      expect(audit.ownerId).toBe(fixture.ownerId);
      expect(audit.payload).toMatchObject({
        memoryId: memory.id,
        status: "DELETED",
      });
    } finally {
      await deleteFixture(fixture);
    }
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID();
  const owner = await prisma.owner.create({
    data: {
      displayName: `OpenViking operations ${suffix}`,
    },
    select: { id: true },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `openviking-operations-${suffix}`,
      displayName: "OpenViking operations representative",
      roleSummary: "Exercises durable sync and deletion recovery.",
      tone: "clear",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate to the owner.",
      allowedSkills: [],
      actionGate: {},
      openvikingEnabled: true,
      knowledgePack: {
        create: {
          identitySummary: "Durable context operations.",
          faq: [{
            id: "durability",
            title: "How is context synchronized?",
            summary: "Through a durable worker job.",
          }],
          materials: [],
          policies: [],
        },
      },
      pricingPlans: {
        create: [
          pricingPlan("FREE", "Free", 0),
          pricingPlan("PASS", "Pass", 10),
          pricingPlan("DEEP_HELP", "Deep help", 20),
          pricingPlan("SPONSOR", "Sponsor", 30),
        ],
      },
    },
    select: { id: true, slug: true },
  });
  const assetText = "Authoritative PostgreSQL knowledge asset used by the published snapshot.";
  const assetChecksum = crypto.createHash("sha256").update(assetText).digest("hex");
  const knowledgeAsset = await prisma.knowledgeAsset.create({
    data: {
      ownerId: owner.id,
      kind: "TEXT",
      status: "READY",
      visibility: "SELECTED_REPRESENTATIVES",
      title: "Pinned PostgreSQL knowledge",
      sourceText: assetText,
      extractedText: assetText,
      checksum: assetChecksum,
      processingVersion: 1,
      processedAt: new Date(),
      representativeLinks: {
        create: {
          representativeId: representative.id,
          usageMode: "QA_SOURCE",
          reviewStatus: "APPROVED",
          enabled: true,
        },
      },
    },
    select: { id: true },
  });
  return {
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    knowledgeAssetId: knowledgeAsset.id,
    knowledgeAssetChecksum: assetChecksum,
  };
}

function pricingPlan(
  type: "FREE" | "PASS" | "DEEP_HELP" | "SPONSOR",
  name: string,
  starsAmount: number,
) {
  return {
    type,
    name,
    starsAmount,
    summary: `${name} plan`,
    includedReplies: type === "FREE" ? 3 : 10,
    includesPriorityHandoff: type !== "FREE",
  };
}

async function deleteFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  await prisma.eventAudit.deleteMany({
    where: {
      OR: [
        { representativeId: fixture.representativeId },
        { ownerId: fixture.ownerId },
      ],
    },
  });
  await prisma.openVikingMemoryRecord.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.representativeContextSync.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  const [immutableReceiptCount, immutableResourceCount] = await Promise.all([
    prisma.publicKnowledgeProjectionItem.count({
      where: { representativeId: fixture.representativeId },
    }),
    prisma.representativeVersionResource.count({
      where: { representativeId: fixture.representativeId },
    }),
  ]);
  if (immutableReceiptCount > 0 || immutableResourceCount > 0) {
    // Published resource snapshots and projection receipts intentionally
    // outlive mutable sync jobs. This database is disposable, so retain their
    // restricted parent rows instead of weakening the append-only invariant.
    return;
  }
  await prisma.representativeChannelBinding.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.pricingPlan.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.knowledgePack.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.representative.updateMany({
    where: { id: fixture.representativeId },
    data: { activeVersionId: null },
  });
  await prisma.representativeVersion.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.representative.deleteMany({
    where: { id: fixture.representativeId },
  });
  await prisma.owner.deleteMany({
    where: { id: fixture.ownerId },
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the OpenViking PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  const safeHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const safeDatabase =
    database.includes("test")
    || database.includes("e2e")
    || database.includes("delegate");
  if (!safeHost || !safeDatabase) {
    throw new Error(
      `Refusing OpenViking PostgreSQL E2E against ${host}/${database}.`,
    );
  }
}
