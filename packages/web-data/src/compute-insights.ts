export type ApprovalActorKind =
  | "org_member"
  | "team_proxy"
  | "system"
  | "external"
  | "unresolved";

export type ApprovalStatusFilter = "all" | "pending" | "approved" | "rejected" | "expired";

export type ApprovalInsightsFilters = {
  approver?: string;
  customer?: string;
  subagent?: string;
  status?: ApprovalStatusFilter;
};

export type ApprovalInsightsOrganizationMember = {
  ownerId?: string;
  displayName: string;
  role: string;
  canApproveCompute: boolean;
};

export type ApprovalInsightsCustomerRef = {
  id: string | null;
  slug: string;
  displayName: string;
  isUnassigned: boolean;
};

export type ApprovalInsightsApproverRef = {
  key: string;
  label: string;
  kind: ApprovalActorKind;
  role?: string;
};

export type ApprovalInsightsApprovalRecord = {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  reason: string;
  requestedActionSummary: string;
  riskSummary: string;
  subagentId?: string | null;
  requestedAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  toolExecutionId?: string | null;
  sessionId?: string | null;
  customerAccount: ApprovalInsightsCustomerRef;
  approver: ApprovalInsightsApproverRef;
  riskScore: number;
  workflowStatus?: string | null;
  workflowScheduledAt?: string | null;
  staleWorkflow: boolean;
};

export type ApprovalInsightsBlockedSignal = {
  id: string;
  createdAt: string;
  customerAccount: ApprovalInsightsCustomerRef;
  subagentId?: string | null;
};

export type ApprovalInsightsCostSignal = {
  subagentId?: string | null;
  costCents: number;
};

export type ApprovalInsightsSource = {
  representative: {
    slug: string;
    displayName: string;
    organization?: {
      id: string;
      slug: string;
      displayName: string;
    } | null;
  };
  organizationMembers: ApprovalInsightsOrganizationMember[];
  approvals: ApprovalInsightsApprovalRecord[];
  blockedSignals: ApprovalInsightsBlockedSignal[];
  costSignals: ApprovalInsightsCostSignal[];
};

export type RepresentativeApprovalInsightsSnapshot = {
  representative: ApprovalInsightsSource["representative"];
  appliedFilters: {
    approver: string;
    customer: string;
    subagent: string;
    status: ApprovalStatusFilter;
  };
  filters: {
    approvers: Array<{
      key: string;
      label: string;
      kind: ApprovalActorKind;
      role?: string;
      resolvedCount: number;
    }>;
    customerAccounts: Array<{
      key: string;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
      approvalCount: number;
      blockedCount: number;
    }>;
    subagents: Array<{
      key: string;
      label: string;
      approvalCount: number;
      blockedCount: number;
      totalCostCents: number;
    }>;
    statuses: ApprovalStatusFilter[];
  };
  summary: {
    pendingApprovals: number;
    approvalsResolvedLast7d: number;
    blockedExecutionsLast7d: number;
    avgApprovalLatencyMinutes: number;
  };
  byApprover: Array<{
    key: string;
    label: string;
    kind: ApprovalActorKind;
    role?: string;
    resolvedCount: number;
    approvedCount: number;
    rejectedCount: number;
    expiredCount: number;
    latestResolvedAt?: string;
  }>;
  byCustomerAccount: Array<{
    key: string;
    slug: string;
    displayName: string;
    isUnassigned: boolean;
    pendingCount: number;
    blockedCount: number;
    resolvedCount: number;
    highRiskOpenCount: number;
    latestActivityAt?: string;
  }>;
  bySubagent: Array<{
    key: string;
    label: string;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
    expiredCount: number;
    blockedCount: number;
    totalCostCents: number;
  }>;
  hotspots: {
    longestPendingApprovals: Array<{
      id: string;
      requestedActionSummary: string;
      customerLabel: string;
      subagentLabel: string;
      requestedAt: string;
      pendingMinutes: number;
      riskScore: number;
    }>;
    highestRiskOpenApprovals: Array<{
      id: string;
      requestedActionSummary: string;
      customerLabel: string;
      subagentLabel: string;
      reason: string;
      riskScore: number;
      requestedAt: string;
    }>;
    mostFrequentlyBlockedCustomers: Array<{
      key: string;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
      blockedCount: number;
      latestBlockedAt?: string;
    }>;
  };
  auditHygiene: {
    missingResolvedByCount: number;
    missingCustomerContextCount: number;
    staleWorkflowCount: number;
    nonMemberApproverCount: number;
    items: Array<{
      key: string;
      label: string;
      detail: string;
      count: number;
    }>;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildRepresentativeApprovalInsights(
  source: ApprovalInsightsSource,
  rawFilters: ApprovalInsightsFilters = {},
  now = new Date(),
): RepresentativeApprovalInsightsSnapshot {
  const filters = normalizeFilters(rawFilters);
  const filterOptions = buildFilterOptions(source);
  const approvals = source.approvals.filter((approval) => matchesApprovalFilters(approval, filters));
  const blockedSignals = source.blockedSignals.filter((signal) =>
    matchesSignalFilters(signal, filters),
  );
  const costSignals = source.costSignals.filter((signal) => matchesSubagentFilter(signal, filters));
  const nowMs = now.getTime();
  const last7dCutoff = nowMs - 7 * DAY_MS;

  const resolvedApprovals = approvals.filter((approval) => approval.status !== "pending");
  const resolvedLatencies = resolvedApprovals
    .map((approval) => {
      if (!approval.resolvedAt) {
        return null;
      }
      return Math.max(0, new Date(approval.resolvedAt).getTime() - new Date(approval.requestedAt).getTime());
    })
    .filter((value): value is number => value !== null);
  const avgApprovalLatencyMinutes = resolvedLatencies.length
    ? Math.round(
        resolvedLatencies.reduce((sum, value) => sum + value, 0) / resolvedLatencies.length / 60000,
      )
    : 0;

  const summary = {
    pendingApprovals: approvals.filter((approval) => approval.status === "pending").length,
    approvalsResolvedLast7d: approvals.filter((approval) => {
      if (approval.status === "pending" || !approval.resolvedAt) {
        return false;
      }
      return new Date(approval.resolvedAt).getTime() >= last7dCutoff;
    }).length,
    blockedExecutionsLast7d: blockedSignals.filter(
      (signal) => new Date(signal.createdAt).getTime() >= last7dCutoff,
    ).length,
    avgApprovalLatencyMinutes,
  };

  const byApproverMap = approvals.reduce((map, approval) => {
      if (approval.status === "pending") {
        return map;
      }
      const current = map.get(approval.approver.key) ?? {
        key: approval.approver.key,
        label: approval.approver.label,
        kind: approval.approver.kind,
        resolvedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        expiredCount: 0,
        ...(approval.approver.role ? { role: approval.approver.role } : {}),
      };
      current.resolvedCount += 1;
      if (approval.status === "approved") current.approvedCount += 1;
      if (approval.status === "rejected") current.rejectedCount += 1;
      if (approval.status === "expired") current.expiredCount += 1;
      if (approval.resolvedAt && (!current.latestResolvedAt || approval.resolvedAt > current.latestResolvedAt)) {
        current.latestResolvedAt = approval.resolvedAt;
      }
      map.set(approval.approver.key, current);
      return map;
    }, new Map<string, RepresentativeApprovalInsightsSnapshot["byApprover"][number]>());
  const byApprover = Array.from(byApproverMap.values()).sort((left, right) => {
    if (right.resolvedCount !== left.resolvedCount) {
      return right.resolvedCount - left.resolvedCount;
    }
    return (right.latestResolvedAt ?? "").localeCompare(left.latestResolvedAt ?? "");
  });

  const byCustomerAccountMap = new Map<
    string,
    RepresentativeApprovalInsightsSnapshot["byCustomerAccount"][number]
  >();
  for (const approval of approvals) {
    const key = approval.customerAccount.isUnassigned ? "unassigned" : approval.customerAccount.id ?? approval.customerAccount.slug;
    const current = byCustomerAccountMap.get(key) ?? {
      key,
      slug: approval.customerAccount.slug,
      displayName: approval.customerAccount.displayName,
      isUnassigned: approval.customerAccount.isUnassigned,
      pendingCount: 0,
      blockedCount: 0,
      resolvedCount: 0,
      highRiskOpenCount: 0,
      latestActivityAt: approval.requestedAt,
    };
    if (approval.status === "pending") current.pendingCount += 1;
    else current.resolvedCount += 1;
    if (approval.status === "pending" && approval.riskScore >= 80) current.highRiskOpenCount += 1;
    {
      const nextLatestActivityAt = maxTimestamp(
        current.latestActivityAt,
        approval.resolvedAt ?? approval.requestedAt,
      );
      if (nextLatestActivityAt) {
        current.latestActivityAt = nextLatestActivityAt;
      }
    }
    byCustomerAccountMap.set(key, current);
  }
  for (const signal of blockedSignals) {
    const key = signal.customerAccount.isUnassigned ? "unassigned" : signal.customerAccount.id ?? signal.customerAccount.slug;
    const current = byCustomerAccountMap.get(key) ?? {
      key,
      slug: signal.customerAccount.slug,
      displayName: signal.customerAccount.displayName,
      isUnassigned: signal.customerAccount.isUnassigned,
      pendingCount: 0,
      blockedCount: 0,
      resolvedCount: 0,
      highRiskOpenCount: 0,
      latestActivityAt: signal.createdAt,
    };
    current.blockedCount += 1;
    {
      const nextLatestActivityAt = maxTimestamp(current.latestActivityAt, signal.createdAt);
      if (nextLatestActivityAt) {
        current.latestActivityAt = nextLatestActivityAt;
      }
    }
    byCustomerAccountMap.set(key, current);
  }
  const byCustomerAccount = Array.from(byCustomerAccountMap.values()).sort((left, right) => {
    const leftRisk = left.highRiskOpenCount * 100 + left.blockedCount * 10 + left.pendingCount;
    const rightRisk = right.highRiskOpenCount * 100 + right.blockedCount * 10 + right.pendingCount;
    if (rightRisk !== leftRisk) {
      return rightRisk - leftRisk;
    }
    return (right.latestActivityAt ?? "").localeCompare(left.latestActivityAt ?? "");
  });

  const bySubagentMap = new Map<string, RepresentativeApprovalInsightsSnapshot["bySubagent"][number]>();
  for (const approval of approvals) {
    const key = normalizeSubagentKey(approval.subagentId);
    const current = bySubagentMap.get(key) ?? createSubagentBucket(key);
    if (approval.status === "pending") current.pendingCount += 1;
    if (approval.status === "approved") current.approvedCount += 1;
    if (approval.status === "rejected") current.rejectedCount += 1;
    if (approval.status === "expired") current.expiredCount += 1;
    bySubagentMap.set(key, current);
  }
  for (const signal of blockedSignals) {
    const key = normalizeSubagentKey(signal.subagentId);
    const current = bySubagentMap.get(key) ?? createSubagentBucket(key);
    current.blockedCount += 1;
    bySubagentMap.set(key, current);
  }
  for (const signal of costSignals) {
    const key = normalizeSubagentKey(signal.subagentId);
    const current = bySubagentMap.get(key) ?? createSubagentBucket(key);
    current.totalCostCents += signal.costCents;
    bySubagentMap.set(key, current);
  }
  const bySubagent = Array.from(bySubagentMap.values()).sort((left, right) => {
    const leftLoad =
      left.totalCostCents + left.blockedCount * 100 + left.pendingCount * 50 + left.rejectedCount * 25;
    const rightLoad =
      right.totalCostCents + right.blockedCount * 100 + right.pendingCount * 50 + right.rejectedCount * 25;
    return rightLoad - leftLoad;
  });

  const longestPendingApprovals = approvals
    .filter((approval) => approval.status === "pending")
    .sort((left, right) => new Date(left.requestedAt).getTime() - new Date(right.requestedAt).getTime())
    .slice(0, 5)
    .map((approval) => ({
      id: approval.id,
      requestedActionSummary: approval.requestedActionSummary,
      customerLabel: approval.customerAccount.displayName,
      subagentLabel: subagentLabel(approval.subagentId),
      requestedAt: approval.requestedAt,
      pendingMinutes: Math.max(0, Math.round((nowMs - new Date(approval.requestedAt).getTime()) / 60000)),
      riskScore: approval.riskScore,
    }));

  const highestRiskOpenApprovals = approvals
    .filter((approval) => approval.status === "pending")
    .sort((left, right) => {
      if (right.riskScore !== left.riskScore) {
        return right.riskScore - left.riskScore;
      }
      return left.requestedAt.localeCompare(right.requestedAt);
    })
    .slice(0, 5)
    .map((approval) => ({
      id: approval.id,
      requestedActionSummary: approval.requestedActionSummary,
      customerLabel: approval.customerAccount.displayName,
      subagentLabel: subagentLabel(approval.subagentId),
      reason: approval.reason,
      riskScore: approval.riskScore,
      requestedAt: approval.requestedAt,
    }));

  const mostFrequentlyBlockedCustomersMap = blockedSignals.reduce((map, signal) => {
      const key = signal.customerAccount.isUnassigned ? "unassigned" : signal.customerAccount.id ?? signal.customerAccount.slug;
      const current = map.get(key) ?? {
        key,
        slug: signal.customerAccount.slug,
        displayName: signal.customerAccount.displayName,
        isUnassigned: signal.customerAccount.isUnassigned,
        blockedCount: 0,
      };
      current.blockedCount += 1;
      current.latestBlockedAt = maxTimestamp(current.latestBlockedAt, signal.createdAt) ?? signal.createdAt;
      map.set(key, current);
      return map;
    }, new Map<string, RepresentativeApprovalInsightsSnapshot["hotspots"]["mostFrequentlyBlockedCustomers"][number]>());
  const mostFrequentlyBlockedCustomers = Array.from(mostFrequentlyBlockedCustomersMap.values())
    .sort((left, right) => {
      if (right.blockedCount !== left.blockedCount) {
        return right.blockedCount - left.blockedCount;
      }
      return (right.latestBlockedAt ?? "").localeCompare(left.latestBlockedAt ?? "");
    })
    .slice(0, 5);

  const missingResolvedByCount = approvals.filter(
    (approval) => approval.status !== "pending" && !approval.resolvedBy,
  ).length;
  const missingCustomerContextCount = approvals.filter(
    (approval) => approval.customerAccount.isUnassigned,
  ).length;
  const staleWorkflowCount = approvals.filter((approval) => approval.staleWorkflow).length;
  const nonMemberApproverCount = approvals.filter(
    (approval) =>
      approval.status !== "pending" &&
      approval.approver.kind !== "org_member" &&
      approval.approver.kind !== "unresolved",
  ).length;

  const auditHygieneItems = [
    {
      key: "missing-resolved-by",
      label: "Resolved approvals missing actor",
      detail: "Resolved approvals should always record who or what acted on them.",
      count: missingResolvedByCount,
    },
    {
      key: "missing-customer-context",
      label: "Approvals without customer context",
      detail: "These approvals cannot be rolled up to a specific customer account.",
      count: missingCustomerContextCount,
    },
    {
      key: "stale-workflows",
      label: "Pending approvals with stale workflow state",
      detail: "Approval expiration workflows are missing, terminal, or overdue while the approval is still pending.",
      count: staleWorkflowCount,
    },
    {
      key: "non-member-approvers",
      label: "Approvals resolved outside organization membership",
      detail: "These were resolved by a system actor, team proxy, or unknown external label.",
      count: nonMemberApproverCount,
    },
  ].filter((item) => item.count > 0);

  return {
    representative: source.representative,
    appliedFilters: filters,
    filters: filterOptions,
    summary,
    byApprover,
    byCustomerAccount,
    bySubagent,
    hotspots: {
      longestPendingApprovals,
      highestRiskOpenApprovals,
      mostFrequentlyBlockedCustomers,
    },
    auditHygiene: {
      missingResolvedByCount,
      missingCustomerContextCount,
      staleWorkflowCount,
      nonMemberApproverCount,
      items: auditHygieneItems,
    },
  };
}

export function normalizeApprover(
  resolvedBy: string | null | undefined,
  organizationMembers: ApprovalInsightsOrganizationMember[],
): ApprovalInsightsApproverRef {
  if (!resolvedBy) {
    return {
      key: "unresolved",
      label: "Unresolved",
      kind: "unresolved",
    };
  }

  const member = organizationMembers.find(
    (candidate) => candidate.ownerId === resolvedBy || candidate.displayName === resolvedBy,
  );
  if (member) {
    return {
      key: `member:${member.ownerId ?? member.displayName}`,
      label: member.displayName,
      kind: "org_member",
      role: member.role.toLowerCase(),
    };
  }

  if (resolvedBy === "owner-dashboard") {
    return {
      key: "team_proxy:owner-dashboard",
      label: "owner-dashboard",
      kind: "team_proxy",
    };
  }

  if (resolvedBy === "workflow-runner") {
    return {
      key: "system:workflow-runner",
      label: "workflow-runner",
      kind: "system",
    };
  }

  return {
    key: `external:${resolvedBy}`,
    label: resolvedBy,
    kind: "external",
  };
}

export function normalizeCustomerAccount(input?: {
  id?: string | null;
  slug?: string | null;
  displayName?: string | null;
} | null): ApprovalInsightsCustomerRef {
  if (!input?.id) {
    return {
      id: null,
      slug: "unassigned",
      displayName: "Unassigned",
      isUnassigned: true,
    };
  }

  return {
    id: input.id,
    slug: input.slug ?? input.id,
    displayName: input.displayName ?? input.slug ?? input.id,
    isUnassigned: false,
  };
}

export function approvalRiskScore(reason: string, riskSummary: string): number {
  const normalizedReason = reason.toLowerCase();
  if (
    normalizedReason.includes("native_browser_mutation") ||
    normalizedReason.includes("complex_shell_command")
  ) {
    return 95;
  }
  if (
    normalizedReason.includes("human_approval_required") ||
    normalizedReason.includes("mcp_binding_requires_approval") ||
    normalizedReason.includes("skill_version_update_review")
  ) {
    return 82;
  }
  if (
    normalizedReason.includes("cost_above_rule_limit") ||
    normalizedReason.includes("auto_approve_budget_exceeded") ||
    normalizedReason.includes("subagent_budget_exceeded")
  ) {
    return 78;
  }
  if (
    normalizedReason.includes("paid_plan_required") ||
    normalizedReason.includes("mcp_requires_network") ||
    normalizedReason.includes("browser_requires_network")
  ) {
    return 68;
  }
  if (riskSummary.toLowerCase().includes("must be explicitly approved")) {
    return 80;
  }
  return 60;
}

function buildFilterOptions(source: ApprovalInsightsSource) {
  const approverMap = source.approvals.reduce((map, approval) => {
      if (approval.status === "pending") {
        return map;
      }
      const current = map.get(approval.approver.key) ?? {
        key: approval.approver.key,
        label: approval.approver.label,
        kind: approval.approver.kind,
        resolvedCount: 0,
        ...(approval.approver.role ? { role: approval.approver.role } : {}),
      };
      current.resolvedCount += 1;
      map.set(approval.approver.key, current);
      return map;
    }, new Map<string, RepresentativeApprovalInsightsSnapshot["filters"]["approvers"][number]>());
  const approvers = Array.from(approverMap.values());
  approvers.sort((left, right) => right.resolvedCount - left.resolvedCount);

  const customerAccountsMap = new Map<
    string,
    RepresentativeApprovalInsightsSnapshot["filters"]["customerAccounts"][number]
  >();
  for (const approval of source.approvals) {
    const key = approval.customerAccount.isUnassigned ? "unassigned" : approval.customerAccount.id ?? approval.customerAccount.slug;
    const current = customerAccountsMap.get(key) ?? {
      key,
      slug: approval.customerAccount.slug,
      displayName: approval.customerAccount.displayName,
      isUnassigned: approval.customerAccount.isUnassigned,
      approvalCount: 0,
      blockedCount: 0,
    };
    current.approvalCount += 1;
    customerAccountsMap.set(key, current);
  }
  for (const signal of source.blockedSignals) {
    const key = signal.customerAccount.isUnassigned ? "unassigned" : signal.customerAccount.id ?? signal.customerAccount.slug;
    const current = customerAccountsMap.get(key) ?? {
      key,
      slug: signal.customerAccount.slug,
      displayName: signal.customerAccount.displayName,
      isUnassigned: signal.customerAccount.isUnassigned,
      approvalCount: 0,
      blockedCount: 0,
    };
    current.blockedCount += 1;
    customerAccountsMap.set(key, current);
  }
  const customerAccounts = Array.from(customerAccountsMap.values()).sort((left, right) => {
    const leftWeight = left.approvalCount + left.blockedCount;
    const rightWeight = right.approvalCount + right.blockedCount;
    return rightWeight - leftWeight;
  });

  const subagentsMap = new Map<string, RepresentativeApprovalInsightsSnapshot["filters"]["subagents"][number]>();
  for (const approval of source.approvals) {
    const key = normalizeSubagentKey(approval.subagentId);
    const current = subagentsMap.get(key) ?? {
      key,
      label: subagentLabel(approval.subagentId),
      approvalCount: 0,
      blockedCount: 0,
      totalCostCents: 0,
    };
    current.approvalCount += 1;
    subagentsMap.set(key, current);
  }
  for (const signal of source.blockedSignals) {
    const key = normalizeSubagentKey(signal.subagentId);
    const current = subagentsMap.get(key) ?? {
      key,
      label: subagentLabel(signal.subagentId),
      approvalCount: 0,
      blockedCount: 0,
      totalCostCents: 0,
    };
    current.blockedCount += 1;
    subagentsMap.set(key, current);
  }
  for (const signal of source.costSignals) {
    const key = normalizeSubagentKey(signal.subagentId);
    const current = subagentsMap.get(key) ?? {
      key,
      label: subagentLabel(signal.subagentId),
      approvalCount: 0,
      blockedCount: 0,
      totalCostCents: 0,
    };
    current.totalCostCents += signal.costCents;
    subagentsMap.set(key, current);
  }

  return {
    approvers,
    customerAccounts,
    subagents: Array.from(subagentsMap.values()).sort((left, right) => {
      const leftWeight = left.totalCostCents + left.approvalCount * 10 + left.blockedCount * 25;
      const rightWeight = right.totalCostCents + right.approvalCount * 10 + right.blockedCount * 25;
      return rightWeight - leftWeight;
    }),
    statuses: ["all", "pending", "approved", "rejected", "expired"] satisfies ApprovalStatusFilter[],
  };
}

function normalizeFilters(rawFilters: ApprovalInsightsFilters) {
  return {
    approver: rawFilters.approver?.trim() || "all",
    customer: rawFilters.customer?.trim() || "all",
    subagent: rawFilters.subagent?.trim() || "all",
    status: rawFilters.status ?? "all",
  };
}

function matchesApprovalFilters(
  approval: ApprovalInsightsApprovalRecord,
  filters: ReturnType<typeof normalizeFilters>,
) {
  if (filters.approver !== "all" && approval.approver.key !== filters.approver) {
    return false;
  }

  const customerKey = approval.customerAccount.isUnassigned
    ? "unassigned"
    : approval.customerAccount.id ?? approval.customerAccount.slug;
  if (filters.customer !== "all" && customerKey !== filters.customer) {
    return false;
  }

  if (filters.subagent !== "all" && normalizeSubagentKey(approval.subagentId) !== filters.subagent) {
    return false;
  }

  if (filters.status !== "all" && approval.status !== filters.status) {
    return false;
  }

  return true;
}

function matchesSignalFilters(
  signal: ApprovalInsightsBlockedSignal,
  filters: ReturnType<typeof normalizeFilters>,
) {
  const customerKey = signal.customerAccount.isUnassigned
    ? "unassigned"
    : signal.customerAccount.id ?? signal.customerAccount.slug;
  if (filters.customer !== "all" && customerKey !== filters.customer) {
    return false;
  }
  if (filters.subagent !== "all" && normalizeSubagentKey(signal.subagentId) !== filters.subagent) {
    return false;
  }
  return true;
}

function matchesSubagentFilter(
  signal: ApprovalInsightsCostSignal,
  filters: ReturnType<typeof normalizeFilters>,
) {
  if (filters.subagent === "all") {
    return true;
  }
  return normalizeSubagentKey(signal.subagentId) === filters.subagent;
}

function createSubagentBucket(key: string) {
  return {
    key,
    label: subagentLabel(key),
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    expiredCount: 0,
    blockedCount: 0,
    totalCostCents: 0,
  };
}

function normalizeSubagentKey(subagentId?: string | null) {
  return subagentId?.trim() || "other";
}

function subagentLabel(subagentId?: string | null) {
  const key = normalizeSubagentKey(subagentId);
  if (key === "compute-agent") return "compute-agent";
  if (key === "browser-agent") return "browser-agent";
  if (key === "quote-agent") return "quote-agent";
  if (key === "handoff-agent") return "handoff-agent";
  if (key === "triage-agent") return "triage-agent";
  return "other";
}

function maxTimestamp(current?: string, candidate?: string | null) {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  return current > candidate ? current : candidate;
}
