import {
  approvalRequestSnapshotSchema,
  artifactSnapshotSchema,
  browserNavigationSnapshotSchema,
  browserSessionSnapshotSchema,
  capabilityPolicyProfileSchema,
  computeSubagentIdSchema,
  computeSessionSnapshotSchema,
  mcpBindingSnapshotSchema,
  toolExecutionSnapshotSchema,
  type BrowserTransportKind,
  type ComputeFilesystemMode,
  type McpTransportKind,
  type ComputeNetworkMode,
} from "@delegate/compute-protocol";

export function mapRequestedByToDb(value: "system" | "owner" | "audience") {
  return value.toUpperCase() as "SYSTEM" | "OWNER" | "AUDIENCE";
}

export function mapRequestedByFromDb(value: string) {
  return value.toLowerCase() as "system" | "owner" | "audience";
}

export function mapRunnerTypeToDb(value: "docker" | "vm") {
  return value.toUpperCase() as "DOCKER" | "VM";
}

export function mapRunnerTypeFromDb(value: string) {
  return value.toLowerCase() as "docker" | "vm";
}

export function mapSessionStatusFromDb(value: string) {
  return value.toLowerCase() as
    | "requested"
    | "starting"
    | "running"
    | "idle"
    | "stopping"
    | "completed"
    | "failed"
    | "expired";
}

export function mapLeaseStatusFromDb(value: string) {
  return value.toLowerCase() as "requested" | "ready" | "releasing" | "released" | "failed";
}

export function mapToolStatusFromDb(value: string) {
  return value.toLowerCase() as
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "blocked"
    | "canceled";
}

export function mapApprovalStatusFromDb(value: string) {
  return value.toLowerCase() as "pending" | "approved" | "rejected" | "expired";
}

export function mapCapabilityFromDb(value: string) {
  return value.toLowerCase() as "exec" | "read" | "write" | "process" | "browser" | "mcp";
}

export function mapCapabilityToDb(value: "exec" | "read" | "write" | "process" | "browser" | "mcp") {
  return value.toUpperCase() as "EXEC" | "READ" | "WRITE" | "PROCESS" | "BROWSER" | "MCP";
}

export function mapPolicyDecisionToDb(value: "allow" | "ask" | "deny") {
  return value.toUpperCase() as "ALLOW" | "ASK" | "DENY";
}

export function mapPolicyDecisionFromDb(value: string) {
  return value.toLowerCase() as "allow" | "ask" | "deny";
}

export function mapArtifactKindFromDb(value: string) {
  return value.toLowerCase() as
    | "stdout"
    | "stderr"
    | "file"
    | "archive"
    | "screenshot"
    | "json"
    | "trace";
}

export function mapNetworkModeFromDb(value: string) {
  return value.toLowerCase() as ComputeNetworkMode;
}

export function mapFilesystemModeFromDb(value: string) {
  return value.toLowerCase() as ComputeFilesystemMode;
}

export function mapMcpTransportKindFromDb(value: string) {
  return value.toLowerCase() as McpTransportKind;
}

export function mapBrowserTransportKindFromDb(value: string) {
  return value.toLowerCase() as BrowserTransportKind;
}

export function mapBrowserTransportKindToDb(value: BrowserTransportKind) {
  return value.toUpperCase() as
    | "PLAYWRIGHT"
    | "OPENAI_COMPUTER"
    | "CLAUDE_COMPUTER_USE"
    | "OPENCODE_COMPUTER_USE";
}

export function mapBrowserSessionStatusFromDb(value: string) {
  return value.toLowerCase() as "active" | "failed" | "closed";
}

export function mapBrowserNavigationStatusFromDb(value: string) {
  return value.toLowerCase() as "succeeded" | "failed";
}

export function serializeSession(session: {
  id: string;
  representativeId: string;
  representativeVersionId: string | null;
  contactId: string | null;
  conversationId: string | null;
  delegationTaskId: string | null;
  delegationTaskStepId: string | null;
  subagentId: string | null;
  policyProfileId: string | null;
  requestedBy: string;
  status: string;
  leaseStatus: string;
  runnerType: string;
  runnerLeaseId: string | null;
  baseImage: string;
  containerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  leaseAcquiredAt: Date | null;
  leaseLastUsedAt: Date | null;
  leaseReleasedAt: Date | null;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
  expiresAt: Date | null;
  endedAt: Date | null;
  failureReason: string | null;
}) {
  return computeSessionSnapshotSchema.parse({
    id: session.id,
    representativeId: session.representativeId,
    representativeVersionId: session.representativeVersionId,
    contactId: session.contactId,
    conversationId: session.conversationId,
    delegationTaskId: session.delegationTaskId,
    delegationTaskStepId: session.delegationTaskStepId,
    subagentId: session.subagentId
      ? computeSubagentIdSchema.parse(session.subagentId)
      : null,
    policyProfileId: session.policyProfileId,
    requestedBy: mapRequestedByFromDb(session.requestedBy),
    status: mapSessionStatusFromDb(session.status),
    leaseStatus: mapLeaseStatusFromDb(session.leaseStatus),
    runnerType: mapRunnerTypeFromDb(session.runnerType),
    runnerLeaseId: session.runnerLeaseId,
    baseImage: session.baseImage,
    containerId: session.containerId,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    leaseAcquiredAt: session.leaseAcquiredAt?.toISOString() ?? null,
    leaseLastUsedAt: session.leaseLastUsedAt?.toISOString() ?? null,
    leaseReleasedAt: session.leaseReleasedAt?.toISOString() ?? null,
    startedAt: session.startedAt?.toISOString() ?? null,
    lastHeartbeatAt: session.lastHeartbeatAt?.toISOString() ?? null,
    expiresAt: session.expiresAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
    failureReason: session.failureReason,
  });
}

export function serializeExecution(execution: {
  id: string;
  sessionId: string;
  mcpBindingId: string | null;
  capability: string;
  subagentId: string | null;
  status: string;
  requestedCommand: string | null;
  requestedPath: string | null;
  workingDirectory: string | null;
  policyDecision: string | null;
  approvalRequestId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  cpuMs: number | null;
  wallMs: number | null;
  bytesRead: number | null;
  bytesWritten: number | null;
  createdAt: Date;
}) {
  return toolExecutionSnapshotSchema.parse({
    id: execution.id,
    sessionId: execution.sessionId,
    capability: mapCapabilityFromDb(execution.capability),
    subagentId: execution.subagentId
      ? computeSubagentIdSchema.parse(execution.subagentId)
      : null,
    status: mapToolStatusFromDb(execution.status),
    requestedCommand: execution.requestedCommand,
    requestedPath: execution.requestedPath,
    workingDirectory: execution.workingDirectory,
    mcpBindingId: execution.mcpBindingId,
    policyDecision: execution.policyDecision
      ? mapPolicyDecisionFromDb(execution.policyDecision)
      : null,
    approvalRequestId: execution.approvalRequestId,
    startedAt: execution.startedAt?.toISOString() ?? null,
    finishedAt: execution.finishedAt?.toISOString() ?? null,
    exitCode: execution.exitCode,
    cpuMs: execution.cpuMs,
    wallMs: execution.wallMs,
    bytesRead: execution.bytesRead,
    bytesWritten: execution.bytesWritten,
    createdAt: execution.createdAt.toISOString(),
  });
}

export function serializeBrowserNavigation(navigation: {
  id: string;
  toolExecutionId: string;
  status: string;
  transportKind: string;
  requestedUrl: string;
  finalUrl: string | null;
  pageTitle: string | null;
  textSnippet: string | null;
  screenshotArtifactId: string | null;
  jsonArtifactId: string | null;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return browserNavigationSnapshotSchema.parse({
    id: navigation.id,
    toolExecutionId: navigation.toolExecutionId,
    status: mapBrowserNavigationStatusFromDb(navigation.status),
    transportKind: mapBrowserTransportKindFromDb(navigation.transportKind),
    requestedUrl: navigation.requestedUrl,
    finalUrl: navigation.finalUrl,
    pageTitle: navigation.pageTitle,
    textSnippet: navigation.textSnippet,
    screenshotArtifactId: navigation.screenshotArtifactId,
    jsonArtifactId: navigation.jsonArtifactId,
    errorMessage: navigation.errorMessage,
    createdAt: navigation.createdAt.toISOString(),
  });
}

export function serializeBrowserSession(session: {
  id: string;
  computeSessionId: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  status: string;
  transportKind: string;
  profilePath: string | null;
  currentUrl: string | null;
  currentTitle: string | null;
  lastToolExecutionId: string | null;
  lastNavigationAt: Date | null;
  closedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  visitCount: number;
  latestNavigation?: ReturnType<typeof serializeBrowserNavigation> | null;
}) {
  return browserSessionSnapshotSchema.parse({
    id: session.id,
    computeSessionId: session.computeSessionId,
    representativeId: session.representativeId,
    contactId: session.contactId,
    conversationId: session.conversationId,
    status: mapBrowserSessionStatusFromDb(session.status),
    transportKind: mapBrowserTransportKindFromDb(session.transportKind),
    profilePath: session.profilePath,
    currentUrl: session.currentUrl,
    currentTitle: session.currentTitle,
    lastToolExecutionId: session.lastToolExecutionId,
    lastNavigationAt: session.lastNavigationAt?.toISOString() ?? null,
    closedAt: session.closedAt?.toISOString() ?? null,
    failureReason: session.failureReason,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    visitCount: session.visitCount,
    latestNavigation: session.latestNavigation ?? null,
  });
}

export function serializeMcpBinding(binding: {
  id: string;
  representativeId: string;
  representativeSkillPackLinkId: string | null;
  slug: string;
  displayName: string;
  description: string | null;
  serverUrl: string;
  transportKind: string;
  allowedToolNames: unknown;
  defaultToolName: string | null;
  enabled: boolean;
  approvalRequired: boolean;
  estimatedCostCentsPerCall: number;
  maxRetries: number;
  retryBackoffMs: number;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return mcpBindingSnapshotSchema.parse({
    id: binding.id,
    representativeId: binding.representativeId,
    representativeSkillPackLinkId: binding.representativeSkillPackLinkId,
    slug: binding.slug,
    displayName: binding.displayName,
    description: binding.description,
    serverUrl: binding.serverUrl,
    transportKind: mapMcpTransportKindFromDb(binding.transportKind),
    allowedToolNames: Array.isArray(binding.allowedToolNames)
      ? binding.allowedToolNames.filter((value): value is string => typeof value === "string")
      : [],
    defaultToolName: binding.defaultToolName,
    enabled: binding.enabled,
    approvalRequired: binding.approvalRequired,
    estimatedCostCentsPerCall: binding.estimatedCostCentsPerCall,
    maxRetries: binding.maxRetries,
    retryBackoffMs: binding.retryBackoffMs,
    consecutiveFailures: binding.consecutiveFailures,
    lastFailureAt: binding.lastFailureAt?.toISOString() ?? null,
    lastFailureReason: binding.lastFailureReason,
    lastSuccessAt: binding.lastSuccessAt?.toISOString() ?? null,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  });
}

export function serializeApprovalRequest(approvalRequest: {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  sessionId: string | null;
  toolExecutionId: string | null;
  generationRunId?: string | null;
  subagentId: string | null;
  status: string;
  reason: string;
  requestedActionSummary: string;
  riskSummary: string;
  requestedAt: Date;
  expiresAt?: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  decisionNote?: string | null;
  requestPayloadHash?: string | null;
  matchedPolicyRuleId?: string | null;
}) {
  return approvalRequestSnapshotSchema.parse({
    id: approvalRequest.id,
    representativeId: approvalRequest.representativeId,
    contactId: approvalRequest.contactId,
    conversationId: approvalRequest.conversationId,
    sessionId: approvalRequest.sessionId,
    toolExecutionId: approvalRequest.toolExecutionId,
    generationRunId: approvalRequest.generationRunId ?? null,
    subagentId:
      approvalRequest.subagentId === "compute-agent" || approvalRequest.subagentId === "browser-agent"
        ? approvalRequest.subagentId
        : null,
    status: mapApprovalStatusFromDb(approvalRequest.status),
    reason: approvalRequest.reason,
    requestedActionSummary: approvalRequest.requestedActionSummary,
    riskSummary: approvalRequest.riskSummary,
    requestedAt: approvalRequest.requestedAt.toISOString(),
    expiresAt: approvalRequest.expiresAt?.toISOString() ?? null,
    resolvedAt: approvalRequest.resolvedAt?.toISOString() ?? null,
    resolvedBy: approvalRequest.resolvedBy,
    decisionNote: approvalRequest.decisionNote ?? null,
    requestPayloadHash: approvalRequest.requestPayloadHash ?? null,
    matchedPolicyRuleId: approvalRequest.matchedPolicyRuleId ?? null,
  });
}

export function serializeArtifact(artifact: {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  sessionId: string | null;
  toolExecutionId: string | null;
  kind: string;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  isPinned: boolean;
  pinnedAt: Date | null;
  pinnedBy: string | null;
  downloadCount: number;
  lastDownloadedAt: Date | null;
  retentionUntil: Date | null;
  summary: string | null;
  createdAt: Date;
}) {
  return artifactSnapshotSchema.parse({
    id: artifact.id,
    representativeId: artifact.representativeId,
    contactId: artifact.contactId,
    conversationId: artifact.conversationId,
    sessionId: artifact.sessionId,
    toolExecutionId: artifact.toolExecutionId,
    kind: mapArtifactKindFromDb(artifact.kind),
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
  });
}

export function serializeCapabilityProfile(profile: {
  id: string;
  representativeId: string | null;
  ownerId: string | null;
  organizationId: string | null;
  customerAccountId: string | null;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  isManaged: boolean;
  managedScope: string;
  managedSource: string | null;
  editableByOwner: boolean;
  contactTrustTierCondition: string | null;
  precedence: number;
  defaultDecision: string;
  maxSessionMinutes: number;
  maxParallelSessions: number;
  maxCommandSeconds: number;
  artifactRetentionDays: number;
  networkMode: string;
  networkAllowlist: string[];
  filesystemMode: string;
  rules: Array<{
    id: string;
    capability: string;
    decision: string;
    commandPattern: string | null;
    pathPattern: string | null;
    domainPattern: string | null;
    resourceScopeCondition: string | null;
    channelCondition: string | null;
    requiredPlanTier: string | null;
    maxCostCents: number | null;
    requiresPaidPlan: boolean;
    requiresHumanApproval: boolean;
    priority: number;
  }>;
}) {
  return capabilityPolicyProfileSchema.parse({
    id: profile.id,
    representativeId: profile.representativeId,
    ownerId: profile.ownerId,
    organizationId: profile.organizationId,
    customerAccountId: profile.customerAccountId,
    name: profile.name,
    isDefault: profile.isDefault,
    enabled: profile.enabled,
    isManaged: profile.isManaged,
    managedScope: profile.managedScope.toLowerCase() as
      | "representative_default"
      | "delegate_managed"
      | "owner_managed"
      | "customer_trust_tier"
      | "org_managed"
      | "customer_account",
    ...(profile.managedSource ? { managedSource: profile.managedSource } : {}),
    editableByOwner: profile.editableByOwner,
    ...(profile.contactTrustTierCondition
      ? {
          contactTrustTierCondition: profile.contactTrustTierCondition.toLowerCase() as
            | "standard"
            | "verified"
            | "vip"
            | "restricted",
        }
      : {}),
    precedence: profile.precedence,
    defaultDecision: mapPolicyDecisionFromDb(profile.defaultDecision),
    maxSessionMinutes: profile.maxSessionMinutes,
    maxParallelSessions: profile.maxParallelSessions,
    maxCommandSeconds: profile.maxCommandSeconds,
    artifactRetentionDays: profile.artifactRetentionDays,
    networkMode: mapNetworkModeFromDb(profile.networkMode),
    networkAllowlist: profile.networkAllowlist,
    filesystemMode: mapFilesystemModeFromDb(profile.filesystemMode),
    rules: profile.rules.map((rule) => ({
      id: rule.id,
      capability: mapCapabilityFromDb(rule.capability),
      decision: mapPolicyDecisionFromDb(rule.decision),
      ...(rule.commandPattern ? { commandPattern: rule.commandPattern } : {}),
      ...(rule.pathPattern ? { pathPattern: rule.pathPattern } : {}),
      ...(rule.domainPattern ? { domainPattern: rule.domainPattern } : {}),
      ...(rule.resourceScopeCondition
        ? {
            resourceScopeCondition: rule.resourceScopeCondition.toLowerCase() as
              | "workspace"
              | "remote_mcp"
              | "browser_lane"
              | "artifact_store",
          }
        : {}),
      ...(rule.channelCondition
        ? { channelCondition: rule.channelCondition.toLowerCase() as any }
        : {}),
      ...(rule.requiredPlanTier
        ? { requiredPlanTier: rule.requiredPlanTier.toLowerCase() as any }
        : {}),
      ...(typeof rule.maxCostCents === "number" ? { maxCostCents: rule.maxCostCents } : {}),
      requiresPaidPlan: rule.requiresPaidPlan,
      requiresHumanApproval: rule.requiresHumanApproval,
      priority: rule.priority,
    })),
  });
}
