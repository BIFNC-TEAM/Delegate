import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeDashboardRepresentativeAccess: vi.fn(),
  requireDashboardRepresentativeAccessActor: vi.fn(),
  dashboardAuthErrorResponse: vi.fn(),
  createCreatorFeedbackSignal: vi.fn(),
  createCreatorTrainingSource: vi.fn(),
  getCreatorTrainingDashboardSnapshot: vi.fn(),
  listCreatorFeedbackSignals: vi.fn(),
  listCreatorTrainingSources: vi.fn(),
  reviewCreatorTrainingSuggestion: vi.fn(),
  rollbackCreatorTrainingVersion: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  createCreatorFeedbackSignal: routeMocks.createCreatorFeedbackSignal,
  createCreatorTrainingSource: routeMocks.createCreatorTrainingSource,
  getCreatorTrainingDashboardSnapshot:
    routeMocks.getCreatorTrainingDashboardSnapshot,
  listCreatorFeedbackSignals: routeMocks.listCreatorFeedbackSignals,
  listCreatorTrainingSources: routeMocks.listCreatorTrainingSources,
  reviewCreatorTrainingSuggestion:
    routeMocks.reviewCreatorTrainingSuggestion,
  rollbackCreatorTrainingVersion:
    routeMocks.rollbackCreatorTrainingVersion,
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
import { PATCH as reviewSuggestion } from "../app/api/dashboard/representatives/[slug]/training/suggestions/[suggestionId]/route";
import { POST as rollbackVersion } from "../app/api/dashboard/representatives/[slug]/training/versions/[versionId]/rollback/route";

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

  it("uses the authenticated actor and never forwards client identity or evaluation", async () => {
    const response = await reviewSuggestion(
      new Request(
        "http://localhost/api/dashboard/representatives/lin/training/suggestions/suggestion-1",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            reviewedBy: "forged-client-actor",
            evaluationReport: { outcome: "passed", checks: [] },
            editedDraftPayload: {
              kind: "faq",
              title: "Refunds",
              summary: "Refunds are available for seven days.",
            },
          }),
        },
      ),
      {
        params: Promise.resolve({
          slug: "lin",
          suggestionId: "suggestion-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(routeMocks.reviewCreatorTrainingSuggestion).toHaveBeenCalledWith(
      "lin",
      "suggestion-1",
      {
        action: "approve",
        reviewedBy: "session-owner-7",
        editedDraftPayload: {
          kind: "faq",
          title: "Refunds",
          summary: "Refunds are available for seven days.",
        },
      },
    );
    expect(routeMocks.requireDashboardRepresentativeAccessActor).toHaveBeenCalledWith("lin");
  });

  it("uses the same authenticated actor for source and feedback creation", async () => {
    const [sourceResponse, feedbackResponse] = await Promise.all([
      createSource(
        new Request(
          "http://localhost/api/dashboard/representatives/lin/training/sources",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "text",
              title: "Refund policy",
              contentText: "Refunds are available for seven days.",
              createdBy: "forged-source-actor",
            }),
          },
        ),
        { params: Promise.resolve({ slug: "lin" }) },
      ),
      createFeedback(
        new Request(
          "http://localhost/api/dashboard/representatives/lin/training/feedback",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signalType: "correction",
              note: "The refund window is seven days.",
              publicSafe: true,
              createdBy: "forged-feedback-actor",
            }),
          },
        ),
        { params: Promise.resolve({ slug: "lin" }) },
      ),
    ]);

    expect(sourceResponse.status).toBe(201);
    expect(feedbackResponse.status).toBe(201);
    expect(routeMocks.createCreatorTrainingSource).toHaveBeenCalledWith("lin", {
      kind: "text",
      title: "Refund policy",
      contentText: "Refunds are available for seven days.",
      createdBy: "session-owner-7",
    });
    expect(routeMocks.createCreatorFeedbackSignal).toHaveBeenCalledWith("lin", {
      signalType: "correction",
      publicSafe: true,
      note: "The refund window is seven days.",
      createdBy: "session-owner-7",
    });
    expect(routeMocks.requireDashboardRepresentativeAccessActor).toHaveBeenCalledTimes(2);
  });

  it("persists the authenticated rollback actor and ignores a forged client actor", async () => {
    const response = await rollbackVersion(
      new Request(
        "http://localhost/api/dashboard/representatives/lin/training/versions/version-1/rollback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rolledBackBy: "forged-client-actor" }),
        },
      ),
      {
        params: Promise.resolve({
          slug: "lin",
          versionId: "version-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.requireDashboardRepresentativeAccessActor).toHaveBeenCalledWith("lin");
    expect(routeMocks.rollbackCreatorTrainingVersion).toHaveBeenCalledWith(
      "lin",
      "version-1",
      { rolledBackBy: "session-owner-7" },
    );
  });

  it("returns a safe conflict when rollback history is ambiguous", async () => {
    routeMocks.rollbackCreatorTrainingVersion.mockRejectedValueOnce(
      new Error(
        "Creator training history is ambiguous for the current knowledge draft. Publish a new update before rolling back.",
      ),
    );

    const response = await rollbackVersion(
      new Request(
        "http://localhost/api/dashboard/representatives/lin/training/versions/version-1/rollback",
        { method: "POST" },
      ),
      {
        params: Promise.resolve({
          slug: "lin",
          versionId: "version-1",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This development history is ambiguous. Publish a new update before reverting.",
      code: "REVISION_HISTORY_AMBIGUOUS",
    });
  });

  it("returns a safe validation error when a knowledge gap has no real answer", async () => {
    routeMocks.reviewCreatorTrainingSuggestion.mockRejectedValueOnce(
      new Error("Knowledge gap requires a creator-authored answer."),
    );

    const response = await reviewSuggestion(
      new Request(
        "http://localhost/api/dashboard/representatives/lin/training/suggestions/suggestion-1",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        },
      ),
      {
        params: Promise.resolve({
          slug: "lin",
          suggestionId: "suggestion-1",
        }),
      },
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "Add a real owner-approved answer before approving this knowledge gap.",
      code: "CREATOR_ANSWER_REQUIRED",
    });
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
