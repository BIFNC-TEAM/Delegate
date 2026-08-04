import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    eventAudit: {
      create: vi.fn(),
    },
    representative: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    representativeContextSync: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    representativeVersion: {
      findFirst: vi.fn(),
    },
    knowledgeAsset: { findMany: vi.fn() },
    representativeVersionResource: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    publicKnowledgeProjectionItem: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

import {
  enqueueRepresentativeOpenVikingSync,
  processRepresentativeOpenVikingSyncJob,
} from "../src/openviking";
import { syncRepresentativeResourceDocumentToOpenViking } from "../src/openviking-boundaries";

const representativeVersionRoot =
  "viking://resources/delegate/reps/delegate/versions/version-1/";

describe("durable OpenViking sync jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENVIKING_ENABLED = "true";
    process.env.OPENVIKING_RESOURCE_SYNC_ENABLED = "true";
    process.env.OPENVIKING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-model-key";
    mockPrisma.$transaction.mockImplementation(async (callback: unknown) => (
      callback as (tx: typeof mockPrisma) => Promise<unknown>
    )(mockPrisma));
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "audit-1" });
    mockPrisma.knowledgeAsset.findMany.mockResolvedValue([]);
    mockPrisma.representativeVersionResource.findMany.mockResolvedValue([]);
    mockPrisma.publicKnowledgeProjectionItem.findFirst.mockResolvedValue(null);
    mockPrisma.publicKnowledgeProjectionItem.create.mockResolvedValue({ id: "projection-1" });
    mockPrisma.publicKnowledgeProjectionItem.update.mockResolvedValue({ id: "projection-1" });
    mockPrisma.representativeVersionResource.createMany.mockImplementation(
      async ({ data }) => {
        mockPrisma.representativeVersionResource.findMany.mockResolvedValue(data);
        return { count: data.length };
      },
    );
  });

  it("rejects memory documents before any temporary upload", async () => {
    const client = {
      tempUpload: vi.fn(),
      addResource: vi.fn(),
      move: vi.fn(),
    };

    await expect(syncRepresentativeResourceDocumentToOpenViking({
      client: client as never,
      expectedRootUri: representativeVersionRoot,
      timeoutSeconds: 300,
      document: {
        uri: "viking://user/memories/delegate/legacy/contact/memory.md",
        filename: "memory.md",
        reason: "legacy memory write",
        contextType: "memory",
        scope: "contact",
        category: "preference",
        content: "raw conversation content",
      },
    })).rejects.toThrow("accepts representative resource documents only");

    expect(client.tempUpload).not.toHaveBeenCalled();
    expect(client.addResource).not.toHaveBeenCalled();
    expect(client.move).not.toHaveBeenCalled();
  });

  it("rejects a resource-labelled memory URI before any temporary upload", async () => {
    const client = {
      tempUpload: vi.fn(),
      addResource: vi.fn(),
    };

    await expect(syncRepresentativeResourceDocumentToOpenViking({
      client: client as never,
      expectedRootUri: representativeVersionRoot,
      timeoutSeconds: 300,
      document: {
        uri: "viking://user/memories/delegate/legacy/contact/memory.md",
        filename: "memory.md",
        reason: "resource-labelled memory write",
        contextType: "resource",
        scope: "representative",
        category: "faq",
        content: "raw conversation content",
      },
    })).rejects.toThrow("canonical viking://resources/ URI");

    expect(client.tempUpload).not.toHaveBeenCalled();
    expect(client.addResource).not.toHaveBeenCalled();
  });

  it("rejects a canonical resource URI outside the pinned version root before upload", async () => {
    const client = {
      tempUpload: vi.fn(),
      addResource: vi.fn(),
    };

    await expect(syncRepresentativeResourceDocumentToOpenViking({
      client: client as never,
      expectedRootUri: representativeVersionRoot,
      timeoutSeconds: 300,
      document: {
        uri: "viking://resources/delegate/reps/other/versions/version-1/faq/index.md",
        filename: "faq.md",
        reason: "cross-representative resource write",
        contextType: "resource",
        scope: "representative",
        category: "faq",
        content: "Cross-representative content.",
      },
    })).rejects.toThrow("outside its pinned version root");

    expect(client.tempUpload).not.toHaveBeenCalled();
    expect(client.addResource).not.toHaveBeenCalled();
  });

  it("creates and reads back exact published knowledge resources", async () => {
    const uri = "viking://resources/delegate/reps/delegate/versions/version-1/faq/index.md";
    const content = "# FAQ\n\nPublished answer.";
    const contentHash = createHash("sha256").update(content).digest("hex");
    const client = {
      ensureExactResourceRoot: vi.fn().mockResolvedValue({ rootUri: representativeVersionRoot }),
      createExactResource: vi.fn().mockResolvedValue({
        rootUri: representativeVersionRoot,
        uri,
        contentHash,
        outcome: "created",
      }),
      readExactResource: vi.fn().mockResolvedValue({ uri, content, contentHash }),
    };

    await expect(syncRepresentativeResourceDocumentToOpenViking({
      client: client as never,
      expectedRootUri: representativeVersionRoot,
      timeoutSeconds: 300,
      document: {
        uri,
        filename: "faq.md",
        reason: "published FAQ",
        contextType: "resource",
        scope: "representative",
        category: "faq",
        content,
      },
    })).resolves.toEqual({ remoteUri: uri, contentHash });

    expect(client.ensureExactResourceRoot).toHaveBeenCalledWith(representativeVersionRoot);
    expect(client.createExactResource).toHaveBeenCalledWith({
      rootUri: representativeVersionRoot,
      uri,
      content,
      contentHash,
      timeoutSeconds: 300,
    });
    expect(client.readExactResource).toHaveBeenCalledWith({
      rootUri: representativeVersionRoot,
      uri,
    });
  });

  it("persists the requested version, trigger, actor, and aggregate fence before returning", async () => {
    const queuedAt = new Date("2026-07-31T05:00:00.000Z");
    mockPrisma.representative.findUnique.mockResolvedValue({
      id: "rep-1",
      ownerId: "owner-1",
      activeVersionId: "version-2",
    });
    mockPrisma.representativeContextSync.create.mockResolvedValue({
      id: "sync-2",
      createdAt: queuedAt,
    });
    mockPrisma.representative.updateMany.mockResolvedValue({ count: 1 });

    const result = await enqueueRepresentativeOpenVikingSync({
      representativeSlug: "delegate",
      trigger: "manual",
      ownerId: "owner-1",
    });

    expect(result).toMatchObject({ id: "sync-2" });
    expect(mockPrisma.representativeContextSync.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        requestedVersionId: "version-2",
        trigger: "manual",
        requestedByOwnerId: "owner-1",
        status: "queued",
        attemptCount: 0,
      }),
    });
    expect(mockPrisma.representative.updateMany).toHaveBeenCalledWith({
      where: {
        id: "rep-1",
        activeVersionId: "version-2",
      },
      data: {
        openvikingLastSyncJobId: "sync-2",
        openvikingLastSyncStatus: "queued",
        openvikingLastSyncError: null,
      },
    });
  });

  it("lets an old version job finish without overwriting the active version aggregate", async () => {
    const now = new Date();
    const assetText = "Authoritative extracted PostgreSQL knowledge asset body.";
    const assetChecksum = createHash("sha256").update(assetText).digest("hex");
    const job = {
      id: "sync-v1",
      representativeId: "rep-1",
      requestedVersionId: "version-1",
      trigger: "publish",
      requestedByOwnerId: "owner-1",
      status: "running",
      itemCount: 0,
      error: null,
      attemptCount: 1,
      availableAt: now,
      leaseToken: "loaded-after-claim",
      leaseExpiresAt: new Date(now.getTime() + 330_000),
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
      representative: buildRepresentative({
        activeVersionId: "version-2",
        openvikingLastSyncJobId: "sync-v2",
      }),
    };
    mockPrisma.representativeContextSync.findUnique.mockImplementation(
      async (args: { select?: unknown }) => (
        args.select
          ? {
              id: job.id,
              status: "queued",
              attemptCount: 0,
              availableAt: now,
              leaseExpiresAt: null,
            }
          : job
      ),
    );
    mockPrisma.representativeContextSync.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.representative.updateMany.mockResolvedValue({ count: 0 });
    const snapshot = {
      ...publishedSnapshot("Version one"),
      knowledgeAssets: [{
        assetId: "asset-1",
        checksum: assetChecksum,
        processingVersion: 3,
      }],
    };
    mockPrisma.representativeVersion.findFirst.mockResolvedValue({
      id: "version-1",
      representativeId: "rep-1",
      status: "PUBLISHED",
      snapshot,
    });
    mockPrisma.representativeVersionResource.findMany.mockResolvedValue([{
      publishedVersionId: "version-1",
      representativeId: "rep-1",
      sourceKind: "KNOWLEDGE_ASSET",
      resourceKey: "knowledge/asset-1.md",
      knowledgeAssetId: "asset-1",
      contentHash: assetChecksum,
      safeText: assetText,
      citationTitle: "Pinned asset",
    }]);
    mockPrisma.knowledgeAsset.findMany.mockResolvedValue([{
      id: "asset-1",
      ownerId: "owner-1",
      title: "Edited draft title",
      status: "READY",
      archivedAt: null,
      checksum: createHash("sha256").update("Edited draft body").digest("hex"),
      processingVersion: 4,
      extractedText: "Edited draft body",
    }]);
    const syncDocument = vi.fn().mockImplementation(async ({ document }) => ({
      remoteUri: document.uri,
      contentHash: createHash("sha256").update(document.content).digest("hex"),
    }));

    const result = await processRepresentativeOpenVikingSyncJob({
      jobId: job.id,
      now,
      syncDocument,
    });

    expect(result).toEqual({ processed: true, status: "succeeded" });
    expect(mockPrisma.knowledgeAsset.findMany).not.toHaveBeenCalled();
    expect(syncDocument).toHaveBeenCalledTimes(6);
    expect(mockPrisma.representativeVersionResource.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          publishedVersionId: "version-1",
          resourceKey: "identity/profile.md",
          sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
        expect.objectContaining({
          publishedVersionId: "version-1",
          resourceKey: "knowledge/asset-1.md",
          sourceKind: "KNOWLEDGE_ASSET",
          contentHash: assetChecksum,
          safeText: assetText,
          citationTitle: "Pinned asset",
        }),
      ]),
      skipDuplicates: true,
    });
    expect(mockPrisma.publicKnowledgeProjectionItem.create).toHaveBeenCalledTimes(6);
    expect(mockPrisma.publicKnowledgeProjectionItem.create.mock.calls.map(
      (call) => call[0].data.resourceKey,
    )).toEqual([
      "identity/profile.md",
      "faq/index.md",
      "materials/index.md",
      "policies/index.md",
      "pricing/index.md",
      "knowledge/asset-1.md",
    ]);
    expect(mockPrisma.publicKnowledgeProjectionItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        publishedVersionId: "version-1",
        sourceKind: "KNOWLEDGE_ASSET",
        knowledgeAssetId: "asset-1",
        remoteUri:
          "viking://resources/delegate/reps/delegate/versions/version-1/knowledge/asset-1.md",
        contentHash: assetChecksum,
      }),
    });
    expect(mockPrisma.representativeVersion.findFirst).toHaveBeenCalledWith({
      where: {
        id: "version-1",
        representativeId: "rep-1",
      },
    });
    expect(mockPrisma.representative.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "rep-1",
          activeVersionId: "version-1",
          openvikingLastSyncJobId: "sync-v1",
        },
        data: expect.objectContaining({
          openvikingLastSyncStatus: "succeeded",
        }),
      }),
    );
    expect(mockPrisma.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: "owner-1",
        representativeId: "rep-1",
        payload: expect.objectContaining({
          syncJobId: "sync-v1",
          versionId: "version-1",
          trigger: "publish",
          aggregateUpdated: false,
        }),
      }),
    });
  });

  it("does not steal a live sync lease", async () => {
    const now = new Date();
    mockPrisma.representativeContextSync.findUnique.mockResolvedValue({
      id: "sync-live",
      status: "running",
      attemptCount: 1,
      availableAt: new Date(now.getTime() - 1_000),
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      processRepresentativeOpenVikingSyncJob({
        jobId: "sync-live",
        now,
      }),
    ).resolves.toEqual({ processed: false });
    expect(mockPrisma.representativeContextSync.updateMany).not.toHaveBeenCalled();
  });

  it("releases a failed attempt into exponential retry backoff", async () => {
    const now = new Date();
    const job = {
      id: "sync-retry",
      representativeId: "rep-1",
      requestedVersionId: "version-2",
      trigger: "manual",
      requestedByOwnerId: "owner-1",
      status: "running",
      itemCount: 0,
      error: null,
      attemptCount: 1,
      availableAt: now,
      leaseToken: "loaded-after-claim",
      leaseExpiresAt: new Date(now.getTime() + 330_000),
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
      representative: buildRepresentative({
        activeVersionId: "version-2",
        openvikingLastSyncJobId: "sync-retry",
      }),
    };
    mockPrisma.representativeContextSync.findUnique.mockImplementation(
      async (args: { select?: unknown }) => (
        args.select
          ? {
              id: job.id,
              status: "queued",
              attemptCount: 0,
              availableAt: now,
              leaseExpiresAt: null,
            }
          : job
      ),
    );
    mockPrisma.representativeContextSync.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.representative.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.representativeVersion.findFirst.mockResolvedValue({
      id: "version-2",
      representativeId: "rep-1",
      status: "PUBLISHED",
      snapshot: publishedSnapshot("Version two"),
    });

    let syncAttempt = 0;
    const result = await processRepresentativeOpenVikingSyncJob({
      jobId: job.id,
      now,
      syncDocument: vi.fn().mockImplementation(async ({ document }) => {
        syncAttempt += 1;
        if (syncAttempt > 1) throw new Error("provider timeout");
        return {
          remoteUri: document.uri,
          contentHash: createHash("sha256").update(document.content).digest("hex"),
        };
      }),
    });

    expect(result).toEqual({ processed: true, status: "retry_wait" });
    const retryUpdate = mockPrisma.representativeContextSync.updateMany.mock.calls
      .map((call) => call[0])
      .find((call) => call.data.status === "retry_wait");
    expect(retryUpdate).toMatchObject({
      where: {
        id: "sync-retry",
        status: "running",
        leaseToken: expect.any(String),
      },
      data: {
        status: "retry_wait",
        itemCount: 1,
        error: "provider timeout",
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: null,
      },
    });
    expect(retryUpdate.data.availableAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

function buildRepresentative(overrides: Record<string, unknown> = {}) {
  return {
    id: "rep-1",
    ownerId: "owner-1",
    slug: "delegate",
    openvikingEnabled: true,
    openvikingAgentId: null,
    activeVersionId: "version-1",
    ...overrides,
  };
}

function publishedSnapshot(displayName: string) {
  return {
    identity: {
      displayName,
      roleSummary: "A public representative.",
      tone: "Clear",
      languages: ["zh"],
    },
    publicMode: true,
    humanInLoop: true,
    groupActivation: "@delegate",
    conversation: {
      freeReplyLimit: 3,
      freeScope: [],
      paywalledIntents: [],
      handoffWindowHours: 24,
      handoffPrompt: "Ask the owner.",
    },
    governance: {
      allowedSkills: [],
    },
    knowledge: {
      identitySummary: "",
      faq: [],
      materials: [],
      policies: [],
    },
    knowledgeAssets: [],
    pricing: [],
  };
}
