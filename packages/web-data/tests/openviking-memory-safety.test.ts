import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    eventAudit: {
      create: vi.fn(),
    },
    openVikingMemoryRecord: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

import {
  deleteRepresentativeOpenVikingMemory,
  resolveAllowedPublishedKnowledgeAssetIds,
  retryRepresentativeOpenVikingMemoryDeletion,
  runOpenVikingMemoryDeletionRecoveryTick,
  suppressRepresentativeOpenVikingMemory,
} from "../src/openviking";
import {
  assertLegacyOpenVikingMemoryUriForRepresentative,
  LegacyOpenVikingMemoryUriError,
} from "../src/openviking-boundaries";

describe("OpenViking memory safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENVIKING_ENABLED = "false";
    mockPrisma.$transaction.mockImplementation(async (callback: unknown) => (
      callback as (tx: typeof mockPrisma) => Promise<unknown>
    )(mockPrisma));
    mockPrisma.eventAudit.create.mockResolvedValue({ id: "audit-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the legacy ledger cleanup-only with no create, activation, or recall helper", () => {
    const source = readFileSync(
      new URL("../src/openviking.ts", import.meta.url),
      "utf8",
    );
    const cleanupStart = source.indexOf("getRepresentativeOpenVikingMemoryPreview");
    const cleanupEnd = source.indexOf(
      "getRepresentativeOpenVikingOverviewMetrics",
      cleanupStart,
    );
    const cleanupSource = source.slice(cleanupStart, cleanupEnd);

    expect(source).not.toMatch(/openVikingMemoryRecord\.(?:create|createMany|upsert)/u);
    expect(source).not.toContain("isOpenVikingMemoryRecallEligible");
    expect(source).not.toContain("isOpenVikingMemoryUriAllowed");
    expect(cleanupSource).toContain("@deprecated Legacy OpenVikingMemoryRecord");
    expect(cleanupSource).toContain("client.remove");
    expect(cleanupSource).not.toContain("tempUpload");
    expect(cleanupSource).not.toContain("addResource");
    expect(cleanupSource).not.toContain("client.move(");
  });

  it.each([
    "viking://user/memories/delegate/lin-founder-rep/contact-1/preferences/timezone.md",
    "viking://agent/memories/delegate/lin-founder-rep/cases/resolved-case.md",
  ])("accepts a canonical representative-bound legacy memory leaf: %s", (uri) => {
    expect(() => assertLegacyOpenVikingMemoryUriForRepresentative({
      representativeSlug: "lin-founder-rep",
      uri,
    })).not.toThrow();
  });

  it.each([
    "viking://resources/delegate/reps/lin-founder-rep/",
    "viking://user/memories/delegate/lin-founder-rep/",
    "viking://agent/memories/delegate/lin-founder-rep/",
    "viking://user/memories/delegate/other-rep/contact-1/preferences/timezone.md",
    "viking://user/memories/delegate/lin-founder-rep/contact-1/preferences/../secret.md",
    "viking://user/memories/delegate/lin-founder-rep/contact-1/preferences/%2e%2e.md",
    "viking://user/memories/delegate/lin-founder-rep/contact-1\\preferences\\timezone.md",
    "viking://user/memories/delegate/lin-founder-rep/contact-1/payment/receipt.md",
    "viking://agent/memories/delegate/lin-founder-rep/payments/receipt.md",
  ])("rejects an unsafe legacy cleanup target: %s", (uri) => {
    expect(() => assertLegacyOpenVikingMemoryUriForRepresentative({
      representativeSlug: "lin-founder-rep",
      uri,
    })).toThrow(LegacyOpenVikingMemoryUriError);
  });

  it("allows only snapshot-pinned knowledge that is still approved and byte-version identical", () => {
    const pins = [{
      assetId: "asset-pinned",
      checksum: "sha256-v1",
      processingVersion: 3,
    }];
    const current = (overrides: Record<string, unknown> = {}) => ({
      assetId: "asset-pinned",
      enabled: true,
      reviewStatus: "APPROVED",
      asset: {
        status: "READY",
        archivedAt: null,
        checksum: "sha256-v1",
        processingVersion: 3,
      },
      ...overrides,
    });

    expect(resolveAllowedPublishedKnowledgeAssetIds({
      pins,
      currentLinks: [current()],
    })).toEqual(new Set(["asset-pinned"]));
    expect(resolveAllowedPublishedKnowledgeAssetIds({
      pins,
      currentLinks: [current({ assetId: "asset-bound-after-publish" })],
    })).toEqual(new Set());
    expect(resolveAllowedPublishedKnowledgeAssetIds({
      pins,
      currentLinks: [current({
        asset: {
          status: "READY",
          archivedAt: null,
          checksum: "sha256-v2",
          processingVersion: 4,
        },
      })],
    })).toEqual(new Set());
    expect(resolveAllowedPublishedKnowledgeAssetIds({
      pins,
      currentLinks: [current({ enabled: false })],
    })).toEqual(new Set());
    expect(resolveAllowedPublishedKnowledgeAssetIds({
      pins,
      currentLinks: [current({ reviewStatus: "PENDING" })],
    })).toEqual(new Set());
    expect(resolveAllowedPublishedKnowledgeAssetIds({
      pins,
      currentLinks: [current({
        asset: {
          status: "PROCESSING",
          archivedAt: null,
          checksum: "sha256-v1",
          processingVersion: 3,
        },
      })],
    })).toEqual(new Set());
  });

  it("pins knowledge versions and enqueues sync inside publish and activation transactions", () => {
    const source = readFileSync(
      new URL("../src/conversation-platform.ts", import.meta.url),
      "utf8",
    );
    const publishStart = source.indexOf("export async function publishRepresentativeVersion");
    const activateStart = source.indexOf(
      "export async function activateRepresentativeVersion",
      publishStart,
    );
    const snapshotStart = source.indexOf("function buildRepresentativeSnapshot", activateStart);
    const publishSource = source.slice(publishStart, activateStart);
    const activateSource = source.slice(activateStart, snapshotStart);
    const snapshotSource = source.slice(snapshotStart);

    expect(publishSource).toContain(
      "reviewStatus: KnowledgeAssetReviewStatus.APPROVED",
    );
    expect(publishSource).toContain("status: KnowledgeAssetStatus.READY");
    expect(publishSource).toContain("archivedAt: null");
    expect(publishSource).toContain("checksum: { not: null }");
    expect(publishSource).toContain("checksum: true");
    expect(publishSource).toContain("processingVersion: true");
    expect(publishSource).toContain("await tx.representativeContextSync.create");
    expect(publishSource).not.toContain("maybeSyncRepresentativeOpenVikingResources");
    expect(publishSource).toContain("requestedVersionId: version.id");
    expect(publishSource).toContain('trigger: "publish"');
    expect(activateSource).toContain("await tx.representativeContextSync.create");
    expect(activateSource).not.toContain("maybeSyncRepresentativeOpenVikingResources");
    expect(activateSource).toContain("requestedVersionId: version.id");
    expect(activateSource).toContain('trigger: "activate"');
    expect(snapshotSource).toContain(
      "knowledgeAssets: representative.knowledgeAssetLinks.map",
    );
    expect(publishSource).toContain("openvikingLastSyncJobId: syncJob.id");
    expect(activateSource).toContain("openvikingLastSyncJobId: syncJob.id");
  });

  it("revalidates recall authorization after remote hydration and before returning", () => {
    const source = readFileSync(
      new URL("../src/openviking.ts", import.meta.url),
      "utf8",
    );
    const recallStart = source.indexOf("export async function recallRepresentativeContext");
    const recallEnd = source.indexOf(
      "async function revalidateRepresentativeRecallAuthorization",
      recallStart,
    );
    const recallSource = source.slice(recallStart, recallEnd);
    const remoteRead = recallSource.indexOf("await publicClient.read");
    const revalidation = recallSource.indexOf(
      "await revalidateRepresentativeRecallAuthorization",
    );

    expect(remoteRead).toBeGreaterThan(-1);
    expect(revalidation).toBeGreaterThan(remoteRead);
    expect(recallSource).toContain(
      "authorizeRecallUri(item.uri, revalidatedAuthorization)",
    );
    expect(recallSource).toContain(
      "hydrateGovernedMemoryRecall(item, revalidatedSource)",
    );
    expect(recallSource).not.toContain("openVikingMemoryRecord.findMany");
    expect(recallSource).toContain("data: authorizedHydrated.map");
  });

  it("suppresses locally before returning the memory", async () => {
    mockPrisma.openVikingMemoryRecord.findFirst.mockResolvedValue(
      buildMemory("ACTIVE"),
    );
    mockPrisma.openVikingMemoryRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.openVikingMemoryRecord.findUnique.mockResolvedValue(
      buildMemory("SUPPRESSED", {
        suppressedAt: new Date("2026-07-31T04:00:00.000Z"),
      }),
    );

    const result = await suppressRepresentativeOpenVikingMemory({
      representativeSlug: "lin-founder-rep",
      memoryId: "memory-1",
    });

    expect(mockPrisma.openVikingMemoryRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: "memory-1",
        representativeId: "rep-1",
        status: "ACTIVE",
      },
      data: {
        status: "SUPPRESSED",
        suppressedAt: expect.any(Date),
        deletionError: null,
      },
    });
    expect(result?.status).toBe("SUPPRESSED");
  });

  it("keeps a remote deletion failure non-recallable and retryable", async () => {
    mockPrisma.openVikingMemoryRecord.findFirst.mockResolvedValue(
      buildMemory("ACTIVE"),
    );
    mockPrisma.openVikingMemoryRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.openVikingMemoryRecord.findUnique.mockResolvedValue(
      buildMemory("DELETE_FAILED", {
        summary: "",
        suppressedAt: new Date("2026-07-31T04:00:00.000Z"),
        lastDeleteAttemptAt: new Date("2026-07-31T04:00:01.000Z"),
        deletionAttemptCount: 1,
        deletionError: "OpenViking is disabled at the environment level.",
      }),
    );

    const result = await deleteRepresentativeOpenVikingMemory({
      representativeSlug: "lin-founder-rep",
      memoryId: "memory-1",
    });

    const updates = mockPrisma.openVikingMemoryRecord.updateMany.mock.calls;
    expect(updates[0]?.[0]).toMatchObject({
      where: { status: { in: ["ACTIVE", "SUPPRESSED", "DELETE_FAILED"] } },
      data: { status: "DELETE_PENDING", summary: "" },
    });
    expect(updates.at(-1)?.[0]).toMatchObject({
      where: {
        status: "DELETE_PENDING",
        lastDeleteAttemptAt: updates[1]?.[0].data.lastDeleteAttemptAt,
      },
      data: {
        status: "DELETE_FAILED",
        deletionError: "OpenViking is disabled at the environment level.",
      },
    });
    expect(result).toMatchObject({
      status: "DELETE_FAILED",
      summary: "",
      deletionAttemptCount: 1,
      deletionError: "REMOTE_DELETE_FAILED",
    });
  });

  it.each([
    "viking://resources/delegate/reps/lin-founder-rep/",
    "viking://user/memories/delegate/lin-founder-rep/",
    "viking://user/memories/delegate/other-rep/contact-1/preferences/timezone.md",
    "viking://agent/memories/delegate/other-rep/cases/resolved-case.md",
    "viking://user/memories/delegate/lin-founder-rep/contact-1/preferences/../secret.md",
    "viking://user/memories/delegate/lin-founder-rep/contact-1/preferences/%2e%2e.md",
    "viking://user/memories/delegate/lin-founder-rep/contact-1\\preferences\\timezone.md",
  ])("does not issue a remote delete for an unsafe legacy URI: %s", async (uri) => {
    process.env.OPENVIKING_ENABLED = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.openVikingMemoryRecord.findFirst.mockResolvedValue(
      buildMemory("SUPPRESSED", {
        uri,
      }),
    );
    mockPrisma.openVikingMemoryRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.openVikingMemoryRecord.findUnique.mockResolvedValue(
      buildMemory("DELETE_FAILED", {
        uri,
        summary: "",
        suppressedAt: new Date("2026-07-31T04:00:00.000Z"),
        lastDeleteAttemptAt: new Date("2026-07-31T04:00:01.000Z"),
        nextDeleteAttemptAt: new Date("2026-07-31T04:00:31.000Z"),
        deletionAttemptCount: 1,
        deletionError:
          "Legacy OpenViking memory deletion refused an out-of-scope or non-canonical URI.",
      }),
    );

    const result = await deleteRepresentativeOpenVikingMemory({
      representativeSlug: "lin-founder-rep",
      memoryId: "memory-1",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockPrisma.openVikingMemoryRecord.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      data: {
        status: "DELETE_FAILED",
        deletionError:
          "Legacy OpenViking memory deletion refused an out-of-scope or non-canonical URI.",
        nextDeleteAttemptAt: expect.any(Date),
      },
    });
    expect(mockPrisma.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        payload: expect.objectContaining({
          memoryId: "memory-1",
          status: "DELETE_FAILED",
          errorCode: "LEGACY_MEMORY_URI_REJECTED",
        }),
      }),
    });
    expect(result).toMatchObject({
      status: "DELETE_FAILED",
      summary: "",
      deletionError: "REMOTE_DELETE_FAILED",
    });
  });

  it("does not steal a live deletion lease", async () => {
    const liveAttemptAt = new Date();
    mockPrisma.openVikingMemoryRecord.findFirst.mockResolvedValue(
      buildMemory("DELETE_PENDING", {
        lastDeleteAttemptAt: liveAttemptAt,
        deletionAttemptCount: 1,
      }),
    );
    mockPrisma.openVikingMemoryRecord.findUnique.mockResolvedValue(
      buildMemory("DELETE_PENDING", {
        lastDeleteAttemptAt: liveAttemptAt,
        deletionAttemptCount: 1,
      }),
    );

    const result = await retryRepresentativeOpenVikingMemoryDeletion({
      representativeSlug: "lin-founder-rep",
      memoryId: "memory-1",
    });

    expect(mockPrisma.openVikingMemoryRecord.updateMany).not.toHaveBeenCalled();
    expect(result?.status).toBe("DELETE_PENDING");
  });

  it("lets a confirmed remote success converge DELETE_FAILED to DELETED", async () => {
    process.env.OPENVIKING_ENABLED = "true";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ status: "ok", result: {} }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )));
    mockPrisma.openVikingMemoryRecord.findFirst.mockResolvedValue(
      buildMemory("DELETE_FAILED", {
        lastDeleteAttemptAt: new Date("2026-07-31T03:00:00.000Z"),
        deletionAttemptCount: 1,
        deletionError: "provider timeout",
      }),
    );
    mockPrisma.openVikingMemoryRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.openVikingMemoryRecord.findUnique.mockResolvedValue(
      buildMemory("DELETED", {
        summary: "",
        deletedAt: new Date("2026-07-31T04:00:00.000Z"),
        deletionAttemptCount: 2,
      }),
    );

    const result = await retryRepresentativeOpenVikingMemoryDeletion({
      representativeSlug: "lin-founder-rep",
      memoryId: "memory-1",
    });

    const deletedUpdate = mockPrisma.openVikingMemoryRecord.updateMany.mock.calls
      .map((call) => call[0])
      .find((call) => call.data.status === "DELETED");
    expect(deletedUpdate).toMatchObject({
      where: {
        status: "DELETE_PENDING",
        lastDeleteAttemptAt: expect.any(Date),
      },
      data: {
        status: "DELETED",
      },
    });
    expect(result?.status).toBe("DELETED");
  });

  it("recovers a migration-created DELETE_PENDING row with no lease", async () => {
    process.env.OPENVIKING_ENABLED = "true";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ status: "ok", result: {} }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )));
    mockPrisma.openVikingMemoryRecord.findMany.mockResolvedValue([
      buildMemory("DELETE_PENDING", {
        summary: "",
        lastDeleteAttemptAt: null,
      }),
    ]);
    mockPrisma.openVikingMemoryRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.openVikingMemoryRecord.findUnique.mockResolvedValue(
      buildMemory("DELETED", {
        summary: "",
        deletedAt: new Date("2026-07-31T04:00:00.000Z"),
        deletionAttemptCount: 1,
      }),
    );

    const result = await runOpenVikingMemoryDeletionRecoveryTick({
      now: new Date("2026-07-31T04:00:00.000Z"),
      limit: 3,
    });

    expect(result).toEqual({
      processed: 1,
      deleted: 1,
      failed: 0,
      pending: 0,
    });
    expect(mockPrisma.openVikingMemoryRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        where: {
          OR: expect.arrayContaining([
            expect.objectContaining({ status: "DELETE_PENDING" }),
            expect.objectContaining({ status: "DELETE_FAILED" }),
          ]),
        },
      }),
    );
  });

  it("attributes memory governance audits to the authenticated owner", async () => {
    mockPrisma.openVikingMemoryRecord.findFirst.mockResolvedValue(
      buildMemory("ACTIVE"),
    );
    mockPrisma.openVikingMemoryRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.openVikingMemoryRecord.findUnique.mockResolvedValue(
      buildMemory("SUPPRESSED"),
    );

    await suppressRepresentativeOpenVikingMemory({
      representativeSlug: "lin-founder-rep",
      memoryId: "memory-1",
      ownerId: "owner-1",
    });

    expect(mockPrisma.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: "owner-1",
        representativeId: "rep-1",
      }),
    });
  });
});

function buildMemory(
  status: "ACTIVE" | "SUPPRESSED" | "DELETE_PENDING" | "DELETED" | "DELETE_FAILED",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "memory-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    audienceIdentityId: null,
    uri: "viking://user/memories/delegate/lin-founder-rep/contact-1/preferences/timezone.md",
    contextType: "memory",
    scope: "contact",
    category: "preference",
    summary: "Prefers Asia/Shanghai.",
    sourceKind: "collector",
    status,
    suppressedAt: null,
    deletedAt: null,
    lastDeleteAttemptAt: null,
    nextDeleteAttemptAt: null,
    deletionAttemptCount: 0,
    deletionError: null,
    deletionRequestedByOwnerId: null,
    createdAt: new Date("2026-07-31T03:00:00.000Z"),
    updatedAt: new Date("2026-07-31T03:00:00.000Z"),
    contact: {
      id: "contact-1",
      displayName: "Mia",
      username: null,
      telegramUserId: null,
      channelUserId: "web-1",
    },
    representative: {
      id: "rep-1",
      ownerId: "owner-1",
      slug: "lin-founder-rep",
      openvikingAgentId: null,
    },
    ...overrides,
  };
}
