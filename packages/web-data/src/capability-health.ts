import { demoRepresentative } from "@delegate/domain";
import {
  SkillPackSource,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillReviewStatus,
} from "@prisma/client";

import { workspaceSkillApprovalReason } from "./compute-approval-domain";
import { prisma } from "./prisma";
import { isWorkspaceSkillReleaseRuntimeTrusted } from "./workspace-skills";

export type CapabilityHealthStatus = "healthy" | "degraded" | "critical";

export type WorkspaceCapabilityOperation =
  | "skill_registry_sync"
  | "skill_release_review";

export const defaultWorkspaceCapabilityHealthThresholds = {
  recentWindowHours: 24,
  skillFailureCriticalCount: 3,
  staleSkillCandidateHours: 24,
  approvalStaleMinutes: 30,
  approvalWarningPendingCount: 10,
  approvalCriticalPendingCount: 20,
  mcpUnverifiedMinutes: 15,
  mcpCriticalConsecutiveFailures: 3,
} as const;

export type WorkspaceCapabilityHealthThresholds = {
  recentWindowHours: number;
  skillFailureCriticalCount: number;
  staleSkillCandidateHours: number;
  approvalStaleMinutes: number;
  approvalWarningPendingCount: number;
  approvalCriticalPendingCount: number;
  mcpUnverifiedMinutes: number;
  mcpCriticalConsecutiveFailures: number;
};

type WorkspaceCapabilityAlert = {
  code: string;
  status: Exclude<CapabilityHealthStatus, "healthy">;
  source: "skills" | "approvals" | "mcp" | "runtime_trust";
  count: number;
  message: string;
  recommendedAction: string;
};

export type WorkspaceCapabilityHealthSnapshot = {
  observedAt: string;
  status: CapabilityHealthStatus;
  scope: {
    ownerId: string;
    activeRepresentativeSlug: string;
    representativeCount: number;
  };
  thresholds: WorkspaceCapabilityHealthThresholds;
  summary: {
    alerts: number;
    degradedAlerts: number;
    criticalAlerts: number;
  };
  signals: {
    skills: {
      status: CapabilityHealthStatus;
      activeInstalls: number;
      updatesAwaitingReview: number;
      staleUpdateCandidates: number;
      rejectedInstalls: number;
      rejectedReleasesLastWindow: number;
      missingInstalledReleases: number;
      registrySyncFailuresLastWindow: number;
      releaseReviewFailuresLastWindow: number;
      processLocalFailureTotals: Record<WorkspaceCapabilityOperation, number>;
      lastProcessLocalFailureAt: string | null;
      lastProcessLocalFailureCode: string | null;
    };
    approvals: {
      status: CapabilityHealthStatus;
      pending: number;
      skillPending: number;
      actionPending: number;
      stalePending: number;
      expiredPending: number;
      oldestPendingAgeMinutes: number | null;
    };
    mcp: {
      status: CapabilityHealthStatus;
      enabledBindings: number;
      degradedBindings: number;
      criticalBindings: number;
      staleUnverifiedBindings: number;
      circuitOpenCandidates: number;
      executionsLastWindow: number;
      failedExecutionsLastWindow: number;
      bindings: Array<{
        id: string;
        slug: string;
        representativeSlug: string;
        status: CapabilityHealthStatus | "unverified";
        consecutiveFailures: number;
        failureCode: string | null;
        lastFailureAt: string | null;
        lastSuccessAt: string | null;
      }>;
    };
    runtimeTrust: {
      status: CapabilityHealthStatus;
      blockedInstalledReleases: number;
      blockedReleasesWithEnabledBindings: number;
      releases: Array<{
        installId: string;
        slug: string;
        version: string | null;
        reason: "executable_package" | "insufficient_clawhub_trust";
        enabledBindings: number;
      }>;
    };
  };
  alerts: WorkspaceCapabilityAlert[];
  dataSources: Array<{
    source: "database" | "process_local";
    signals: string[];
    limitation: string | null;
  }>;
};

export type WorkspaceCapabilityHealthData = {
  ownerId: string;
  activeRepresentativeSlug: string;
  representativeCount: number;
  installs: Array<{
    id: string;
    status: string;
    reviewStatus: string;
    installedVersion: string | null;
    skillPack: {
      slug: string;
      source: string;
      executesCode: boolean;
    };
    releases: Array<{
      version: string;
      status: string;
      executesCode: boolean;
      registryTrustEligible: boolean;
      signatureStatus: string;
      discoveredAt: Date;
      updatedAt: Date;
    }>;
    representativeBindings: Array<{ enabled: boolean }>;
  }>;
  approvals: {
    pending: number;
    skillPending: number;
    actionPending: number;
    stalePending: number;
    expiredPending: number;
    oldestRequestedAt: Date | null;
  };
  mcpBindings: Array<{
    id: string;
    slug: string;
    enabled: boolean;
    consecutiveFailures: number;
    lastFailureAt: Date | null;
    lastFailureReason: string | null;
    lastSuccessAt: Date | null;
    createdAt: Date;
    representative: { slug: string };
  }>;
  mcpExecutions: {
    totalLastWindow: number;
    failedLastWindow: number;
  };
  operationMetrics: WorkspaceCapabilityOperationMetricSnapshot;
};

type WorkspaceCapabilityOperationMetricSnapshot = {
  totals: Record<WorkspaceCapabilityOperation, number>;
  recent: Record<WorkspaceCapabilityOperation, number>;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
};

type WorkspaceCapabilityOperationMetricStore = {
  totals: Record<WorkspaceCapabilityOperation, number>;
  events: Array<{
    operation: WorkspaceCapabilityOperation;
    occurredAt: number;
    failureCode: string;
  }>;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
};

type CapabilityHealthGlobal = typeof globalThis & {
  __delegateWorkspaceCapabilityOperationMetricsV1?: Map<
    string,
    WorkspaceCapabilityOperationMetricStore
  >;
};

const metricEventLimitPerScope = 500;

export function recordWorkspaceCapabilityOperationFailure(input: {
  ownerId?: string | null;
  representativeSlug: string;
  operation: WorkspaceCapabilityOperation;
  error?: unknown;
  now?: Date;
}) {
  const scopeKey = capabilityMetricScopeKey(input.ownerId, input.representativeSlug);
  const store = getCapabilityOperationMetricStores();
  const current = store.get(scopeKey) ?? {
    totals: {
      skill_registry_sync: 0,
      skill_release_review: 0,
    },
    events: [],
    lastFailureAt: null,
    lastFailureCode: null,
  };
  const occurredAt = (input.now ?? new Date()).getTime();
  const failureCode = classifyWorkspaceCapabilityOperationError(input.error);
  current.totals[input.operation] += 1;
  current.events.push({ operation: input.operation, occurredAt, failureCode });
  if (current.events.length > metricEventLimitPerScope) {
    current.events.splice(0, current.events.length - metricEventLimitPerScope);
  }
  if (occurredAt >= (current.lastFailureAt ?? 0)) {
    current.lastFailureAt = occurredAt;
    current.lastFailureCode = failureCode;
  }
  store.set(scopeKey, current);
  if (process.env.NODE_ENV !== "test") {
    console.error(
      JSON.stringify({
        event: "workspace_capability_operation_failed",
        operation: input.operation,
        failureCode,
        scope: input.ownerId?.trim() ? "owner" : "representative",
        ownerId: input.ownerId?.trim() || null,
        representativeSlug: input.representativeSlug,
        observedAt: new Date(occurredAt).toISOString(),
      }),
    );
  }
}

export function getWorkspaceCapabilityOperationMetricSnapshot(input: {
  ownerId: string;
  representativeSlug: string;
  windowStart: Date;
}): WorkspaceCapabilityOperationMetricSnapshot {
  const stores = getCapabilityOperationMetricStores();
  const scopeKeys = new Set([
    capabilityMetricScopeKey(input.ownerId, input.representativeSlug),
    capabilityMetricScopeKey(null, input.representativeSlug),
  ]);
  const snapshot: WorkspaceCapabilityOperationMetricSnapshot = {
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
  };
  let lastFailureAt = 0;
  for (const scopeKey of scopeKeys) {
    const metricStore = stores.get(scopeKey);
    if (!metricStore) continue;
    snapshot.totals.skill_registry_sync += metricStore.totals.skill_registry_sync;
    snapshot.totals.skill_release_review += metricStore.totals.skill_release_review;
    for (const event of metricStore.events) {
      if (event.occurredAt >= input.windowStart.getTime()) {
        snapshot.recent[event.operation] += 1;
      }
    }
    if ((metricStore.lastFailureAt ?? 0) > lastFailureAt) {
      lastFailureAt = metricStore.lastFailureAt ?? 0;
      snapshot.lastFailureCode = metricStore.lastFailureCode;
    }
  }
  snapshot.lastFailureAt = lastFailureAt ? new Date(lastFailureAt).toISOString() : null;
  return snapshot;
}

export function resetWorkspaceCapabilityOperationMetricsForTest() {
  getCapabilityOperationMetricStores().clear();
}

export async function getWorkspaceCapabilityHealthSnapshot(input: {
  ownerId?: string | null;
  activeRepresentativeSlug: string;
  now?: Date;
  thresholds?: Partial<WorkspaceCapabilityHealthThresholds>;
}): Promise<WorkspaceCapabilityHealthSnapshot | null> {
  const now = input.now ?? new Date();
  const thresholds = normalizeThresholds(input.thresholds);
  const windowStart = new Date(
    now.getTime() - thresholds.recentWindowHours * 60 * 60 * 1000,
  );
  const staleApprovalCutoff = new Date(
    now.getTime() - thresholds.approvalStaleMinutes * 60 * 1000,
  );

  if (!process.env.DATABASE_URL?.trim()) {
    if (input.activeRepresentativeSlug !== demoRepresentative.slug) return null;
    const ownerId = input.ownerId?.trim() || "demo-owner";
    return buildWorkspaceCapabilityHealthSnapshot(
      {
        ownerId,
        activeRepresentativeSlug: input.activeRepresentativeSlug,
        representativeCount: 1,
        installs: [],
        approvals: emptyApprovalHealthData(),
        mcpBindings: [],
        mcpExecutions: { totalLastWindow: 0, failedLastWindow: 0 },
        operationMetrics: getWorkspaceCapabilityOperationMetricSnapshot({
          ownerId,
          representativeSlug: input.activeRepresentativeSlug,
          windowStart,
        }),
      },
      now,
      thresholds,
    );
  }

  const representative = await prisma.representative.findFirst({
    where: {
      slug: input.activeRepresentativeSlug,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    },
    select: { ownerId: true },
  });
  if (!representative) return null;
  const ownerId = input.ownerId?.trim() || representative.ownerId;
  const approvalWhere = {
    representative: { ownerId },
    status: "PENDING" as const,
  };
  const mcpExecutionWhere = {
    createdAt: { gte: windowStart },
    mcpBindingId: { not: null },
    session: { representative: { ownerId } },
  };
  const [
    representativeCount,
    installs,
    mcpBindings,
    pendingApprovals,
    pendingSkillApprovals,
    stalePendingApprovals,
    expiredPendingApprovals,
    oldestPendingApproval,
    totalMcpExecutions,
    failedMcpExecutions,
  ] = await Promise.all([
    prisma.representative.count({ where: { ownerId } }),
    prisma.workspaceSkillInstall.findMany({
      where: { ownerId },
      select: {
        id: true,
        status: true,
        reviewStatus: true,
        installedVersion: true,
        skillPack: {
          select: {
            slug: true,
            source: true,
            executesCode: true,
          },
        },
        releases: {
          select: {
            version: true,
            status: true,
            executesCode: true,
            registryTrustEligible: true,
            signatureStatus: true,
            discoveredAt: true,
            updatedAt: true,
          },
        },
        representativeBindings: {
          select: { enabled: true },
        },
      },
    }),
    prisma.representativeMcpBinding.findMany({
      where: { representative: { ownerId } },
      select: {
        id: true,
        slug: true,
        enabled: true,
        consecutiveFailures: true,
        lastFailureAt: true,
        lastFailureReason: true,
        lastSuccessAt: true,
        createdAt: true,
        representative: { select: { slug: true } },
      },
    }),
    prisma.approvalRequest.count({ where: approvalWhere }),
    prisma.approvalRequest.count({
      where: {
        ...approvalWhere,
        OR: [
          { workspaceSkillReleaseId: { not: null } },
          { reason: workspaceSkillApprovalReason },
        ],
      },
    }),
    prisma.approvalRequest.count({
      where: { ...approvalWhere, requestedAt: { lte: staleApprovalCutoff } },
    }),
    prisma.approvalRequest.count({
      where: { ...approvalWhere, expiresAt: { lte: now } },
    }),
    prisma.approvalRequest.findFirst({
      where: approvalWhere,
      orderBy: { requestedAt: "asc" },
      select: { requestedAt: true },
    }),
    prisma.toolExecution.count({ where: mcpExecutionWhere }),
    prisma.toolExecution.count({
      where: { ...mcpExecutionWhere, status: "FAILED" },
    }),
  ]);

  return buildWorkspaceCapabilityHealthSnapshot(
    {
      ownerId,
      activeRepresentativeSlug: input.activeRepresentativeSlug,
      representativeCount,
      installs,
      approvals: {
        pending: pendingApprovals,
        skillPending: pendingSkillApprovals,
        actionPending: Math.max(0, pendingApprovals - pendingSkillApprovals),
        stalePending: stalePendingApprovals,
        expiredPending: expiredPendingApprovals,
        oldestRequestedAt: oldestPendingApproval?.requestedAt ?? null,
      },
      mcpBindings,
      mcpExecutions: {
        totalLastWindow: totalMcpExecutions,
        failedLastWindow: failedMcpExecutions,
      },
      operationMetrics: getWorkspaceCapabilityOperationMetricSnapshot({
        ownerId,
        representativeSlug: input.activeRepresentativeSlug,
        windowStart,
      }),
    },
    now,
    thresholds,
  );
}

export function buildWorkspaceCapabilityHealthSnapshot(
  data: WorkspaceCapabilityHealthData,
  now: Date = new Date(),
  rawThresholds: Partial<WorkspaceCapabilityHealthThresholds> =
    defaultWorkspaceCapabilityHealthThresholds,
): WorkspaceCapabilityHealthSnapshot {
  const thresholds = normalizeThresholds(rawThresholds);
  const recentCutoff = new Date(
    now.getTime() - thresholds.recentWindowHours * 60 * 60 * 1000,
  );
  const staleCandidateCutoff = new Date(
    now.getTime() - thresholds.staleSkillCandidateHours * 60 * 60 * 1000,
  );
  const activeInstalls = data.installs.filter(
    (install) => install.status !== WorkspaceSkillInstallStatus.ARCHIVED,
  );
  const updatesAwaitingReview = activeInstalls.filter(
    (install) => install.status === WorkspaceSkillInstallStatus.UPDATE_AVAILABLE,
  ).length;
  const staleUpdateCandidates = activeInstalls.reduce(
    (count, install) =>
      count +
      install.releases.filter(
        (release) =>
          release.status === WorkspaceSkillReleaseStatus.CANDIDATE &&
          release.discoveredAt <= staleCandidateCutoff,
      ).length,
    0,
  );
  const rejectedInstalls = activeInstalls.filter(
    (install) => install.reviewStatus === WorkspaceSkillReviewStatus.REJECTED,
  ).length;
  const rejectedReleasesLastWindow = data.installs.reduce(
    (count, install) =>
      count +
      install.releases.filter(
        (release) =>
          release.status === WorkspaceSkillReleaseStatus.REJECTED &&
          release.updatedAt >= recentCutoff,
      ).length,
    0,
  );
  const missingInstalledReleases = activeInstalls.filter(
    (install) =>
      !install.releases.some(
        (release) =>
          release.status === WorkspaceSkillReleaseStatus.INSTALLED ||
          (install.installedVersion !== null && release.version === install.installedVersion),
      ),
  ).length;
  const recentSkillFailures =
    data.operationMetrics.recent.skill_registry_sync +
    data.operationMetrics.recent.skill_release_review;
  const skillsStatus: CapabilityHealthStatus =
    missingInstalledReleases > 0 ||
    recentSkillFailures >= thresholds.skillFailureCriticalCount
      ? "critical"
      : recentSkillFailures > 0 ||
          staleUpdateCandidates > 0 ||
          rejectedInstalls > 0 ||
          rejectedReleasesLastWindow > 0
        ? "degraded"
        : "healthy";

  const oldestPendingAgeMinutes = data.approvals.oldestRequestedAt
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - data.approvals.oldestRequestedAt.getTime()) / (60 * 1000),
        ),
      )
    : null;
  const approvalsStatus: CapabilityHealthStatus =
    data.approvals.expiredPending > 0 ||
    data.approvals.pending >= thresholds.approvalCriticalPendingCount
      ? "critical"
      : data.approvals.stalePending > 0 ||
          data.approvals.pending >= thresholds.approvalWarningPendingCount
        ? "degraded"
        : "healthy";

  const unverifiedCutoff = new Date(
    now.getTime() - thresholds.mcpUnverifiedMinutes * 60 * 1000,
  );
  const serializedMcpBindings = data.mcpBindings
    .filter((binding) => binding.enabled)
    .map((binding) => {
      const staleUnverified =
        !binding.lastSuccessAt &&
        binding.createdAt <= unverifiedCutoff &&
        binding.consecutiveFailures === 0;
      const status: CapabilityHealthStatus | "unverified" =
        binding.consecutiveFailures >= thresholds.mcpCriticalConsecutiveFailures
          ? "critical"
          : binding.consecutiveFailures > 0
            ? "degraded"
            : staleUnverified
              ? "unverified"
              : "healthy";
      return {
        id: binding.id,
        slug: binding.slug,
        representativeSlug: binding.representative.slug,
        status,
        consecutiveFailures: binding.consecutiveFailures,
        failureCode: safeMcpFailureCode(binding.lastFailureReason),
        lastFailureAt: binding.lastFailureAt?.toISOString() ?? null,
        lastSuccessAt: binding.lastSuccessAt?.toISOString() ?? null,
      };
    });
  const criticalMcpBindings = serializedMcpBindings.filter(
    (binding) => binding.status === "critical",
  ).length;
  const degradedMcpBindings = serializedMcpBindings.filter(
    (binding) => binding.status === "degraded",
  ).length;
  const staleUnverifiedMcpBindings = serializedMcpBindings.filter(
    (binding) => binding.status === "unverified",
  ).length;
  const mcpStatus: CapabilityHealthStatus =
    criticalMcpBindings > 0
      ? "critical"
      : degradedMcpBindings > 0 || staleUnverifiedMcpBindings > 0
        ? "degraded"
        : "healthy";

  const runtimeTrustBlockedReleases = activeInstalls.flatMap((install) => {
    const installedRelease =
      install.releases.find(
        (release) => release.status === WorkspaceSkillReleaseStatus.INSTALLED,
      ) ??
      install.releases.find(
        (release) =>
          install.installedVersion !== null &&
          release.version === install.installedVersion,
      );
    const executesCode =
      installedRelease?.executesCode ?? install.skillPack.executesCode;
    const trusted = isWorkspaceSkillReleaseRuntimeTrusted({
      source: install.skillPack.source,
      executesCode,
      registryTrustEligible: installedRelease?.registryTrustEligible ?? false,
      signatureStatus: installedRelease?.signatureStatus ?? null,
    });
    if (trusted) return [];
    const enabledBindings = install.representativeBindings.filter(
      (binding) => binding.enabled,
    ).length;
    return [
      {
        installId: install.id,
        slug: install.skillPack.slug,
        version: installedRelease?.version ?? install.installedVersion,
        reason: executesCode
          ? ("executable_package" as const)
          : ("insufficient_clawhub_trust" as const),
        enabledBindings,
      },
    ];
  });
  const blockedReleasesWithEnabledBindings = runtimeTrustBlockedReleases.filter(
    (release) => release.enabledBindings > 0,
  ).length;
  const runtimeTrustStatus: CapabilityHealthStatus =
    blockedReleasesWithEnabledBindings > 0
      ? "critical"
      : runtimeTrustBlockedReleases.length > 0
        ? "degraded"
        : "healthy";

  const alerts: WorkspaceCapabilityAlert[] = [];
  if (recentSkillFailures > 0) {
    alerts.push({
      code: "skills.operation_failures_recent",
      status:
        recentSkillFailures >= thresholds.skillFailureCriticalCount
          ? "critical"
          : "degraded",
      source: "skills",
      count: recentSkillFailures,
      message: `${recentSkillFailures} skill registry or release review operations failed in this web process during the observation window.`,
      recommendedAction:
        "Inspect structured application errors and retry only after the Registry, trust, or validation cause is understood.",
    });
  }
  if (missingInstalledReleases > 0) {
    alerts.push({
      code: "skills.installed_release_missing",
      status: "critical",
      source: "skills",
      count: missingInstalledReleases,
      message: `${missingInstalledReleases} active skill installs do not have a matching installed release.`,
      recommendedAction:
        "Run the workspace skill reconciliation preflight before publishing or enabling bindings.",
    });
  }
  if (staleUpdateCandidates > 0) {
    alerts.push({
      code: "skills.update_candidates_stale",
      status: "degraded",
      source: "skills",
      count: staleUpdateCandidates,
      message: `${staleUpdateCandidates} skill update candidates have awaited review longer than the configured threshold.`,
      recommendedAction: "Review, reject, or reconcile the candidate releases.",
    });
  }
  if (rejectedInstalls > 0 || rejectedReleasesLastWindow > 0) {
    alerts.push({
      code: "skills.rejected_state",
      status: "degraded",
      source: "skills",
      count: Math.max(rejectedInstalls, rejectedReleasesLastWindow),
      message: "One or more skill installs or recent releases are in a rejected state.",
      recommendedAction:
        "Confirm that rejected versions remain disabled and inspect the review decision in the audit timeline.",
    });
  }
  if (data.approvals.expiredPending > 0) {
    alerts.push({
      code: "approvals.expired_pending",
      status: "critical",
      source: "approvals",
      count: data.approvals.expiredPending,
      message: `${data.approvals.expiredPending} pending approvals are past their expiry time.`,
      recommendedAction:
        "Check approval-expiration workflow health and resolve or expire the orphaned requests.",
    });
  }
  if (data.approvals.pending >= thresholds.approvalCriticalPendingCount) {
    alerts.push({
      code: "approvals.backlog_critical",
      status: "critical",
      source: "approvals",
      count: data.approvals.pending,
      message: "The pending approval backlog reached the critical threshold.",
      recommendedAction:
        "Triage high-risk and oldest requests first, then verify expiration workers are draining the queue.",
    });
  } else if (
    data.approvals.pending >= thresholds.approvalWarningPendingCount ||
    data.approvals.stalePending > 0
  ) {
    alerts.push({
      code: "approvals.backlog_degraded",
      status: "degraded",
      source: "approvals",
      count: Math.max(data.approvals.pending, data.approvals.stalePending),
      message: "The approval backlog is stale or above its warning threshold.",
      recommendedAction: "Review the oldest pending approvals and workflow dispatch status.",
    });
  }
  if (criticalMcpBindings > 0) {
    alerts.push({
      code: "mcp.consecutive_failures_critical",
      status: "critical",
      source: "mcp",
      count: criticalMcpBindings,
      message:
        "One or more enabled MCP bindings reached the consecutive-failure circuit candidate threshold.",
      recommendedAction:
        "Pause or disable affected bindings while checking endpoint availability, credentials, and allowlist policy.",
    });
  }
  if (degradedMcpBindings > 0) {
    alerts.push({
      code: "mcp.consecutive_failures",
      status: "degraded",
      source: "mcp",
      count: degradedMcpBindings,
      message: "One or more enabled MCP bindings have consecutive failures.",
      recommendedAction:
        "Inspect the normalized failure code and recent execution audit before retrying.",
    });
  }
  if (staleUnverifiedMcpBindings > 0) {
    alerts.push({
      code: "mcp.connection_unverified",
      status: "degraded",
      source: "mcp",
      count: staleUnverifiedMcpBindings,
      message: "One or more enabled MCP bindings have no successful call after the verification grace period.",
      recommendedAction: "Run a safe read-only connectivity check or disable unused bindings.",
    });
  }
  if (blockedReleasesWithEnabledBindings > 0) {
    alerts.push({
      code: "runtime_trust.enabled_binding_blocked",
      status: "critical",
      source: "runtime_trust",
      count: blockedReleasesWithEnabledBindings,
      message: "Runtime-untrusted skill releases still have enabled representative bindings.",
      recommendedAction:
        "Disable the bindings immediately, re-review exact-version trust evidence, and republish the representative.",
    });
  } else if (runtimeTrustBlockedReleases.length > 0) {
    alerts.push({
      code: "runtime_trust.release_blocked",
      status: "degraded",
      source: "runtime_trust",
      count: runtimeTrustBlockedReleases.length,
      message: "Installed skill releases are correctly blocked by the runtime trust boundary.",
      recommendedAction:
        "Keep bindings disabled until executable content is removed or sufficient exact-version trust evidence is available.",
    });
  }

  const criticalAlerts = alerts.filter((alert) => alert.status === "critical").length;
  const degradedAlerts = alerts.filter((alert) => alert.status === "degraded").length;
  return {
    observedAt: now.toISOString(),
    status: highestHealthStatus([
      skillsStatus,
      approvalsStatus,
      mcpStatus,
      runtimeTrustStatus,
    ]),
    scope: {
      ownerId: data.ownerId,
      activeRepresentativeSlug: data.activeRepresentativeSlug,
      representativeCount: data.representativeCount,
    },
    thresholds,
    summary: {
      alerts: alerts.length,
      degradedAlerts,
      criticalAlerts,
    },
    signals: {
      skills: {
        status: skillsStatus,
        activeInstalls: activeInstalls.length,
        updatesAwaitingReview,
        staleUpdateCandidates,
        rejectedInstalls,
        rejectedReleasesLastWindow,
        missingInstalledReleases,
        registrySyncFailuresLastWindow:
          data.operationMetrics.recent.skill_registry_sync,
        releaseReviewFailuresLastWindow:
          data.operationMetrics.recent.skill_release_review,
        processLocalFailureTotals: { ...data.operationMetrics.totals },
        lastProcessLocalFailureAt: data.operationMetrics.lastFailureAt,
        lastProcessLocalFailureCode: data.operationMetrics.lastFailureCode,
      },
      approvals: {
        status: approvalsStatus,
        pending: data.approvals.pending,
        skillPending: data.approvals.skillPending,
        actionPending: data.approvals.actionPending,
        stalePending: data.approvals.stalePending,
        expiredPending: data.approvals.expiredPending,
        oldestPendingAgeMinutes,
      },
      mcp: {
        status: mcpStatus,
        enabledBindings: serializedMcpBindings.length,
        degradedBindings: degradedMcpBindings,
        criticalBindings: criticalMcpBindings,
        staleUnverifiedBindings: staleUnverifiedMcpBindings,
        circuitOpenCandidates: criticalMcpBindings,
        executionsLastWindow: data.mcpExecutions.totalLastWindow,
        failedExecutionsLastWindow: data.mcpExecutions.failedLastWindow,
        bindings: serializedMcpBindings,
      },
      runtimeTrust: {
        status: runtimeTrustStatus,
        blockedInstalledReleases: runtimeTrustBlockedReleases.length,
        blockedReleasesWithEnabledBindings,
        releases: runtimeTrustBlockedReleases,
      },
    },
    alerts,
    dataSources: [
      {
        source: "database",
        signals: [
          "skill lifecycle state",
          "approval backlog",
          "MCP binding health",
          "MCP execution outcomes",
          "runtime trust state",
        ],
        limitation: null,
      },
      {
        source: "process_local",
        signals: ["skill registry sync failures", "skill release review failures"],
        limitation:
          "Counters reset when the dashboard process restarts and are not aggregated across replicas.",
      },
    ],
  };
}

function normalizeThresholds(
  input?: Partial<WorkspaceCapabilityHealthThresholds>,
): WorkspaceCapabilityHealthThresholds {
  return {
    recentWindowHours: positiveNumber(
      input?.recentWindowHours,
      defaultWorkspaceCapabilityHealthThresholds.recentWindowHours,
    ),
    skillFailureCriticalCount: positiveInteger(
      input?.skillFailureCriticalCount,
      defaultWorkspaceCapabilityHealthThresholds.skillFailureCriticalCount,
    ),
    staleSkillCandidateHours: positiveNumber(
      input?.staleSkillCandidateHours,
      defaultWorkspaceCapabilityHealthThresholds.staleSkillCandidateHours,
    ),
    approvalStaleMinutes: positiveNumber(
      input?.approvalStaleMinutes,
      defaultWorkspaceCapabilityHealthThresholds.approvalStaleMinutes,
    ),
    approvalWarningPendingCount: positiveInteger(
      input?.approvalWarningPendingCount,
      defaultWorkspaceCapabilityHealthThresholds.approvalWarningPendingCount,
    ),
    approvalCriticalPendingCount: positiveInteger(
      input?.approvalCriticalPendingCount,
      defaultWorkspaceCapabilityHealthThresholds.approvalCriticalPendingCount,
    ),
    mcpUnverifiedMinutes: positiveNumber(
      input?.mcpUnverifiedMinutes,
      defaultWorkspaceCapabilityHealthThresholds.mcpUnverifiedMinutes,
    ),
    mcpCriticalConsecutiveFailures: positiveInteger(
      input?.mcpCriticalConsecutiveFailures,
      defaultWorkspaceCapabilityHealthThresholds.mcpCriticalConsecutiveFailures,
    ),
  };
}

function positiveNumber(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Math.max(1, Math.trunc(positiveNumber(value, fallback)));
}

function highestHealthStatus(statuses: CapabilityHealthStatus[]) {
  if (statuses.includes("critical")) return "critical" as const;
  if (statuses.includes("degraded")) return "degraded" as const;
  return "healthy" as const;
}

function safeMcpFailureCode(reason: string | null) {
  const normalized = reason
    ?.trim()
    .toLowerCase()
    .split(":", 1)[0]
    ?.replace(/[^a-z0-9_.-]/g, "_")
    .slice(0, 80);
  return normalized || null;
}

export function classifyWorkspaceCapabilityOperationError(error: unknown) {
  const message = error instanceof Error
    ? `${error.name} ${error.message}`.toLowerCase()
    : String(error ?? "").toLowerCase();
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborterror")
  ) {
    return "timeout";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econn") ||
    message.includes("enotfound")
  ) {
    return "network_error";
  }
  if (
    message.includes("trust") ||
    message.includes("signature") ||
    message.includes("verification") ||
    message.includes("provenance")
  ) {
    return "trust_validation_failed";
  }
  if (message.includes("not found")) return "not_found";
  if (
    message.includes("conflict") ||
    message.includes("candidate") ||
    message.includes("already") ||
    message.includes("p2034")
  ) {
    return "state_conflict";
  }
  if (
    message.includes("prisma") ||
    message.includes("database") ||
    message.includes("transaction")
  ) {
    return "database_error";
  }
  if (
    message.includes("invalid") ||
    message.includes("required") ||
    message.includes("unsupported")
  ) {
    return "validation_error";
  }
  return "operation_failed";
}

function capabilityMetricScopeKey(
  ownerId: string | null | undefined,
  representativeSlug: string,
) {
  return ownerId?.trim()
    ? `owner:${ownerId.trim()}`
    : `representative:${representativeSlug.trim()}`;
}

function getCapabilityOperationMetricStores() {
  const host = globalThis as CapabilityHealthGlobal;
  host.__delegateWorkspaceCapabilityOperationMetricsV1 ??= new Map();
  return host.__delegateWorkspaceCapabilityOperationMetricsV1;
}

function emptyApprovalHealthData() {
  return {
    pending: 0,
    skillPending: 0,
    actionPending: 0,
    stalePending: 0,
    expiredPending: 0,
    oldestRequestedAt: null,
  };
}
