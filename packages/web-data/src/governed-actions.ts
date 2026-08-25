type GovernanceLayer =
  | "delegate_managed"
  | "owner_managed"
  | "org_managed"
  | "customer_account"
  | "unassigned_default";

type GovernedActionKind =
  | "compute_execution"
  | "approval_request"
  | "artifact_pin"
  | "artifact_unpin"
  | "artifact_download"
  | "deliverable_create"
  | "deliverable_update"
  | "deliverable_publish"
  | "package_rebuild"
  | "package_download"
  | "billing_debit";

type GovernedActionOutcome =
  | "allow"
  | "ask"
  | "deny"
  | "queued"
  | "running"
  | "approved_waiting_execution"
  | "approved"
  | "rejected"
  | "expired"
  | "blocked"
  | "completed";

type GovernedActionActorKind =
  | "owner"
  | "team_member"
  | "system"
  | "audience"
  | "workflow"
  | "external"
  | "unknown";

type GovernedActionResourceKind =
  | "tool_execution"
  | "approval_request"
  | "artifact"
  | "deliverable"
  | "ledger_entry";

type CustomerRef = {
  key: string;
  slug: string;
  displayName: string;
  isUnassigned: boolean;
};

type ArtifactGovernanceRef = {
  id: string;
  kind: "stdout" | "stderr" | "file" | "archive" | "screenshot" | "json" | "trace";
  customerAccount: CustomerRef;
  primaryLayer: GovernanceLayer;
  layers: GovernanceLayer[];
  ownerOnlyActions: string[];
  restrictedActions: string[];
  blockedUnpinByDeliverable: boolean;
  dependentDeliverableCount: number;
};

type DeliverableGovernanceRef = {
  id: string;
  title: string;
  kind: "deck" | "case_study" | "download" | "generated_document" | "package";
  visibility: "owner_only" | "public_material";
  sourceKind: "artifact" | "external_link" | "bundle";
  customerAccounts: CustomerRef[];
  primaryLayer: GovernanceLayer;
  layers: GovernanceLayer[];
  ownerOnlyActions: string[];
  restrictedActions: string[];
  customerDownloadEligible: boolean;
  packageDeliveryEligible: boolean;
  ambiguousCustomerContext: boolean;
  hasCachedPackage: boolean;
};

export type GovernedActionSource = {
  representative: {
    slug: string;
    displayName: string;
  };
  approvals: Array<{
    id: string;
    status: "pending" | "approved" | "rejected" | "expired";
    reason: string;
    requestedActionSummary: string;
    riskSummary: string;
    riskScore: number;
    subagentId?: string;
    requestedAt: string;
    resolvedAt?: string;
    resolvedBy?: string;
    toolExecutionId?: string;
    sessionId?: string;
    customerAccount: CustomerRef;
    approver: {
      key: string;
      label: string;
      kind: "org_member" | "team_proxy" | "system" | "external" | "unresolved";
      role?: string;
    };
    workflowStatus?: string;
    workflowScheduledAt?: string;
    staleWorkflow: boolean;
  }>;
  executions: Array<{
    id: string;
    sessionId: string;
    capability: "exec" | "read" | "write" | "process" | "browser" | "mcp";
    subagentId?: string | null;
    status: "queued" | "running" | "succeeded" | "failed" | "blocked" | "canceled";
    policyDecision?: "allow" | "ask" | "deny" | null;
    approvalRequestId?: string | null;
    requestedCommand?: string | null;
    requestedPath?: string | null;
    createdAt: string;
    finishedAt?: string | null;
    customerAccount: CustomerRef;
    primaryLayer: GovernanceLayer;
  }>;
  artifacts: Array<{
    id: string;
    kind: ArtifactGovernanceRef["kind"];
    createdAt: string;
    pinnedAt?: string | null;
    pinnedBy?: string | null;
    downloadCount: number;
    lastDownloadedAt?: string | null;
    toolExecutionId?: string | null;
    governance: ArtifactGovernanceRef;
  }>;
  deliverables: Array<{
    id: string;
    title: string;
    kind: DeliverableGovernanceRef["kind"];
    visibility: DeliverableGovernanceRef["visibility"];
    sourceKind: DeliverableGovernanceRef["sourceKind"];
    createdAt: string;
    updatedAt: string;
    createdBy?: string | null;
    downloadCount: number;
    lastDownloadedAt?: string | null;
    packageBuiltAt?: string | null;
    hasCachedPackage: boolean;
    governance: DeliverableGovernanceRef;
  }>;
  ledgerEntries: Array<{
    id: string;
    kind: string;
    costCents: number;
    quantity: number;
    unit: string;
    createdAt: string;
    notes?: string | null;
    sessionId?: string | null;
    toolExecutionId?: string | null;
    customerAccount: CustomerRef;
    primaryLayer: GovernanceLayer;
    subagentId?: string | null;
  }>;
};

export type RepresentativeGovernedActionSnapshot = {
  representative: {
    slug: string;
    displayName: string;
  };
  summary: {
    totalGovernedActions: number;
    actionsRequiringOwner: number;
    actionsResolvedAutomatically: number;
    blockedOrDeniedActions: number;
    actionsWithBillingImpact: number;
    actionsAffectingPublicMaterials: number;
  };
  byActionKind: Array<{
    key: GovernedActionKind;
    count: number;
    blockedCount: number;
    ownerRequiredCount: number;
    billingImpactCount: number;
    totalCostCents: number;
  }>;
  byOutcome: Array<{
    key: GovernedActionOutcome;
    count: number;
  }>;
  byGovernanceLayer: Array<{
    key: GovernanceLayer;
    count: number;
    ownerRequiredCount: number;
    billingImpactCount: number;
  }>;
  byCustomerAccount: Array<{
    key: string;
    slug: string;
    displayName: string;
    isUnassigned: boolean;
    count: number;
    ownerRequiredCount: number;
    blockedCount: number;
    billingImpactCount: number;
  }>;
  bySubagent: Array<{
    key: string;
    label: string;
    count: number;
    blockedCount: number;
    totalCostCents: number;
  }>;
  billingImpact: {
    totalInternalCostCents: number;
    breakdown: Array<{
      key:
        | "compute"
        | "storage"
        | "browser"
        | "mcp"
        | "model"
        | "egress"
        | "other";
      label: string;
      costCents: number;
    }>;
  };
  hotspots: {
    mostExpensiveActions: Array<{
      id: string;
      actionKind: GovernedActionKind;
      summary: string;
      totalCostCents: number;
      customerLabel: string;
      occurredAt: string;
    }>;
    mostFrequentlyBlockedActions: Array<{
      key: GovernedActionKind;
      count: number;
    }>;
    mostCommonOwnerOnlyActions: Array<{
      key: GovernedActionKind;
      count: number;
    }>;
    staleApprovalsWithLinks: Array<{
      id: string;
      summary: string;
      customerLabel: string;
      hasBillingLink: boolean;
      hasResourceLink: boolean;
      workflowStatus?: string;
    }>;
  };
  hygiene: {
    missingCustomerContextCount: number;
    missingApproverAttributionCount: number;
    missingBillingLinkCount: number;
    missingResourceLinkCount: number;
    items: Array<{
      key: string;
      label: string;
      detail: string;
      count: number;
    }>;
  };
  recentActions: Array<{
    id: string;
    actionKind: GovernedActionKind;
    actor: {
      key: string;
      label: string;
      kind: GovernedActionActorKind;
    };
    target: {
      resourceKind: GovernedActionResourceKind;
      id: string;
    };
    primaryGovernanceLayer: GovernanceLayer;
    customerAccount: CustomerRef;
    subagentId?: string | null;
    policyOutcome?: "allow" | "ask" | "deny" | null;
    approvalStatus?: "pending" | "approved" | "rejected" | "expired" | null;
    workflowStatus?: string | null;
    outcome: GovernedActionOutcome;
    ownerRequired: boolean;
    publicMaterialAffecting: boolean;
    hasBillingImpact: boolean;
    totalCostCents: number;
    occurredAt: string;
    summary: string;
    links: {
      approvalId?: string | null;
      toolExecutionId?: string | null;
      artifactId?: string | null;
      deliverableId?: string | null;
      ledgerEntryIds: string[];
    };
  }>;
};

type GovernedActionRecord = RepresentativeGovernedActionSnapshot["recentActions"][number];

const governanceLayerOrder: GovernanceLayer[] = [
  "delegate_managed",
  "owner_managed",
  "org_managed",
  "customer_account",
  "unassigned_default",
];

const actionKindOrder: GovernedActionKind[] = [
  "compute_execution",
  "approval_request",
  "artifact_pin",
  "artifact_unpin",
  "artifact_download",
  "deliverable_create",
  "deliverable_update",
  "deliverable_publish",
  "package_rebuild",
  "package_download",
  "billing_debit",
];

const actionOutcomeOrder: GovernedActionOutcome[] = [
  "allow",
  "ask",
  "deny",
  "queued",
  "running",
  "approved_waiting_execution",
  "approved",
  "rejected",
  "expired",
  "blocked",
  "completed",
];

export function buildRepresentativeGovernedActionSnapshot(
  source: GovernedActionSource,
): RepresentativeGovernedActionSnapshot {
  const approvalsByExecutionId = new Map(
    source.approvals
      .filter((approval) => approval.toolExecutionId)
      .map((approval) => [approval.toolExecutionId as string, approval] as const),
  );
  const artifactEgressLedgerByExecutionId = new Map<
    string,
    GovernedActionSource["ledgerEntries"][number]
  >();
  const bundleEgressLedgerByDeliverableId = new Map<
    string,
    GovernedActionSource["ledgerEntries"][number][]
  >();
  const ledgerByExecutionId = new Map<string, GovernedActionSource["ledgerEntries"][number][]>();

  for (const entry of source.ledgerEntries) {
    if (
      entry.toolExecutionId &&
      !artifactEgressLedgerByExecutionId.has(entry.toolExecutionId) &&
      (entry.notes === "artifact_download_egress" || entry.notes === "deliverable_artifact_download")
    ) {
      artifactEgressLedgerByExecutionId.set(entry.toolExecutionId, entry);
    }
    if (entry.toolExecutionId) {
      const bucket = ledgerByExecutionId.get(entry.toolExecutionId) ?? [];
      bucket.push(entry);
      ledgerByExecutionId.set(entry.toolExecutionId, bucket);
    }
    if (entry.notes?.startsWith("deliverable_bundle_download:")) {
      const deliverableId = entry.notes.split(":")[1];
      if (deliverableId) {
        const bucket = bundleEgressLedgerByDeliverableId.get(deliverableId) ?? [];
        bucket.push(entry);
        bundleEgressLedgerByDeliverableId.set(deliverableId, bucket);
      }
    }
  }

  const recentActions: GovernedActionRecord[] = [];

  for (const execution of source.executions) {
    const approval = approvalsByExecutionId.get(execution.id);
    const ledgerEntries = ledgerByExecutionId.get(execution.id) ?? [];
    const totalCostCents = ledgerEntries.reduce((sum, entry) => sum + entry.costCents, 0);
    recentActions.push({
      id: `compute_execution:${execution.id}`,
      actionKind: "compute_execution",
      actor: {
        key: "system:compute_broker",
        label: "Compute broker",
        kind: "system",
      },
      target: {
        resourceKind: "tool_execution",
        id: execution.id,
      },
      primaryGovernanceLayer: execution.primaryLayer,
      customerAccount: execution.customerAccount,
      subagentId: execution.subagentId ?? null,
      policyOutcome: execution.policyDecision ?? null,
      approvalStatus: approval?.status ?? null,
      workflowStatus: approval?.workflowStatus ?? null,
      outcome: resolveExecutionOutcome(execution.status, execution.policyDecision ?? null, approval?.status ?? null),
      ownerRequired: Boolean(approval),
      publicMaterialAffecting: false,
      hasBillingImpact: ledgerEntries.length > 0,
      totalCostCents,
      occurredAt: execution.finishedAt ?? execution.createdAt,
      summary: buildExecutionSummary(execution, approval),
      links: {
        approvalId: approval?.id ?? null,
        toolExecutionId: execution.id,
        ledgerEntryIds: ledgerEntries.map((entry) => entry.id),
      },
    });
  }

  for (const approval of source.approvals) {
    recentActions.push({
      id: `approval_request:${approval.id}`,
      actionKind: "approval_request",
      actor: {
        key: approval.approver.key,
        label: approval.status === "pending" ? "Owner approval required" : approval.approver.label,
        kind: mapApproverKindToActorKind(approval.approver.kind),
      },
      target: {
        resourceKind: "approval_request",
        id: approval.id,
      },
      primaryGovernanceLayer: approval.customerAccount.isUnassigned ? "owner_managed" : "customer_account",
      customerAccount: approval.customerAccount,
      subagentId: approval.subagentId ?? null,
      policyOutcome: "ask",
      approvalStatus: approval.status,
      workflowStatus: approval.workflowStatus ?? null,
      outcome: mapApprovalOutcome(approval.status),
      ownerRequired: true,
      publicMaterialAffecting: false,
      hasBillingImpact: false,
      totalCostCents: 0,
      occurredAt: approval.resolvedAt ?? approval.requestedAt,
      summary: approval.requestedActionSummary,
      links: {
        approvalId: approval.id,
        toolExecutionId: approval.toolExecutionId ?? null,
        ledgerEntryIds: [],
      },
    });
  }

  for (const artifact of source.artifacts) {
    if (artifact.pinnedAt) {
      recentActions.push({
        id: `artifact_pin:${artifact.id}`,
        actionKind: "artifact_pin",
        actor: normalizeNamedActor(artifact.pinnedBy, "owner"),
        target: {
          resourceKind: "artifact",
          id: artifact.id,
        },
        primaryGovernanceLayer: artifact.governance.primaryLayer,
        customerAccount: artifact.governance.customerAccount,
        policyOutcome: "allow",
        approvalStatus: null,
        workflowStatus: null,
        outcome: "completed",
        ownerRequired: true,
        publicMaterialAffecting: false,
        hasBillingImpact: false,
        totalCostCents: 0,
        occurredAt: artifact.pinnedAt,
        summary: `Pinned ${artifact.kind} artifact`,
        links: {
          artifactId: artifact.id,
          ledgerEntryIds: [],
        },
      });
    }

    if (artifact.governance.blockedUnpinByDeliverable) {
      recentActions.push({
        id: `artifact_unpin:${artifact.id}`,
        actionKind: "artifact_unpin",
        actor: {
          key: "policy:resource_governance",
          label: "Resource governance",
          kind: "system",
        },
        target: {
          resourceKind: "artifact",
          id: artifact.id,
        },
        primaryGovernanceLayer: artifact.governance.primaryLayer,
        customerAccount: artifact.governance.customerAccount,
        policyOutcome: "deny",
        approvalStatus: null,
        workflowStatus: null,
        outcome: "blocked",
        ownerRequired: true,
        publicMaterialAffecting: false,
        hasBillingImpact: false,
        totalCostCents: 0,
        occurredAt: artifact.pinnedAt ?? artifact.createdAt,
        summary: "Artifact cannot be unpinned while deliverables still depend on it",
        links: {
          artifactId: artifact.id,
          ledgerEntryIds: [],
        },
      });
    }

    if (artifact.downloadCount > 0 && artifact.lastDownloadedAt) {
      const linkedLedgerEntry = artifact.toolExecutionId
        ? artifactEgressLedgerByExecutionId.get(artifact.toolExecutionId)
        : undefined;
      recentActions.push({
        id: `artifact_download:${artifact.id}`,
        actionKind: "artifact_download",
        actor: {
          key: "system:download_surface",
          label: "Download surface",
          kind: "system",
        },
        target: {
          resourceKind: "artifact",
          id: artifact.id,
        },
        primaryGovernanceLayer: artifact.governance.primaryLayer,
        customerAccount: artifact.governance.customerAccount,
        policyOutcome: "allow",
        approvalStatus: null,
        workflowStatus: null,
        outcome: "completed",
        ownerRequired: artifact.governance.ownerOnlyActions.includes("download"),
        publicMaterialAffecting: false,
        hasBillingImpact: Boolean(linkedLedgerEntry),
        totalCostCents: linkedLedgerEntry?.costCents ?? 0,
        occurredAt: artifact.lastDownloadedAt,
        summary: `Artifact downloaded ${artifact.downloadCount} time(s)`,
        links: {
          artifactId: artifact.id,
          toolExecutionId: artifact.toolExecutionId ?? null,
          ledgerEntryIds: linkedLedgerEntry ? [linkedLedgerEntry.id] : [],
        },
      });
    }
  }

  for (const deliverable of source.deliverables) {
    recentActions.push({
      id: `deliverable_create:${deliverable.id}`,
      actionKind: "deliverable_create",
      actor: normalizeNamedActor(deliverable.createdBy, "owner"),
      target: {
        resourceKind: "deliverable",
        id: deliverable.id,
      },
      primaryGovernanceLayer: deliverable.governance.primaryLayer,
      customerAccount: deliverable.governance.customerAccounts[0] ?? createUnassignedCustomerRef(),
      policyOutcome: "allow",
      approvalStatus: null,
      workflowStatus: null,
      outcome: "completed",
      ownerRequired: true,
      publicMaterialAffecting: deliverable.visibility === "public_material",
      hasBillingImpact: false,
      totalCostCents: 0,
      occurredAt: deliverable.createdAt,
      summary: `Created ${deliverable.kind} deliverable`,
      links: {
        deliverableId: deliverable.id,
        ledgerEntryIds: [],
      },
    });

    if (deliverable.updatedAt !== deliverable.createdAt) {
      recentActions.push({
        id: `deliverable_update:${deliverable.id}`,
        actionKind: "deliverable_update",
        actor: normalizeNamedActor(deliverable.createdBy, "owner"),
        target: {
          resourceKind: "deliverable",
          id: deliverable.id,
        },
        primaryGovernanceLayer: deliverable.governance.primaryLayer,
        customerAccount: deliverable.governance.customerAccounts[0] ?? createUnassignedCustomerRef(),
        policyOutcome: "allow",
        approvalStatus: null,
        workflowStatus: null,
        outcome: "completed",
        ownerRequired: true,
        publicMaterialAffecting: deliverable.visibility === "public_material",
        hasBillingImpact: false,
        totalCostCents: 0,
        occurredAt: deliverable.updatedAt,
        summary: `Updated ${deliverable.kind} deliverable`,
        links: {
          deliverableId: deliverable.id,
          ledgerEntryIds: [],
        },
      });
    }

    if (deliverable.visibility === "public_material") {
      recentActions.push({
        id: `deliverable_publish:${deliverable.id}`,
        actionKind: "deliverable_publish",
        actor: normalizeNamedActor(deliverable.createdBy, "owner"),
        target: {
          resourceKind: "deliverable",
          id: deliverable.id,
        },
        primaryGovernanceLayer: deliverable.governance.primaryLayer,
        customerAccount: deliverable.governance.customerAccounts[0] ?? createUnassignedCustomerRef(),
        policyOutcome: "allow",
        approvalStatus: null,
        workflowStatus: null,
        outcome: "completed",
        ownerRequired: true,
        publicMaterialAffecting: true,
        hasBillingImpact: false,
        totalCostCents: 0,
        occurredAt: deliverable.updatedAt,
        summary: `Published ${deliverable.title} as public material`,
        links: {
          deliverableId: deliverable.id,
          ledgerEntryIds: [],
        },
      });
    }

    if (deliverable.sourceKind === "bundle") {
      recentActions.push({
        id: `package_rebuild:${deliverable.id}`,
        actionKind: "package_rebuild",
        actor: normalizeNamedActor(deliverable.createdBy, "owner"),
        target: {
          resourceKind: "deliverable",
          id: deliverable.id,
        },
        primaryGovernanceLayer: deliverable.governance.primaryLayer,
        customerAccount: deliverable.governance.customerAccounts[0] ?? createUnassignedCustomerRef(),
        policyOutcome: deliverable.hasCachedPackage ? "allow" : "ask",
        approvalStatus: null,
        workflowStatus: null,
        outcome: deliverable.hasCachedPackage ? "completed" : "blocked",
        ownerRequired: true,
        publicMaterialAffecting: deliverable.visibility === "public_material",
        hasBillingImpact: false,
        totalCostCents: 0,
        occurredAt: deliverable.packageBuiltAt ?? deliverable.updatedAt,
        summary: deliverable.hasCachedPackage
          ? "Bundle package is cached and ready"
          : "Bundle package still needs owner-triggered rebuild",
        links: {
          deliverableId: deliverable.id,
          ledgerEntryIds: [],
        },
      });
    }

    if (deliverable.lastDownloadedAt && deliverable.downloadCount > 0) {
      const bundleEgressEntries = bundleEgressLedgerByDeliverableId.get(deliverable.id) ?? [];
      recentActions.push({
        id: `package_download:${deliverable.id}`,
        actionKind:
          deliverable.sourceKind === "bundle" ? "package_download" : "artifact_download",
        actor: {
          key: "system:deliverable_download",
          label: "Deliverable download",
          kind: "system",
        },
        target: {
          resourceKind: "deliverable",
          id: deliverable.id,
        },
        primaryGovernanceLayer: deliverable.governance.primaryLayer,
        customerAccount: deliverable.governance.customerAccounts[0] ?? createUnassignedCustomerRef(),
        policyOutcome: "allow",
        approvalStatus: null,
        workflowStatus: null,
        outcome: "completed",
        ownerRequired: deliverable.governance.ownerOnlyActions.includes("package_rebuild"),
        publicMaterialAffecting: deliverable.visibility === "public_material",
        hasBillingImpact: bundleEgressEntries.length > 0,
        totalCostCents: bundleEgressEntries.reduce((sum, entry) => sum + entry.costCents, 0),
        occurredAt: deliverable.lastDownloadedAt,
        summary: `Deliverable downloaded ${deliverable.downloadCount} time(s)`,
        links: {
          deliverableId: deliverable.id,
          ledgerEntryIds: bundleEgressEntries.map((entry) => entry.id),
        },
      });
    }
  }

  for (const entry of source.ledgerEntries) {
    const actionKind = "billing_debit";
    recentActions.push({
      id: `${actionKind}:${entry.id}`,
      actionKind,
      actor: {
        key: "system:billing",
        label: "Billing ledger",
        kind: "system",
      },
      target: {
        resourceKind: "ledger_entry",
        id: entry.id,
      },
      primaryGovernanceLayer: entry.primaryLayer,
      customerAccount: entry.customerAccount,
      subagentId: entry.subagentId ?? null,
      policyOutcome: null,
      approvalStatus: null,
      workflowStatus: null,
      outcome: "completed",
      ownerRequired: false,
      publicMaterialAffecting: entry.notes?.startsWith("deliverable_bundle_download:") ?? false,
      hasBillingImpact: true,
      totalCostCents: entry.costCents,
      occurredAt: entry.createdAt,
      summary: buildLedgerSummary(entry),
      links: {
        toolExecutionId: entry.toolExecutionId ?? null,
        ledgerEntryIds: [entry.id],
      },
    });
  }

  const sortedActions = [...recentActions].sort(
    (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
  );

  return {
    representative: source.representative,
    summary: {
      totalGovernedActions: sortedActions.length,
      actionsRequiringOwner: sortedActions.filter((action) => action.ownerRequired).length,
      actionsResolvedAutomatically: sortedActions.filter(
        (action) =>
          !action.ownerRequired &&
          (action.outcome === "allow" || action.outcome === "completed"),
      ).length,
      blockedOrDeniedActions: sortedActions.filter((action) =>
        ["blocked", "deny", "rejected", "expired", "ask"].includes(action.outcome),
      ).length,
      actionsWithBillingImpact: sortedActions.filter((action) => action.hasBillingImpact).length,
      actionsAffectingPublicMaterials: sortedActions.filter((action) => action.publicMaterialAffecting).length,
    },
    byActionKind: actionKindOrder.map((key) => {
      const actions = sortedActions.filter((action) => action.actionKind === key);
      return {
        key,
        count: actions.length,
        blockedCount: actions.filter((action) => isBlockedOutcome(action.outcome)).length,
        ownerRequiredCount: actions.filter((action) => action.ownerRequired).length,
        billingImpactCount: actions.filter((action) => action.hasBillingImpact).length,
        totalCostCents: actions.reduce((sum, action) => sum + action.totalCostCents, 0),
      };
    }),
    byOutcome: actionOutcomeOrder.map((key) => ({
      key,
      count: sortedActions.filter((action) => action.outcome === key).length,
    })),
    byGovernanceLayer: governanceLayerOrder.map((key) => {
      const actions = sortedActions.filter((action) => action.primaryGovernanceLayer === key);
      return {
        key,
        count: actions.length,
        ownerRequiredCount: actions.filter((action) => action.ownerRequired).length,
        billingImpactCount: actions.filter((action) => action.hasBillingImpact).length,
      };
    }),
    byCustomerAccount: buildCustomerBreakdown(sortedActions),
    bySubagent: buildSubagentBreakdown(sortedActions),
    billingImpact: buildBillingImpact(sortedActions),
    hotspots: {
      mostExpensiveActions: sortedActions
        .filter((action) => action.totalCostCents > 0)
        .slice()
        .sort((left, right) => right.totalCostCents - left.totalCostCents)
        .slice(0, 8)
        .map((action) => ({
          id: action.id,
          actionKind: action.actionKind,
          summary: action.summary,
          totalCostCents: action.totalCostCents,
          customerLabel: action.customerAccount.displayName,
          occurredAt: action.occurredAt,
        })),
      mostFrequentlyBlockedActions: actionKindOrder
        .map((key) => ({
          key,
          count: sortedActions.filter((action) => action.actionKind === key && isBlockedOutcome(action.outcome))
            .length,
        }))
        .filter((item) => item.count > 0)
        .sort((left, right) => right.count - left.count)
        .slice(0, 6),
      mostCommonOwnerOnlyActions: actionKindOrder
        .map((key) => ({
          key,
          count: sortedActions.filter((action) => action.actionKind === key && action.ownerRequired).length,
        }))
        .filter((item) => item.count > 0)
        .sort((left, right) => right.count - left.count)
        .slice(0, 6),
      staleApprovalsWithLinks: source.approvals
        .filter((approval) => approval.staleWorkflow)
        .map((approval) => ({
          id: approval.id,
          summary: approval.requestedActionSummary,
          customerLabel: approval.customerAccount.displayName,
          hasBillingLink: sortedActions.some(
            (action) =>
              action.links.approvalId === approval.id &&
              (action.hasBillingImpact || action.links.ledgerEntryIds.length > 0),
          ),
          hasResourceLink: sortedActions.some(
            (action) => action.links.approvalId === approval.id && Boolean(action.links.toolExecutionId),
          ),
          ...(approval.workflowStatus ? { workflowStatus: approval.workflowStatus } : {}),
        })),
    },
    hygiene: buildHygiene(sortedActions),
    recentActions: sortedActions.slice(0, 24),
  };
}

function mapApprovalOutcome(
  status: GovernedActionSource["approvals"][number]["status"],
): GovernedActionOutcome {
  switch (status) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    case "pending":
      return "ask";
  }
}

function buildCustomerBreakdown(actions: GovernedActionRecord[]) {
  const buckets = new Map<
    string,
    {
      key: string;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
      count: number;
      ownerRequiredCount: number;
      blockedCount: number;
      billingImpactCount: number;
    }
  >();

  for (const action of actions) {
    const current = buckets.get(action.customerAccount.key) ?? {
      key: action.customerAccount.key,
      slug: action.customerAccount.slug,
      displayName: action.customerAccount.displayName,
      isUnassigned: action.customerAccount.isUnassigned,
      count: 0,
      ownerRequiredCount: 0,
      blockedCount: 0,
      billingImpactCount: 0,
    };
    current.count += 1;
    if (action.ownerRequired) current.ownerRequiredCount += 1;
    if (isBlockedOutcome(action.outcome)) current.blockedCount += 1;
    if (action.hasBillingImpact) current.billingImpactCount += 1;
    buckets.set(action.customerAccount.key, current);
  }

  return [...buckets.values()].sort((left, right) => right.count - left.count);
}

function buildSubagentBreakdown(actions: GovernedActionRecord[]) {
  const buckets = new Map<
    string,
    {
      key: string;
      label: string;
      count: number;
      blockedCount: number;
      totalCostCents: number;
    }
  >();

  for (const action of actions) {
    const key = action.subagentId ?? "other";
    const current = buckets.get(key) ?? {
      key,
      label: action.subagentId ?? "other",
      count: 0,
      blockedCount: 0,
      totalCostCents: 0,
    };
    current.count += 1;
    if (isBlockedOutcome(action.outcome)) current.blockedCount += 1;
    current.totalCostCents += action.totalCostCents;
    buckets.set(key, current);
  }

  return [...buckets.values()].sort((left, right) => right.count - left.count);
}

function buildBillingImpact(actions: GovernedActionRecord[]) {
  const buckets = new Map<
    "compute" | "storage" | "browser" | "mcp" | "model" | "egress" | "other",
    { key: "compute" | "storage" | "browser" | "mcp" | "model" | "egress" | "other"; label: string; costCents: number }
  >();

  for (const action of actions.filter((candidate) => candidate.actionKind === "billing_debit")) {
    const key = resolveBillingBreakdownKey(action.summary);
    const current = buckets.get(key) ?? {
      key,
      label: key.replaceAll("_", " "),
      costCents: 0,
    };
    current.costCents += action.totalCostCents;
    buckets.set(key, current);
  }

  const ledgerActions = actions.filter((candidate) => candidate.actionKind === "billing_debit");
  return {
    // Ledger rows are the accounting source of truth. Compute/resource actions
    // carry the same linked cost for timeline display, so summing every action
    // would count one internal cost more than once.
    totalInternalCostCents: ledgerActions.reduce(
      (sum, action) => sum + action.totalCostCents,
      0,
    ),
    breakdown: [...buckets.values()].sort((left, right) => right.costCents - left.costCents),
  };
}

function buildHygiene(actions: GovernedActionRecord[]) {
  const missingCustomerContextCount = actions.filter((action) => action.customerAccount.isUnassigned).length;
  const missingApproverAttributionCount = actions.filter(
    (action) => action.actionKind === "approval_request" && action.approvalStatus !== "pending" && action.actor.kind === "unknown",
  ).length;
  const missingBillingLinkCount = actions.filter(
    (action) =>
      (action.actionKind === "compute_execution" ||
        action.actionKind === "artifact_download" ||
        action.actionKind === "package_download") &&
      action.totalCostCents === 0 &&
      action.hasBillingImpact === false &&
      ((action.actionKind === "compute_execution" && action.outcome === "completed") ||
        action.actionKind === "artifact_download" ||
        action.actionKind === "package_download"),
  ).length;
  const missingResourceLinkCount = actions.filter(
    (action) =>
      action.actionKind === "approval_request" &&
      !action.links.toolExecutionId &&
      !action.links.artifactId &&
      !action.links.deliverableId,
  ).length;

  return {
    missingCustomerContextCount,
    missingApproverAttributionCount,
    missingBillingLinkCount,
    missingResourceLinkCount,
    items: [
      {
        key: "missing_customer_context",
        label: "Actions missing customer context",
        detail: "These actions still fall into the unassigned customer bucket.",
        count: missingCustomerContextCount,
      },
      {
        key: "missing_approver_attribution",
        label: "Actions missing approver attribution",
        detail: "Resolved approvals should show who acted on behalf of the owner or team.",
        count: missingApproverAttributionCount,
      },
      {
        key: "missing_billing_link",
        label: "Actions missing billing linkage",
        detail: "These actions look billable but do not yet link to a ledger entry.",
        count: missingBillingLinkCount,
      },
      {
        key: "missing_resource_link",
        label: "Actions missing resource linkage",
        detail: "These approval rows still do not point at the resource or execution they govern.",
        count: missingResourceLinkCount,
      },
    ].filter((item) => item.count > 0),
  };
}

function resolveExecutionOutcome(
  status: GovernedActionSource["executions"][number]["status"],
  policyDecision: "allow" | "ask" | "deny" | null,
  approvalStatus: "pending" | "approved" | "rejected" | "expired" | null,
): GovernedActionOutcome {
  if (approvalStatus === "rejected") {
    return "rejected";
  }
  if (approvalStatus === "expired") {
    return "expired";
  }
  if (status === "blocked" && policyDecision === "deny") {
    return "deny";
  }
  if (status === "blocked" && (policyDecision === "ask" || approvalStatus === "pending")) {
    return "ask";
  }
  if (status === "blocked" || status === "failed" || status === "canceled") {
    return "blocked";
  }
  if (status === "succeeded") {
    return "completed";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "queued") {
    return approvalStatus === "approved"
      ? "approved_waiting_execution"
      : "queued";
  }
  return policyDecision === "allow" ? "allow" : "blocked";
}

function buildExecutionSummary(
  execution: GovernedActionSource["executions"][number],
  approval:
    | GovernedActionSource["approvals"][number]
    | undefined,
) {
  if (approval) {
    return approval.requestedActionSummary;
  }
  if (execution.requestedCommand) {
    return execution.requestedCommand;
  }
  if (execution.requestedPath) {
    return `${execution.capability} ${execution.requestedPath}`;
  }
  return `${execution.capability} execution`;
}

function normalizeNamedActor(
  rawValue: string | null | undefined,
  fallbackKind: GovernedActionActorKind,
): GovernedActionRecord["actor"] {
  if (!rawValue) {
    return {
      key: `${fallbackKind}:unknown`,
      label: "Unknown actor",
      kind: "unknown",
    };
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "owner-dashboard" || normalized === "owner") {
    return {
      key: "owner:dashboard",
      label: rawValue,
      kind: "owner",
    };
  }
  if (normalized.includes("workflow")) {
    return {
      key: `workflow:${rawValue}`,
      label: rawValue,
      kind: "workflow",
    };
  }
  if (normalized.includes("system")) {
    return {
      key: `system:${rawValue}`,
      label: rawValue,
      kind: "system",
    };
  }

  return {
    key: `${fallbackKind}:${rawValue}`,
    label: rawValue,
    kind: fallbackKind,
  };
}

function mapApproverKindToActorKind(
  kind: GovernedActionSource["approvals"][number]["approver"]["kind"],
): GovernedActionActorKind {
  switch (kind) {
    case "org_member":
      return "team_member";
    case "team_proxy":
      return "owner";
    case "system":
      return "system";
    case "external":
      return "external";
    case "unresolved":
      return "unknown";
  }
}

function isBlockedOutcome(outcome: GovernedActionOutcome) {
  return ["ask", "deny", "rejected", "expired", "blocked"].includes(outcome);
}

function resolveBillingBreakdownKey(
  summary: string,
): "compute" | "storage" | "browser" | "mcp" | "model" | "egress" | "other" {
  const normalized = summary.toLowerCase();
  if (normalized.includes("compute")) return "compute";
  if (normalized.includes("storage")) return "storage";
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("mcp")) return "mcp";
  if (normalized.includes("model")) return "model";
  if (normalized.includes("egress")) return "egress";
  return "other";
}

function buildLedgerSummary(entry: GovernedActionSource["ledgerEntries"][number]) {
  switch (entry.kind) {
    case "compute_minutes":
      return "compute minutes";
    case "storage_bytes":
      return "storage bytes";
    case "browser_minutes":
      return "browser minutes";
    case "model_usage":
      return "model usage";
    case "mcp_calls":
      return "mcp calls";
    case "artifact_egress":
      return "artifact egress";
    default:
      return entry.kind.replaceAll("_", " ");
  }
}

function createUnassignedCustomerRef(): CustomerRef {
  return {
    key: "unassigned",
    slug: "unassigned",
    displayName: "Unassigned",
    isUnassigned: true,
  };
}
