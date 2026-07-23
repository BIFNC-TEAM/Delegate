import { afterEach, describe, expect, it } from "vitest";

import {
  buildWorkspaceCapabilityHealthSnapshot,
  getWorkspaceCapabilityHealthSnapshot,
  getWorkspaceCapabilityOperationMetricSnapshot,
  recordWorkspaceCapabilityOperationFailure,
  resetWorkspaceCapabilityOperationMetricsForTest,
  type WorkspaceCapabilityHealthData,
} from "../src/capability-health";

const now = new Date("2026-07-23T12:00:00.000Z");

describe("workspace capability health", () => {
  afterEach(() => {
    resetWorkspaceCapabilityOperationMetricsForTest();
  });

  it("reports an empty workspace as healthy without manufacturing activity", () => {
    const snapshot = buildWorkspaceCapabilityHealthSnapshot(
      emptyHealthData(),
      now,
    );

    expect(snapshot.status).toBe("healthy");
    expect(snapshot.summary).toEqual({
      alerts: 0,
      degradedAlerts: 0,
      criticalAlerts: 0,
    });
    expect(snapshot.signals.skills.activeInstalls).toBe(0);
    expect(snapshot.signals.approvals.pending).toBe(0);
    expect(snapshot.signals.mcp.enabledBindings).toBe(0);
    expect(snapshot.dataSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "database" }),
        expect.objectContaining({ source: "process_local" }),
      ]),
    );
  });

  it("raises critical alerts for approval expiry, MCP circuit candidates, and enabled untrusted bindings", () => {
    const data = emptyHealthData();
    data.installs.push({
      id: "install_untrusted",
      status: "INSTALLED",
      reviewStatus: "NEEDS_REVIEW",
      installedVersion: "2.0.0",
      skillPack: {
        slug: "untrusted-clawhub",
        source: "CLAWHUB",
        executesCode: false,
      },
      releases: [
        {
          version: "2.0.0",
          status: "INSTALLED",
          executesCode: false,
          registryTrustEligible: false,
          signatureStatus: "UNVERIFIED",
          discoveredAt: new Date("2026-07-23T11:00:00.000Z"),
          updatedAt: new Date("2026-07-23T11:00:00.000Z"),
        },
      ],
      representativeBindings: [{ enabled: true }],
    });
    data.approvals = {
      pending: 2,
      skillPending: 1,
      actionPending: 1,
      stalePending: 2,
      expiredPending: 1,
      oldestRequestedAt: new Date("2026-07-23T10:00:00.000Z"),
    };
    data.mcpBindings.push({
      id: "mcp_1",
      slug: "crm",
      enabled: true,
      consecutiveFailures: 3,
      lastFailureAt: new Date("2026-07-23T11:59:00.000Z"),
      lastFailureReason:
        "mcp_server_unavailable:https://secret.example.test/path?token=hidden",
      lastSuccessAt: null,
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      representative: { slug: "lin-founder-rep" },
    });

    const snapshot = buildWorkspaceCapabilityHealthSnapshot(data, now);

    expect(snapshot.status).toBe("critical");
    expect(snapshot.signals.approvals.oldestPendingAgeMinutes).toBe(120);
    expect(snapshot.signals.mcp.circuitOpenCandidates).toBe(1);
    expect(snapshot.signals.mcp.bindings[0]?.failureCode).toBe(
      "mcp_server_unavailable",
    );
    expect(JSON.stringify(snapshot)).not.toContain("secret.example.test");
    expect(
      snapshot.signals.runtimeTrust.blockedReleasesWithEnabledBindings,
    ).toBe(1);
    expect(snapshot.alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        "approvals.expired_pending",
        "mcp.consecutive_failures_critical",
        "runtime_trust.enabled_binding_blocked",
      ]),
    );
  });

  it("keeps technical failure counters tenant-scoped and applies the rolling window", () => {
    recordWorkspaceCapabilityOperationFailure({
      ownerId: "owner_a",
      representativeSlug: "rep-a",
      operation: "skill_registry_sync",
      error: new Error("fetch failed for https://secret.example.test"),
      now: new Date("2026-07-23T11:59:00.000Z"),
    });
    recordWorkspaceCapabilityOperationFailure({
      ownerId: "owner_a",
      representativeSlug: "rep-a",
      operation: "skill_release_review",
      error: new Error("Candidate state conflict"),
      now: new Date("2026-07-21T11:59:00.000Z"),
    });
    recordWorkspaceCapabilityOperationFailure({
      ownerId: "owner_b",
      representativeSlug: "rep-b",
      operation: "skill_registry_sync",
      error: new Error("publisher signature verification failed"),
      now: new Date("2026-07-23T11:59:00.000Z"),
    });

    expect(
      getWorkspaceCapabilityOperationMetricSnapshot({
        ownerId: "owner_a",
        representativeSlug: "rep-a",
        windowStart: new Date("2026-07-22T12:00:00.000Z"),
      }),
    ).toEqual({
      totals: {
        skill_registry_sync: 1,
        skill_release_review: 1,
      },
      recent: {
        skill_registry_sync: 1,
        skill_release_review: 0,
      },
      lastFailureAt: "2026-07-23T11:59:00.000Z",
      lastFailureCode: "network_error",
    });
  });

  it("returns an honest database-free demo snapshot", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const snapshot = await getWorkspaceCapabilityHealthSnapshot({
        activeRepresentativeSlug: "lin-founder-rep",
        now,
      });
      expect(snapshot?.status).toBe("healthy");
      expect(snapshot?.scope.ownerId).toBe("demo-owner");
      expect(snapshot?.signals.mcp.executionsLastWindow).toBe(0);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });
});

function emptyHealthData(): WorkspaceCapabilityHealthData {
  return {
    ownerId: "owner_a",
    activeRepresentativeSlug: "lin-founder-rep",
    representativeCount: 1,
    installs: [],
    approvals: {
      pending: 0,
      skillPending: 0,
      actionPending: 0,
      stalePending: 0,
      expiredPending: 0,
      oldestRequestedAt: null,
    },
    mcpBindings: [],
    mcpExecutions: {
      totalLastWindow: 0,
      failedLastWindow: 0,
    },
    operationMetrics: {
      totals: {
        skill_registry_sync: 0,
        skill_release_review: 0,
      },
      recent: {
        skill_registry_sync: 0,
        skill_release_review: 0,
      },
      lastFailureAt: null,
      lastFailureCode: null,
    },
  };
}
