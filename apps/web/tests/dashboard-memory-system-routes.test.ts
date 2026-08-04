import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepresentativeAccessError } from "@delegate/web-data";
import { MemoryDashboardError } from "@delegate/web-data/memory-dashboard";

const mocks = vi.hoisted(() => ({
  executeMemoryDashboardAction: vi.fn(),
  getMemoryDashboardOverview: vi.fn(),
  getMemoryDashboardSettings: vi.fn(),
  listMemoryDashboardEntries: vi.fn(),
  listMemoryDashboardOperations: vi.fn(),
  listMemoryDashboardReconciliation: vi.fn(),
  listMemoryDashboardUsage: vi.fn(),
  requireDashboardApiOwnerSession: vi.fn(),
  resolveDashboardRequestMetadata: vi.fn(),
  updateMemoryDashboardSettings: vi.fn(),
}));

vi.mock("@delegate/web-data/memory-dashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@delegate/web-data/memory-dashboard")>(),
  executeMemoryDashboardAction: mocks.executeMemoryDashboardAction,
  getMemoryDashboardOverview: mocks.getMemoryDashboardOverview,
  getMemoryDashboardSettings: mocks.getMemoryDashboardSettings,
  listMemoryDashboardEntries: mocks.listMemoryDashboardEntries,
  listMemoryDashboardOperations: mocks.listMemoryDashboardOperations,
  listMemoryDashboardReconciliation: mocks.listMemoryDashboardReconciliation,
  listMemoryDashboardUsage: mocks.listMemoryDashboardUsage,
  updateMemoryDashboardSettings: mocks.updateMemoryDashboardSettings,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardApiOwnerSession: mocks.requireDashboardApiOwnerSession,
}));

vi.mock("../app/api/dashboard/request-metadata", () => ({
  resolveDashboardRequestMetadata: mocks.resolveDashboardRequestMetadata,
}));

import { GET as getEntries } from "../app/api/dashboard/memory/entries/route";
import {
  GET as getOperations,
  POST as postOperation,
} from "../app/api/dashboard/memory/operations/route";
import { GET as getOverview } from "../app/api/dashboard/memory/overview/route";
import { GET as getReconciliation } from "../app/api/dashboard/memory/reconciliation/route";
import {
  GET as getSettings,
  PATCH as patchSettings,
} from "../app/api/dashboard/memory/settings/route";
import { GET as getUsage } from "../app/api/dashboard/memory/usage/route";

const representative = {
  id: "rep-1",
  slug: "delegate",
  displayName: "Delegate",
};

describe("dashboard memory system routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardApiOwnerSession.mockResolvedValue({ ownerId: "owner-1" });
    mocks.resolveDashboardRequestMetadata.mockReturnValue({
      requestId: "request-1",
      idempotencyKey: "ignored-fallback",
    });
    mocks.getMemoryDashboardOverview.mockResolvedValue({
      representative,
      metrics: {
        effectiveMemories: 2,
        pendingCandidates: 1,
        today: {
          searchHits: 5,
          injectedIntoModel: 2,
          citedByModel: 1,
          displayedSources: 1,
        },
      },
    });
    mocks.listMemoryDashboardEntries.mockResolvedValue(emptyPage());
    mocks.listMemoryDashboardUsage.mockResolvedValue(emptyPage());
    mocks.listMemoryDashboardOperations.mockResolvedValue(emptyPage());
    mocks.listMemoryDashboardReconciliation.mockResolvedValue(emptyPage());
    mocks.getMemoryDashboardSettings.mockResolvedValue({
      representative,
      revision: 0,
      advanced: {
        provider: "openviking",
        recallLimit: 6,
        recallThreshold: 0.01,
        namespaceManagedByServer: true,
        targetManagedByServer: true,
      },
    });
    mocks.executeMemoryDashboardAction.mockResolvedValue({
      requestId: "request-1",
      result: { action: "suppress_memory", status: "SUPPRESSED" },
    });
    mocks.updateMemoryDashboardSettings.mockResolvedValue({
      requestId: "request-1",
      settings: { representative, revision: 1 },
    });
  });

  it("serves all six owner-scoped read surfaces as private no-store", async () => {
    const cases = [
      [getOverview, "/overview?rep=delegate"],
      [getEntries, "/entries?rep=delegate&scope=CONTACT_CHANNEL&limit=20"],
      [getUsage, "/usage?rep=delegate&sourceKind=CONTACT_MEMORY"],
      [getOperations, "/operations?rep=delegate&kind=cleanup"],
      [getReconciliation, "/reconciliation?rep=delegate"],
      [getSettings, "/settings?rep=delegate"],
    ] as const;
    for (const [handler, path] of cases) {
      const response = await handler(new Request(`http://localhost/api/dashboard/memory${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.getMemoryDashboardOverview).toHaveBeenCalledWith({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    });
    expect(mocks.listMemoryDashboardEntries).toHaveBeenCalledWith(expect.objectContaining({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      query: expect.objectContaining({ scope: "CONTACT_CHANNEL", limit: 20 }),
    }));
  });

  it("rejects unknown and repeated URL filters before calling data services", async () => {
    const unknown = await getEntries(new Request(
      "http://localhost/api/dashboard/memory/entries?rep=delegate&rawQuery=secret",
    ));
    expect(unknown.status).toBe(422);
    await expect(unknown.json()).resolves.toMatchObject({
      code: "memory_dashboard_invalid_request",
    });

    const repeated = await getUsage(new Request(
      "http://localhost/api/dashboard/memory/usage?rep=delegate&rep=other",
    ));
    expect(repeated.status).toBe(422);
    await expect(repeated.json()).resolves.toMatchObject({
      code: "memory_dashboard_invalid_query",
    });
    expect(mocks.listMemoryDashboardEntries).not.toHaveBeenCalled();
    expect(mocks.listMemoryDashboardUsage).not.toHaveBeenCalled();
  });

  it("requires an authenticated persisted Owner identity", async () => {
    mocks.requireDashboardApiOwnerSession.mockRejectedValueOnce(
      new RepresentativeAccessError("Authentication required.", 401),
    );
    const response = await getOverview(new Request(
      "http://localhost/api/dashboard/memory/overview?rep=delegate",
    ));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
      code: "memory_dashboard_unauthorized",
    });
  });

  it("requires Idempotency-Key and forwards optimistic governance metadata", async () => {
    const missingKey = await postOperation(jsonRequest(
      "/operations?rep=delegate",
      { action: "enqueue_reconciliation" },
    ));
    expect(missingKey.status).toBe(422);
    await expect(missingKey.json()).resolves.toMatchObject({
      code: "memory_dashboard_idempotency_required",
    });

    const response = await postOperation(jsonRequest(
      "/operations?rep=delegate",
      {
        action: "suppress_memory",
        memoryId: "memory-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "owner_request",
      },
      "memory-action-1",
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.executeMemoryDashboardAction).toHaveBeenCalledWith({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-1",
      idempotencyKey: "memory-action-1",
      action: {
        action: "suppress_memory",
        memoryId: "memory-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "owner_request",
      },
    });

    await postOperation(jsonRequest(
      "/operations?rep=delegate",
      {
        action: "retry_projection",
        projectionItemId: "projection-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "owner_retry",
      },
      "projection-retry-1",
    ));
    expect(mocks.executeMemoryDashboardAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: "projection-retry-1",
        action: expect.objectContaining({
          action: "retry_projection",
          projectionItemId: "projection-1",
          expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        }),
      }),
    );
  });

  it("preserves reviewer allow/deny decisions at the operations route", async () => {
    mocks.requireDashboardApiOwnerSession.mockResolvedValue({ ownerId: "reviewer-1" });
    mocks.executeMemoryDashboardAction.mockResolvedValueOnce({
      requestId: "request-1",
      result: { action: "approve_candidate", status: "APPROVED" },
    });
    const approved = await postOperation(jsonRequest(
      "/operations?rep=delegate",
      {
        action: "approve_candidate",
        candidateId: "candidate-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "reviewer_decision",
      },
      "review-candidate-1",
    ));
    expect(approved.status).toBe(200);
    expect(mocks.executeMemoryDashboardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actorOwnerId: "reviewer-1",
        action: expect.objectContaining({ action: "approve_candidate" }),
      }),
    );

    mocks.executeMemoryDashboardAction.mockRejectedValueOnce(
      new MemoryDashboardError(
        "memory_dashboard_forbidden",
        "Reviewers may only review pending memory candidates.",
        403,
      ),
    );
    const denied = await postOperation(jsonRequest(
      "/operations?rep=delegate",
      {
        action: "suppress_memory",
        memoryId: "memory-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "reviewer_attempt",
      },
      "reviewer-suppress-1",
    ));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      code: "memory_dashboard_forbidden",
    });
  });

  it("strictly validates settings and exposes no editable namespace or target", async () => {
    const validPolicy = {
      basic: {
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        representativeExperienceEnabled: false,
        autoExtract: false,
      },
      channels: {
        web: { recallEnabled: true, extractEnabled: false },
        matrix: { recallEnabled: false, extractEnabled: false },
        telegram: { recallEnabled: false, extractEnabled: false },
      },
      retention: { days: 30, expiryAction: "ARCHIVE" },
      advanced: {
        provider: "openviking",
        recallLimit: 6,
        recallThreshold: 0.01,
      },
    };
    const invalid = await patchSettings(jsonRequest(
      "/settings?rep=delegate",
      {
        expectedRevision: 0,
        policy: { ...validPolicy, targetUri: "viking://unsafe" },
      },
      "settings-1",
      "PATCH",
    ));
    expect(invalid.status).toBe(422);
    expect(mocks.updateMemoryDashboardSettings).not.toHaveBeenCalled();

    const unsupportedChannel = await patchSettings(jsonRequest(
      "/settings?rep=delegate",
      {
        expectedRevision: 0,
        policy: {
          ...validPolicy,
          channels: {
            ...validPolicy.channels,
            matrix: { recallEnabled: true, extractEnabled: false },
          },
        },
      },
      "settings-unsupported-channel",
      "PATCH",
    ));
    expect(unsupportedChannel.status).toBe(422);
    await expect(unsupportedChannel.json()).resolves.toMatchObject({
      code: "memory_dashboard_invalid_request",
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("pre-interaction disclosure"),
          reasonCode: "memory_channel_disclosure_unavailable",
        }),
      ]),
    });
    expect(mocks.updateMemoryDashboardSettings).not.toHaveBeenCalled();

    const valid = await patchSettings(jsonRequest(
      "/settings?rep=delegate",
      { expectedRevision: 0, policy: validPolicy },
      "settings-1",
      "PATCH",
    ));
    expect(valid.status).toBe(200);
    expect(mocks.updateMemoryDashboardSettings).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "settings-1",
      update: { expectedRevision: 0, policy: validPolicy },
    }));

    const getResponse = await getSettings(new Request(
      "http://localhost/api/dashboard/memory/settings?rep=delegate",
    ));
    const payload = await getResponse.json();
    expect(payload.advanced).toMatchObject({
      namespaceManagedByServer: true,
      targetManagedByServer: true,
    });
    expect(JSON.stringify(payload)).not.toMatch(/(?:uri|layer|score|session|rawQuery)/iu);
  });

  it("forwards capped reconciliation issue pagination", async () => {
    const response = await getReconciliation(new Request(
      "http://localhost/api/dashboard/memory/reconciliation?rep=delegate&runId=recon-1&itemLimit=50",
    ));
    expect(response.status).toBe(200);
    expect(mocks.listMemoryDashboardReconciliation).toHaveBeenCalledWith({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      query: {
        rep: "delegate",
        runId: "recon-1",
        itemLimit: 50,
      },
    });
  });
});

function emptyPage() {
  return {
    representative,
    page: {
      asOf: "2026-08-04T00:00:00.000Z",
      limit: 25,
      hasMore: false,
      nextCursor: null,
    },
    items: [],
  };
}

function jsonRequest(
  path: string,
  body: unknown,
  idempotencyKey?: string,
  method = "POST",
) {
  return new Request(`http://localhost/api/dashboard/memory${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}
