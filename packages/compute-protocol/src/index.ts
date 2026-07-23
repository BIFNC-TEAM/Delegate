import { z } from "zod";

export const capabilityKindSchema = z.enum([
  "exec",
  "read",
  "write",
  "process",
  "browser",
  "mcp",
]);
export const computeSubagentIdSchema = z.enum([
  "compute-agent",
  "browser-agent",
]);
export const capabilityPlanTierSchema = z.enum(["pass", "deep_help"]);
export const policyDecisionSchema = z.enum(["allow", "ask", "deny"]);
export const managedPolicyScopeSchema = z.enum([
  "representative_default",
  "delegate_managed",
  "owner_managed",
  "customer_trust_tier",
  "org_managed",
  "customer_account",
]);
export const contactComputeTrustTierSchema = z.enum([
  "standard",
  "verified",
  "vip",
  "restricted",
]);
export const policyResourceScopeSchema = z.enum([
  "workspace",
  "remote_mcp",
  "browser_lane",
  "artifact_store",
]);
export const mcpTransportKindSchema = z.enum(["streamable_http", "sse"]);
export const policyChannelSchema = z.enum([
  "private_chat",
  "group_mention",
  "group_reply",
  "channel_entry",
]);
export const computeSessionStatusSchema = z.enum([
  "requested",
  "starting",
  "running",
  "idle",
  "stopping",
  "completed",
  "failed",
  "expired",
]);
export const computeLeaseStatusSchema = z.enum([
  "requested",
  "ready",
  "releasing",
  "released",
  "failed",
]);
export const toolExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "canceled",
]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const artifactKindSchema = z.enum([
  "stdout",
  "stderr",
  "file",
  "archive",
  "screenshot",
  "json",
  "trace",
]);
export const deliverableKindSchema = z.enum([
  "deck",
  "case_study",
  "download",
  "generated_document",
  "package",
]);
export const deliverableVisibilitySchema = z.enum(["owner_only", "public_material"]);
export const deliverableSourceKindSchema = z.enum(["artifact", "external_link", "bundle"]);
export const deliverablePackagingPresetKeySchema = z.enum([
  "deck",
  "package",
  "case_study",
  "download_pack",
  "generated_document",
]);
export const maxDeliverableBundleItems = 20;
export const computeRequestedBySchema = z.enum(["system", "owner", "audience"]);
export const computeRunnerTypeSchema = z.enum(["docker", "vm"]);
export const computeNetworkModeSchema = z.enum(["no_network", "allowlist", "full"]);
export const computeFilesystemModeSchema = z.enum([
  "workspace_only",
  "read_only_workspace",
  "ephemeral_full",
]);
export const computeNetworkAllowlistSchema = z
  .array(z.string().trim().min(1))
  .max(50)
  .default([]);
export const computeExecutionOutcomeSchema = z.enum([
  "completed",
  "failed",
  "blocked",
  "pending_approval",
]);
export const browserTransportKindSchema = z.enum([
  "playwright",
  "openai_computer",
  "claude_computer_use",
  "opencode_computer_use",
]);
export const browserExecutionModeSchema = z.enum([
  "deterministic",
  "native",
]);
export const nativeComputerProviderSchema = z.enum(["openai", "anthropic", "opencode"]);
export const nativeComputerProviderStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing_credentials",
  "missing_model",
  "missing_sandbox",
]);
export const nativeComputerUsePreflightStateSchema = z.enum([
  "ready",
  "no_browser_session",
  "missing_screenshot",
  "no_ready_providers",
]);
export const browserSessionStatusSchema = z.enum(["active", "failed", "closed"]);
export const browserNavigationStatusSchema = z.enum(["succeeded", "failed"]);

export const capabilityPolicyRuleSchema = z.object({
  id: z.string(),
  capability: capabilityKindSchema,
  decision: policyDecisionSchema,
  commandPattern: z.string().optional(),
  pathPattern: z.string().optional(),
  domainPattern: z.string().optional(),
  resourceScopeCondition: policyResourceScopeSchema.optional(),
  channelCondition: policyChannelSchema.optional(),
  requiredPlanTier: capabilityPlanTierSchema.optional(),
  maxCostCents: z.number().int().nonnegative().optional(),
  requiresPaidPlan: z.boolean().default(false),
  requiresHumanApproval: z.boolean().default(false),
  priority: z.number().int(),
});

export const capabilityPolicyProfileSchema = z.object({
  id: z.string(),
  representativeId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  organizationId: z.string().nullable().optional(),
  customerAccountId: z.string().nullable().optional(),
  name: z.string(),
  isDefault: z.boolean(),
  enabled: z.boolean().default(true),
  isManaged: z.boolean().default(false),
  managedScope: managedPolicyScopeSchema.default("representative_default"),
  managedSource: z.string().optional(),
  editableByOwner: z.boolean().default(false),
  contactTrustTierCondition: contactComputeTrustTierSchema.optional(),
  precedence: z.number().int().default(0),
  defaultDecision: policyDecisionSchema,
  maxSessionMinutes: z.number().int().positive(),
  maxParallelSessions: z.number().int().positive(),
  maxCommandSeconds: z.number().int().positive(),
  artifactRetentionDays: z.number().int().positive(),
  networkMode: computeNetworkModeSchema,
  networkAllowlist: computeNetworkAllowlistSchema,
  filesystemMode: computeFilesystemModeSchema,
  rules: z.array(capabilityPolicyRuleSchema).default([]),
});

export const ownerManagedOverlayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  browserDecision: policyDecisionSchema,
  browserRequiresApproval: z.boolean().default(true),
  mcpDecision: policyDecisionSchema,
  mcpRequiresApproval: z.boolean().default(true),
  requiredPlanTier: capabilityPlanTierSchema.default("pass"),
});

export const ownerManagedPolicyOverlaysSchema = z.object({
  baseline: ownerManagedOverlayConfigSchema,
  trustedCustomer: ownerManagedOverlayConfigSchema.extend({
    trustTier: contactComputeTrustTierSchema.default("verified"),
  }),
});

export const governanceContactAssignmentSchema = z.object({
  contactId: z.string(),
  displayName: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  computeTrustTier: contactComputeTrustTierSchema.nullable().optional(),
  customerAccountId: z.string().nullable().optional(),
  customerAccountSlug: z.string().nullable().optional(),
});

export const customerAccountOverlaySchema = ownerManagedOverlayConfigSchema.extend({
  id: z.string().nullable().optional(),
  slug: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  contactIds: z.array(z.string()).max(50).default([]),
});

export const organizationGovernanceOverlaysSchema = z.object({
  organization: z.object({
    id: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  }),
  organizationBaseline: ownerManagedOverlayConfigSchema,
  customerAccounts: z.array(customerAccountOverlaySchema).max(12).default([]),
  contactAssignments: z.array(governanceContactAssignmentSchema).max(100).default([]),
});

const computeSubagentAllowedCapabilities = {
  "compute-agent": ["exec", "read", "write", "process", "mcp"],
  "browser-agent": ["browser"],
} as const satisfies Record<z.infer<typeof computeSubagentIdSchema>, readonly z.infer<typeof capabilityKindSchema>[]>;

const computeSubagentBudgetCredits = {
  "compute-agent": 24,
  "browser-agent": 48,
} as const satisfies Record<z.infer<typeof computeSubagentIdSchema>, number>;

function refineSubagentCapabilityBoundary<T extends z.ZodTypeAny>(
  schema: T,
  getShape: (value: z.infer<T>) => {
    subagentId?: z.infer<typeof computeSubagentIdSchema>;
    capabilities: z.infer<typeof capabilityKindSchema>[];
  },
) {
  return schema.superRefine((value, ctx) => {
    if (!value || typeof value !== "object") {
      return;
    }

    const shape = getShape(value as z.infer<T>);
    if (!shape.subagentId) {
      return;
    }

    const allowed = new Set(computeSubagentAllowedCapabilities[shape.subagentId]);
    for (const capability of shape.capabilities) {
      if (!allowed.has(capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Subagent ${shape.subagentId} cannot execute capability ${capability}.`,
          path: ["subagentId"],
        });
        break;
      }
    }
  });
}

export const createComputeSessionRequestSchema = refineSubagentCapabilityBoundary(z.object({
  representativeId: z.string(),
  contactId: z.string().optional(),
  conversationId: z.string().optional(),
  generationRunId: z.string().optional(),
  delegationTaskId: z.string().optional(),
  delegationTaskStepId: z.string().optional(),
  subagentId: computeSubagentIdSchema,
  requestedBy: computeRequestedBySchema,
  requestedCapabilities: z.array(capabilityKindSchema).min(1),
  reason: z.string().min(1),
  requestedBaseImage: z.string().optional(),
}), (value) => ({
  subagentId: value.subagentId,
  capabilities: value.requestedCapabilities,
}));

export const computeSessionLeaseSchema = z.object({
  sessionId: z.string(),
  status: computeSessionStatusSchema,
  leaseStatus: computeLeaseStatusSchema,
  runnerType: computeRunnerTypeSchema,
  baseImage: z.string(),
  leaseToken: z.string(),
  leaseId: z.string().nullable().optional(),
  expiresAt: z.string().datetime().optional(),
  leaseAcquiredAt: z.string().datetime().nullable().optional(),
  leaseReleasedAt: z.string().datetime().nullable().optional(),
});

export const computeSessionSnapshotSchema = z.object({
  id: z.string(),
  representativeId: z.string(),
  representativeVersionId: z.string().nullable().optional(),
  contactId: z.string().nullable(),
  conversationId: z.string().nullable(),
  delegationTaskId: z.string().nullable(),
  delegationTaskStepId: z.string().nullable(),
  subagentId: computeSubagentIdSchema.nullable(),
  policyProfileId: z.string().nullable(),
  requestedBy: computeRequestedBySchema,
  status: computeSessionStatusSchema,
  leaseStatus: computeLeaseStatusSchema,
  runnerType: computeRunnerTypeSchema,
  runnerLeaseId: z.string().nullable(),
  baseImage: z.string(),
  containerId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  leaseAcquiredAt: z.string().datetime().nullable(),
  leaseLastUsedAt: z.string().datetime().nullable(),
  leaseReleasedAt: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastHeartbeatAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  failureReason: z.string().nullable(),
});

export const browserNavigationSnapshotSchema = z.object({
  id: z.string(),
  toolExecutionId: z.string(),
  status: browserNavigationStatusSchema,
  transportKind: browserTransportKindSchema,
  requestedUrl: z.string().url(),
  finalUrl: z.string().url().nullable(),
  pageTitle: z.string().nullable(),
  textSnippet: z.string().nullable(),
  screenshotArtifactId: z.string().nullable(),
  jsonArtifactId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const browserSessionSnapshotSchema = z.object({
  id: z.string(),
  computeSessionId: z.string(),
  representativeId: z.string(),
  contactId: z.string().nullable(),
  conversationId: z.string().nullable(),
  status: browserSessionStatusSchema,
  transportKind: browserTransportKindSchema,
  profilePath: z.string().nullable(),
  currentUrl: z.string().url().nullable(),
  currentTitle: z.string().nullable(),
  lastToolExecutionId: z.string().nullable(),
  lastNavigationAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  visitCount: z.number().int().nonnegative(),
  latestNavigation: browserNavigationSnapshotSchema.nullable(),
});

export const nativeComputerProviderSnapshotSchema = z.object({
  provider: nativeComputerProviderSchema,
  status: nativeComputerProviderStatusSchema,
  enabled: z.boolean(),
  model: z.string().nullable().optional(),
  transportKind: browserTransportKindSchema,
  reason: z.string().nullable().optional(),
});

export const nativeComputerUsePreflightSnapshotSchema = z.object({
  state: nativeComputerUsePreflightStateSchema,
  sessionId: z.string().nullable(),
  browserSessionId: z.string().nullable(),
  browserTransportKind: browserTransportKindSchema.nullable().optional(),
  preferredProvider: nativeComputerProviderSchema.nullable().optional(),
  targetTransportKind: browserTransportKindSchema.nullable().optional(),
  currentUrl: z.string().url().nullable().optional(),
  currentTitle: z.string().nullable().optional(),
  latestNavigationId: z.string().nullable().optional(),
  latestNavigationAt: z.string().datetime().nullable().optional(),
  latestRequestedUrl: z.string().url().nullable().optional(),
  latestFinalUrl: z.string().url().nullable().optional(),
  latestTextSnippet: z.string().nullable().optional(),
  latestScreenshotArtifactId: z.string().nullable().optional(),
  latestJsonArtifactId: z.string().nullable().optional(),
  requiresApprovalForMutations: z.boolean(),
  supportsSessionReuse: z.boolean(),
  providerReadiness: z.array(nativeComputerProviderSnapshotSchema),
  nextStep: z.string(),
});

export const createComputeSessionResponseSchema = z.object({
  session: computeSessionSnapshotSchema,
  lease: computeSessionLeaseSchema,
});

export const terminateComputeSessionRequestSchema = z.object({
  reason: z.string().min(1).optional(),
});

export const heartbeatComputeSessionRequestSchema = z.object({
  reason: z.string().min(1).optional(),
});

export const heartbeatComputeSessionResponseSchema = z.object({
  session: computeSessionSnapshotSchema,
});

export const toolExecutionRequestSchema = refineSubagentCapabilityBoundary(z.object({
  capability: capabilityKindSchema,
  subagentId: computeSubagentIdSchema,
  command: z.string().min(1).optional(),
  content: z.string().optional(),
  path: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  url: z.string().url().optional(),
  bindingId: z.string().min(1).optional(),
  bindingSlug: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  toolArguments: z.record(z.string(), z.unknown()).optional(),
  workingDirectory: z.string().min(1).optional(),
  estimatedCostCents: z.number().int().nonnegative().optional(),
  hasPaidEntitlement: z.boolean().default(false),
  browserMode: browserExecutionModeSchema.default("deterministic"),
  task: z.string().min(1).optional(),
  nativeProvider: nativeComputerProviderSchema.optional(),
  maxSteps: z.number().int().positive().max(8).default(3),
  allowMutations: z.boolean().default(false),
}), (value) => ({
  subagentId: value.subagentId,
  capabilities: [value.capability],
}));

export const nativeComputerUseExecutionRequestSchema = z.object({
  sessionId: z.string().min(1),
  task: z.string().trim().min(1),
  provider: nativeComputerProviderSchema.optional(),
  maxSteps: z.number().int().positive().max(8).default(3),
  allowMutations: z.boolean().default(false),
});

export const mcpBindingSnapshotSchema = z.object({
  id: z.string(),
  representativeId: z.string(),
  representativeSkillPackLinkId: z.string().nullable().optional(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  serverUrl: z.string().url(),
  transportKind: mcpTransportKindSchema,
  allowedToolNames: z.array(z.string().min(1)),
  defaultToolName: z.string().nullable().optional(),
  enabled: z.boolean(),
  approvalRequired: z.boolean(),
  estimatedCostCentsPerCall: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().min(0).max(5).default(0),
  retryBackoffMs: z.number().int().min(100).max(30_000).default(1000),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  lastFailureAt: z.string().datetime().nullable().optional(),
  lastFailureReason: z.string().nullable().optional(),
  lastSuccessAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const mcpServerUrlSchema = z.string().trim().max(2048).url().superRefine((value, ctx) => {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$|\.$/gu, "");
  if (
    url.protocol !== "https:"
    || Boolean(url.username)
    || Boolean(url.password)
    || isClearlyNonPublicHostname(hostname)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "MCP serverUrl must be a credential-free public HTTPS endpoint.",
    });
  }
});

const mcpBindingFieldsSchema = z.object({
  representativeSkillPackLinkId: z.string().trim().min(1).max(128).optional(),
  slug: z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u),
  displayName: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000).optional(),
  serverUrl: mcpServerUrlSchema,
  transportKind: mcpTransportKindSchema.default("streamable_http"),
  allowedToolNames: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
  defaultToolName: z.string().trim().min(1).max(128).optional(),
  enabled: z.boolean().default(true),
  approvalRequired: z.boolean().default(true),
  estimatedCostCentsPerCall: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().min(0).max(5).default(0),
  retryBackoffMs: z.number().int().min(100).max(30_000).default(1000),
});

export function ipv4MappedAddressToIpv4(address: string): string | null {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!normalized.includes(":")) return null;

  const compressedParts = normalized.split("::");
  if (compressedParts.length > 2) return null;
  const left = parseIpv6Words(compressedParts[0] ?? "");
  const right = parseIpv6Words(compressedParts[1] ?? "");
  if (!left || !right) return null;

  let words: number[];
  if (compressedParts.length === 2) {
    const missingWordCount = 8 - left.length - right.length;
    if (missingWordCount < 1) return null;
    words = [...left, ...Array<number>(missingWordCount).fill(0), ...right];
  } else {
    words = left;
  }
  if (
    words.length !== 8
    || words.slice(0, 5).some((word) => word !== 0)
    || words[5] !== 0xffff
  ) {
    return null;
  }

  const high = words[6]!;
  const low = words[7]!;
  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

function parseIpv6Words(value: string): number[] | null {
  if (!value) return [];
  const tokens = value.split(":");
  const words: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token) return null;
    if (token.includes(".")) {
      if (index !== tokens.length - 1) return null;
      const octets = token.split(".");
      if (
        octets.length !== 4
        || octets.some((octet) => !/^\d{1,3}$/u.test(octet))
      ) {
        return null;
      }
      const values = octets.map(Number);
      if (values.some((octet) => octet > 255)) return null;
      words.push((values[0]! << 8) | values[1]!, (values[2]! << 8) | values[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(token)) return null;
    words.push(Number.parseInt(token, 16));
  }
  return words;
}

function isClearlyNonPublicHostname(hostname: string) {
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
  ) {
    return true;
  }
  const mappedIpv4 = ipv4MappedAddressToIpv4(hostname);
  if (mappedIpv4) {
    return isClearlyNonPublicHostname(mappedIpv4);
  }
  if (hostname.includes(":")) {
    return hostname === "::"
      || hostname === "::1"
      || hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || /^fe[89ab]/u.test(hostname)
      || hostname.startsWith("ff");
  }
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second! >= 64 && second! <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first! >= 224;
}

function refineMcpBindingSchema<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value, ctx) => {
    if (!value || typeof value !== "object") {
      return;
    }

    const record = value as {
      allowedToolNames?: string[];
      defaultToolName?: string;
    };
    if (!Array.isArray(record.allowedToolNames)) {
      return;
    }

    const deduped = new Set(record.allowedToolNames);
    if (deduped.size !== record.allowedToolNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed tool names must be unique.",
        path: ["allowedToolNames"],
      });
    }

    if (record.defaultToolName && !deduped.has(record.defaultToolName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Default tool must also appear in allowed tool names.",
        path: ["defaultToolName"],
      });
    }
  });
}

export const upsertMcpBindingRequestSchema = refineMcpBindingSchema(mcpBindingFieldsSchema);

export const updateMcpBindingRequestSchema = refineMcpBindingSchema(
  mcpBindingFieldsSchema.extend({
    transportKind: mcpTransportKindSchema,
    enabled: z.boolean(),
    approvalRequired: z.boolean(),
    estimatedCostCentsPerCall: z.number().int().nonnegative(),
    maxRetries: z.number().int().min(0).max(5),
    retryBackoffMs: z.number().int().min(100).max(30_000),
  }).partial().extend({
    expectedUpdatedAt: z.string().datetime(),
  }),
).refine(
  (value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"),
  {
    message: "At least one MCP binding field is required.",
  },
);

export const approvalRequestSnapshotSchema = z.object({
  id: z.string(),
  representativeId: z.string(),
  contactId: z.string().nullable(),
  conversationId: z.string().nullable(),
  sessionId: z.string().nullable(),
  toolExecutionId: z.string().nullable(),
  generationRunId: z.string().nullable().optional(),
  subagentId: computeSubagentIdSchema.nullable().optional(),
  status: approvalStatusSchema,
  reason: z.string(),
  requestedActionSummary: z.string(),
  riskSummary: z.string(),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().optional(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedBy: z.string().nullable(),
  decisionNote: z.string().nullable().optional(),
  requestPayloadHash: z.string().nullable().optional(),
  matchedPolicyRuleId: z.string().nullable().optional(),
});

export const resolveApprovalRequestSchema = z.object({
  resolution: z.enum(["approved", "rejected"]),
  resolvedBy: z.string().trim().min(1).optional(),
  decisionNote: z.string().trim().max(1000).optional(),
});

export const artifactSnapshotSchema = z.object({
  id: z.string(),
  representativeId: z.string(),
  contactId: z.string().nullable(),
  conversationId: z.string().nullable(),
  sessionId: z.string().nullable(),
  toolExecutionId: z.string().nullable(),
  kind: artifactKindSchema,
  bucket: z.string(),
  objectKey: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  isPinned: z.boolean().default(false),
  pinnedAt: z.string().datetime().nullable(),
  pinnedBy: z.string().nullable(),
  downloadCount: z.number().int().nonnegative().default(0),
  lastDownloadedAt: z.string().datetime().nullable(),
  retentionUntil: z.string().datetime().nullable(),
  summary: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const updateArtifactRequestSchema = z.object({
  pinned: z.boolean(),
  pinnedBy: z.string().trim().min(1).optional(),
});

export const updateArtifactResponseSchema = z.object({
  artifact: artifactSnapshotSchema,
});

export const deliverableSnapshotSchema = z.object({
  id: z.string(),
  representativeId: z.string(),
  artifactId: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  kind: deliverableKindSchema,
  visibility: deliverableVisibilitySchema,
  sourceKind: deliverableSourceKindSchema,
  externalUrl: z.string().url().nullable(),
  bundleItemArtifactIds: z.array(z.string()).default([]),
  downloadCount: z.number().int().nonnegative().default(0),
  lastDownloadedAt: z.string().datetime().nullable(),
  packageBuiltAt: z.string().datetime().nullable(),
  packageSizeBytes: z.number().int().nonnegative().nullable(),
  hasCachedPackage: z.boolean().default(false),
  createdBy: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const deliverableFieldsSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  kind: deliverableKindSchema,
  visibility: deliverableVisibilitySchema.default("owner_only"),
  sourceKind: deliverableSourceKindSchema,
  artifactId: z.string().trim().min(1).optional(),
  externalUrl: z.string().url().optional(),
  bundleItemArtifactIds: z.array(z.string().trim().min(1)).max(maxDeliverableBundleItems).default([]),
  createdBy: z.string().trim().min(1).optional(),
});

function refineDeliverableSchema<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value, ctx) => {
    if (!value || typeof value !== "object") {
      return;
    }

    const record = value as {
      sourceKind?: "artifact" | "external_link" | "bundle";
      artifactId?: string;
      externalUrl?: string;
      bundleItemArtifactIds?: string[];
    };

    if (record.sourceKind === "artifact" && !record.artifactId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifactId is required for artifact-backed deliverables.",
        path: ["artifactId"],
      });
    }

    if (record.sourceKind === "external_link" && !record.externalUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "externalUrl is required for external-link deliverables.",
        path: ["externalUrl"],
      });
    }

    if (record.sourceKind === "bundle" && (!Array.isArray(record.bundleItemArtifactIds) || record.bundleItemArtifactIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bundleItemArtifactIds are required for bundle deliverables.",
        path: ["bundleItemArtifactIds"],
      });
    }
  });
}

export const upsertDeliverableRequestSchema = refineDeliverableSchema(deliverableFieldsSchema);

export const updateDeliverableRequestSchema = refineDeliverableSchema(
  deliverableFieldsSchema.partial(),
).refine((value) => Object.keys(value).length > 0, {
  message: "At least one deliverable field is required.",
});

export const listDeliverablesResponseSchema = z.object({
  representative: z.object({
    slug: z.string(),
    displayName: z.string(),
  }),
  deliverables: z.array(deliverableSnapshotSchema),
});

export const deliverablePackagingPresetSnapshotSchema = z.object({
  key: deliverablePackagingPresetKeySchema,
  kind: deliverableKindSchema,
  visibility: deliverableVisibilitySchema,
  sourceKind: deliverableSourceKindSchema,
  title: z.string(),
  summary: z.string(),
  recommendedPublicMaterial: z.boolean(),
  suggestedArtifactKinds: z.array(artifactKindSchema),
  bundleItemArtifactIds: z.array(z.string()).default([]),
  artifactId: z.string().nullable().optional(),
});

export const listDeliverablePackagingPresetsResponseSchema = z.object({
  representative: z.object({
    slug: z.string(),
    displayName: z.string(),
  }),
  presets: z.array(deliverablePackagingPresetSnapshotSchema),
});

export const representativeDeliverableInsightsSnapshotSchema = z.object({
  representative: z.object({
    slug: z.string(),
    displayName: z.string(),
  }),
  summary: z.object({
    totalDeliverables: z.number().int().nonnegative(),
    publicMaterials: z.number().int().nonnegative(),
    totalDownloads: z.number().int().nonnegative(),
    bundlePackageDownloads: z.number().int().nonnegative(),
    pinnedArtifactsReused: z.number().int().nonnegative(),
  }),
  byKind: z.array(
    z.object({
      key: deliverableKindSchema,
      count: z.number().int().nonnegative(),
      totalDownloads: z.number().int().nonnegative(),
    }),
  ),
  bySourceKind: z.array(
    z.object({
      key: deliverableSourceKindSchema,
      count: z.number().int().nonnegative(),
      totalDownloads: z.number().int().nonnegative(),
    }),
  ),
  byVisibility: z.array(
    z.object({
      key: deliverableVisibilitySchema,
      count: z.number().int().nonnegative(),
      totalDownloads: z.number().int().nonnegative(),
    }),
  ),
  topDeliverables: z.object({
    mostDownloaded: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        downloadCount: z.number().int().nonnegative(),
        visibility: deliverableVisibilitySchema,
      }),
    ),
    mostRecentlyDownloaded: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        lastDownloadedAt: z.string().datetime(),
        downloadCount: z.number().int().nonnegative(),
      }),
    ),
    mostRecentlyUpdated: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        updatedAt: z.string().datetime(),
      }),
    ),
  }),
  artifactReuseHotspots: z.array(
    z.object({
      artifactId: z.string(),
      artifactKind: artifactKindSchema,
      reuseCount: z.number().int().nonnegative(),
      isPinned: z.boolean(),
    }),
  ),
  packageHealth: z.object({
    cachedPackageCount: z.number().int().nonnegative(),
    stalePackageCount: z.number().int().nonnegative(),
    oversizedBundleAttempts: z.number().int().nonnegative(),
  }),
});

export const resourceGovernanceLayerSchema = z.enum([
  "delegate_managed",
  "owner_managed",
  "org_managed",
  "customer_account",
  "unassigned_default",
]);

const resourceGovernanceCustomerRefSchema = z.object({
  key: z.string(),
  slug: z.string(),
  displayName: z.string(),
  isUnassigned: z.boolean(),
});

export const representativeResourceGovernanceSnapshotSchema = z.object({
  representative: z.object({
    slug: z.string(),
    displayName: z.string(),
  }),
  summary: z.object({
    artifactCount: z.number().int().nonnegative(),
    pinnedArtifacts: z.number().int().nonnegative(),
    orgOrCustomerGovernedArtifacts: z.number().int().nonnegative(),
    artifactOwnerOnlyActionCount: z.number().int().nonnegative(),
    deliverableCount: z.number().int().nonnegative(),
    publicMaterials: z.number().int().nonnegative(),
    ownerOnlyDeliverables: z.number().int().nonnegative(),
    cachedPackages: z.number().int().nonnegative(),
    orgOrCustomerGovernedDeliverables: z.number().int().nonnegative(),
    deliverableOwnerOnlyActionCount: z.number().int().nonnegative(),
  }),
  byGovernanceLayer: z.array(
    z.object({
      key: resourceGovernanceLayerSchema,
      label: z.string(),
      artifactCount: z.number().int().nonnegative(),
      deliverableCount: z.number().int().nonnegative(),
      resourceCount: z.number().int().nonnegative(),
    }),
  ),
  byCustomerAccount: z.array(
    z.object({
      key: z.string(),
      slug: z.string(),
      displayName: z.string(),
      isUnassigned: z.boolean(),
      visibleArtifactCount: z.number().int().nonnegative(),
      deliverableCount: z.number().int().nonnegative(),
      publicMaterialCount: z.number().int().nonnegative(),
      restrictedActionCount: z.number().int().nonnegative(),
    }),
  ),
  riskyActions: z.object({
    packageRebuildsRequireOwner: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        layer: resourceGovernanceLayerSchema,
      }),
    ),
    publicMaterialFlipsRequireOwner: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        layer: resourceGovernanceLayerSchema,
      }),
    ),
    blockedArtifactUnpins: z.array(
      z.object({
        artifactId: z.string(),
        deliverableTitles: z.array(z.string()),
        layer: resourceGovernanceLayerSchema,
      }),
    ),
  }),
  hygiene: z.object({
    missingCustomerContextCount: z.number().int().nonnegative(),
    ambiguousGovernanceCount: z.number().int().nonnegative(),
    publicDeliverablesWithoutAttributionCount: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        detail: z.string(),
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
  artifacts: z.array(
    z.object({
      id: z.string(),
      kind: artifactKindSchema,
      customerAccount: resourceGovernanceCustomerRefSchema,
      primaryLayer: resourceGovernanceLayerSchema,
      layers: z.array(resourceGovernanceLayerSchema),
      ownerOnlyActions: z.array(z.string()),
      restrictedActions: z.array(z.string()),
      blockedUnpinByDeliverable: z.boolean(),
      dependentDeliverableCount: z.number().int().nonnegative(),
    }),
  ),
  deliverables: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      kind: deliverableKindSchema,
      visibility: deliverableVisibilitySchema,
      sourceKind: deliverableSourceKindSchema,
      customerAccounts: z.array(resourceGovernanceCustomerRefSchema),
      primaryLayer: resourceGovernanceLayerSchema,
      layers: z.array(resourceGovernanceLayerSchema),
      ownerOnlyActions: z.array(z.string()),
      restrictedActions: z.array(z.string()),
      customerDownloadEligible: z.boolean(),
      packageDeliveryEligible: z.boolean(),
      ambiguousCustomerContext: z.boolean(),
      hasCachedPackage: z.boolean(),
    }),
  ),
});

export const governedActionKindSchema = z.enum([
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
  "billing_credit",
]);

export const governedActionOutcomeSchema = z.enum([
  "allow",
  "ask",
  "deny",
  "approved",
  "rejected",
  "expired",
  "blocked",
  "completed",
]);

export const governedActionActorKindSchema = z.enum([
  "owner",
  "team_member",
  "system",
  "audience",
  "workflow",
  "external",
  "unknown",
]);

export const governedActionResourceKindSchema = z.enum([
  "tool_execution",
  "approval_request",
  "artifact",
  "deliverable",
  "ledger_entry",
]);

export const governedActionBillingBreakdownKeySchema = z.enum([
  "compute",
  "storage",
  "browser",
  "mcp",
  "model",
  "egress",
  "plan_debit",
  "sponsor_credit",
  "other",
]);

const governedActionRecordSchema = z.object({
  id: z.string(),
  actionKind: governedActionKindSchema,
  actor: z.object({
    key: z.string(),
    label: z.string(),
    kind: governedActionActorKindSchema,
  }),
  target: z.object({
    resourceKind: governedActionResourceKindSchema,
    id: z.string(),
  }),
  primaryGovernanceLayer: resourceGovernanceLayerSchema,
  customerAccount: resourceGovernanceCustomerRefSchema,
  subagentId: computeSubagentIdSchema.nullable().optional(),
  policyOutcome: policyDecisionSchema.nullable().optional(),
  approvalStatus: approvalStatusSchema.nullable().optional(),
  workflowStatus: z.string().nullable().optional(),
  outcome: governedActionOutcomeSchema,
  ownerRequired: z.boolean(),
  publicMaterialAffecting: z.boolean(),
  hasBillingImpact: z.boolean(),
  totalCostCents: z.number().int(),
  totalCreditDelta: z.number().int(),
  occurredAt: z.string().datetime(),
  summary: z.string(),
  links: z.object({
    approvalId: z.string().nullable().optional(),
    toolExecutionId: z.string().nullable().optional(),
    artifactId: z.string().nullable().optional(),
    deliverableId: z.string().nullable().optional(),
    ledgerEntryIds: z.array(z.string()),
  }),
});

export const representativeGovernedActionSnapshotSchema = z.object({
  representative: z.object({
    slug: z.string(),
    displayName: z.string(),
  }),
  summary: z.object({
    totalGovernedActions: z.number().int().nonnegative(),
    actionsRequiringOwner: z.number().int().nonnegative(),
    actionsResolvedAutomatically: z.number().int().nonnegative(),
    blockedOrDeniedActions: z.number().int().nonnegative(),
    actionsWithBillingImpact: z.number().int().nonnegative(),
    actionsAffectingPublicMaterials: z.number().int().nonnegative(),
  }),
  byActionKind: z.array(
    z.object({
      key: governedActionKindSchema,
      count: z.number().int().nonnegative(),
      blockedCount: z.number().int().nonnegative(),
      ownerRequiredCount: z.number().int().nonnegative(),
      billingImpactCount: z.number().int().nonnegative(),
      totalCostCents: z.number().int(),
      totalCreditDelta: z.number().int(),
    }),
  ),
  byOutcome: z.array(
    z.object({
      key: governedActionOutcomeSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
  byGovernanceLayer: z.array(
    z.object({
      key: resourceGovernanceLayerSchema,
      count: z.number().int().nonnegative(),
      ownerRequiredCount: z.number().int().nonnegative(),
      billingImpactCount: z.number().int().nonnegative(),
    }),
  ),
  byCustomerAccount: z.array(
    z.object({
      key: z.string(),
      slug: z.string(),
      displayName: z.string(),
      isUnassigned: z.boolean(),
      count: z.number().int().nonnegative(),
      ownerRequiredCount: z.number().int().nonnegative(),
      blockedCount: z.number().int().nonnegative(),
      billingImpactCount: z.number().int().nonnegative(),
    }),
  ),
  bySubagent: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number().int().nonnegative(),
      blockedCount: z.number().int().nonnegative(),
      totalCostCents: z.number().int(),
      totalCreditDelta: z.number().int(),
    }),
  ),
  billingImpact: z.object({
    totalInternalCostCents: z.number().int(),
    totalCreditDelta: z.number().int(),
    breakdown: z.array(
      z.object({
        key: governedActionBillingBreakdownKeySchema,
        label: z.string(),
        costCents: z.number().int(),
        creditDelta: z.number().int(),
      }),
    ),
  }),
  hotspots: z.object({
    mostExpensiveActions: z.array(
      z.object({
        id: z.string(),
        actionKind: governedActionKindSchema,
        summary: z.string(),
        totalCostCents: z.number().int(),
        customerLabel: z.string(),
        occurredAt: z.string().datetime(),
      }),
    ),
    mostFrequentlyBlockedActions: z.array(
      z.object({
        key: governedActionKindSchema,
        count: z.number().int().nonnegative(),
      }),
    ),
    mostCommonOwnerOnlyActions: z.array(
      z.object({
        key: governedActionKindSchema,
        count: z.number().int().nonnegative(),
      }),
    ),
    staleApprovalsWithLinks: z.array(
      z.object({
        id: z.string(),
        summary: z.string(),
        customerLabel: z.string(),
        hasBillingLink: z.boolean(),
        hasResourceLink: z.boolean(),
        workflowStatus: z.string().optional(),
      }),
    ),
  }),
  hygiene: z.object({
    missingCustomerContextCount: z.number().int().nonnegative(),
    missingApproverAttributionCount: z.number().int().nonnegative(),
    missingBillingLinkCount: z.number().int().nonnegative(),
    missingResourceLinkCount: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        detail: z.string(),
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
  recentActions: z.array(governedActionRecordSchema),
});

export const deliverableDownloadResponseSchema = z.object({
  fileName: z.string(),
  mimeType: z.string(),
});

export const toolExecutionSnapshotSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  capability: capabilityKindSchema,
  subagentId: computeSubagentIdSchema.nullable(),
  status: toolExecutionStatusSchema,
  requestedCommand: z.string().nullable(),
  requestedPath: z.string().nullable(),
  workingDirectory: z.string().nullable(),
  mcpBindingId: z.string().nullable().optional(),
  policyDecision: policyDecisionSchema.nullable(),
  approvalRequestId: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  cpuMs: z.number().int().nullable(),
  wallMs: z.number().int().nullable(),
  bytesRead: z.number().int().nullable(),
  bytesWritten: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});

export const executeToolResponseSchema = z.object({
  outcome: computeExecutionOutcomeSchema,
  session: computeSessionSnapshotSchema,
  execution: toolExecutionSnapshotSchema,
  approvalRequest: approvalRequestSnapshotSchema.nullable().optional(),
  artifacts: z.array(artifactSnapshotSchema).default([]),
  billing: z
    .object({
      estimatedCredits: z.number().int().nonnegative().optional(),
      actualCredits: z.number().int().nonnegative().optional(),
      computeCostCents: z.number().int().nonnegative().optional(),
      browserCostCents: z.number().int().nonnegative().optional(),
      providerCostCents: z.number().int().nonnegative().optional(),
      mcpCostCents: z.number().int().nonnegative().optional(),
      storageCostCents: z.number().int().nonnegative().optional(),
      conversationBudgetRemainingCredits: z.number().int().nullable().optional(),
      ownerBalanceCredits: z.number().int().nullable().optional(),
      sponsorPoolCredit: z.number().int().nullable().optional(),
    })
    .optional(),
});

export const nativeComputerUseExecutionResponseSchema = executeToolResponseSchema.extend({
  nativeComputerUse: z.object({
    executionMode: browserExecutionModeSchema,
    provider: nativeComputerProviderSchema,
    maxSteps: z.number().int().positive(),
    allowMutations: z.boolean(),
    traceArtifactId: z.string().nullable().optional(),
    finalText: z.string().nullable().optional(),
  }),
});

export const resolveApprovalResponseSchema = z.object({
  outcome: z.enum(["approved_and_executed", "approved", "rejected"]),
  approvalRequest: approvalRequestSnapshotSchema,
  session: computeSessionSnapshotSchema.nullable().optional(),
  execution: toolExecutionSnapshotSchema.nullable().optional(),
  artifacts: z.array(artifactSnapshotSchema).default([]),
  billing: executeToolResponseSchema.shape.billing,
});

export const listArtifactsResponseSchema = z.object({
  session: computeSessionSnapshotSchema,
  artifacts: z.array(artifactSnapshotSchema),
});

export const listApprovalsResponseSchema = z.object({
  session: computeSessionSnapshotSchema,
  approvals: z.array(approvalRequestSnapshotSchema),
});

export const listMcpBindingsResponseSchema = z.object({
  representative: z.object({
    slug: z.string(),
    displayName: z.string(),
  }),
  bindings: z.array(mcpBindingSnapshotSchema),
});

export const brokerHealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("compute-broker"),
  runnerType: computeRunnerTypeSchema,
  sandboxProvider: z.enum(["docker", "daytona"]).optional(),
  artifactBucket: z.string(),
});

export const nativeComputerUsePreflightResponseSchema = z.object({
  preflight: nativeComputerUsePreflightSnapshotSchema,
});

export const artifactDetailResponseSchema = z.object({
  artifact: artifactSnapshotSchema,
  contentText: z.string().nullable(),
  truncated: z.boolean().default(false),
});

export type CapabilityKind = z.infer<typeof capabilityKindSchema>;
export type ComputeSubagentId = z.infer<typeof computeSubagentIdSchema>;
export type CapabilityPlanTier = z.infer<typeof capabilityPlanTierSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type ManagedPolicyScope = z.infer<typeof managedPolicyScopeSchema>;
export type ContactComputeTrustTier = z.infer<typeof contactComputeTrustTierSchema>;
export type PolicyResourceScope = z.infer<typeof policyResourceScopeSchema>;
export type McpTransportKind = z.infer<typeof mcpTransportKindSchema>;
export type PolicyChannel = z.infer<typeof policyChannelSchema>;
export type ComputeSessionStatus = z.infer<typeof computeSessionStatusSchema>;
export type ComputeLeaseStatus = z.infer<typeof computeLeaseStatusSchema>;
export type ToolExecutionStatus = z.infer<typeof toolExecutionStatusSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type DeliverableKind = z.infer<typeof deliverableKindSchema>;
export type DeliverableVisibility = z.infer<typeof deliverableVisibilitySchema>;
export type DeliverableSourceKind = z.infer<typeof deliverableSourceKindSchema>;
export type DeliverablePackagingPresetKey = z.infer<typeof deliverablePackagingPresetKeySchema>;
export type ResourceGovernanceLayer = z.infer<typeof resourceGovernanceLayerSchema>;
export type GovernedActionKind = z.infer<typeof governedActionKindSchema>;
export type GovernedActionOutcome = z.infer<typeof governedActionOutcomeSchema>;
export type GovernedActionActorKind = z.infer<typeof governedActionActorKindSchema>;
export type GovernedActionResourceKind = z.infer<typeof governedActionResourceKindSchema>;
export type ComputeRequestedBy = z.infer<typeof computeRequestedBySchema>;
export type ComputeRunnerType = z.infer<typeof computeRunnerTypeSchema>;
export type ComputeNetworkMode = z.infer<typeof computeNetworkModeSchema>;
export type ComputeFilesystemMode = z.infer<typeof computeFilesystemModeSchema>;
export type ComputeExecutionOutcome = z.infer<typeof computeExecutionOutcomeSchema>;
export type BrowserTransportKind = z.infer<typeof browserTransportKindSchema>;
export type BrowserExecutionMode = z.infer<typeof browserExecutionModeSchema>;
export type NativeComputerProvider = z.infer<typeof nativeComputerProviderSchema>;
export type NativeComputerProviderStatus = z.infer<typeof nativeComputerProviderStatusSchema>;
export type NativeComputerUsePreflightState = z.infer<typeof nativeComputerUsePreflightStateSchema>;
export type BrowserSessionStatus = z.infer<typeof browserSessionStatusSchema>;
export type BrowserNavigationStatus = z.infer<typeof browserNavigationStatusSchema>;
export type CapabilityPolicyRule = z.infer<typeof capabilityPolicyRuleSchema>;
export type CapabilityPolicyProfile = z.infer<typeof capabilityPolicyProfileSchema>;
export type OwnerManagedPolicyOverlays = z.infer<typeof ownerManagedPolicyOverlaysSchema>;
export type GovernanceContactAssignment = z.infer<typeof governanceContactAssignmentSchema>;
export type CustomerAccountOverlay = z.infer<typeof customerAccountOverlaySchema>;
export type OrganizationGovernanceOverlays = z.infer<typeof organizationGovernanceOverlaysSchema>;
export type CreateComputeSessionRequest = z.infer<typeof createComputeSessionRequestSchema>;
export type ComputeSessionLease = z.infer<typeof computeSessionLeaseSchema>;
export type ComputeSessionSnapshot = z.infer<typeof computeSessionSnapshotSchema>;
export type BrowserNavigationSnapshot = z.infer<typeof browserNavigationSnapshotSchema>;
export type BrowserSessionSnapshot = z.infer<typeof browserSessionSnapshotSchema>;
export type NativeComputerProviderSnapshot = z.infer<typeof nativeComputerProviderSnapshotSchema>;
export type NativeComputerUsePreflightSnapshot = z.infer<
  typeof nativeComputerUsePreflightSnapshotSchema
>;
export type CreateComputeSessionResponse = z.infer<typeof createComputeSessionResponseSchema>;
export type TerminateComputeSessionRequest = z.infer<typeof terminateComputeSessionRequestSchema>;
export type HeartbeatComputeSessionRequest = z.infer<typeof heartbeatComputeSessionRequestSchema>;
export type HeartbeatComputeSessionResponse = z.infer<typeof heartbeatComputeSessionResponseSchema>;
export type ToolExecutionRequest = z.infer<typeof toolExecutionRequestSchema>;
export type NativeComputerUseExecutionRequest = z.infer<
  typeof nativeComputerUseExecutionRequestSchema
>;
export type ToolExecutionSnapshot = z.infer<typeof toolExecutionSnapshotSchema>;
export type McpBindingSnapshot = z.infer<typeof mcpBindingSnapshotSchema>;
export type UpsertMcpBindingRequest = z.infer<typeof upsertMcpBindingRequestSchema>;
export type UpdateMcpBindingRequest = z.infer<typeof updateMcpBindingRequestSchema>;
export type ApprovalRequestSnapshot = z.infer<typeof approvalRequestSnapshotSchema>;
export type ResolveApprovalRequest = z.infer<typeof resolveApprovalRequestSchema>;
export type ResolveApprovalResponse = z.infer<typeof resolveApprovalResponseSchema>;
export type ArtifactSnapshot = z.infer<typeof artifactSnapshotSchema>;
export type UpdateArtifactRequest = z.infer<typeof updateArtifactRequestSchema>;
export type UpdateArtifactResponse = z.infer<typeof updateArtifactResponseSchema>;
export type DeliverableSnapshot = z.infer<typeof deliverableSnapshotSchema>;
export type UpsertDeliverableRequest = z.infer<typeof upsertDeliverableRequestSchema>;
export type UpdateDeliverableRequest = z.infer<typeof updateDeliverableRequestSchema>;
export type ListDeliverablesResponse = z.infer<typeof listDeliverablesResponseSchema>;
export type DeliverablePackagingPresetSnapshot = z.infer<
  typeof deliverablePackagingPresetSnapshotSchema
>;
export type ListDeliverablePackagingPresetsResponse = z.infer<
  typeof listDeliverablePackagingPresetsResponseSchema
>;
export type RepresentativeDeliverableInsightsSnapshot = z.infer<
  typeof representativeDeliverableInsightsSnapshotSchema
>;
export type RepresentativeResourceGovernanceSnapshot = z.infer<
  typeof representativeResourceGovernanceSnapshotSchema
>;
export type RepresentativeGovernedActionSnapshot = z.infer<
  typeof representativeGovernedActionSnapshotSchema
>;
export type DeliverableDownloadResponse = z.infer<typeof deliverableDownloadResponseSchema>;
export type ExecuteToolResponse = z.infer<typeof executeToolResponseSchema>;
export type NativeComputerUseExecutionResponse = z.infer<
  typeof nativeComputerUseExecutionResponseSchema
>;
export type ListArtifactsResponse = z.infer<typeof listArtifactsResponseSchema>;
export type ListApprovalsResponse = z.infer<typeof listApprovalsResponseSchema>;
export type ListMcpBindingsResponse = z.infer<typeof listMcpBindingsResponseSchema>;
export type BrokerHealth = z.infer<typeof brokerHealthSchema>;
export type NativeComputerUsePreflightResponse = z.infer<
  typeof nativeComputerUsePreflightResponseSchema
>;
export type ArtifactDetailResponse = z.infer<typeof artifactDetailResponseSchema>;

export function listCapabilitiesForComputeSubagent(subagentId: ComputeSubagentId): CapabilityKind[] {
  return [...computeSubagentAllowedCapabilities[subagentId]];
}

export function isCapabilityAllowedForComputeSubagent(
  subagentId: ComputeSubagentId,
  capability: CapabilityKind,
): boolean {
  return listCapabilitiesForComputeSubagent(subagentId).includes(capability);
}

export function getComputeSubagentBudgetCredits(subagentId: ComputeSubagentId): number {
  return computeSubagentBudgetCredits[subagentId];
}

export function resolveComputeSubagentIdForCapability(capability: CapabilityKind): ComputeSubagentId {
  return capability === "browser" ? "browser-agent" : "compute-agent";
}
