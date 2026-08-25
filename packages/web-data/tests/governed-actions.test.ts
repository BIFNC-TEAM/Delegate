import { describe, expect, it } from "vitest";

import { buildRepresentativeGovernedActionSnapshot, type GovernedActionSource } from "../src/governed-actions";

function customerRef(id: string, slug: string, displayName: string) {
  return {
    key: id,
    slug,
    displayName,
    isUnassigned: false,
  };
}

function createSource(): GovernedActionSource {
  const acme = customerRef("acct_acme", "acme-design-partner", "Acme Design Partner");
  const unassigned = {
    key: "unassigned",
    slug: "unassigned",
    displayName: "Unassigned",
    isUnassigned: true,
  } as const;

  return {
    representative: {
      slug: "lin-founder-rep",
      displayName: "Lin Founder Rep",
    },
    approvals: [
      {
        id: "approval_browser",
        status: "approved",
        reason: "native_browser_mutation_requires_approval",
        requestedActionSummary: "Publish the public case study package.",
        riskSummary: "Public material changes require owner approval.",
        riskScore: 92,
        subagentId: "browser-agent",
        requestedAt: "2026-03-26T08:00:00.000Z",
        resolvedAt: "2026-03-26T08:05:00.000Z",
        resolvedBy: "Alice Operator",
        toolExecutionId: "execution_browser",
        sessionId: "session_browser",
        customerAccount: acme,
        approver: {
          key: "member:Alice Operator",
          label: "Alice Operator",
          kind: "org_member",
          role: "OWNER",
        },
        workflowStatus: "completed",
        workflowScheduledAt: "2026-03-26T08:30:00.000Z",
        staleWorkflow: false,
      },
      {
        id: "approval_stale",
        status: "pending",
        reason: "human_approval_required",
        requestedActionSummary: "Run the internal export package.",
        riskSummary: "This export still needs owner review.",
        riskScore: 63,
        subagentId: "compute-agent",
        requestedAt: "2026-03-25T08:00:00.000Z",
        customerAccount: unassigned,
        approver: {
          key: "unresolved",
          label: "Pending approval",
          kind: "unresolved",
        },
        staleWorkflow: true,
      },
    ],
    executions: [
      {
        id: "execution_browser",
        sessionId: "session_browser",
        capability: "browser",
        subagentId: "browser-agent",
        status: "succeeded",
        policyDecision: "ask",
        approvalRequestId: "approval_browser",
        requestedCommand: "Publish the public case study package.",
        createdAt: "2026-03-26T08:00:00.000Z",
        finishedAt: "2026-03-26T08:09:00.000Z",
        customerAccount: acme,
        primaryLayer: "customer_account",
      },
      {
        id: "execution_export",
        sessionId: "session_export",
        capability: "process",
        subagentId: "compute-agent",
        status: "blocked",
        policyDecision: "deny",
        createdAt: "2026-03-25T08:00:00.000Z",
        customerAccount: unassigned,
        primaryLayer: "unassigned_default",
      },
    ],
    artifacts: [
      {
        id: "artifact_public_pack",
        kind: "archive",
        createdAt: "2026-03-26T08:09:00.000Z",
        pinnedAt: "2026-03-26T08:10:00.000Z",
        pinnedBy: "owner-dashboard",
        downloadCount: 2,
        lastDownloadedAt: "2026-03-26T09:00:00.000Z",
        toolExecutionId: "execution_browser",
        governance: {
          id: "artifact_public_pack",
          kind: "archive",
          customerAccount: acme,
          primaryLayer: "customer_account",
          layers: ["delegate_managed", "owner_managed", "org_managed", "customer_account"],
          ownerOnlyActions: ["pin", "unpin", "read", "download"],
          restrictedActions: ["unpin_blocked_by_deliverable_dependency"],
          blockedUnpinByDeliverable: true,
          dependentDeliverableCount: 1,
        },
      },
    ],
    deliverables: [
      {
        id: "deliverable_public",
        title: "Acme public package",
        kind: "package",
        visibility: "public_material",
        sourceKind: "bundle",
        createdAt: "2026-03-26T08:20:00.000Z",
        updatedAt: "2026-03-26T08:40:00.000Z",
        createdBy: "owner-dashboard",
        downloadCount: 3,
        lastDownloadedAt: "2026-03-26T09:10:00.000Z",
        packageBuiltAt: "2026-03-26T08:35:00.000Z",
        hasCachedPackage: true,
        governance: {
          id: "deliverable_public",
          title: "Acme public package",
          kind: "package",
          visibility: "public_material",
          sourceKind: "bundle",
          customerAccounts: [acme],
          primaryLayer: "customer_account",
          layers: ["delegate_managed", "owner_managed", "org_managed", "customer_account"],
          ownerOnlyActions: ["create", "update", "manage_owner_only", "publish_public_material", "package_rebuild"],
          restrictedActions: [],
          customerDownloadEligible: true,
          packageDeliveryEligible: true,
          ambiguousCustomerContext: false,
          hasCachedPackage: true,
        },
      },
      {
        id: "deliverable_owner_only",
        title: "Internal memo",
        kind: "generated_document",
        visibility: "owner_only",
        sourceKind: "artifact",
        createdAt: "2026-03-25T07:00:00.000Z",
        updatedAt: "2026-03-25T07:00:00.000Z",
        createdBy: "owner-dashboard",
        downloadCount: 0,
        hasCachedPackage: false,
        governance: {
          id: "deliverable_owner_only",
          title: "Internal memo",
          kind: "generated_document",
          visibility: "owner_only",
          sourceKind: "artifact",
          customerAccounts: [unassigned],
          primaryLayer: "owner_managed",
          layers: ["owner_managed", "unassigned_default"],
          ownerOnlyActions: ["create", "update", "manage_owner_only"],
          restrictedActions: [],
          customerDownloadEligible: false,
          packageDeliveryEligible: false,
          ambiguousCustomerContext: false,
          hasCachedPackage: false,
        },
      },
    ],
    ledgerEntries: [
      {
        id: "ledger_compute",
        kind: "compute_minutes",
        costCents: 120,
        quantity: 1,
        unit: "minute",
        createdAt: "2026-03-26T08:09:10.000Z",
        notes: "compute_usage",
        sessionId: "session_browser",
        toolExecutionId: "execution_browser",
        customerAccount: acme,
        primaryLayer: "customer_account",
        subagentId: "browser-agent",
      },
      {
        id: "ledger_browser",
        kind: "browser_minutes",
        costCents: 40,
        quantity: 1,
        unit: "minute",
        createdAt: "2026-03-26T08:09:11.000Z",
        notes: "browser_usage",
        sessionId: "session_browser",
        toolExecutionId: "execution_browser",
        customerAccount: acme,
        primaryLayer: "customer_account",
        subagentId: "browser-agent",
      },
      {
        id: "ledger_package_download",
        kind: "artifact_egress",
        costCents: 8,
        quantity: 524288,
        unit: "byte",
        createdAt: "2026-03-26T09:10:01.000Z",
        notes: "deliverable_bundle_download:deliverable_public",
        customerAccount: acme,
        primaryLayer: "customer_account",
      },
    ],
  };
}

describe("buildRepresentativeGovernedActionSnapshot", () => {
  it("joins policy, approval, resource, and billing semantics into the same action model", () => {
    const snapshot = buildRepresentativeGovernedActionSnapshot(createSource());

    expect(snapshot.summary.totalGovernedActions).toBeGreaterThan(8);
    expect(snapshot.summary.actionsRequiringOwner).toBeGreaterThan(3);
    expect(snapshot.summary.actionsWithBillingImpact).toBeGreaterThan(3);
    expect(snapshot.byActionKind.find((row) => row.key === "compute_execution")).toMatchObject({
      count: 2,
      blockedCount: 1,
      billingImpactCount: 1,
    });
    expect(snapshot.recentActions.find((action) => action.id === "compute_execution:execution_browser")).toMatchObject({
      policyOutcome: "ask",
      approvalStatus: "approved",
      totalCostCents: 160,
      customerAccount: {
        key: "acct_acme",
      },
    });
  });

  it("keeps artifact, deliverable, approval, and billing actions in one timeline", () => {
    const snapshot = buildRepresentativeGovernedActionSnapshot(createSource());

    expect(snapshot.byActionKind.find((row) => row.key === "artifact_pin")?.count).toBe(1);
    expect(snapshot.byActionKind.find((row) => row.key === "artifact_unpin")?.count).toBe(1);
    expect(snapshot.byActionKind.find((row) => row.key === "deliverable_publish")?.count).toBe(1);
    expect(snapshot.byActionKind.find((row) => row.key === "package_download")?.count).toBe(1);
    expect(snapshot.byActionKind.find((row) => row.key === "billing_debit")?.count).toBeGreaterThan(0);
    expect(snapshot.hotspots.mostExpensiveActions[0]).toMatchObject({
      actionKind: "compute_execution",
      totalCostCents: 160,
    });
  });

  it("places missing customer context into the unassigned bucket and keeps owner-only resources private", () => {
    const snapshot = buildRepresentativeGovernedActionSnapshot(createSource());

    expect(snapshot.byCustomerAccount.find((row) => row.key === "unassigned")).toMatchObject({
      isUnassigned: true,
      count: expect.any(Number),
    });
    expect(snapshot.recentActions.find((action) => action.id === "deliverable_create:deliverable_owner_only")).toMatchObject({
      publicMaterialAffecting: false,
      customerAccount: {
        key: "unassigned",
      },
    });
  });

  it("does not fabricate approval semantics out of raw billing rows", () => {
    const snapshot = buildRepresentativeGovernedActionSnapshot(createSource());

    const billingAction = snapshot.recentActions.find((action) => action.id === "billing_debit:ledger_compute");
    expect(billingAction).toMatchObject({
      actionKind: "billing_debit",
      approvalStatus: null,
      outcome: "completed",
    });
  });

  it("does not report approved queued or running executions as completed", () => {
    const source = createSource();
    source.executions[0] = {
      ...source.executions[0]!,
      status: "queued",
      finishedAt: null,
    };

    let snapshot = buildRepresentativeGovernedActionSnapshot(source);
    expect(snapshot.recentActions.find(
      (action) => action.id === "compute_execution:execution_browser",
    )?.outcome).toBe("approved_waiting_execution");

    source.executions[0] = {
      ...source.executions[0]!,
      status: "running",
    };
    snapshot = buildRepresentativeGovernedActionSnapshot(source);
    expect(snapshot.recentActions.find(
      (action) => action.id === "compute_execution:execution_browser",
    )?.outcome).toBe("running");
  });

  it("counts each internal ledger cost once", () => {
    const snapshot = buildRepresentativeGovernedActionSnapshot(createSource());

    expect(snapshot.billingImpact.totalInternalCostCents).toBe(168);
  });

  it("returns a stable default structure when governance is empty", () => {
    const snapshot = buildRepresentativeGovernedActionSnapshot({
      representative: {
        slug: "lin-founder-rep",
        displayName: "Lin Founder Rep",
      },
      approvals: [],
      executions: [],
      artifacts: [],
      deliverables: [],
      ledgerEntries: [],
    });

    expect(snapshot.summary).toEqual({
      totalGovernedActions: 0,
      actionsRequiringOwner: 0,
      actionsResolvedAutomatically: 0,
      blockedOrDeniedActions: 0,
      actionsWithBillingImpact: 0,
      actionsAffectingPublicMaterials: 0,
    });
    expect(snapshot.recentActions).toEqual([]);
    expect(snapshot.hotspots.mostExpensiveActions).toEqual([]);
    expect(snapshot.hygiene.items).toEqual([]);
  });
});
