import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeDashboardRepresentativeAccess: vi.fn(),
  requireDashboardRepresentativeAccessActor: vi.fn(),
  dashboardAuthErrorResponse: vi.fn(),
  buildCreatorTrainingSuggestions: vi.fn(),
  createCreatorFeedbackSignal: vi.fn(),
  createCreatorTrainingSource: vi.fn(),
  disableCreatorTrainingSource: vi.fn(),
  enqueueCreatorTrainingReviewWorkflow: vi.fn(),
  getCreatorTrainingDashboardSnapshot: vi.fn(),
  listCreatorFeedbackSignals: vi.fn(),
  listCreatorTrainingSources: vi.fn(),
  listCreatorTrainingSuggestions: vi.fn(),
  reviewCreatorTrainingSuggestion: vi.fn(),
  rollbackCreatorTrainingVersion: vi.fn(),
  updateCreatorTrainingSource: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  buildCreatorTrainingSuggestions: routeMocks.buildCreatorTrainingSuggestions,
  createCreatorFeedbackSignal: routeMocks.createCreatorFeedbackSignal,
  createCreatorTrainingSource: routeMocks.createCreatorTrainingSource,
  disableCreatorTrainingSource: routeMocks.disableCreatorTrainingSource,
  enqueueCreatorTrainingReviewWorkflow:
    routeMocks.enqueueCreatorTrainingReviewWorkflow,
  getCreatorTrainingDashboardSnapshot:
    routeMocks.getCreatorTrainingDashboardSnapshot,
  listCreatorFeedbackSignals: routeMocks.listCreatorFeedbackSignals,
  listCreatorTrainingSources: routeMocks.listCreatorTrainingSources,
  listCreatorTrainingSuggestions: routeMocks.listCreatorTrainingSuggestions,
  reviewCreatorTrainingSuggestion:
    routeMocks.reviewCreatorTrainingSuggestion,
  rollbackCreatorTrainingVersion:
    routeMocks.rollbackCreatorTrainingVersion,
  updateCreatorTrainingSource: routeMocks.updateCreatorTrainingSource,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  authorizeDashboardRepresentativeAccess:
    routeMocks.authorizeDashboardRepresentativeAccess,
  requireDashboardRepresentativeAccessActor:
    routeMocks.requireDashboardRepresentativeAccessActor,
  dashboardAuthErrorResponse: routeMocks.dashboardAuthErrorResponse,
}));

import { GET as getDevelopmentSnapshot } from "../app/api/dashboard/representatives/[slug]/training/route";
import { POST as createFeedback } from "../app/api/dashboard/representatives/[slug]/training/feedback/route";
import { POST as createSource } from "../app/api/dashboard/representatives/[slug]/training/sources/route";
import {
  DELETE as disableSource,
  PATCH as updateSource,
} from "../app/api/dashboard/representatives/[slug]/training/sources/[sourceId]/route";
import { POST as buildSuggestions } from "../app/api/dashboard/representatives/[slug]/training/suggestions/route";
import { PATCH as reviewSuggestion } from "../app/api/dashboard/representatives/[slug]/training/suggestions/[suggestionId]/route";
import { POST as rollbackVersion } from "../app/api/dashboard/representatives/[slug]/training/versions/[versionId]/rollback/route";
import { POST as enqueueTrainingWorkflow } from "../app/api/dashboard/representatives/[slug]/training/workflows/route";

const trainingRoutePaths = [
  "../app/api/dashboard/representatives/[slug]/training/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/feedback/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/sources/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/sources/[sourceId]/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/suggestions/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/suggestions/[suggestionId]/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/versions/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/versions/[versionId]/rollback/route.ts",
  "../app/api/dashboard/representatives/[slug]/training/workflows/route.ts",
];
const dashboardAuthSource = readFileSync(
  new URL("../app/api/dashboard/auth.ts", import.meta.url),
  "utf8",
);

describe("Representative Development routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.authorizeDashboardRepresentativeAccess.mockResolvedValue(null);
    routeMocks.requireDashboardRepresentativeAccessActor.mockResolvedValue("session-owner-7");
    routeMocks.dashboardAuthErrorResponse.mockReturnValue(null);
    routeMocks.createCreatorFeedbackSignal.mockResolvedValue({ id: "feedback-1" });
    routeMocks.createCreatorTrainingSource.mockResolvedValue({ id: "source-1" });
    routeMocks.getCreatorTrainingDashboardSnapshot.mockResolvedValue({
      sources: [],
      feedbackSignals: [],
      suggestions: [],
      versions: [],
      latestWorkflow: null,
      summary: {
        availableSourceCount: 0,
        pendingFeedbackCount: 0,
        pendingSuggestionCount: 0,
        appliedVersionCount: 0,
      },
    });
    routeMocks.reviewCreatorTrainingSuggestion.mockResolvedValue({
      suggestion: { id: "suggestion-1", status: "published" },
      version: { id: "version-1" },
    });
    routeMocks.rollbackCreatorTrainingVersion.mockResolvedValue({
      id: "version-1",
      status: "rolled_back",
      rolledBackBy: "session-owner-7",
    });
  });

  it("returns one real private dashboard snapshot", async () => {
    const response = await getDevelopmentSnapshot(
      new Request("http://localhost/api/dashboard/representatives/lin/training"),
      { params: Promise.resolve({ slug: "lin" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(routeMocks.getCreatorTrainingDashboardSnapshot).toHaveBeenCalledWith("lin");
    expect(await response.json()).toMatchObject({
      summary: { pendingSuggestionCount: 0 },
    });
  });

  it("returns a least-privilege dashboard DTO without internal actor or workflow ids", async () => {
    routeMocks.getCreatorTrainingDashboardSnapshot.mockResolvedValueOnce({
      sources: [
        {
          id: "source-1",
          kind: "text",
          status: "active",
          title: "Refund policy",
          locator: null,
          contentText: "Seven days.",
          metadata: { providerInternalId: "provider_internal_1" },
          lastSyncedAt: null,
          errorReason: null,
          createdBy: "owner_internal_7",
          representativeId: "rep_internal_1",
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
      feedbackSignals: [
        {
          id: "feedback-1",
          signalType: "correction",
          status: "new",
          publicSafe: true,
          note: "Seven days.",
          suggestedText: "Refunds are available for seven days.",
          createdBy: "owner_internal_7",
          representativeId: "rep_internal_1",
          contactId: "contact_internal_1",
          conversationId: "conversation_internal_1",
          turnId: "turn_internal_1",
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
      suggestions: [
        {
          id: "suggestion-1",
          sourceId: "source-1",
          feedbackSignalId: null,
          suggestionType: "material_update",
          status: "pending",
          title: "Refund policy",
          rationale: "Owner source changed.",
          draftPayload: { title: "Refund policy", summary: "Seven days." },
          riskLevel: "low",
          reviewedAt: null,
          reviewNote: null,
          reviewedBy: "owner_internal_7",
          representativeId: "rep_internal_1",
          dedupeKey: "internal-dedupe",
          originKey: "internal-origin",
          originRevision: 1,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
      versions: [
        {
          id: "version-1",
          title: "Refund update",
          status: "published",
          publishedBy: "owner_internal_7",
          publishedAt: "2026-07-31T00:00:00.000Z",
          rolledBackBy: null,
          rolledBackAt: null,
          snapshotBefore: { secret: "before" },
          snapshotAfter: { secret: "after" },
          evaluationReport: { internal: true },
        },
      ],
      latestWorkflow: {
        id: "workflow-1",
        status: "completed",
        scheduledAt: "2026-07-31T00:00:00.000Z",
        createdAt: "2026-07-31T00:00:00.000Z",
        dedupeKey: "internal-dedupe",
        externalWorkflowId: "internal-workflow",
      },
      summary: {
        availableSourceCount: 0,
        pendingFeedbackCount: 0,
        pendingSuggestionCount: 0,
        appliedVersionCount: 1,
      },
    });

    const response = await getDevelopmentSnapshot(
      new Request("http://localhost/api/dashboard/representatives/lin/training"),
      { params: Promise.resolve({ slug: "lin" }) },
    );
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(payload.versions[0]).toEqual({
      id: "version-1",
      title: "Refund update",
      status: "published",
      ownerReviewed: true,
      publishedAt: "2026-07-31T00:00:00.000Z",
      ownerReverted: false,
      rolledBackAt: null,
    });
    expect(payload.latestWorkflow).toEqual({
      id: "workflow-1",
      status: "completed",
      scheduledAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    expect(serialized).not.toMatch(
      /owner_internal_7|rep_internal_1|contact_internal_1|conversation_internal_1|turn_internal_1|provider_internal_1|internal-dedupe|internal-origin|internal-workflow|snapshotBefore|snapshotAfter|evaluationReport/u,
    );
  });

  it("retires every legacy training write with one stable private 410 response", async () => {
    const unparseableJsonRequest = (url: string, method: "POST" | "PATCH") => new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const responses = await Promise.all([
      createFeedback(
        unparseableJsonRequest(
          "http://localhost/api/dashboard/representatives/lin/training/feedback",
          "POST",
        ),
        { params: Promise.resolve({ slug: "lin" }) },
      ),
      createSource(
        unparseableJsonRequest(
          "http://localhost/api/dashboard/representatives/lin/training/sources",
          "POST",
        ),
        { params: Promise.resolve({ slug: "lin" }) },
      ),
      updateSource(
        unparseableJsonRequest(
          "http://localhost/api/dashboard/representatives/lin/training/sources/source-1",
          "PATCH",
        ),
        { params: Promise.resolve({ slug: "lin", sourceId: "source-1" }) },
      ),
      disableSource(
        new Request(
          "http://localhost/api/dashboard/representatives/lin/training/sources/source-1",
          { method: "DELETE" },
        ),
        { params: Promise.resolve({ slug: "lin", sourceId: "source-1" }) },
      ),
      buildSuggestions(
        new Request(
          "http://localhost/api/dashboard/representatives/lin/training/suggestions",
          { method: "POST" },
        ),
        { params: Promise.resolve({ slug: "lin" }) },
      ),
      reviewSuggestion(
        unparseableJsonRequest(
          "http://localhost/api/dashboard/representatives/lin/training/suggestions/suggestion-1",
          "PATCH",
        ),
        { params: Promise.resolve({ slug: "lin", suggestionId: "suggestion-1" }) },
      ),
      rollbackVersion(
        new Request(
          "http://localhost/api/dashboard/representatives/lin/training/versions/version-1/rollback",
          { method: "POST" },
        ),
        { params: Promise.resolve({ slug: "lin", versionId: "version-1" }) },
      ),
      enqueueTrainingWorkflow(
        unparseableJsonRequest(
          "http://localhost/api/dashboard/representatives/lin/training/workflows",
          "POST",
        ),
        { params: Promise.resolve({ slug: "lin" }) },
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(410);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: "Legacy representative development writes are retired and no longer accepted.",
        code: "CREATOR_TRAINING_RETIRED",
      });
    }
    expect(routeMocks.authorizeDashboardRepresentativeAccess).toHaveBeenCalledTimes(8);
    expect(routeMocks.buildCreatorTrainingSuggestions).not.toHaveBeenCalled();
    expect(routeMocks.createCreatorFeedbackSignal).not.toHaveBeenCalled();
    expect(routeMocks.createCreatorTrainingSource).not.toHaveBeenCalled();
    expect(routeMocks.disableCreatorTrainingSource).not.toHaveBeenCalled();
    expect(routeMocks.enqueueCreatorTrainingReviewWorkflow).not.toHaveBeenCalled();
    expect(routeMocks.reviewCreatorTrainingSuggestion).not.toHaveBeenCalled();
    expect(routeMocks.rollbackCreatorTrainingVersion).not.toHaveBeenCalled();
    expect(routeMocks.updateCreatorTrainingSource).not.toHaveBeenCalled();
    expect(routeMocks.requireDashboardRepresentativeAccessActor).not.toHaveBeenCalled();
  });

  it("preserves authorization failures before returning the retirement response", async () => {
    const unauthorizedResponse = new Response(
      JSON.stringify({ error: "Unauthorized." }),
      {
        status: 401,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "application/json",
        },
      },
    );
    routeMocks.authorizeDashboardRepresentativeAccess.mockResolvedValueOnce(
      unauthorizedResponse,
    );

    const response = await createFeedback(
      new Request(
        "http://localhost/api/dashboard/representatives/lin/training/feedback",
        { method: "POST" },
      ),
      { params: Promise.resolve({ slug: "lin" }) },
    );

    expect(response).toBe(unauthorizedResponse);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(routeMocks.createCreatorFeedbackSignal).not.toHaveBeenCalled();
  });

  it("marks every training API response private and non-cacheable", () => {
    for (const routePath of trainingRoutePaths) {
      const source = readFileSync(new URL(routePath, import.meta.url), "utf8");
      expect(source, routePath).toContain("withPrivateNoStore");
      expect(source, routePath).not.toContain(
        "error instanceof Error ? error.message",
      );
    }
    expect(
      readFileSync(
        new URL(
          "../app/api/dashboard/representatives/[slug]/training/sources/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ).not.toContain("body.createdBy");
    expect(
      readFileSync(
        new URL(
          "../app/api/dashboard/representatives/[slug]/training/feedback/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ).not.toContain("body.createdBy");
    expect(
      readFileSync(
        new URL(
          "../app/api/dashboard/representatives/[slug]/training/suggestions/[suggestionId]/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ).not.toContain("body.reviewedBy");
    expect(
      readFileSync(
        new URL(
          "../app/api/dashboard/representatives/[slug]/training/versions/[versionId]/rollback/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ).not.toContain("body.rolledBackBy");
    expect(dashboardAuthSource).toContain("resolveDashboardSessionActor");
    expect(dashboardAuthSource).toContain("session?.ownerId?.trim()");
    expect(dashboardAuthSource).toContain("session?.email?.trim().toLowerCase()");
  });

  it("masks unknown internal errors", async () => {
    routeMocks.getCreatorTrainingDashboardSnapshot.mockRejectedValueOnce(
      new Error("postgresql://owner:secret@db.internal/delegate"),
    );

    const response = await getDevelopmentSnapshot(
      new Request("http://localhost/api/dashboard/representatives/lin/training"),
      { params: Promise.resolve({ slug: "lin" }) },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "Failed to load representative development.",
      code: "CREATOR_TRAINING_ERROR",
    });
  });
});
