import { describe, expect, it } from "vitest";

import {
  buildRepresentativeApprovalInsights,
  normalizeApprover,
  normalizeCustomerAccount,
  approvalRiskScore,
  type ApprovalInsightsSource,
} from "../src/compute-insights";

function createSource(): ApprovalInsightsSource {
  return {
    representative: {
      slug: "lin-founder-rep",
      displayName: "Lin Founder Rep",
      organization: {
        id: "org_lin",
        slug: "lin-ops-org",
        displayName: "Lin Ops Org",
      },
    },
    organizationMembers: [
      {
        displayName: "Alice Operator",
        role: "OWNER",
        canApproveCompute: true,
      },
    ],
    approvals: [
      {
        id: "approval_pending_browser",
        status: "pending",
        reason: "native_browser_mutation_requires_approval",
        requestedActionSummary: "Submit the partner application form.",
        riskSummary: "Native browser runs that may click or type need approval.",
        subagentId: "browser-agent",
        requestedAt: "2026-03-25T10:00:00.000Z",
        resolvedAt: null,
        resolvedBy: null,
        sessionId: "session_browser",
        toolExecutionId: "execution_browser",
        customerAccount: normalizeCustomerAccount({
          id: "acct_acme",
          slug: "acme-design-partner",
          displayName: "Acme Design Partner",
        }),
        approver: normalizeApprover(undefined, [
          {
            displayName: "Alice Operator",
            role: "OWNER",
            canApproveCompute: true,
          },
        ]),
        riskScore: approvalRiskScore(
          "native_browser_mutation_requires_approval",
          "Native browser runs that may click or type need approval.",
        ),
        workflowStatus: "QUEUED",
        workflowScheduledAt: "2026-03-25T10:30:00.000Z",
        staleWorkflow: false,
      },
      {
        id: "approval_approved_compute",
        status: "approved",
        reason: "human_approval_required",
        requestedActionSummary: "Run the onboarding compute task.",
        riskSummary: "This request matched a rule that requires owner approval.",
        subagentId: "compute-agent",
        requestedAt: "2026-03-24T08:00:00.000Z",
        resolvedAt: "2026-03-24T08:30:00.000Z",
        resolvedBy: "Alice Operator",
        sessionId: "session_compute",
        toolExecutionId: "execution_compute",
        customerAccount: normalizeCustomerAccount({
          id: "acct_acme",
          slug: "acme-design-partner",
          displayName: "Acme Design Partner",
        }),
        approver: normalizeApprover("Alice Operator", [
          {
            displayName: "Alice Operator",
            role: "OWNER",
            canApproveCompute: true,
          },
        ]),
        riskScore: approvalRiskScore(
          "human_approval_required",
          "This request matched a rule that requires owner approval.",
        ),
        workflowStatus: "COMPLETED",
        workflowScheduledAt: "2026-03-24T08:20:00.000Z",
        staleWorkflow: false,
      },
      {
        id: "approval_rejected_unassigned",
        status: "rejected",
        reason: "subagent_budget_exceeded",
        requestedActionSummary: "Run a large bundle export.",
        riskSummary: "This request exceeds the credit cap for its delegated compute lane.",
        subagentId: "compute-agent",
        requestedAt: "2026-03-23T07:00:00.000Z",
        resolvedAt: "2026-03-23T07:10:00.000Z",
        resolvedBy: "owner-dashboard",
        sessionId: "session_export",
        toolExecutionId: "execution_export",
        customerAccount: normalizeCustomerAccount(null),
        approver: normalizeApprover("owner-dashboard", [
          {
            displayName: "Alice Operator",
            role: "OWNER",
            canApproveCompute: true,
          },
        ]),
        riskScore: approvalRiskScore(
          "subagent_budget_exceeded",
          "This request exceeds the credit cap for its delegated compute lane.",
        ),
        workflowStatus: "COMPLETED",
        workflowScheduledAt: "2026-03-23T07:05:00.000Z",
        staleWorkflow: false,
      },
      {
        id: "approval_pending_stale",
        status: "pending",
        reason: "mcp_binding_requires_approval",
        requestedActionSummary: "Call the remote design MCP binding.",
        riskSummary: "This MCP binding is configured to require owner approval.",
        subagentId: "browser-agent",
        requestedAt: "2026-03-20T07:00:00.000Z",
        resolvedAt: null,
        resolvedBy: null,
        sessionId: "session_mcp",
        toolExecutionId: "execution_mcp",
        customerAccount: normalizeCustomerAccount({
          id: "acct_beta",
          slug: "beta-ops",
          displayName: "Beta Ops",
        }),
        approver: normalizeApprover(undefined, [
          {
            displayName: "Alice Operator",
            role: "OWNER",
            canApproveCompute: true,
          },
        ]),
        riskScore: approvalRiskScore(
          "mcp_binding_requires_approval",
          "This MCP binding is configured to require owner approval.",
        ),
        workflowStatus: "FAILED",
        workflowScheduledAt: "2026-03-20T07:30:00.000Z",
        staleWorkflow: true,
      },
    ],
    blockedSignals: [
      {
        id: "blocked_acme_browser",
        createdAt: "2026-03-25T10:00:00.000Z",
        customerAccount: normalizeCustomerAccount({
          id: "acct_acme",
          slug: "acme-design-partner",
          displayName: "Acme Design Partner",
        }),
        subagentId: "browser-agent",
      },
      {
        id: "blocked_unassigned_compute",
        createdAt: "2026-03-24T11:00:00.000Z",
        customerAccount: normalizeCustomerAccount(null),
        subagentId: "compute-agent",
      },
      {
        id: "blocked_beta_browser",
        createdAt: "2026-03-22T11:00:00.000Z",
        customerAccount: normalizeCustomerAccount({
          id: "acct_beta",
          slug: "beta-ops",
          displayName: "Beta Ops",
        }),
        subagentId: "browser-agent",
      },
    ],
    costSignals: [
      {
        subagentId: "browser-agent",
        costCents: 320,
      },
      {
        subagentId: "compute-agent",
        costCents: 180,
      },
      {
        subagentId: "browser-agent",
        costCents: 50,
      },
    ],
  };
}

describe("buildRepresentativeApprovalInsights", () => {
  it("treats workspace skill adoption as an explicit high-risk decision", () => {
    expect(approvalRiskScore("skill_version_update_review", "Review a signed skill release.")).toBe(82);
  });

  it("aggregates approvals by customer account, subagent, and resolver", () => {
    const snapshot = buildRepresentativeApprovalInsights(createSource(), {}, new Date("2026-03-26T12:00:00.000Z"));

    expect(snapshot.summary.pendingApprovals).toBe(2);
    expect(snapshot.summary.approvalsResolvedLast7d).toBe(2);
    expect(snapshot.summary.blockedExecutionsLast7d).toBe(3);
    expect(snapshot.byApprover[0]).toMatchObject({
      key: "member:Alice Operator",
      resolvedCount: 1,
      approvedCount: 1,
    });
    expect(snapshot.bySubagent.find((row) => row.key === "browser-agent")).toMatchObject({
      pendingCount: 2,
      blockedCount: 2,
      totalCostCents: 370,
    });
    expect(snapshot.byCustomerAccount.find((row) => row.key === "acct_acme")).toMatchObject({
      pendingCount: 1,
      blockedCount: 1,
      resolvedCount: 1,
      highRiskOpenCount: 1,
    });
  });

  it("places approvals without a customer account into the unassigned bucket", () => {
    const snapshot = buildRepresentativeApprovalInsights(createSource(), {}, new Date("2026-03-26T12:00:00.000Z"));

    expect(snapshot.byCustomerAccount.find((row) => row.key === "unassigned")).toMatchObject({
      isUnassigned: true,
      displayName: "Unassigned",
      resolvedCount: 1,
      blockedCount: 1,
    });
    expect(snapshot.hotspots.mostFrequentlyBlockedCustomers.find((row) => row.key === "unassigned")).toBeTruthy();
  });

  it("does not mix resolved and pending approvals when calculating risk hotspots", () => {
    const snapshot = buildRepresentativeApprovalInsights(
      createSource(),
      { status: "pending" },
      new Date("2026-03-26T12:00:00.000Z"),
    );

    expect(snapshot.summary.approvalsResolvedLast7d).toBe(0);
    expect(snapshot.hotspots.longestPendingApprovals).toHaveLength(2);
    expect(snapshot.hotspots.highestRiskOpenApprovals.every((item) => item.id.startsWith("approval_pending"))).toBe(true);
    expect(snapshot.byApprover).toHaveLength(0);
  });

  it("returns a stable default structure when governance-linked data is empty", () => {
    const snapshot = buildRepresentativeApprovalInsights(
      {
        representative: {
          slug: "lin-founder-rep",
          displayName: "Lin Founder Rep",
          organization: null,
        },
        organizationMembers: [],
        approvals: [],
        blockedSignals: [],
        costSignals: [],
      },
      {},
      new Date("2026-03-26T12:00:00.000Z"),
    );

    expect(snapshot.summary).toEqual({
      pendingApprovals: 0,
      approvalsResolvedLast7d: 0,
      blockedExecutionsLast7d: 0,
      avgApprovalLatencyMinutes: 0,
    });
    expect(snapshot.filters.statuses).toEqual(["all", "pending", "approved", "rejected", "expired"]);
    expect(snapshot.byApprover).toEqual([]);
    expect(snapshot.byCustomerAccount).toEqual([]);
    expect(snapshot.hotspots.longestPendingApprovals).toEqual([]);
    expect(snapshot.auditHygiene.items).toEqual([]);
  });
});
