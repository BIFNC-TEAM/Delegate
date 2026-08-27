import { posix as pathPosix } from "node:path";

import { Prisma } from "@prisma/client";
import {
  nativeComputerUseExecutionResponseSchema,
  nativeComputerUseExecutionRequestSchema,
  nativeComputerUsePreflightResponseSchema,
  organizationGovernanceOverlaysSchema,
  representativeGovernedActionSnapshotSchema,
  representativeResourceGovernanceSnapshotSchema,
  ownerManagedPolicyOverlaysSchema,
  updateArtifactRequestSchema,
  updateArtifactResponseSchema,
  updateMcpBindingRequestSchema,
  upsertMcpBindingRequestSchema,
  type ArtifactDetailResponse,
  type BrowserTransportKind,
  type McpBindingSnapshot,
  type NativeComputerProvider,
  type NativeComputerUseExecutionResponse,
  type NativeComputerUsePreflightSnapshot,
  type OrganizationGovernanceOverlays,
  type OwnerManagedPolicyOverlays,
  type RepresentativeGovernedActionSnapshot,
  type RepresentativeResourceGovernanceSnapshot,
  type ResolveApprovalResponse,
  type UpdateArtifactResponse,
  type UpsertMcpBindingRequest,
} from "@delegate/compute-protocol";
import { resolveArtifactRetentionUntil } from "@delegate/artifacts";

import { readArtifactObject } from "./artifact-store";
import {
  approvalRiskScore,
  buildRepresentativeApprovalInsights,
  normalizeApprover,
  normalizeCustomerAccount,
  type ApprovalInsightsFilters,
  type ApprovalInsightsSource,
  type RepresentativeApprovalInsightsSnapshot,
} from "./compute-insights";
import { buildRepresentativeGovernedActionSnapshot } from "./governed-actions";
import { buildDelegationApprovalPolicyExplanation } from "./delegation-task-product";
import { assertComputeApprovalDomain } from "./compute-approval-domain";
import {
  McpBindingOperationError,
  updateMcpBindingWithOptimisticLock,
} from "./mcp-binding-concurrency";
import { prisma } from "./prisma";
import { callComputeBroker } from "./compute-client";
import { buildRepresentativeResourceGovernanceSnapshot } from "./resource-governance";
import {
  diffWorkspaceSkillRuntimeRequirements,
  parseWorkspaceSkillRuntimeRequirements,
} from "./workspace-skills";

const computeSessionInclude = Prisma.validator<Prisma.ComputeSessionDefaultArgs>()({
  include: {
    toolExecutions: {
      orderBy: [{ createdAt: "desc" }],
      take: 5,
    },
  },
});

type ComputeSessionRecord = Prisma.ComputeSessionGetPayload<{
  include: typeof computeSessionInclude.include;
}>;

const browserSessionInclude = Prisma.validator<Prisma.BrowserSessionDefaultArgs>()({
  include: {
    navigations: {
      orderBy: [{ createdAt: "desc" }],
      take: 3,
    },
    _count: {
      select: {
        navigations: true,
      },
    },
  },
});

type BrowserSessionRecord = Prisma.BrowserSessionGetPayload<{
  include: typeof browserSessionInclude.include;
}>;

const approvalInclude = Prisma.validator<Prisma.ApprovalRequestDefaultArgs>()({
  include: {
    representative: {
      select: {
        slug: true,
        displayName: true,
      },
    },
    contact: {
      select: {
        displayName: true,
        username: true,
        customerAccount: {
          select: {
            id: true,
            slug: true,
            displayName: true,
          },
        },
      },
    },
    delegationTask: {
      select: {
        id: true,
        title: true,
        status: true,
        nextActionBy: true,
      },
    },
    workspaceSkillRelease: {
      include: {
        install: {
          include: {
            skillPack: { select: { slug: true, source: true } },
            releases: {
              where: { status: "INSTALLED" },
              select: { version: true, capabilityTags: true, runtimeRequirements: true },
              take: 1,
            },
            representativeBindings: {
              where: { enabled: true },
              select: { id: true },
            },
          },
        },
      },
    },
    workflowRuns: {
      where: {
        kind: "APPROVAL_EXPIRATION",
      },
      orderBy: [{ scheduledAt: "desc" }],
      take: 1,
      select: {
        id: true,
        status: true,
        scheduledAt: true,
      },
    },
  },
});

type ApprovalRecord = Prisma.ApprovalRequestGetPayload<{
  include: typeof approvalInclude.include;
}>;

type ResourceArtifactRecord = {
  id: string;
  kind: string;
  isPinned: boolean;
  contactId: string | null;
  createdAt: Date;
  pinnedAt: Date | null;
  pinnedBy: string | null;
  downloadCount: number;
  lastDownloadedAt: Date | null;
  toolExecutionId: string | null;
};

type ResourceDeliverableRecord = {
  id: string;
  title: string;
  kind: string;
  visibility: string;
  sourceKind: string;
  artifactId: string | null;
  bundleItemArtifactIds: string[];
  createdBy: string | null;
  packageBuiltAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  downloadCount: number;
  lastDownloadedAt: Date | null;
};

type ResourceRecordBundle = {
  artifacts: ResourceArtifactRecord[];
  deliverables: ResourceDeliverableRecord[];
  dependentDeliverablesByArtifact: Map<
    string,
    Array<{
      id: string;
      title: string;
    }>
  >;
};

type RepresentativeIdentity = {
  id: string;
  ownerId: string;
  slug: string;
  displayName: string;
  computeEnabled: boolean;
  computeDefaultPolicyMode: string;
  computeBaseImage: string;
  computeMaxSessionMinutes: number;
  computeAutoApproveTokenLimit: number;
  computeArtifactRetentionDays: number;
  computeNetworkMode: string;
  computeNetworkAllowlist: string[];
  computeFilesystemMode: string;
  owner: {
    organization: {
      id: string;
      slug: string;
      displayName: string;
      members: Array<{
        id: string;
        ownerId: string;
        displayName: string;
        role: string;
        canApproveCompute: boolean;
      }>;
      capabilityProfiles: Array<{
        id: string;
        name: string;
        enabled: boolean;
        managedSource: string | null;
        managedScope: string;
        editableByOwner: boolean;
        contactTrustTierCondition: string | null;
        precedence: number;
        rules: Array<{
          id: string;
          capability: string;
          decision: string;
          resourceScopeCondition: string | null;
          channelCondition: string | null;
          requiredPlanTier: string | null;
          priority: number;
          requiresHumanApproval: boolean;
        }>;
      }>;
    } | null;
    capabilityProfiles: Array<{
      id: string;
      name: string;
      enabled: boolean;
      managedSource: string | null;
      managedScope: string;
      editableByOwner: boolean;
      contactTrustTierCondition: string | null;
      precedence: number;
      rules: Array<{
        id: string;
        capability: string;
        decision: string;
        resourceScopeCondition: string | null;
        channelCondition: string | null;
        requiredPlanTier: string | null;
        priority: number;
        requiresHumanApproval: boolean;
      }>;
    }>;
  };
  capabilityProfiles: Array<{
    id: string;
    name: string;
    enabled: boolean;
    isManaged: boolean;
    managedSource: string | null;
    managedScope: string;
    editableByOwner: boolean;
    contactTrustTierCondition: string | null;
    precedence: number;
    rules: Array<{
      id: string;
      capability: string;
      decision: string;
      resourceScopeCondition: string | null;
      channelCondition: string | null;
      requiredPlanTier: string | null;
      priority: number;
    }>;
  }>;
  mcpBindings: Array<{
    id: string;
    representativeId: string;
    representativeSkillPackLinkId: string | null;
    slug: string;
    displayName: string;
    description: string | null;
    serverUrl: string;
    transportKind: string;
    allowedToolNames: Prisma.JsonValue;
    defaultToolName: string | null;
    enabled: boolean;
    approvalRequired: boolean;
    estimatedTokensPerCall: number;
    maxRetries: number;
    retryBackoffMs: number;
    consecutiveFailures: number;
    lastFailureAt: Date | null;
    lastFailureReason: string | null;
    lastSuccessAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    representativeSkillPackLink: {
      skillPack: {
        displayName: string;
      };
    } | null;
  }>;
  organizationCustomerAccounts: Array<{
    id: string;
    slug: string;
    displayName: string;
    enabled: boolean;
    contacts: Array<{
      id: string;
    }>;
    capabilityProfiles: Array<{
      id: string;
      name: string;
      enabled: boolean;
      managedSource: string | null;
      managedScope: string;
      editableByOwner: boolean;
      contactTrustTierCondition: string | null;
      precedence: number;
      rules: Array<{
        id: string;
        capability: string;
        decision: string;
        resourceScopeCondition: string | null;
        channelCondition: string | null;
        requiredPlanTier: string | null;
        priority: number;
        requiresHumanApproval: boolean;
      }>;
    }>;
  }>;
  contacts: Array<{
    id: string;
    displayName: string | null;
    username: string | null;
    computeTrustTier: string | null;
    customerAccountId: string | null;
  }>;
};

export type RepresentativeComputeSnapshot = {
  representative: {
    slug: string;
    displayName: string;
    computeEnabled: boolean;
    defaultPolicyMode: "allow" | "ask" | "deny";
    baseImage: string;
    maxSessionMinutes: number;
    autoApproveTokenLimit: number;
    artifactRetentionDays: number;
    networkMode: "no_network" | "allowlist" | "full";
    networkAllowlist: string[];
    filesystemMode: "workspace_only" | "read_only_workspace" | "ephemeral_full";
    delegateManagedProfiles: Array<{
      id: string;
      name: string;
      managedSource?: string;
      precedence: number;
      ruleCount: number;
      highlights: string[];
    }>;
    ownerManagedOverlays: {
      baseline: {
        enabled: boolean;
        browserDecision: "allow" | "ask" | "deny";
        browserRequiresApproval: boolean;
        mcpDecision: "allow" | "ask" | "deny";
        mcpRequiresApproval: boolean;
        requiredPlanTier: "pass" | "deep_help";
      };
      trustedCustomer: {
        enabled: boolean;
        trustTier: "standard" | "verified" | "vip" | "restricted";
        browserDecision: "allow" | "ask" | "deny";
        browserRequiresApproval: boolean;
        mcpDecision: "allow" | "ask" | "deny";
        mcpRequiresApproval: boolean;
        requiredPlanTier: "pass" | "deep_help";
      };
    };
    governance: OrganizationGovernanceOverlays;
    mcpBindings: Array<
      McpBindingSnapshot & {
        sourceSkillPack?: string;
      }
    >;
  };
  nativeComputerUse: NativeComputerUsePreflightSnapshot;
  browserSessions: Array<{
    id: string;
    computeSessionId: string;
    status: "active" | "failed" | "closed";
    transportKind: BrowserTransportKind;
    profilePath?: string;
    currentUrl?: string;
    currentTitle?: string;
    lastToolExecutionId?: string;
    lastNavigationAt?: string;
    closedAt?: string;
    failureReason?: string;
    createdAt: string;
    updatedAt: string;
    visitCount: number;
    latestNavigation?: {
      id: string;
      toolExecutionId: string;
      status: "succeeded" | "failed";
      transportKind: BrowserTransportKind;
      requestedUrl: string;
      finalUrl?: string;
      pageTitle?: string;
      textSnippet?: string;
      screenshotArtifactId?: string;
      jsonArtifactId?: string;
      errorMessage?: string;
      createdAt: string;
    };
  }>;
  sessions: Array<{
    id: string;
    status: string;
    leaseStatus: string;
    requestedBy: string;
    baseImage: string;
    runnerLeaseId?: string;
    containerId?: string;
    createdAt: string;
    leaseAcquiredAt?: string;
    leaseLastUsedAt?: string;
    leaseReleasedAt?: string;
    startedAt?: string;
    lastHeartbeatAt?: string;
    expiresAt?: string;
    endedAt?: string;
    failureReason?: string;
    executionCount: number;
    latestExecution?: {
      id: string;
      capability: string;
      status: string;
      requestedCommand?: string;
      createdAt: string;
    };
  }>;
  ledger: Array<{
    id: string;
    kind: string;
    costCents: number;
    quantity: number;
    unit: string;
    createdAt: string;
    notes?: string;
    sessionId?: string;
    toolExecutionId?: string;
  }>;
};

export type RepresentativeComputeApprovalSnapshot = {
  representative: {
    slug: string;
    displayName: string;
  };
  approvals: Array<{
    id: string;
    representative: {
      slug: string;
      displayName: string;
    };
    kind: "compute" | "skill_update";
    status: string;
    reason: string;
    requestedActionSummary: string;
    riskSummary: string;
    riskScore: number;
    policy: {
      decision: "ask";
      matchedRuleId?: string;
      requestFingerprint?: string;
      explanation: string;
    };
    subagentId?: string;
    requestedAt: string;
    resolvedAt?: string;
    resolvedBy?: string;
    toolExecutionId?: string;
    sessionId?: string;
    customerAccount: {
      id: string | null;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
    };
    approver: {
      key: string;
      label: string;
      kind: "org_member" | "team_proxy" | "system" | "external" | "unresolved";
      role?: string;
    };
    workflowStatus?: string;
    workflowScheduledAt?: string;
    expiresAt?: string;
    decisionNote?: string;
    action?: {
      capability: string;
      status: string;
      requestedCommand?: string;
      requestedPath?: string;
      workingDirectory?: string;
      createdAt: string;
    };
    contact?: {
      displayName: string;
      username?: string;
    };
    staleWorkflow: boolean;
    task?: {
      id: string;
      title: string;
      status: string;
      nextActionBy: string;
    };
    skillRelease?: {
      installId: string;
      releaseId: string;
      slug: string;
      displayName: string;
      source: string;
      installedVersion: string | null;
      candidateVersion: string;
      signatureStatus: string;
      provenanceDigest: string | null;
      capabilityTags: string[];
      addedRequirements: string[];
      runtimeRequirementDiff: {
        added: string[];
        removed: string[];
        changed: boolean;
      };
      enabledBindings: number;
      sbomUrl?: string;
      attestationUrl?: string;
      registryTrust?: {
        source: string;
        verified: boolean;
        autoUpdateEligible: boolean;
        decision: string;
        securityStatus: string;
        reasons: string[];
      };
    };
  }>;
};

export type RepresentativeComputeArtifactSnapshot = {
  representative: {
    slug: string;
    displayName: string;
  };
  artifacts: Array<{
    id: string;
    kind: string;
    bucket: string;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    isPinned: boolean;
    pinnedAt?: string;
    pinnedBy?: string;
    downloadCount: number;
    lastDownloadedAt?: string;
    summary?: string;
    createdAt: string;
    retentionUntil?: string;
    sessionId?: string;
    toolExecutionId?: string;
  }>;
};

export type RepresentativeComputeArtifactDetail = ArtifactDetailResponse & {
  representative: {
    slug: string;
    displayName: string;
  };
};

export type UpsertRepresentativeMcpBindingInput = {
  representativeSlug: string;
  bindingId?: string;
  changedBy?: string;
  expectedUpdatedAt?: string;
} & UpsertMcpBindingRequest;

export type UpdateRepresentativeManagedPolicyOverlaysInput = {
  representativeSlug: string;
  overlays: OwnerManagedPolicyOverlays;
};

export type UpdateRepresentativeOrganizationGovernanceInput = {
  representativeSlug: string;
  governance: OrganizationGovernanceOverlays;
};

export type ResolveRepresentativeComputeApprovalInput = {
  representativeSlug: string;
  approvalId: string;
  resolution: "approved" | "rejected";
  resolvedBy?: string;
  decisionNote?: string;
};

export type ExecuteRepresentativeNativeComputerUseInput = {
  representativeSlug: string;
  sessionId: string;
  task: string;
  provider?: NativeComputerProvider;
  maxSteps?: number;
  allowMutations?: boolean;
};

export type { RepresentativeApprovalInsightsSnapshot } from "./compute-insights";

export async function getRepresentativeMcpBindingsSnapshot(representativeSlug: string) {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      slug: true,
      displayName: true,
      mcpBindings: {
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          representativeId: true,
          representativeSkillPackLinkId: true,
          slug: true,
          displayName: true,
          description: true,
          serverUrl: true,
          transportKind: true,
          allowedToolNames: true,
          defaultToolName: true,
          enabled: true,
          approvalRequired: true,
          estimatedTokensPerCall: true,
          maxRetries: true,
          retryBackoffMs: true,
          consecutiveFailures: true,
          lastFailureAt: true,
          lastFailureReason: true,
          lastSuccessAt: true,
          createdAt: true,
          updatedAt: true,
          representativeSkillPackLink: {
            select: {
              skillPack: {
                select: {
                  displayName: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!representative) {
    return null;
  }

  return {
    representative: {
      slug: representative.slug,
      displayName: representative.displayName,
    },
    bindings: representative.mcpBindings.map((binding) => serializeMcpBindingRecord(binding)),
  };
}

export async function getRepresentativeComputeSnapshot(
  representativeSlug: string,
): Promise<RepresentativeComputeSnapshot | null> {
  const representative = await getRepresentativeIdentity(representativeSlug);

  if (!representative) {
    return null;
  }

  const [sessions, browserSessions, ledgerEntries] = await Promise.all([
    prisma.computeSession.findMany({
      where: { representativeId: representative.id },
      ...computeSessionInclude,
      orderBy: [{ createdAt: "desc" }],
      take: 20,
    }),
    prisma.browserSession.findMany({
      where: { representativeId: representative.id },
      ...browserSessionInclude,
      orderBy: [{ lastNavigationAt: "desc" }, { createdAt: "desc" }],
      take: 12,
    }),
    prisma.ledgerEntry.findMany({
      where: { representativeId: representative.id },
      orderBy: [{ createdAt: "desc" }],
      take: 15,
    }),
  ]);
  const latestBrowserSession = browserSessions[0];
  const nativeComputerUse = nativeComputerUsePreflightResponseSchema.parse(
    await callComputeBroker(
      `/internal/compute/browser-native/preflight${
        latestBrowserSession?.computeSessionId
          ? `?sessionId=${encodeURIComponent(latestBrowserSession.computeSessionId)}`
          : ""
      }`,
      {
        method: "GET",
      },
    ),
  ).preflight;

  return {
    representative: serializeRepresentativeIdentity(representative),
    nativeComputerUse,
    browserSessions: browserSessions.map((session) => serializeBrowserSessionRecord(session)),
    sessions: sessions.map((session) => serializeComputeSession(session)),
    ledger: ledgerEntries.map((entry) => ({
      id: entry.id,
      kind: entry.kind.toLowerCase(),
      costCents: entry.costCents,
      quantity: entry.quantity,
      unit: entry.unit,
      createdAt: entry.createdAt.toISOString(),
      ...(entry.notes ? { notes: entry.notes } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.toolExecutionId ? { toolExecutionId: entry.toolExecutionId } : {}),
    })),
  };
}

export async function getRepresentativeComputeApprovals(
  representativeSlug: string,
): Promise<RepresentativeComputeApprovalSnapshot | null> {
  const representative = await getRepresentativeIdentity(representativeSlug);

  if (!representative) {
    return null;
  }

  const approvals = await queryRepresentativeApprovals(representative.id, 100, representative.ownerId);
  const executionIds = approvals
    .map((approval) => approval.toolExecutionId)
    .filter((id): id is string => Boolean(id));
  const executions = executionIds.length
    ? await prisma.toolExecution.findMany({
        where: { id: { in: executionIds } },
        select: {
          id: true,
          capability: true,
          status: true,
          requestedCommand: true,
          requestedPath: true,
          workingDirectory: true,
          createdAt: true,
        },
      })
    : [];
  const executionById = new Map(executions.map((execution) => [execution.id, execution]));

  return {
    representative: {
      slug: representative.slug,
      displayName: representative.displayName,
    },
    approvals: approvals.map((approval) =>
      serializeRepresentativeApproval(
        approval,
        representative,
        approval.toolExecutionId ? executionById.get(approval.toolExecutionId) : undefined,
      ),
    ),
  };
}

export async function getRepresentativeApprovalInsights(
  representativeSlug: string,
  filters: ApprovalInsightsFilters = {},
): Promise<RepresentativeApprovalInsightsSnapshot | null> {
  const representative = await getRepresentativeIdentity(representativeSlug);

  if (!representative) {
    return null;
  }

  const source = await buildRepresentativeApprovalInsightsSource(representative);
  return buildRepresentativeApprovalInsights(source, filters);
}

export async function getRepresentativeResourceGovernance(
  representativeSlug: string,
): Promise<RepresentativeResourceGovernanceSnapshot | null> {
  const representative = await getRepresentativeIdentity(representativeSlug);

  if (!representative) {
    return null;
  }

  const resourceRecords = await queryRepresentativeResourceRecords(representative.id);
  return buildRepresentativeResourceGovernanceSnapshotForRepresentative(representative, resourceRecords);
}

export async function getRepresentativeGovernedActions(
  representativeSlug: string,
): Promise<RepresentativeGovernedActionSnapshot | null> {
  const representative = await getRepresentativeIdentity(representativeSlug);

  if (!representative) {
    return null;
  }

  const [approvals, resourceRecords, executions, ledgerEntries] = await Promise.all([
    queryRepresentativeApprovals(representative.id, 80),
    queryRepresentativeResourceRecords(representative.id),
    prisma.toolExecution.findMany({
      where: {
        session: {
          representativeId: representative.id,
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 120,
      select: {
        id: true,
        sessionId: true,
        capability: true,
        subagentId: true,
        status: true,
        policyDecision: true,
        approvalRequestId: true,
        requestedCommand: true,
        requestedPath: true,
        createdAt: true,
        finishedAt: true,
        session: {
          select: {
            contact: {
              select: {
                customerAccount: {
                  select: {
                    id: true,
                    slug: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.ledgerEntry.findMany({
      where: {
        representativeId: representative.id,
      },
      orderBy: [{ createdAt: "desc" }],
      take: 160,
      select: {
        id: true,
        kind: true,
        costCents: true,
        quantity: true,
        unit: true,
        createdAt: true,
        notes: true,
        sessionId: true,
        toolExecutionId: true,
        contact: {
          select: {
            customerAccount: {
              select: {
                id: true,
                slug: true,
                displayName: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const resourceGovernance = buildRepresentativeResourceGovernanceSnapshotForRepresentative(
    representative,
    resourceRecords,
  );
  const artifactGovernanceById = new Map(
    resourceGovernance.artifacts.map((artifact) => [artifact.id, artifact] as const),
  );
  const deliverableGovernanceById = new Map(
    resourceGovernance.deliverables.map((deliverable) => [deliverable.id, deliverable] as const),
  );
  const hasOrganization = Boolean(representative.owner.organization?.id);

  return representativeGovernedActionSnapshotSchema.parse(
    buildRepresentativeGovernedActionSnapshot({
      representative: {
        slug: representative.slug,
        displayName: representative.displayName,
      },
      approvals: approvals.map((approval) => {
        const serialized = serializeApprovalInsightRecord(approval, representative);
        const {
          subagentId,
          customerAccount,
          resolvedAt,
          resolvedBy,
          toolExecutionId,
          sessionId,
          workflowStatus,
          workflowScheduledAt,
          ...rest
        } = serialized;
        return {
          ...rest,
          ...(subagentId ? { subagentId } : {}),
          ...(resolvedAt ? { resolvedAt } : {}),
          ...(resolvedBy ? { resolvedBy } : {}),
          ...(toolExecutionId ? { toolExecutionId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(workflowStatus ? { workflowStatus } : {}),
          ...(workflowScheduledAt ? { workflowScheduledAt } : {}),
          customerAccount: toGovernedCustomerRef(customerAccount),
        };
      }),
      executions: executions.flatMap((execution) => {
        if (
          !execution.session
          || !execution.sessionId
          || !["EXEC", "READ", "WRITE", "PROCESS", "BROWSER", "MCP"]
            .includes(execution.capability)
        ) {
          return [];
        }
        const customerAccount = toGovernedCustomerRef(
          normalizeCustomerAccount(
            execution.session.contact?.customerAccount ?? null,
          ),
        );
        return [{
          id: execution.id,
          sessionId: execution.sessionId,
          capability: execution.capability.toLowerCase() as
            | "exec"
            | "read"
            | "write"
            | "process"
            | "browser"
            | "mcp",
          subagentId: execution.subagentId,
          status: execution.status.toLowerCase() as
            | "queued"
            | "running"
            | "succeeded"
            | "failed"
            | "blocked"
            | "canceled",
          policyDecision: execution.policyDecision?.toLowerCase() as "allow" | "ask" | "deny" | null,
          approvalRequestId: execution.approvalRequestId,
          requestedCommand: execution.requestedCommand,
          requestedPath: execution.requestedPath,
          createdAt: execution.createdAt.toISOString(),
          finishedAt: execution.finishedAt?.toISOString() ?? null,
          customerAccount,
          primaryLayer: resolveGovernedCustomerLayer(customerAccount, hasOrganization),
        }];
      }),
      artifacts: resourceRecords.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind.toLowerCase() as
          | "stdout"
          | "stderr"
          | "file"
          | "archive"
          | "screenshot"
          | "json"
          | "trace",
        createdAt: artifact.createdAt.toISOString(),
        pinnedAt: artifact.pinnedAt?.toISOString() ?? null,
        pinnedBy: artifact.pinnedBy,
        downloadCount: artifact.downloadCount,
        lastDownloadedAt: artifact.lastDownloadedAt?.toISOString() ?? null,
        toolExecutionId: artifact.toolExecutionId,
        governance: artifactGovernanceById.get(artifact.id)!,
      })),
      deliverables: resourceRecords.deliverables.map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        kind: deliverable.kind.toLowerCase() as
          | "deck"
          | "case_study"
          | "download"
          | "generated_document"
          | "package",
        visibility: deliverable.visibility.toLowerCase() as "owner_only" | "public_material",
        sourceKind: deliverable.sourceKind.toLowerCase() as "artifact" | "external_link" | "bundle",
        createdAt: deliverable.createdAt.toISOString(),
        updatedAt: deliverable.updatedAt.toISOString(),
        createdBy: deliverable.createdBy,
        downloadCount: deliverable.downloadCount,
        lastDownloadedAt: deliverable.lastDownloadedAt?.toISOString() ?? null,
        packageBuiltAt: deliverable.packageBuiltAt?.toISOString() ?? null,
        hasCachedPackage: Boolean(deliverable.packageBuiltAt),
        governance: deliverableGovernanceById.get(deliverable.id)!,
      })),
      ledgerEntries: ledgerEntries.map((entry) => {
        const customerAccount = toGovernedCustomerRef(
          normalizeCustomerAccount(entry.contact?.customerAccount ?? null),
        );
        return {
          id: entry.id,
          kind: entry.kind.toLowerCase(),
          costCents: entry.costCents,
          quantity: Math.round(entry.quantity),
          unit: entry.unit,
          createdAt: entry.createdAt.toISOString(),
          notes: entry.notes ?? null,
          sessionId: entry.sessionId ?? null,
          toolExecutionId: entry.toolExecutionId ?? null,
          customerAccount,
          primaryLayer: resolveGovernedCustomerLayer(customerAccount, hasOrganization),
          subagentId:
            executions.find((execution) => execution.id === entry.toolExecutionId)?.subagentId ?? null,
        };
      }),
    }),
  );
}

export async function getRepresentativeComputeArtifacts(
  representativeSlug: string,
): Promise<RepresentativeComputeArtifactSnapshot | null> {
  const representative = await getRepresentativeIdentity(representativeSlug);

  if (!representative) {
    return null;
  }

  const artifacts = await prisma.artifact.findMany({
    where: { representativeId: representative.id },
    orderBy: [{ createdAt: "desc" }],
    take: 50,
  });

  return {
    representative: {
      slug: representative.slug,
      displayName: representative.displayName,
    },
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind.toLowerCase(),
      bucket: artifact.bucket,
      objectKey: artifact.objectKey,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      isPinned: artifact.isPinned,
      downloadCount: artifact.downloadCount,
      ...(artifact.pinnedAt ? { pinnedAt: artifact.pinnedAt.toISOString() } : {}),
      ...(artifact.pinnedBy ? { pinnedBy: artifact.pinnedBy } : {}),
      ...(artifact.lastDownloadedAt
        ? { lastDownloadedAt: artifact.lastDownloadedAt.toISOString() }
        : {}),
      ...(artifact.summary ? { summary: artifact.summary } : {}),
      createdAt: artifact.createdAt.toISOString(),
      ...(artifact.retentionUntil ? { retentionUntil: artifact.retentionUntil.toISOString() } : {}),
      ...(artifact.sessionId ? { sessionId: artifact.sessionId } : {}),
      ...(artifact.toolExecutionId ? { toolExecutionId: artifact.toolExecutionId } : {}),
    })),
  };
}

export async function getRepresentativeComputeArtifactDetail(
  representativeSlug: string,
  artifactId: string,
): Promise<RepresentativeComputeArtifactDetail | null> {
  const artifact = await getRepresentativeArtifactRecord(representativeSlug, artifactId);

  if (!artifact) {
    return null;
  }

  const { buffer } = await readArtifactObject(artifact.objectKey);
  const isTextArtifact =
    artifact.mimeType.startsWith("text/") ||
    artifact.mimeType.includes("json") ||
    artifact.kind === "STDOUT" ||
    artifact.kind === "STDERR" ||
    artifact.kind === "TRACE";
  const text = isTextArtifact ? buffer.toString("utf8") : null;
  const maxChars = 20000;
  const contentText = text ? text.slice(0, maxChars) : null;

  return {
    representative: {
      slug: artifact.representative.slug,
      displayName: artifact.representative.displayName,
    },
    artifact: {
      id: artifact.id,
      representativeId: artifact.representativeId,
      contactId: artifact.contactId,
      conversationId: artifact.conversationId,
      sessionId: artifact.sessionId,
      toolExecutionId: artifact.toolExecutionId,
      kind: artifact.kind.toLowerCase() as
        | "stdout"
        | "stderr"
        | "file"
        | "archive"
        | "screenshot"
        | "json"
        | "trace",
      bucket: artifact.bucket,
      objectKey: artifact.objectKey,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      isPinned: artifact.isPinned,
      pinnedAt: artifact.pinnedAt?.toISOString() ?? null,
      pinnedBy: artifact.pinnedBy,
      downloadCount: artifact.downloadCount,
      lastDownloadedAt: artifact.lastDownloadedAt?.toISOString() ?? null,
      retentionUntil: artifact.retentionUntil?.toISOString() ?? null,
      summary: artifact.summary,
      createdAt: artifact.createdAt.toISOString(),
    },
    contentText,
    truncated: Boolean(text && text.length > maxChars),
  };
}

export async function getRepresentativeComputeArtifactDownload(
  representativeSlug: string,
  artifactId: string,
  options?: {
    recordDownload?: boolean;
  },
): Promise<{
  fileName: string;
  mimeType: string;
  buffer: Buffer;
} | null> {
  const artifact = await getRepresentativeArtifactRecord(representativeSlug, artifactId);

  if (!artifact) {
    return null;
  }

  const { buffer } = await readArtifactObject(artifact.objectKey);

  if (options?.recordDownload !== false) {
    const now = new Date();
    const egressCostCents = Math.max(1, Math.ceil(buffer.byteLength / 65536));
    await prisma.$transaction([
      prisma.artifact.update({
        where: { id: artifact.id },
        data: {
          downloadCount: {
            increment: 1,
          },
          lastDownloadedAt: now,
        },
      }),
      prisma.ledgerEntry.create({
        data: {
          representativeId: artifact.representativeId,
          contactId: artifact.contactId,
          conversationId: artifact.conversationId,
          sessionId: artifact.sessionId,
          toolExecutionId: artifact.toolExecutionId,
          kind: "ARTIFACT_EGRESS",
          quantity: buffer.byteLength,
          unit: "byte",
          costCents: egressCostCents,
          notes: "artifact_download_egress",
        },
      }),
    ]);
  }

  return {
    fileName: buildArtifactFileName(artifact),
    mimeType: artifact.mimeType,
    buffer,
  };
}

export async function updateRepresentativeComputeArtifact(
  representativeSlug: string,
  artifactId: string,
  rawInput: unknown,
): Promise<UpdateArtifactResponse | null> {
  const input = updateArtifactRequestSchema.parse(rawInput);
  const artifact = await getRepresentativeArtifactRecord(representativeSlug, artifactId);

  if (!artifact) {
    return null;
  }

  if (!input.pinned) {
    const dependentDeliverable = await prisma.deliverable.findFirst({
      where: {
        representativeId: artifact.representativeId,
        OR: [
          {
            artifactId: artifact.id,
          },
          {
            bundleItemArtifactIds: {
              has: artifact.id,
            },
          },
        ],
      },
      select: {
        id: true,
        title: true,
      },
    });

    if (dependentDeliverable) {
      throw new Error(
        `Artifact is still referenced by deliverable "${dependentDeliverable.title}" and cannot be unpinned.`,
      );
    }
  }

  const nextRetentionUntil = input.pinned
    ? null
    : resolveArtifactRetentionUntil(
        artifact.createdAt,
        artifact.representative.computeArtifactRetentionDays,
      );
  const updated = await prisma.artifact.update({
    where: { id: artifact.id },
    data: {
      isPinned: input.pinned,
      pinnedAt: input.pinned ? new Date() : null,
      pinnedBy: input.pinned ? input.pinnedBy ?? "owner-dashboard" : null,
      retentionUntil: nextRetentionUntil,
    },
  });

  return updateArtifactResponseSchema.parse({
    artifact: {
      id: updated.id,
      representativeId: updated.representativeId,
      contactId: updated.contactId,
      conversationId: updated.conversationId,
      sessionId: updated.sessionId,
      toolExecutionId: updated.toolExecutionId,
      kind: updated.kind.toLowerCase(),
      bucket: updated.bucket,
      objectKey: updated.objectKey,
      mimeType: updated.mimeType,
      sizeBytes: updated.sizeBytes,
      sha256: updated.sha256,
      isPinned: updated.isPinned,
      pinnedAt: updated.pinnedAt?.toISOString() ?? null,
      pinnedBy: updated.pinnedBy,
      downloadCount: updated.downloadCount,
      lastDownloadedAt: updated.lastDownloadedAt?.toISOString() ?? null,
      retentionUntil: updated.retentionUntil?.toISOString() ?? null,
      summary: updated.summary,
      createdAt: updated.createdAt.toISOString(),
    },
  });
}

export async function resolveRepresentativeComputeApproval(
  input: ResolveRepresentativeComputeApprovalInput,
): Promise<ResolveApprovalResponse> {
  const representative = await getRepresentativeIdentity(input.representativeSlug);

  if (!representative) {
    throw new Error(`Representative "${input.representativeSlug}" not found.`);
  }

  const approval = await prisma.approvalRequest.findFirst({
    where: {
      id: input.approvalId,
      representativeId: representative.id,
    },
    select: {
      id: true,
      reason: true,
      workspaceSkillReleaseId: true,
    },
  });

  if (!approval) {
    throw new Error("Approval request not found for this representative.");
  }
  assertComputeApprovalDomain(approval);

  const brokerResponse = await callComputeBroker(
    `/internal/compute/approvals/${input.approvalId}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        resolution: input.resolution,
        ...(input.resolvedBy ? { resolvedBy: input.resolvedBy } : {}),
        ...(input.decisionNote ? { decisionNote: input.decisionNote } : {}),
      }),
    },
  );

  return brokerResponse as ResolveApprovalResponse;
}

export async function executeRepresentativeNativeComputerUse(
  input: ExecuteRepresentativeNativeComputerUseInput,
): Promise<NativeComputerUseExecutionResponse> {
  const representative = await getRepresentativeIdentity(input.representativeSlug);

  if (!representative) {
    throw new Error(`Representative "${input.representativeSlug}" not found.`);
  }

  const parsed = nativeComputerUseExecutionRequestSchema.parse({
    sessionId: input.sessionId,
    task: input.task,
    provider: input.provider,
    maxSteps: input.maxSteps,
    allowMutations: input.allowMutations,
  });

  const session = await prisma.computeSession.findFirst({
    where: {
      id: parsed.sessionId,
      representativeId: representative.id,
    },
    select: {
      id: true,
    },
  });

  if (!session) {
    throw new Error("Compute session not found for this representative.");
  }

  const brokerResponse = await callComputeBroker(
    `/internal/compute/sessions/${parsed.sessionId}/executions`,
    {
      method: "POST",
      body: JSON.stringify({
        capability: "browser",
        subagentId: "browser-agent",
        browserMode: "native",
        task: parsed.task,
        ...(parsed.provider ? { nativeProvider: parsed.provider } : {}),
        maxSteps: parsed.maxSteps,
        allowMutations: parsed.allowMutations,
        hasPaidEntitlement: false,
      }),
    },
  );

  return nativeComputerUseExecutionResponseSchema.parse(brokerResponse);
}

export async function updateRepresentativeManagedPolicyOverlays(
  input: UpdateRepresentativeManagedPolicyOverlaysInput,
) {
  const representative = await getRepresentativeIdentity(input.representativeSlug);

  if (!representative) {
    throw new Error(`Representative "${input.representativeSlug}" not found.`);
  }

  const parsed = ownerManagedPolicyOverlaysSchema.parse(input.overlays);
  const baselineProfileId = `cap_profile_owner_baseline_${representative.ownerId}`;
  const trustedProfileId = `cap_profile_owner_trusted_${representative.ownerId}`;

  await prisma.$transaction(async (tx) => {
    const [baselineProfile, trustedProfile] = await Promise.all([
      tx.capabilityPolicyProfile.upsert({
        where: { id: baselineProfileId },
        update: {
          ownerId: representative.ownerId,
          representativeId: null,
          name: "Owner Managed Baseline",
          isDefault: false,
          enabled: parsed.baseline.enabled,
          isManaged: true,
          managedScope: "OWNER_MANAGED",
          managedSource: "owner-managed",
          editableByOwner: true,
          contactTrustTierCondition: null,
          precedence: 80,
          defaultDecision: parsed.baseline.browserDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
        },
        create: {
          id: baselineProfileId,
          ownerId: representative.ownerId,
          representativeId: null,
          name: "Owner Managed Baseline",
          isDefault: false,
          enabled: parsed.baseline.enabled,
          isManaged: true,
          managedScope: "OWNER_MANAGED",
          managedSource: "owner-managed",
          editableByOwner: true,
          precedence: 80,
          defaultDecision: parsed.baseline.browserDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
        },
      }),
      tx.capabilityPolicyProfile.upsert({
        where: { id: trustedProfileId },
        update: {
          ownerId: representative.ownerId,
          representativeId: null,
          name: "Trusted Customer Overlay",
          isDefault: false,
          enabled: parsed.trustedCustomer.enabled,
          isManaged: true,
          managedScope: "CUSTOMER_TRUST_TIER",
          managedSource: "owner-managed",
          editableByOwner: true,
          contactTrustTierCondition: parsed.trustedCustomer.trustTier.toUpperCase(),
          precedence: 90,
          defaultDecision: parsed.trustedCustomer.browserDecision.toUpperCase() as
            | "ALLOW"
            | "ASK"
            | "DENY",
        },
        create: {
          id: trustedProfileId,
          ownerId: representative.ownerId,
          representativeId: null,
          name: "Trusted Customer Overlay",
          isDefault: false,
          enabled: parsed.trustedCustomer.enabled,
          isManaged: true,
          managedScope: "CUSTOMER_TRUST_TIER",
          managedSource: "owner-managed",
          editableByOwner: true,
          contactTrustTierCondition: parsed.trustedCustomer.trustTier.toUpperCase(),
          precedence: 90,
          defaultDecision: parsed.trustedCustomer.browserDecision.toUpperCase() as
            | "ALLOW"
            | "ASK"
            | "DENY",
        },
      }),
    ]);

    await tx.capabilityPolicyRule.deleteMany({
      where: {
        profileId: {
          in: [baselineProfile.id, trustedProfile.id],
        },
      },
    });

    await tx.capabilityPolicyRule.createMany({
      data: [
        {
          id: `${baselineProfile.id}_browser_baseline`,
          profileId: baselineProfile.id,
          capability: "BROWSER",
          decision: parsed.baseline.browserDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
          resourceScopeCondition: "BROWSER_LANE",
          channelCondition: "PRIVATE_CHAT",
          requiredPlanTier: parsed.baseline.requiredPlanTier.toUpperCase() as "PASS" | "DEEP_HELP",
          priority: 160,
          requiresPaidPlan: true,
          requiresHumanApproval: parsed.baseline.browserRequiresApproval,
        },
        {
          id: `${baselineProfile.id}_mcp_baseline`,
          profileId: baselineProfile.id,
          capability: "MCP",
          decision: parsed.baseline.mcpDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
          resourceScopeCondition: "REMOTE_MCP",
          channelCondition: "PRIVATE_CHAT",
          priority: 155,
          requiresPaidPlan: false,
          requiresHumanApproval: parsed.baseline.mcpRequiresApproval,
        },
        {
          id: `${trustedProfile.id}_browser_trusted`,
          profileId: trustedProfile.id,
          capability: "BROWSER",
          decision: parsed.trustedCustomer.browserDecision.toUpperCase() as
            | "ALLOW"
            | "ASK"
            | "DENY",
          resourceScopeCondition: "BROWSER_LANE",
          channelCondition: "PRIVATE_CHAT",
          requiredPlanTier: parsed.trustedCustomer.requiredPlanTier.toUpperCase() as
            | "PASS"
            | "DEEP_HELP",
          priority: 170,
          requiresPaidPlan: true,
          requiresHumanApproval: parsed.trustedCustomer.browserRequiresApproval,
        },
        {
          id: `${trustedProfile.id}_mcp_trusted`,
          profileId: trustedProfile.id,
          capability: "MCP",
          decision: parsed.trustedCustomer.mcpDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
          resourceScopeCondition: "REMOTE_MCP",
          channelCondition: "PRIVATE_CHAT",
          priority: 165,
          requiresPaidPlan: false,
          requiresHumanApproval: parsed.trustedCustomer.mcpRequiresApproval,
        },
      ],
    });
  });

  const snapshot = await getRepresentativeComputeSnapshot(input.representativeSlug);
  if (!snapshot) {
    throw new Error(`Representative "${input.representativeSlug}" not found after update.`);
  }

  return snapshot.representative.ownerManagedOverlays;
}

export async function updateRepresentativeOrganizationGovernance(
  input: UpdateRepresentativeOrganizationGovernanceInput,
) {
  const representative = await getRepresentativeIdentity(input.representativeSlug);

  if (!representative) {
    throw new Error(`Representative "${input.representativeSlug}" not found.`);
  }

  const parsed = organizationGovernanceOverlaysSchema.parse(input.governance);

  await prisma.$transaction(async (tx) => {
    const owner = await tx.owner.findUnique({
      where: { id: representative.ownerId },
      select: {
        id: true,
        displayName: true,
        handle: true,
        organizationId: true,
      },
    });

    if (!owner) {
      throw new Error("Owner not found for representative governance update.");
    }

    let organizationId = owner.organizationId;
    const preferredSlugBase =
      parsed.organization.slug?.trim() ||
      owner.handle?.trim() ||
      representative.slug ||
      owner.displayName;
    const organizationSlug = slugifyGovernanceValue(preferredSlugBase, owner.id);
    const organizationDisplayName =
      parsed.organization.displayName?.trim() || `${owner.displayName} Org`;

    if (!organizationId) {
      const organization = await tx.organization.create({
        data: {
          slug: organizationSlug,
          displayName: organizationDisplayName,
        },
      });
      organizationId = organization.id;
      await tx.owner.update({
        where: { id: owner.id },
        data: {
          organizationId,
        },
      });
    } else {
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          slug: organizationSlug,
          displayName: organizationDisplayName,
        },
      });
    }

    await tx.organizationMember.upsert({
      where: {
        organizationId_ownerId: {
          organizationId,
          ownerId: owner.id,
        },
      },
      update: {
        displayName: owner.displayName,
        role: "OWNER",
        canApproveCompute: true,
        canManageArtifacts: true,
        canManageBilling: true,
        canManagePolicies: true,
      },
      create: {
        organizationId,
        ownerId: owner.id,
        displayName: owner.displayName,
        role: "OWNER",
        canApproveCompute: true,
        canManageArtifacts: true,
        canManageBilling: true,
        canManagePolicies: true,
      },
    });

    const orgBaselineProfileId = `cap_profile_org_baseline_${organizationId}`;
    const orgBaselineProfile = await tx.capabilityPolicyProfile.upsert({
      where: { id: orgBaselineProfileId },
      update: {
        organizationId,
        ownerId: null,
        representativeId: null,
        customerAccountId: null,
        name: "Organization Managed Baseline",
        isDefault: false,
        enabled: parsed.organizationBaseline.enabled,
        isManaged: true,
        managedScope: "ORG_MANAGED",
        managedSource: "org-managed",
        editableByOwner: true,
        contactTrustTierCondition: null,
        precedence: 95,
        defaultDecision: parsed.organizationBaseline.browserDecision.toUpperCase() as
          | "ALLOW"
          | "ASK"
          | "DENY",
      },
      create: {
        id: orgBaselineProfileId,
        organizationId,
        name: "Organization Managed Baseline",
        isDefault: false,
        enabled: parsed.organizationBaseline.enabled,
        isManaged: true,
        managedScope: "ORG_MANAGED",
        managedSource: "org-managed",
        editableByOwner: true,
        precedence: 95,
        defaultDecision: parsed.organizationBaseline.browserDecision.toUpperCase() as
          | "ALLOW"
          | "ASK"
          | "DENY",
      },
    });

    await tx.capabilityPolicyRule.deleteMany({
      where: {
        profileId: orgBaselineProfile.id,
      },
    });
    await tx.capabilityPolicyRule.createMany({
      data: buildManagedOverlayRules({
        profileId: orgBaselineProfile.id,
        profileKey: "org_baseline",
        precedenceBase: 180,
        config: parsed.organizationBaseline,
      }),
    });

    const existingAccounts = await tx.customerAccount.findMany({
      where: {
        representativeId: representative.id,
      },
      select: {
        id: true,
        slug: true,
      },
    });
    const existingBySlug = new Map(existingAccounts.map((account) => [account.slug, account]));
    const seenAccountIds = new Set<string>();

    for (const account of parsed.customerAccounts) {
      const normalizedSlug = slugifyGovernanceValue(account.slug, representative.id);
      const existingAccount = existingBySlug.get(normalizedSlug);
      const persistedAccount = existingAccount
        ? await tx.customerAccount.update({
            where: { id: existingAccount.id },
            data: {
              organizationId,
              representativeId: representative.id,
              slug: normalizedSlug,
              displayName: account.displayName.trim(),
              enabled: account.enabled,
            },
          })
        : await tx.customerAccount.create({
            data: {
              organizationId,
              representativeId: representative.id,
              slug: normalizedSlug,
              displayName: account.displayName.trim(),
              enabled: account.enabled,
            },
          });

      seenAccountIds.add(persistedAccount.id);

      const customerProfileId = `cap_profile_customer_${persistedAccount.id}`;
      const customerProfile = await tx.capabilityPolicyProfile.upsert({
        where: { id: customerProfileId },
        update: {
          organizationId,
          customerAccountId: persistedAccount.id,
          ownerId: null,
          representativeId: representative.id,
          name: `${persistedAccount.displayName} Customer Overlay`,
          isDefault: false,
          enabled: account.enabled,
          isManaged: true,
          managedScope: "CUSTOMER_ACCOUNT",
          managedSource: "customer-account",
          editableByOwner: true,
          contactTrustTierCondition: null,
          precedence: 110,
          defaultDecision: account.browserDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
        },
        create: {
          id: customerProfileId,
          organizationId,
          customerAccountId: persistedAccount.id,
          representativeId: representative.id,
          name: `${persistedAccount.displayName} Customer Overlay`,
          isDefault: false,
          enabled: account.enabled,
          isManaged: true,
          managedScope: "CUSTOMER_ACCOUNT",
          managedSource: "customer-account",
          editableByOwner: true,
          precedence: 110,
          defaultDecision: account.browserDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
        },
      });

      await tx.capabilityPolicyRule.deleteMany({
        where: {
          profileId: customerProfile.id,
        },
      });
      await tx.capabilityPolicyRule.createMany({
        data: buildManagedOverlayRules({
          profileId: customerProfile.id,
          profileKey: `customer_${persistedAccount.id}`,
          precedenceBase: 190,
          config: account,
        }),
      });
    }

    const staleAccountIds = existingAccounts
      .filter((account) => !seenAccountIds.has(account.id))
      .map((account) => account.id);
    if (staleAccountIds.length) {
      await tx.contact.updateMany({
        where: {
          representativeId: representative.id,
          customerAccountId: {
            in: staleAccountIds,
          },
        },
        data: {
          customerAccountId: null,
        },
      });
      await tx.capabilityPolicyRule.deleteMany({
        where: {
          profile: {
            customerAccountId: {
              in: staleAccountIds,
            },
          },
        },
      });
      await tx.capabilityPolicyProfile.deleteMany({
        where: {
          customerAccountId: {
            in: staleAccountIds,
          },
        },
      });
      await tx.customerAccount.deleteMany({
        where: {
          id: {
            in: staleAccountIds,
          },
        },
      });
    }

    await tx.contact.updateMany({
      where: {
        representativeId: representative.id,
      },
      data: {
        customerAccountId: null,
      },
    });

    for (const account of parsed.customerAccounts) {
      const normalizedSlug = slugifyGovernanceValue(account.slug, representative.id);
      const persistedAccount = await tx.customerAccount.findFirst({
        where: {
          representativeId: representative.id,
          slug: normalizedSlug,
        },
        select: {
          id: true,
        },
      });
      if (!persistedAccount || !account.contactIds.length) {
        continue;
      }
      await tx.contact.updateMany({
        where: {
          representativeId: representative.id,
          id: {
            in: account.contactIds,
          },
        },
        data: {
          customerAccountId: persistedAccount.id,
        },
      });
    }
  });

  const snapshot = await getRepresentativeComputeSnapshot(input.representativeSlug);
  if (!snapshot) {
    throw new Error(`Representative "${input.representativeSlug}" not found after update.`);
  }

  return snapshot.representative.governance;
}

export async function upsertRepresentativeMcpBinding(
  input: UpsertRepresentativeMcpBindingInput,
): Promise<McpBindingSnapshot> {
  const representative = await getRepresentativeIdentity(input.representativeSlug);

  if (!representative) {
    throw new McpBindingOperationError(
      `Representative "${input.representativeSlug}" not found.`,
      404,
      "Representative not found.",
    );
  }

  const rawBindingInput = {
    representativeSkillPackLinkId: input.representativeSkillPackLinkId,
    slug: input.slug,
    displayName: input.displayName,
    description: input.description,
    serverUrl: input.serverUrl,
    transportKind: input.transportKind,
    allowedToolNames: input.allowedToolNames,
    defaultToolName: input.defaultToolName,
    enabled: input.enabled,
    approvalRequired: input.approvalRequired,
    estimatedTokensPerCall: input.estimatedTokensPerCall,
    // Persist the legacy field as zero. Remote tool results are not provably
    // idempotent, so the runtime never retries an invocation automatically.
    maxRetries: 0,
    retryBackoffMs: input.retryBackoffMs,
  };
  const parsedResult = upsertMcpBindingRequestSchema.safeParse(rawBindingInput);
  if (!parsedResult.success) {
    throw new McpBindingOperationError(
      parsedResult.error.issues[0]?.message
        ?? "The MCP binding configuration is invalid.",
      400,
    );
  }
  const parsed = parsedResult.data;
  if (input.bindingId) {
    const updateResult = updateMcpBindingRequestSchema.safeParse({
      ...rawBindingInput,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    if (!updateResult.success) {
      throw new McpBindingOperationError(
        updateResult.error.issues[0]?.message
          ?? "A valid expectedUpdatedAt timestamp is required when updating an MCP binding.",
        400,
      );
    }
  }

  const linkId = parsed.representativeSkillPackLinkId ?? null;
  if (linkId) {
    const linkedSkillPack = await prisma.representativeSkillPack.findFirst({
      where: {
        id: linkId,
        representativeId: representative.id,
      },
      select: {
        id: true,
      },
    });

    if (!linkedSkillPack) {
      throw new McpBindingOperationError(
        "Representative skill pack link not found for this binding.",
        404,
      );
    }
  }

  if (parsed.defaultToolName && !parsed.allowedToolNames.includes(parsed.defaultToolName)) {
    throw new McpBindingOperationError(
      "The default MCP tool must be included in allowedToolNames.",
      400,
    );
  }

  const binding = await prisma.$transaction(async (tx) => {
    const data = {
      representativeSkillPackLinkId: linkId,
      slug: parsed.slug,
      displayName: parsed.displayName,
      description: parsed.description ?? null,
      serverUrl: parsed.serverUrl,
      transportKind: parsed.transportKind.toUpperCase() as "STREAMABLE_HTTP" | "SSE",
      allowedToolNames: parsed.allowedToolNames,
      defaultToolName: parsed.defaultToolName ?? null,
      enabled: parsed.enabled,
      approvalRequired: parsed.approvalRequired,
      estimatedTokensPerCall: parsed.estimatedTokensPerCall,
      maxRetries: parsed.maxRetries,
      retryBackoffMs: parsed.retryBackoffMs,
    };
    const bindingId = input.bindingId;
    const mutation = bindingId
      ? await updateMcpBindingWithOptimisticLock({
          expectedUpdatedAt: input.expectedUpdatedAt!,
          loadCurrent: () => tx.representativeMcpBinding.findFirst({
            where: {
              id: bindingId,
              representativeId: representative.id,
            },
          }),
          claimUpdate: (expectedUpdatedAt) => tx.representativeMcpBinding.updateMany({
            where: {
              id: bindingId,
              representativeId: representative.id,
              updatedAt: expectedUpdatedAt,
            },
            data: {
              ...data,
              configRevision: {
                increment: 1,
              },
              healthRequestGeneration: 0,
              lastHealthObservationGeneration: 0,
              lastHealthObservationStartedAt: null,
              consecutiveFailures: 0,
              lastFailureAt: null,
              lastFailureReason: null,
              lastSuccessAt: null,
            },
          }),
          loadUpdated: () => tx.representativeMcpBinding.findUniqueOrThrow({
            where: { id: bindingId },
          }),
        })
      : {
          previous: null,
          updated: await tx.representativeMcpBinding.create({
            data: {
              representativeId: representative.id,
              ...data,
            },
          }),
        };
    const existingBinding = mutation.previous;
    const saved = mutation.updated;
    const changedFields = existingBinding
      ? [
          existingBinding.representativeSkillPackLinkId !== linkId ? "linked_skill" : null,
          existingBinding.slug !== parsed.slug ? "slug" : null,
          existingBinding.displayName !== parsed.displayName ? "display_name" : null,
          existingBinding.description !== (parsed.description ?? null) ? "description" : null,
          existingBinding.serverUrl !== parsed.serverUrl ? "server_url" : null,
          existingBinding.transportKind.toLowerCase() !== parsed.transportKind ? "transport" : null,
          JSON.stringify(existingBinding.allowedToolNames) !== JSON.stringify(parsed.allowedToolNames) ? "tool_allowlist" : null,
          existingBinding.defaultToolName !== (parsed.defaultToolName ?? null) ? "default_tool" : null,
          existingBinding.enabled !== parsed.enabled ? "enabled" : null,
          existingBinding.approvalRequired !== parsed.approvalRequired ? "approval_required" : null,
          existingBinding.estimatedTokensPerCall !== parsed.estimatedTokensPerCall ? "estimated_tokens" : null,
          existingBinding.maxRetries !== parsed.maxRetries || existingBinding.retryBackoffMs !== parsed.retryBackoffMs ? "retry_policy" : null,
        ].filter((value): value is string => Boolean(value))
      : ["created"];
    await tx.eventAudit.create({
      data: {
        representativeId: representative.id,
        type: "MCP_BINDING_CHANGED",
        payload: {
          bindingId: saved.id,
          slug: saved.slug,
          operation: input.bindingId ? "updated" : "created",
          changedFields,
          enabled: saved.enabled,
          approvalRequired: saved.approvalRequired,
          allowedToolCount: parsed.allowedToolNames.length,
          representativeSkillPackLinkId: saved.representativeSkillPackLinkId,
          changedBy: input.changedBy ?? representative.ownerId,
        },
      },
    });
    return saved;
  });

  return serializeMcpBindingRecord({
    ...binding,
    representativeSkillPackLink: null,
  });
}

function serializeComputeSession(session: ComputeSessionRecord) {
  const latestExecution = session.toolExecutions[0];

  return {
    id: session.id,
    ...(session.representativeVersionId
      ? { representativeVersionId: session.representativeVersionId }
      : {}),
    status: session.status.toLowerCase(),
    leaseStatus: session.leaseStatus.toLowerCase(),
    requestedBy: session.requestedBy.toLowerCase(),
    baseImage: session.baseImage,
    ...(session.runnerLeaseId ? { runnerLeaseId: session.runnerLeaseId } : {}),
    ...(session.containerId ? { containerId: session.containerId } : {}),
    createdAt: session.createdAt.toISOString(),
    ...(session.leaseAcquiredAt ? { leaseAcquiredAt: session.leaseAcquiredAt.toISOString() } : {}),
    ...(session.leaseLastUsedAt ? { leaseLastUsedAt: session.leaseLastUsedAt.toISOString() } : {}),
    ...(session.leaseReleasedAt ? { leaseReleasedAt: session.leaseReleasedAt.toISOString() } : {}),
    ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
    ...(session.lastHeartbeatAt
      ? { lastHeartbeatAt: session.lastHeartbeatAt.toISOString() }
      : {}),
    ...(session.expiresAt ? { expiresAt: session.expiresAt.toISOString() } : {}),
    ...(session.endedAt ? { endedAt: session.endedAt.toISOString() } : {}),
    ...(session.failureReason ? { failureReason: session.failureReason } : {}),
    executionCount: session.toolExecutions.length,
    ...(latestExecution
      ? {
          latestExecution: {
            id: latestExecution.id,
            capability: latestExecution.capability.toLowerCase(),
            status: latestExecution.status.toLowerCase(),
            ...(latestExecution.requestedCommand
              ? { requestedCommand: latestExecution.requestedCommand }
              : {}),
            createdAt: latestExecution.createdAt.toISOString(),
          },
        }
      : {}),
  };
}

function serializeBrowserSessionRecord(session: BrowserSessionRecord) {
  const latestNavigation = session.navigations[0];

  return {
    id: session.id,
    computeSessionId: session.computeSessionId,
    status: session.status.toLowerCase() as "active" | "failed" | "closed",
    transportKind: session.transportKind.toLowerCase() as BrowserTransportKind,
    ...(session.profilePath ? { profilePath: session.profilePath } : {}),
    ...(session.currentUrl ? { currentUrl: session.currentUrl } : {}),
    ...(session.currentTitle ? { currentTitle: session.currentTitle } : {}),
    ...(session.lastToolExecutionId ? { lastToolExecutionId: session.lastToolExecutionId } : {}),
    ...(session.lastNavigationAt ? { lastNavigationAt: session.lastNavigationAt.toISOString() } : {}),
    ...(session.closedAt ? { closedAt: session.closedAt.toISOString() } : {}),
    ...(session.failureReason ? { failureReason: session.failureReason } : {}),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    visitCount: session._count.navigations,
    ...(latestNavigation
      ? {
          latestNavigation: {
            id: latestNavigation.id,
            toolExecutionId: latestNavigation.toolExecutionId,
            status: latestNavigation.status.toLowerCase() as "succeeded" | "failed",
            transportKind: latestNavigation.transportKind.toLowerCase() as BrowserTransportKind,
            requestedUrl: latestNavigation.requestedUrl,
            ...(latestNavigation.finalUrl ? { finalUrl: latestNavigation.finalUrl } : {}),
            ...(latestNavigation.pageTitle ? { pageTitle: latestNavigation.pageTitle } : {}),
            ...(latestNavigation.textSnippet ? { textSnippet: latestNavigation.textSnippet } : {}),
            ...(latestNavigation.screenshotArtifactId
              ? { screenshotArtifactId: latestNavigation.screenshotArtifactId }
              : {}),
            ...(latestNavigation.jsonArtifactId
              ? { jsonArtifactId: latestNavigation.jsonArtifactId }
              : {}),
            ...(latestNavigation.errorMessage ? { errorMessage: latestNavigation.errorMessage } : {}),
            createdAt: latestNavigation.createdAt.toISOString(),
          },
        }
      : {}),
  };
}

async function getRepresentativeIdentity(
  representativeSlug: string,
): Promise<RepresentativeIdentity | null> {
  return prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      ownerId: true,
      slug: true,
      displayName: true,
      computeEnabled: true,
      computeDefaultPolicyMode: true,
      computeBaseImage: true,
      computeMaxSessionMinutes: true,
      computeAutoApproveTokenLimit: true,
      computeArtifactRetentionDays: true,
      computeNetworkMode: true,
      computeNetworkAllowlist: true,
      computeFilesystemMode: true,
      owner: {
        select: {
          organization: {
            select: {
              id: true,
              slug: true,
              displayName: true,
              members: {
                orderBy: [{ createdAt: "asc" }],
                select: {
                  id: true,
                  ownerId: true,
                  displayName: true,
                  role: true,
                  canApproveCompute: true,
                },
              },
              capabilityProfiles: {
                where: {
                  isManaged: true,
                },
                orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
                select: {
                  id: true,
                  name: true,
                  enabled: true,
                  managedSource: true,
                  managedScope: true,
                  editableByOwner: true,
                  contactTrustTierCondition: true,
                  precedence: true,
                  rules: {
                    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
                    select: {
                      id: true,
                      capability: true,
                      decision: true,
                      resourceScopeCondition: true,
                      channelCondition: true,
                      requiredPlanTier: true,
                      priority: true,
                      requiresHumanApproval: true,
                    },
                  },
                },
              },
            },
          },
          capabilityProfiles: {
            where: {
              isManaged: true,
            },
            orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
            select: {
              id: true,
              name: true,
              enabled: true,
              managedSource: true,
              managedScope: true,
              editableByOwner: true,
              contactTrustTierCondition: true,
              precedence: true,
              rules: {
                orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
                select: {
                  id: true,
                  capability: true,
                  decision: true,
                  resourceScopeCondition: true,
                  channelCondition: true,
                  requiredPlanTier: true,
                  priority: true,
                  requiresHumanApproval: true,
                },
              },
            },
          },
        },
      },
      capabilityProfiles: {
        where: {
          isManaged: true,
        },
        orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          enabled: true,
          isManaged: true,
          managedSource: true,
          managedScope: true,
          editableByOwner: true,
          contactTrustTierCondition: true,
          precedence: true,
          rules: {
            orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
            select: {
              id: true,
              capability: true,
              decision: true,
              resourceScopeCondition: true,
              channelCondition: true,
              requiredPlanTier: true,
              priority: true,
            },
          },
        },
      },
      mcpBindings: {
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          representativeId: true,
          representativeSkillPackLinkId: true,
          slug: true,
          displayName: true,
          description: true,
          serverUrl: true,
          transportKind: true,
          allowedToolNames: true,
          defaultToolName: true,
          enabled: true,
          approvalRequired: true,
          estimatedTokensPerCall: true,
          maxRetries: true,
          retryBackoffMs: true,
          consecutiveFailures: true,
          lastFailureAt: true,
          lastFailureReason: true,
          lastSuccessAt: true,
          createdAt: true,
          updatedAt: true,
          representativeSkillPackLink: {
            select: {
              skillPack: {
                select: {
                  displayName: true,
                },
              },
            },
          },
        },
      },
      organizationCustomerAccounts: {
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          slug: true,
          displayName: true,
          enabled: true,
          contacts: {
            select: {
              id: true,
            },
          },
          capabilityProfiles: {
            where: {
              isManaged: true,
            },
            orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
            select: {
              id: true,
              name: true,
              enabled: true,
              managedSource: true,
              managedScope: true,
              editableByOwner: true,
              contactTrustTierCondition: true,
              precedence: true,
              rules: {
                orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
                select: {
                  id: true,
                  capability: true,
                  decision: true,
                  resourceScopeCondition: true,
                  channelCondition: true,
                  requiredPlanTier: true,
                  priority: true,
                  requiresHumanApproval: true,
                },
              },
            },
          },
        },
      },
      contacts: {
        orderBy: [{ lastSeenAt: "desc" }],
        select: {
          id: true,
          displayName: true,
          username: true,
          computeTrustTier: true,
          customerAccountId: true,
        },
        take: 50,
      },
    },
  });
}

async function queryRepresentativeApprovals(
  representativeId: string,
  take = 20,
  workspaceOwnerId?: string,
) {
  return prisma.approvalRequest.findMany({
    where: workspaceOwnerId
      ? {
          OR: [
            { representative: { ownerId: workspaceOwnerId } },
            { workspaceSkillRelease: { install: { ownerId: workspaceOwnerId } } },
          ],
        }
      : { representativeId },
    ...approvalInclude,
    orderBy: workspaceOwnerId
      ? [{ status: "asc" }, { requestedAt: "desc" }]
      : [{ requestedAt: "desc" }],
    take,
  });
}

async function queryRepresentativeResourceRecords(
  representativeId: string,
): Promise<ResourceRecordBundle> {
  const [artifacts, deliverables] = await Promise.all([
    prisma.artifact.findMany({
      where: {
        representativeId,
      },
      select: {
        id: true,
        kind: true,
        isPinned: true,
        contactId: true,
        createdAt: true,
        pinnedAt: true,
        pinnedBy: true,
        downloadCount: true,
        lastDownloadedAt: true,
        toolExecutionId: true,
      },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.deliverable.findMany({
      where: {
        representativeId,
      },
      select: {
        id: true,
        title: true,
        kind: true,
        visibility: true,
        sourceKind: true,
        artifactId: true,
        bundleItemArtifactIds: true,
        createdBy: true,
        packageBuiltAt: true,
        createdAt: true,
        updatedAt: true,
        downloadCount: true,
        lastDownloadedAt: true,
      },
      orderBy: [{ createdAt: "desc" }],
    }),
  ]);

  const dependentDeliverablesByArtifact = new Map<
    string,
    Array<{
      id: string;
      title: string;
    }>
  >();

  for (const deliverable of deliverables) {
    const artifactIds = [
      ...(deliverable.artifactId ? [deliverable.artifactId] : []),
      ...deliverable.bundleItemArtifactIds,
    ];
    for (const artifactId of artifactIds) {
      const bucket = dependentDeliverablesByArtifact.get(artifactId) ?? [];
      bucket.push({
        id: deliverable.id,
        title: deliverable.title,
      });
      dependentDeliverablesByArtifact.set(artifactId, bucket);
    }
  }

  return {
    artifacts,
    deliverables,
    dependentDeliverablesByArtifact,
  };
}

async function buildRepresentativeApprovalInsightsSource(
  representative: RepresentativeIdentity,
): Promise<ApprovalInsightsSource> {
  const [approvals, blockedEvents, ledgerEntries] = await Promise.all([
    queryRepresentativeApprovals(representative.id, 120, representative.ownerId),
    prisma.eventAudit.findMany({
      where: {
        representativeId: representative.id,
        type: "TOOL_EXECUTION_BLOCKED",
        createdAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 120,
      select: {
        id: true,
        createdAt: true,
        payload: true,
        contact: {
          select: {
            customerAccount: {
              select: {
                id: true,
                slug: true,
                displayName: true,
              },
            },
          },
        },
      },
    }),
    prisma.ledgerEntry.findMany({
      where: {
        representativeId: representative.id,
        toolExecutionId: {
          not: null,
        },
        createdAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 240,
      select: {
        toolExecutionId: true,
        costCents: true,
      },
    }),
  ]);

  const toolExecutionIds = Array.from(
    new Set(
      ledgerEntries
        .map((entry) => entry.toolExecutionId)
        .filter((toolExecutionId): toolExecutionId is string => Boolean(toolExecutionId)),
    ),
  );
  const toolExecutions = toolExecutionIds.length
    ? await prisma.toolExecution.findMany({
        where: {
          id: {
            in: toolExecutionIds,
          },
        },
        select: {
          id: true,
          subagentId: true,
        },
      })
    : [];
  const toolExecutionMap = new Map(toolExecutions.map((execution) => [execution.id, execution]));

  return {
    representative: {
      slug: representative.slug,
      displayName: representative.displayName,
      organization: representative.owner.organization
        ? {
            id: representative.owner.organization.id,
            slug: representative.owner.organization.slug,
            displayName: representative.owner.organization.displayName,
          }
        : null,
    },
    organizationMembers:
      representative.owner.organization?.members.map((member) => ({
        displayName: member.displayName,
        role: member.role,
        canApproveCompute: member.canApproveCompute,
      })) ?? [],
    approvals: approvals.map((approval) => serializeApprovalInsightRecord(approval, representative)),
    blockedSignals: blockedEvents.map((event) => ({
      id: event.id,
      createdAt: event.createdAt.toISOString(),
      customerAccount: normalizeCustomerAccount(event.contact?.customerAccount ?? null),
      subagentId: parseEventAuditSubagentId(event.payload),
    })),
    costSignals: ledgerEntries.map((entry) => ({
      subagentId: entry.toolExecutionId ? toolExecutionMap.get(entry.toolExecutionId)?.subagentId ?? null : null,
      costCents: entry.costCents,
    })),
  };
}

async function getRepresentativeArtifactRecord(representativeSlug: string, artifactId: string) {
  return prisma.artifact.findFirst({
    where: {
      id: artifactId,
      representative: {
        slug: representativeSlug,
      },
    },
    include: {
      representative: {
        select: {
          slug: true,
          displayName: true,
          computeArtifactRetentionDays: true,
        },
      },
    },
  });
}

function serializeRepresentativeApproval(
  approval: ApprovalRecord,
  representative: RepresentativeIdentity,
  execution?: {
    capability: string;
    status: string;
    requestedCommand: string | null;
    requestedPath: string | null;
    workingDirectory: string | null;
    createdAt: Date;
  },
) {
  const workflow = approval.workflowRuns[0];
  const customerAccount = normalizeCustomerAccount(approval.contact?.customerAccount ?? null);
  const approver = normalizeApprover(
    approval.resolvedBy,
    representative.owner.organization?.members.map((member) => ({
      ownerId: member.ownerId,
      displayName: member.displayName,
      role: member.role,
      canApproveCompute: member.canApproveCompute,
    })) ?? [],
  );
  const staleWorkflow = isApprovalWorkflowStale(
    approval.status,
    workflow?.status ?? null,
    workflow?.scheduledAt ?? null,
  );

  return {
    id: approval.id,
    representative: {
      slug: approval.representative.slug,
      displayName: approval.representative.displayName,
    },
    kind: approval.workspaceSkillRelease ? "skill_update" as const : "compute" as const,
    status: approval.status.toLowerCase(),
    reason: approval.reason,
    requestedActionSummary: approval.requestedActionSummary,
    riskSummary: approval.riskSummary,
    riskScore: approvalRiskScore(approval.reason, approval.riskSummary),
    policy: {
      decision: "ask" as const,
      ...(approval.matchedPolicyRuleId ? { matchedRuleId: approval.matchedPolicyRuleId } : {}),
      ...(approval.requestPayloadHash ? { requestFingerprint: approval.requestPayloadHash } : {}),
      explanation: approval.workspaceSkillRelease
        ? "A workspace skill update must satisfy provenance, permission-diff, and owner update-policy checks before adoption."
        : buildDelegationApprovalPolicyExplanation(approval.reason, approval.matchedPolicyRuleId),
    },
    customerAccount,
    approver,
    staleWorkflow,
    ...(approval.delegationTask
      ? {
          task: {
            id: approval.delegationTask.id,
            title: approval.delegationTask.title,
            status: approval.delegationTask.status.toLowerCase(),
            nextActionBy: approval.delegationTask.nextActionBy.toLowerCase(),
          },
        }
      : {}),
    ...(approval.subagentId ? { subagentId: approval.subagentId } : {}),
    ...(approval.workspaceSkillRelease
      ? {
          skillRelease: serializeApprovalSkillRelease(approval.workspaceSkillRelease),
        }
      : {}),
    requestedAt: approval.requestedAt.toISOString(),
    ...(approval.expiresAt ? { expiresAt: approval.expiresAt.toISOString() } : {}),
    ...(approval.decisionNote ? { decisionNote: approval.decisionNote } : {}),
    ...(approval.contact
      ? {
          contact: {
            displayName: approval.contact.displayName || "Anonymous visitor",
            ...(approval.contact.username ? { username: approval.contact.username } : {}),
          },
        }
      : {}),
    ...(execution
      ? {
          action: {
            capability: execution.capability.toLowerCase(),
            status: execution.status.toLowerCase(),
            ...(execution.requestedCommand
              ? { requestedCommand: redactApprovalCommand(execution.requestedCommand) }
              : {}),
            ...(execution.requestedPath ? { requestedPath: execution.requestedPath } : {}),
            ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
            createdAt: execution.createdAt.toISOString(),
          },
        }
      : approval.workspaceSkillRelease
        ? {
            action: {
              capability: "skill_update",
              status: approval.status.toLowerCase(),
              createdAt: approval.requestedAt.toISOString(),
            },
          }
        : {}),
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt.toISOString() } : {}),
    ...(approval.resolvedBy ? { resolvedBy: approval.resolvedBy } : {}),
    ...(approval.toolExecutionId ? { toolExecutionId: approval.toolExecutionId } : {}),
    ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
    ...(workflow ? { workflowStatus: workflow.status.toLowerCase() } : {}),
    ...(workflow ? { workflowScheduledAt: workflow.scheduledAt.toISOString() } : {}),
  };
}

function serializeApprovalSkillRelease(
  release: NonNullable<ApprovalRecord["workspaceSkillRelease"]>,
) {
  const installedTags = parseApprovalCapabilityTags(release.install.releases[0]?.capabilityTags);
  const candidateTags = parseApprovalCapabilityTags(release.capabilityTags);
  const installedRequirements = deriveApprovalRequirements(installedTags);
  const candidateRequirements = deriveApprovalRequirements(candidateTags);
  const runtimeRequirementDiff = diffWorkspaceSkillRuntimeRequirements(
    parseWorkspaceSkillRuntimeRequirements(release.install.releases[0]?.runtimeRequirements),
    parseWorkspaceSkillRuntimeRequirements(release.runtimeRequirements),
  );
  const registryTrustEvidence = parseApprovalRegistryTrustEvidence(release.registryTrustEvidence);
  return {
    installId: release.installId,
    releaseId: release.id,
    slug: release.install.skillPack.slug,
    displayName: release.displayName,
    source: release.install.skillPack.source.toLowerCase(),
    installedVersion: release.install.installedVersion,
    candidateVersion: release.version,
    signatureStatus: release.signatureStatus.toLowerCase(),
    provenanceDigest: release.provenanceDigest,
    capabilityTags: candidateTags,
    addedRequirements: candidateRequirements.filter((item) => !installedRequirements.includes(item)),
    runtimeRequirementDiff,
    enabledBindings: release.install.representativeBindings.length,
    ...(release.registryTrustSource
      ? {
          registryTrust: {
            source: release.registryTrustSource,
            verified: release.registryVerified,
            autoUpdateEligible: release.registryTrustEligible,
            decision: registryTrustEvidence.decision,
            securityStatus: registryTrustEvidence.securityStatus,
            reasons: registryTrustEvidence.reasons,
          },
        }
      : {}),
    ...(release.sbomUrl ? { sbomUrl: release.sbomUrl } : {}),
    ...(release.attestationUrl ? { attestationUrl: release.attestationUrl } : {}),
  };
}

function parseApprovalRegistryTrustEvidence(value: Prisma.JsonValue | null) {
  const evidence = value && typeof value === "object" && !Array.isArray(value)
    ? value as Prisma.JsonObject
    : null;
  return {
    decision: typeof evidence?.decision === "string" ? evidence.decision : "unknown",
    securityStatus: typeof evidence?.securityStatus === "string" ? evidence.securityStatus : "unknown",
    reasons: Array.isArray(evidence?.reasons)
      ? evidence.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 32)
      : [],
  };
}

function parseApprovalCapabilityTags(value: Prisma.JsonValue | undefined) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function deriveApprovalRequirements(tags: string[]) {
  const capabilities = ["exec", "read", "write", "process", "browser", "mcp"];
  const normalized = tags.map((tag) => tag.toLowerCase());
  return capabilities.filter((capability) =>
    normalized.some((tag) => tag === capability || tag.startsWith(`${capability}-`) || tag.endsWith(`-${capability}`)),
  );
}

function redactApprovalCommand(value: string) {
  const normalized = value.replace(/\b(api[_-]?key|token|password|secret)=\S+/gi, "$1=[redacted]");
  return normalized.length > 600 ? `${normalized.slice(0, 600)}…` : normalized;
}

function buildRepresentativeResourceGovernanceSnapshotForRepresentative(
  representative: RepresentativeIdentity,
  resourceRecords: ResourceRecordBundle,
) {
  const governance = serializeOrganizationGovernance(representative);

  return representativeResourceGovernanceSnapshotSchema.parse(
    buildRepresentativeResourceGovernanceSnapshot({
      representative: {
        slug: representative.slug,
        displayName: representative.displayName,
      },
      ownerManagedOverlays: serializeOwnerManagedOverlays(representative.owner.capabilityProfiles),
      governance: {
        ...governance,
        organization: {
          id: governance.organization.id ?? null,
          slug: governance.organization.slug ?? null,
          displayName: governance.organization.displayName ?? null,
        },
        customerAccounts: governance.customerAccounts.map((account) => ({
          ...account,
          id: account.id ?? null,
        })),
        contactAssignments: governance.contactAssignments.map((assignment) => ({
          ...assignment,
          displayName: assignment.displayName ?? null,
          username: assignment.username ?? null,
          computeTrustTier: assignment.computeTrustTier ?? null,
          customerAccountId: assignment.customerAccountId ?? null,
          customerAccountSlug: assignment.customerAccountSlug ?? null,
        })),
      },
      artifacts: resourceRecords.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind.toLowerCase() as
          | "stdout"
          | "stderr"
          | "file"
          | "archive"
          | "screenshot"
          | "json"
          | "trace",
        isPinned: artifact.isPinned,
        contactId: artifact.contactId,
        dependentDeliverableIds:
          resourceRecords.dependentDeliverablesByArtifact.get(artifact.id)?.map((item) => item.id) ?? [],
        dependentDeliverableTitles:
          resourceRecords.dependentDeliverablesByArtifact.get(artifact.id)?.map((item) => item.title) ?? [],
      })),
      deliverables: resourceRecords.deliverables.map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        kind: deliverable.kind.toLowerCase() as
          | "deck"
          | "case_study"
          | "download"
          | "generated_document"
          | "package",
        visibility: deliverable.visibility.toLowerCase() as "owner_only" | "public_material",
        sourceKind: deliverable.sourceKind.toLowerCase() as "artifact" | "external_link" | "bundle",
        artifactId: deliverable.artifactId,
        bundleItemArtifactIds: deliverable.bundleItemArtifactIds,
        hasCachedPackage: Boolean(deliverable.packageBuiltAt),
        createdBy: deliverable.createdBy,
      })),
    }),
  );
}

function resolveGovernedCustomerLayer(
  customerAccount: {
    isUnassigned: boolean;
  },
  hasOrganization: boolean,
) {
  if (!customerAccount.isUnassigned) {
    return "customer_account" as const;
  }

  if (hasOrganization) {
    return "org_managed" as const;
  }

  return "owner_managed" as const;
}

function toGovernedCustomerRef(
  customerAccount: ReturnType<typeof normalizeCustomerAccount>,
) {
  return {
    key: customerAccount.id ?? "unassigned",
    slug: customerAccount.slug,
    displayName: customerAccount.displayName,
    isUnassigned: customerAccount.isUnassigned,
  };
}

function serializeApprovalInsightRecord(
  approval: ApprovalRecord,
  representative: RepresentativeIdentity,
) {
  const workflow = approval.workflowRuns[0];

  return {
    id: approval.id,
    status: approval.status.toLowerCase() as "pending" | "approved" | "rejected" | "expired",
    reason: approval.reason,
    requestedActionSummary: approval.requestedActionSummary,
    riskSummary: approval.riskSummary,
    subagentId: approval.subagentId,
    requestedAt: approval.requestedAt.toISOString(),
    resolvedAt: approval.resolvedAt?.toISOString() ?? null,
    resolvedBy: approval.resolvedBy ?? null,
    toolExecutionId: approval.toolExecutionId ?? null,
    sessionId: approval.sessionId ?? null,
    customerAccount: normalizeCustomerAccount(approval.contact?.customerAccount ?? null),
    approver: normalizeApprover(
      approval.resolvedBy,
      representative.owner.organization?.members.map((member) => ({
        displayName: member.displayName,
        role: member.role,
        canApproveCompute: member.canApproveCompute,
      })) ?? [],
    ),
    riskScore: approvalRiskScore(approval.reason, approval.riskSummary),
    workflowStatus: workflow?.status.toLowerCase() ?? null,
    workflowScheduledAt: workflow?.scheduledAt.toISOString() ?? null,
    staleWorkflow: isApprovalWorkflowStale(
      approval.status,
      workflow?.status ?? null,
      workflow?.scheduledAt ?? null,
    ),
  };
}

function isApprovalWorkflowStale(
  approvalStatus: ApprovalRecord["status"],
  workflowStatus: string | null,
  workflowScheduledAt: Date | null,
) {
  if (approvalStatus !== "PENDING") {
    return false;
  }

  if (!workflowStatus || !workflowScheduledAt) {
    return true;
  }

  if (workflowStatus === "FAILED" || workflowStatus === "CANCELED" || workflowStatus === "COMPLETED") {
    return true;
  }

  if (workflowStatus === "QUEUED") {
    return workflowScheduledAt.getTime() < Date.now() - 15 * 60 * 1000;
  }

  return false;
}

function parseEventAuditSubagentId(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const maybeSubagentId = (payload as { subagentId?: unknown }).subagentId;
  return typeof maybeSubagentId === "string" && maybeSubagentId.trim() ? maybeSubagentId : null;
}

function serializeRepresentativeIdentity(representative: RepresentativeIdentity) {
  return {
    slug: representative.slug,
    displayName: representative.displayName,
    computeEnabled: representative.computeEnabled,
    defaultPolicyMode: representative.computeDefaultPolicyMode.toLowerCase() as
      | "allow"
      | "ask"
      | "deny",
    baseImage: representative.computeBaseImage,
    maxSessionMinutes: representative.computeMaxSessionMinutes,
    autoApproveTokenLimit: representative.computeAutoApproveTokenLimit,
    artifactRetentionDays: representative.computeArtifactRetentionDays,
    networkMode: representative.computeNetworkMode.toLowerCase() as
      | "no_network"
      | "allowlist"
      | "full",
    networkAllowlist: representative.computeNetworkAllowlist,
    filesystemMode: representative.computeFilesystemMode.toLowerCase() as
      | "workspace_only"
      | "read_only_workspace"
      | "ephemeral_full",
    delegateManagedProfiles: representative.capabilityProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      ...(profile.managedSource ? { managedSource: profile.managedSource } : {}),
      precedence: profile.precedence,
      ruleCount: profile.rules.length,
      highlights: profile.rules.slice(0, 3).map((rule) => {
        const channel = rule.channelCondition ? ` @ ${rule.channelCondition.toLowerCase()}` : "";
        const plan = rule.requiredPlanTier ? ` / ${rule.requiredPlanTier.toLowerCase()}` : "";
        const scope = rule.resourceScopeCondition
          ? ` / ${rule.resourceScopeCondition.toLowerCase()}`
          : "";
        return `${rule.capability.toLowerCase()} -> ${rule.decision.toLowerCase()}${scope}${channel}${plan}`;
      }),
    })),
    ownerManagedOverlays: serializeOwnerManagedOverlays(representative.owner.capabilityProfiles),
    governance: serializeOrganizationGovernance(representative),
    mcpBindings: representative.mcpBindings.map((binding) => serializeMcpBindingRecord(binding)),
  };
}

function serializeOwnerManagedOverlays(
  profiles: RepresentativeIdentity["owner"]["capabilityProfiles"],
) {
  const baselineProfile = profiles.find((profile) => profile.managedScope === "OWNER_MANAGED");
  const trustedProfile = profiles.find(
    (profile) => profile.managedScope === "CUSTOMER_TRUST_TIER",
  );

  return ownerManagedPolicyOverlaysSchema.parse({
    baseline: {
      enabled: baselineProfile?.enabled ?? true,
      browserDecision: resolveOverlayRuleDecision(baselineProfile, "BROWSER", "ASK"),
      browserRequiresApproval: resolveOverlayRuleApproval(baselineProfile, "BROWSER", true),
      mcpDecision: resolveOverlayRuleDecision(baselineProfile, "MCP", "ASK"),
      mcpRequiresApproval: resolveOverlayRuleApproval(baselineProfile, "MCP", true),
      requiredPlanTier: resolveOverlayRulePlanTier(baselineProfile, "BROWSER", "PASS"),
    },
    trustedCustomer: {
      enabled: trustedProfile?.enabled ?? true,
      trustTier: resolveOverlayTrustTier(trustedProfile?.contactTrustTierCondition),
      browserDecision: resolveOverlayRuleDecision(trustedProfile, "BROWSER", "ASK"),
      browserRequiresApproval: resolveOverlayRuleApproval(trustedProfile, "BROWSER", true),
      mcpDecision: resolveOverlayRuleDecision(trustedProfile, "MCP", "ALLOW"),
      mcpRequiresApproval: resolveOverlayRuleApproval(trustedProfile, "MCP", false),
      requiredPlanTier: resolveOverlayRulePlanTier(trustedProfile, "BROWSER", "PASS"),
    },
  });
}

function serializeOrganizationGovernance(representative: RepresentativeIdentity) {
  const orgProfiles = representative.owner.organization?.capabilityProfiles ?? [];
  const organizationBaseline = orgProfiles.find((profile) => profile.managedScope === "ORG_MANAGED");

  return organizationGovernanceOverlaysSchema.parse({
    organization: representative.owner.organization
      ? {
          id: representative.owner.organization.id,
          slug: representative.owner.organization.slug,
          displayName: representative.owner.organization.displayName,
        }
      : {
          id: null,
          slug: null,
          displayName: null,
        },
    organizationBaseline: {
      enabled: organizationBaseline?.enabled ?? true,
      browserDecision: resolveOverlayRuleDecision(organizationBaseline, "BROWSER", "ASK"),
      browserRequiresApproval: resolveOverlayRuleApproval(organizationBaseline, "BROWSER", true),
      mcpDecision: resolveOverlayRuleDecision(organizationBaseline, "MCP", "ASK"),
      mcpRequiresApproval: resolveOverlayRuleApproval(organizationBaseline, "MCP", true),
      requiredPlanTier: resolveOverlayRulePlanTier(organizationBaseline, "BROWSER", "PASS"),
    },
    customerAccounts: representative.organizationCustomerAccounts.map((account) => {
      const customerProfile = account.capabilityProfiles.find(
        (profile) => profile.managedScope === "CUSTOMER_ACCOUNT",
      );
      return {
        id: account.id,
        slug: account.slug,
        displayName: account.displayName,
        enabled: customerProfile?.enabled ?? account.enabled,
        browserDecision: resolveOverlayRuleDecision(customerProfile, "BROWSER", "ASK"),
        browserRequiresApproval: resolveOverlayRuleApproval(customerProfile, "BROWSER", true),
        mcpDecision: resolveOverlayRuleDecision(customerProfile, "MCP", "ALLOW"),
        mcpRequiresApproval: resolveOverlayRuleApproval(customerProfile, "MCP", false),
        requiredPlanTier: resolveOverlayRulePlanTier(customerProfile, "BROWSER", "PASS"),
        contactIds: account.contacts.map((contact) => contact.id),
      };
    }),
    contactAssignments: representative.contacts.map((contact) => {
      const customerAccount = representative.organizationCustomerAccounts.find(
        (account) => account.id === contact.customerAccountId,
      );
      return {
        contactId: contact.id,
        displayName: contact.displayName,
        username: contact.username,
        computeTrustTier: resolveOverlayTrustTier(contact.computeTrustTier),
        customerAccountId: contact.customerAccountId,
        customerAccountSlug: customerAccount?.slug ?? null,
      };
    }),
  });
}

function resolveOverlayRuleDecision(
  profile: RepresentativeIdentity["owner"]["capabilityProfiles"][number] | undefined,
  capability: "BROWSER" | "MCP",
  fallback: "ALLOW" | "ASK" | "DENY",
) {
  const rule = profile?.rules.find((candidate) => candidate.capability === capability);
  return (rule?.decision ?? fallback).toLowerCase() as "allow" | "ask" | "deny";
}

function resolveOverlayRuleApproval(
  profile: RepresentativeIdentity["owner"]["capabilityProfiles"][number] | undefined,
  capability: "BROWSER" | "MCP",
  fallback: boolean,
) {
  const rule = profile?.rules.find((candidate) => candidate.capability === capability);
  return rule?.requiresHumanApproval ?? fallback;
}

function resolveOverlayRulePlanTier(
  profile: RepresentativeIdentity["owner"]["capabilityProfiles"][number] | undefined,
  capability: "BROWSER" | "MCP",
  fallback: "PASS" | "DEEP_HELP",
) {
  const rule = profile?.rules.find((candidate) => candidate.capability === capability);
  return (rule?.requiredPlanTier ?? fallback).toLowerCase() as "pass" | "deep_help";
}

function resolveOverlayTrustTier(
  value: string | null | undefined,
): "standard" | "verified" | "vip" | "restricted" {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "verified" ||
    normalized === "vip" ||
    normalized === "restricted"
  ) {
    return normalized;
  }

  return "standard";
}

function buildManagedOverlayRules(params: {
  profileId: string;
  profileKey: string;
  precedenceBase: number;
  config: {
    browserDecision: "allow" | "ask" | "deny";
    browserRequiresApproval: boolean;
    mcpDecision: "allow" | "ask" | "deny";
    mcpRequiresApproval: boolean;
    requiredPlanTier: "pass" | "deep_help";
  };
}) {
  return [
    {
      id: `${params.profileId}_${params.profileKey}_browser`,
      profileId: params.profileId,
      capability: "BROWSER" as const,
      decision: params.config.browserDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
      resourceScopeCondition: "BROWSER_LANE" as const,
      channelCondition: "PRIVATE_CHAT" as const,
      requiredPlanTier: params.config.requiredPlanTier.toUpperCase() as "PASS" | "DEEP_HELP",
      priority: params.precedenceBase,
      requiresPaidPlan: true,
      requiresHumanApproval: params.config.browserRequiresApproval,
    },
    {
      id: `${params.profileId}_${params.profileKey}_mcp`,
      profileId: params.profileId,
      capability: "MCP" as const,
      decision: params.config.mcpDecision.toUpperCase() as "ALLOW" | "ASK" | "DENY",
      resourceScopeCondition: "REMOTE_MCP" as const,
      channelCondition: "PRIVATE_CHAT" as const,
      priority: params.precedenceBase - 5,
      requiresPaidPlan: false,
      requiresHumanApproval: params.config.mcpRequiresApproval,
    },
  ];
}

function slugifyGovernanceValue(input: string, fallbackSeed: string) {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalized) {
    return normalized;
  }

  return `governance-${fallbackSeed.slice(0, 8).toLowerCase()}`;
}

function serializeMcpBindingRecord(binding: RepresentativeIdentity["mcpBindings"][number]) {
  return {
    id: binding.id,
    representativeId: binding.representativeId,
    representativeSkillPackLinkId: binding.representativeSkillPackLinkId,
    slug: binding.slug,
    displayName: binding.displayName,
    description: binding.description,
    serverUrl: binding.serverUrl,
    transportKind: binding.transportKind.toLowerCase() as "streamable_http" | "sse",
    allowedToolNames: Array.isArray(binding.allowedToolNames)
      ? binding.allowedToolNames.filter((value): value is string => typeof value === "string")
      : [],
    defaultToolName: binding.defaultToolName,
    enabled: binding.enabled,
    approvalRequired: binding.approvalRequired,
    estimatedTokensPerCall: binding.estimatedTokensPerCall,
    maxRetries: binding.maxRetries,
    retryBackoffMs: binding.retryBackoffMs,
    consecutiveFailures: binding.consecutiveFailures,
    lastFailureAt: binding.lastFailureAt?.toISOString() ?? null,
    lastFailureReason: binding.lastFailureReason,
    lastSuccessAt: binding.lastSuccessAt?.toISOString() ?? null,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
    ...(binding.representativeSkillPackLink?.skillPack.displayName
      ? { sourceSkillPack: binding.representativeSkillPackLink.skillPack.displayName }
      : {}),
  };
}

function buildArtifactFileName(artifact: {
  id: string;
  kind: string;
  objectKey: string;
  mimeType: string;
}) {
  const objectName = pathPosix.basename(artifact.objectKey);
  const objectExtension = objectName.includes(".") ? objectName.split(".").pop() : undefined;
  const extension =
    artifact.mimeType.includes("json")
      ? "json"
      : artifact.mimeType.includes("text/")
        ? "txt"
        : artifact.mimeType === "image/jpeg"
          ? "jpg"
          : artifact.mimeType === "image/png"
            ? "png"
            : objectExtension || "bin";
  return `${artifact.kind.toLowerCase()}-${artifact.id}.${extension}`;
}
