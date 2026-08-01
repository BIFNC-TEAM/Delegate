import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeDashboardRepresentativeAccess: vi.fn(),
  dashboardAuthErrorResponse: vi.fn(),
  deleteRepresentativeOpenVikingMemory: vi.fn(),
  getRepresentativeOpenVikingMemoryPreview: vi.fn(),
  getRepresentativeOpenVikingRecallUsage: vi.fn(),
  getRepresentativeOpenVikingSnapshot: vi.fn(),
  requireDashboardRepresentativeAccess: vi.fn(),
  retryRepresentativeOpenVikingMemoryDeletion: vi.fn(),
  suppressRepresentativeOpenVikingMemory: vi.fn(),
  syncRepresentativeOpenVikingResources: vi.fn(),
  updateRepresentativeOpenVikingConfig: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  deleteRepresentativeOpenVikingMemory:
    mocks.deleteRepresentativeOpenVikingMemory,
  getRepresentativeOpenVikingMemoryPreview:
    mocks.getRepresentativeOpenVikingMemoryPreview,
  getRepresentativeOpenVikingRecallUsage:
    mocks.getRepresentativeOpenVikingRecallUsage,
  getRepresentativeOpenVikingSnapshot:
    mocks.getRepresentativeOpenVikingSnapshot,
  retryRepresentativeOpenVikingMemoryDeletion:
    mocks.retryRepresentativeOpenVikingMemoryDeletion,
  suppressRepresentativeOpenVikingMemory:
    mocks.suppressRepresentativeOpenVikingMemory,
  syncRepresentativeOpenVikingResources:
    mocks.syncRepresentativeOpenVikingResources,
  updateRepresentativeOpenVikingConfig:
    mocks.updateRepresentativeOpenVikingConfig,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  authorizeDashboardRepresentativeAccess:
    mocks.authorizeDashboardRepresentativeAccess,
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess:
    mocks.requireDashboardRepresentativeAccess,
}));

import {
  GET as getContextSettings,
  PATCH as patchContextSettings,
} from "../app/api/dashboard/representatives/[slug]/openviking/route";
import {
  DELETE as deleteMemory,
  PATCH as patchMemory,
} from "../app/api/dashboard/representatives/[slug]/openviking/memories/[memoryId]/route";
import { GET as getMemories } from "../app/api/dashboard/representatives/[slug]/openviking/memories/route";
import { GET as getRecallUsage } from "../app/api/dashboard/representatives/[slug]/openviking/recall-traces/route";
import { POST as syncContext } from "../app/api/dashboard/representatives/[slug]/openviking/sync/route";

const representativeContext = {
  params: Promise.resolve({ slug: "delegate" }),
};
const memoryContext = {
  params: Promise.resolve({ slug: "delegate", memoryId: "memory-1" }),
};

describe("dashboard governed context routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeDashboardRepresentativeAccess.mockResolvedValue(null);
    mocks.requireDashboardRepresentativeAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
  });

  it("strictly rejects string booleans and client-owned provider fields", async () => {
    const stringBoolean = await patchContextSettings(
      jsonRequest({
        enabled: "false",
        autoRecall: true,
        recallLimit: 6,
        recallScoreThreshold: 0.1,
      }),
      representativeContext,
    );
    const targetOverride = await patchContextSettings(
      jsonRequest({
        enabled: true,
        autoRecall: true,
        autoCapture: false,
        recallLimit: 6,
        recallScoreThreshold: 0.1,
        targetUri: "viking://agent/memories/other",
      }),
      representativeContext,
    );

    expect(stringBoolean.status).toBe(422);
    expect(targetOverride.status).toBe(422);
    expect(stringBoolean.headers.get("cache-control")).toBe("private, no-store");
    expect(targetOverride.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.updateRepresentativeOpenVikingConfig).not.toHaveBeenCalled();
  });

  it("rejects attempts to enable automatic conversation capture", async () => {
    const response = await patchContextSettings(
      jsonRequest({
        enabled: true,
        autoRecall: true,
        autoCapture: true,
        recallLimit: 6,
        recallScoreThreshold: 0.1,
      }),
      representativeContext,
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.updateRepresentativeOpenVikingConfig).not.toHaveBeenCalled();
  });

  it("passes only validated owner controls to the service", async () => {
    const snapshot = unsafeSnapshot({
      recallLimit: 8,
      recallScoreThreshold: 0.2,
    });
    mocks.updateRepresentativeOpenVikingConfig.mockResolvedValue(snapshot);

    const response = await patchContextSettings(
      jsonRequest({
        enabled: true,
        autoRecall: true,
        autoCapture: false,
        recallLimit: 8,
        recallScoreThreshold: 0.2,
      }),
      representativeContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.updateRepresentativeOpenVikingConfig).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      input: {
        enabled: true,
        autoRecall: true,
        autoCapture: false,
        recallLimit: 8,
        recallScoreThreshold: 0.2,
      },
      ownerId: "owner-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      autoRecall: true,
      autoCapture: false,
      recallLimit: 8,
      recallScoreThreshold: 0.2,
    });
  });

  it("maps settings reads, updates, and syncs to the same safe DTO", async () => {
    const snapshot = unsafeSnapshot();
    mocks.getRepresentativeOpenVikingSnapshot.mockResolvedValue(snapshot);
    mocks.updateRepresentativeOpenVikingConfig.mockResolvedValue(snapshot);
    mocks.syncRepresentativeOpenVikingResources.mockResolvedValue(snapshot);

    const responses = [
      await getContextSettings(
        new Request("http://localhost/api/dashboard/representatives/delegate/openviking"),
        representativeContext,
      ),
      await patchContextSettings(
        jsonRequest({
          enabled: true,
          autoRecall: true,
          autoCapture: false,
          recallLimit: 6,
          recallScoreThreshold: 0.1,
        }),
        representativeContext,
      ),
      await syncContext(
        new Request(
          "http://localhost/api/dashboard/representatives/delegate/openviking/sync",
          { method: "POST" },
        ),
        representativeContext,
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(Object.keys(payload).sort()).toEqual([
        "autoCapture",
        "autoRecall",
        "enabled",
        "lastSyncAt",
        "lastSyncItemCount",
        "lastSyncStatus",
        "publicKnowledgeSyncAvailable",
        "recallLimit",
        "recallScoreThreshold",
        "recentCommitActivity",
        "recentSyncJobs",
        "representativeSlug",
        "serviceStatus",
      ]);
      expect(payload.recentSyncJobs[0]).toEqual({
        status: "failed",
        itemCount: 0,
        startedAt: "2026-07-31T00:00:00.000Z",
        finishedAt: "2026-07-31T00:01:00.000Z",
      });
      expect(payload.recentCommitActivity[0]).toEqual({
        status: "failed",
        memoriesExtracted: 0,
        createdAt: "2026-07-31T00:02:00.000Z",
      });
      expect(JSON.stringify(payload)).not.toMatch(
        /agentId|agentIdOverride|targetUri|baseUrl|consoleUrl|captureMode|resourceSyncEnabled|lastSyncError|sessionId|sessionKey|provider stack|private-host/u,
      );
    }
    expect(mocks.syncRepresentativeOpenVikingResources).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      trigger: "manual",
      ownerId: "owner-1",
    });
  });

  it.each([
    "blocked_unpublished",
    "blocked_missing_credentials",
    "failed",
  ])("preserves the business sync result %s in the safe response", async (status) => {
    mocks.syncRepresentativeOpenVikingResources.mockResolvedValue(
      unsafeSnapshot({
        lastSyncStatus: status,
        health: {
          status: "healthy",
          detail: "internal provider detail",
          mode: "remote",
          baseUrl: "https://private-host",
        },
      }),
    );

    const response = await syncContext(
      new Request(
        "http://localhost/api/dashboard/representatives/delegate/openviking/sync",
        { method: "POST" },
      ),
      representativeContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.lastSyncStatus).toBe(status);
    expect(JSON.stringify(payload)).not.toMatch(
      /internal provider detail|private-host|lastSyncError/u,
    );
  });

  it("keeps sync unavailable while model credentials are missing", async () => {
    mocks.getRepresentativeOpenVikingSnapshot.mockResolvedValue(
      unsafeSnapshot({
        modelCredentialsAvailable: false,
        health: {
          status: "healthy",
          detail: "API reachable but model credentials are missing.",
          mode: "remote",
          baseUrl: "https://private-host",
        },
      }),
    );

    const response = await getContextSettings(
      new Request(
        "http://localhost/api/dashboard/representatives/delegate/openviking",
      ),
      representativeContext,
    );
    const payload = await response.json();

    expect(payload.serviceStatus).toBe("unavailable");
    expect(payload.publicKnowledgeSyncAvailable).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("modelCredentialsAvailable");
  });

  it.each([
    ["queued", "queued"],
    ["retry_wait", "pending"],
  ])("normalizes durable job status %s to %s", async (status, expected) => {
    mocks.getRepresentativeOpenVikingSnapshot.mockResolvedValue(
      unsafeSnapshot({
        lastSyncStatus: status,
        recentSyncJobs: [{
          id: "sync-job",
          status,
          itemCount: 0,
          startedAt: "2026-07-31T00:00:00.000Z",
        }],
      }),
    );

    const response = await getContextSettings(
      new Request(
        "http://localhost/api/dashboard/representatives/delegate/openviking",
      ),
      representativeContext,
    );
    const payload = await response.json();

    expect(payload.lastSyncStatus).toBe(expected);
    expect(payload.recentSyncJobs[0].status).toBe(expected);
  });

  it("returns only aggregate recall usage and safe governed-memory fields", async () => {
    mocks.getRepresentativeOpenVikingRecallUsage.mockResolvedValue({
      today: 2,
      total: 9,
      queryText: "private visitor question",
      recalledUri: "viking://internal/secret",
      score: 0.98,
    });
    mocks.getRepresentativeOpenVikingMemoryPreview.mockResolvedValue([
      unsafeMemory(),
    ]);

    const recallResponse = await getRecallUsage(
      new Request(
        "http://localhost/api/dashboard/representatives/delegate/openviking/recall-traces",
      ),
      representativeContext,
    );
    const memoryResponse = await getMemories(
      new Request(
        "http://localhost/api/dashboard/representatives/delegate/openviking/memories",
      ),
      representativeContext,
    );
    const recallPayload = await recallResponse.json();
    const memoryPayload = await memoryResponse.json();

    expect(recallPayload).toEqual({ usage: { today: 2, total: 9 } });
    expect(JSON.stringify(recallPayload)).not.toMatch(
      /queryText|recalledUri|score|private visitor question|viking:\/\//u,
    );
    expect(memoryPayload).toEqual({
      memories: [
        {
          id: "memory-1",
          contactDisplayLabel: "Visitor",
          summary: "",
          status: "DELETE_FAILED",
          createdAt: "2026-07-29T00:00:00.000Z",
          lastActionAttemptAt: "2026-07-31T00:03:00.000Z",
          actionAttemptCount: 3,
        },
      ],
    });
    expect(JSON.stringify(memoryPayload)).not.toMatch(
      /uri|scope|sourceKind|category|contact-id|deletionError|hunter2/u,
    );
  });

  it("redacts provider and database errors from settings reads", async () => {
    mocks.getRepresentativeOpenVikingSnapshot.mockRejectedValue(
      new Error("postgres://owner:password@private-host/delegate"),
    );

    const response = await getContextSettings(
      new Request("http://localhost/api/dashboard/representatives/delegate/openviking"),
      representativeContext,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("Failed to load governed context settings.");
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-host");
  });

  it("keeps suppress, retry, delete, not-found, and auth responses private", async () => {
    const memory = unsafeMemory({ status: "SUPPRESSED" });
    mocks.suppressRepresentativeOpenVikingMemory.mockResolvedValue(memory);
    mocks.retryRepresentativeOpenVikingMemoryDeletion.mockResolvedValue({
      ...memory,
      status: "DELETED",
    });
    mocks.deleteRepresentativeOpenVikingMemory.mockResolvedValue({
      ...memory,
      status: "DELETE_PENDING",
    });

    const suppressed = await patchMemory(
      jsonRequest({ action: "suppress" }),
      memoryContext,
    );
    const retried = await patchMemory(
      jsonRequest({ action: "retry" }),
      memoryContext,
    );
    const deleted = await deleteMemory(
      new Request(
        "http://localhost/api/dashboard/representatives/delegate/openviking/memories/memory-1",
        { method: "DELETE" },
      ),
      memoryContext,
    );

    expect(suppressed.status).toBe(200);
    expect(retried.status).toBe(200);
    expect(deleted.status).toBe(200);
    for (const response of [suppressed, retried, deleted]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(JSON.stringify(await response.json())).not.toMatch(
        /uri|scope|sourceKind|category|contact-id|deletionError|hunter2/u,
      );
    }
    expect(mocks.suppressRepresentativeOpenVikingMemory).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      memoryId: "memory-1",
      ownerId: "owner-1",
    });
    expect(mocks.retryRepresentativeOpenVikingMemoryDeletion).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      memoryId: "memory-1",
      ownerId: "owner-1",
    });
    expect(mocks.deleteRepresentativeOpenVikingMemory).toHaveBeenCalledWith({
      representativeSlug: "delegate",
      memoryId: "memory-1",
      ownerId: "owner-1",
    });

    mocks.suppressRepresentativeOpenVikingMemory.mockResolvedValue(null);
    const missing = await patchMemory(
      jsonRequest({ action: "suppress" }),
      memoryContext,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");

    const forbiddenError = new Error("Forbidden.");
    mocks.requireDashboardRepresentativeAccess.mockRejectedValue(
      forbiddenError,
    );
    mocks.dashboardAuthErrorResponse.mockImplementation((error) =>
      error === forbiddenError
        ? Response.json({ error: "Forbidden." }, { status: 403 })
        : null,
    );
    const forbidden = await deleteMemory(
      new Request(
        "http://localhost/api/dashboard/representatives/delegate/openviking/memories/memory-1",
        { method: "DELETE" },
      ),
      memoryContext,
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("cache-control")).toBe("private, no-store");
  });
});

function jsonRequest(body: unknown) {
  return new Request(
    "http://localhost/api/dashboard/representatives/delegate/openviking",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function unsafeSnapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    representativeSlug: "delegate",
    enabled: true,
    agentId: "agent-secret",
    agentIdOverride: "agent-override-secret",
    autoRecall: true,
    autoCapture: false,
    captureMode: "semantic",
    recallLimit: 6,
    recallScoreThreshold: 0.1,
    targetUri: "viking://internal/representative",
    resourceSyncEnabled: true,
    modelCredentialsAvailable: true,
    lastSyncAt: "2026-07-31T00:01:00.000Z",
    lastSyncStatus: "failed",
    lastSyncItemCount: 0,
    lastSyncError: "provider stack at private-host",
    health: {
      status: "degraded",
      detail: "provider stack at private-host",
      mode: "remote",
      baseUrl: "https://private-host",
      consoleUrl: "https://private-host/console",
    },
    recentSyncJobs: [
      {
        id: "sync-internal-id",
        status: "failed",
        itemCount: 0,
        error: "provider stack at private-host",
        startedAt: "2026-07-31T00:00:00.000Z",
        finishedAt: "2026-07-31T00:01:00.000Z",
      },
    ],
    recentCommitTraces: [
      {
        id: "trace-internal-id",
        sessionId: "session-secret",
        sessionKey: "session-key-secret",
        reason: "provider-specific reason",
        status: "failed",
        memoriesExtracted: 0,
        createdAt: "2026-07-31T00:02:00.000Z",
        error: "provider stack at private-host",
      },
    ],
    ...overrides,
  };
}

function unsafeMemory(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "memory-1",
    uri: "viking://internal/memory-1",
    scope: "contact",
    category: "preference",
    summary: "password: hunter2",
    sourceKind: "conversation_summary",
    status: "DELETE_FAILED",
    suppressedAt: "2026-07-30T00:00:00.000Z",
    deletedAt: undefined,
    lastDeleteAttemptAt: "2026-07-31T00:03:00.000Z",
    deletionAttemptCount: 3,
    deletionError: "provider stack at private-host",
    createdAt: "2026-07-29T00:00:00.000Z",
    contact: {
      id: "contact-id",
      displayName: "Visitor",
    },
    ...overrides,
  };
}
