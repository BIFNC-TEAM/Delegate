import { evaluateCapabilityPolicyStack } from "@delegate/capability-policy";
import {
  computeSubagentIdSchema,
  resolveComputeSubagentIdForCapability,
  toolExecutionRequestSchema,
  type CapabilityKind,
  type ComputeSubagentId,
} from "@delegate/compute-protocol";
import {
  resolveServerOwnedMcpCapabilityPolicyV3,
  type RepresentativeRuntimeMcpBindingGrant,
} from "@delegate/web-data";
import {
  readPersistedDelegationStepRequest,
  stableSha256,
} from "@delegate/runtime";

import {
  deriveConversationComputeEntitlements,
  requireAudienceGenerationRunAuthorization,
} from "./entitlements";
import {
  resolveDelegationTaskSessionDurationMinutes,
  resolveEffectiveDelegationFilesystemMode,
  resolveEffectiveDelegationNetworkMode,
  type DelegationTaskResourcePolicyContext,
} from "./delegation-task-context";
import { loadRepresentativeMcpBinding, resolveMcpToolName } from "./mcp-bindings";
import { normalizeContainerPath } from "./path-utils";
import { prisma } from "./prisma";
import { loadComputeRuntimeAuthority } from "./runtime-authority";
import { SessionError } from "./session-error";
import { serializeCapabilityProfile } from "./serializers";

export async function loadSessionPolicyContext(sessionId: string) {
  const session = await prisma.computeSession.findUnique({
    where: { id: sessionId },
    include: {
      representative: {
        include: {
          owner: {
            include: {
              organization: {
                include: {
                  capabilityProfiles: {
                    where: {
                      isManaged: true,
                      enabled: true,
                    },
                    orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
                    include: {
                      rules: {
                        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
                      },
                    },
                  },
                },
              },
              capabilityProfiles: {
                where: {
                  isManaged: true,
                  enabled: true,
                },
                orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
                include: {
                  rules: {
                    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
                  },
                },
              },
            },
          },
          capabilityProfiles: {
            where: {
              isManaged: true,
              enabled: true,
            },
            orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
            include: {
              rules: {
                orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
              },
            },
          },
        },
      },
      contact: {
        include: {
          customerAccount: {
            include: {
              capabilityProfiles: {
                where: {
                  isManaged: true,
                  enabled: true,
                },
                orderBy: [{ precedence: "desc" }, { createdAt: "asc" }],
                include: {
                  rules: {
                    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
                  },
                },
              },
            },
          },
        },
      },
      conversation: {
        select: {
          channel: true,
        },
      },
      delegationTask: {
        select: {
          resourcePolicy: {
            select: {
              maxDurationMinutes: true,
              maxEstimatedTokens: true,
              allowedCapabilities: true,
              allowedMcpBindingIds: true,
              networkMode: true,
              filesystemMode: true,
              requireApprovalForExternalSideEffects: true,
            },
          },
        },
      },
      delegationTaskStep: {
        select: {
          mcpBindingId: true,
          inputSnapshot: true,
        },
      },
      policyProfile: {
        include: {
          rules: {
            orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });

  if (!session) {
    throw new SessionError(404, "compute_session_not_found");
  }

  if (session.endedAt) {
    throw new SessionError(409, "compute_session_already_terminated");
  }

  assertComputeSessionExpiry(session.expiresAt);

  if (!session.policyProfile) {
    throw new SessionError(409, "capability_policy_profile_missing");
  }

  const runtimeAuthority = await loadComputeRuntimeAuthority({
    representativeId: session.representativeId,
    representativeSlug: session.representative.slug,
    pinnedRepresentativeVersionId: session.representativeVersionId,
  });
  if (!runtimeAuthority.compute.enabled) {
    throw new SessionError(409, "compute_disabled_for_published_version");
  }
  const audienceAuthorization =
    await requireAudienceGenerationRunAuthorization({
      requestedBy: session.requestedBy,
      representativeId: session.representativeId,
      contactId: session.contactId,
      conversationId: session.conversationId,
      generationRunId: session.generationRunId,
    });
  const effectiveExpiresAt = resolveComputeSessionExpiryCeiling({
    storedExpiresAt: session.expiresAt,
    createdAt: session.createdAt,
    runtimeMaxSessionMinutes: runtimeAuthority.compute.maxSessionMinutes,
    ...(typeof session.delegationTask?.resourcePolicy?.maxDurationMinutes === "number"
      ? {
          taskMaxDurationMinutes:
            session.delegationTask.resourcePolicy.maxDurationMinutes,
        }
      : {}),
  });
  assertComputeSessionExpiry(effectiveExpiresAt);
  if (effectiveExpiresAt < session.expiresAt) {
    await prisma.computeSession.updateMany({
      where: {
        id: session.id,
        expiresAt: { gt: effectiveExpiresAt },
      },
      data: {
        expiresAt: effectiveExpiresAt,
      },
    });
  }
  const currentProfile = serializeCapabilityProfile(session.policyProfile);
  const representativeNetworkMode = resolveEffectiveDelegationNetworkMode(
    currentProfile.networkMode,
    runtimeAuthority.compute.networkMode,
  );
  const representativeFilesystemMode =
    resolveEffectiveDelegationFilesystemMode(
      currentProfile.filesystemMode,
      runtimeAuthority.compute.filesystemMode,
    );
  const taskResourcePolicy = session.delegationTask?.resourcePolicy;

  return {
    session:
      effectiveExpiresAt.getTime() === session.expiresAt.getTime()
        ? session
        : { ...session, expiresAt: effectiveExpiresAt },
    profile: {
      ...currentProfile,
      defaultDecision: resolveRestrictiveDecision(
        currentProfile.defaultDecision,
        runtimeAuthority.compute.defaultPolicyMode,
      ),
      maxSessionMinutes: resolveDelegationTaskSessionDurationMinutes({
        representativeMaxSessionMinutes: Math.min(
          currentProfile.maxSessionMinutes,
          runtimeAuthority.compute.maxSessionMinutes,
        ),
        resourcePolicy: taskResourcePolicy,
      }),
      artifactRetentionDays: Math.min(
        currentProfile.artifactRetentionDays,
        runtimeAuthority.compute.artifactRetentionDays,
      ),
      networkMode: resolveEffectiveDelegationNetworkMode(
        representativeNetworkMode,
        taskResourcePolicy?.networkMode,
      ),
      networkAllowlist: [...runtimeAuthority.compute.networkAllowlist],
      filesystemMode: resolveEffectiveDelegationFilesystemMode(
        representativeFilesystemMode,
        taskResourcePolicy?.filesystemMode,
      ),
    },
    runtimeAuthority,
    audienceAuthorization,
    managedProfiles: [
      ...(session.representative.owner.organization?.capabilityProfiles ?? []),
      ...session.representative.owner.capabilityProfiles,
      ...(session.contact?.customerAccount?.capabilityProfiles ?? []),
      ...session.representative.capabilityProfiles,
    ].map((profile) =>
      serializeCapabilityProfile(profile),
    ),
  };
}

export async function evaluateExecutionRequest(sessionId: string, rawInput: unknown) {
  const input = toolExecutionRequestSchema.parse(rawInput);
  const normalizedPath =
    (input.capability === "read" || input.capability === "write") && input.path
      ? normalizeContainerPath(input.path)
      : input.path;
  const context = await loadSessionPolicyContext(sessionId);
  const serverVerifiedCompiledTask = resolveServerVerifiedCompiledSandboxTask({
    input,
    stepInputSnapshot: context.session.delegationTaskStep?.inputSnapshot,
  });
  const entitlements = deriveConversationComputeEntitlements(
    context.audienceAuthorization,
  );
  const mcpBinding =
    input.capability === "mcp"
      ? await loadRepresentativeMcpBinding({
          representativeId: context.session.representativeId,
          bindingId: input.bindingId,
          bindingSlug: input.bindingSlug,
          runtimeGrants: context.runtimeAuthority.mcpBindings,
        })
      : null;
  const mcpToolName =
    input.capability === "mcp" && mcpBinding
      ? resolveMcpToolName({
          binding: mcpBinding,
          requestedToolName: input.toolName,
        }).toolName
      : undefined;
  const bindingDomain = mcpBinding ? new URL(mcpBinding.serverUrl).hostname : undefined;
  const serverVerifiedReadOnlyMcp =
    input.capability === "mcp" && mcpBinding && mcpToolName
      ? resolveServerVerifiedReadOnlyMcp({
          binding: mcpBinding,
          runtimeGrants: context.runtimeAuthority.mcpBindings,
          toolName: mcpToolName,
        })
      : false;
  const estimatedTokens = Math.max(
    input.estimatedTokens ?? 0,
    mcpBinding?.estimatedTokensPerCall ?? 0,
  );
  const evaluatedDecision = evaluateCapabilityPolicyStack(
    [...context.managedProfiles, context.profile],
    {
      capability: input.capability,
      command: input.capability === "mcp" ? mcpToolName : input.command,
      path: normalizedPath,
      domain: input.capability === "mcp" ? bindingDomain : input.domain,
      resourceScope: resolvePolicyResourceScope(input.capability),
      ...(context.session.conversation?.channel
        ? {
            channel: context.session.conversation.channel.toLowerCase() as
              | "private_chat"
              | "group_mention"
              | "group_reply"
              | "channel_entry",
          }
        : {}),
      ...(entitlements.activePlanTier ? { activePlanTier: entitlements.activePlanTier } : {}),
      estimatedTokens,
      hasPaidEntitlement: entitlements.hasPaidEntitlement,
      contactTrustTier: normalizeContactTrustTier(context.session.contact?.computeTrustTier),
      ...(context.session.contact?.customerAccountId
        ? { customerAccountId: context.session.contact.customerAccountId }
        : {}),
    },
  );
  const policyDecision = applyServerVerifiedReadOnlyMcpDecision(
    evaluatedDecision,
    serverVerifiedReadOnlyMcp,
  );
  const publishedCapabilityMode =
    context.runtimeAuthority.compute.capabilityModes[input.capability];
  const decision = applyDelegationTaskResourcePolicyDecision({
    decision: restrictEvaluatedDecision(
      policyDecision,
      serverVerifiedReadOnlyMcp && publishedCapabilityMode === "ask"
        ? "allow"
        : publishedCapabilityMode,
    ),
    capability: input.capability,
    estimatedTokens,
    ...(mcpBinding ? { mcpBindingId: mcpBinding.id } : {}),
    ...(context.session.delegationTaskStep?.mcpBindingId
      ? { taskMcpBindingId: context.session.delegationTaskStep.mcpBindingId }
      : {}),
    browserMode: input.browserMode,
    allowMutations: input.allowMutations,
    serverVerifiedReadOnlyMcp,
    delegatedExecution: Boolean(context.session.delegationTaskId),
    resourcePolicy: context.session.delegationTask?.resourcePolicy,
  });

  const sessionSubagentId = resolveSessionComputeSubagentId(
    context.session.subagentId,
    input.capability,
  );
  assertExecutionSubagentRoute({
    sessionSubagentId,
    requestedSubagentId: input.subagentId,
    capability: input.capability,
  });

  return {
    input: {
      ...input,
      ...(normalizedPath ? { path: normalizedPath } : {}),
      ...(input.capability === "mcp" && mcpBinding ? { bindingId: mcpBinding.id } : {}),
      ...(input.capability === "mcp" && bindingDomain ? { domain: bindingDomain } : {}),
      ...(input.capability === "mcp" && mcpToolName ? { toolName: mcpToolName } : {}),
    },
    context,
    decision,
    entitlements,
    mcpBinding,
    serverVerifiedReadOnlyMcp,
    serverVerifiedCompiledTask,
    sessionSubagentId,
  };
}

export function resolveServerVerifiedCompiledSandboxTask(input: {
  input: ReturnType<typeof toolExecutionRequestSchema.parse>;
  stepInputSnapshot: unknown;
}) {
  if (!input.input.compiledTask) return false;
  const snapshot = record(input.stepInputSnapshot);
  const executionRequest = record(snapshot?.["executionRequest"]);
  const persistedRequest = readPersistedDelegationStepRequest(snapshot?.["request"]);
  if (
    input.input.capability !== "exec"
    || !input.input.command
    || executionRequest?.["capabilityKey"] !== "compute.task"
    || !persistedRequest?.compiledTask
    || persistedRequest.command !== input.input.command
    || stableSha256(persistedRequest.compiledTask) !== stableSha256(input.input.compiledTask)
  ) {
    throw new SessionError(409, "compiled_sandbox_task_mismatch");
  }
  return true;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveServerVerifiedReadOnlyMcp(input: {
  binding: {
    id: string;
    serverUrl: string;
    transportKind: string;
    configRevision: number;
  };
  runtimeGrants: RepresentativeRuntimeMcpBindingGrant[];
  toolName: string;
}) {
  const grant = input.runtimeGrants.find(
    (candidate) => candidate.id === input.binding.id,
  );
  const definition = grant?.toolDefinitions?.find(
    (candidate) =>
      candidate.exactToolName === input.toolName
      && candidate.bindingRevision === input.binding.configRevision,
  );
  if (!grant || !definition) return false;
  const policy = resolveServerOwnedMcpCapabilityPolicyV3({
    serverUrl: input.binding.serverUrl,
    transportKind: input.binding.transportKind,
    toolName: input.toolName,
    toolSchemaHash: definition.toolSchemaHash,
  });
  return Boolean(
    policy
    && policy.effect.mutation === "none"
    && policy.idempotency === "naturally_idempotent",
  );
}

export function applyServerVerifiedReadOnlyMcpDecision(
  decision: ExecutionPolicyDecision,
  serverVerifiedReadOnlyMcp: boolean,
): ExecutionPolicyDecision {
  if (
    serverVerifiedReadOnlyMcp
    && decision.decision === "ask"
    && decision.reason === "managed_human_approval_required"
  ) {
    return {
      decision: "allow",
      reason: "server_verified_read_only_mcp",
    };
  }
  return decision;
}

export function assertComputeSessionExpiry(
  expiresAt: Date | null,
  nowMs = Date.now(),
): asserts expiresAt is Date {
  if (!expiresAt) {
    throw new SessionError(409, "compute_session_expiry_missing");
  }
  if (expiresAt.getTime() <= nowMs) {
    throw new SessionError(409, "compute_session_expired");
  }
}

export function resolveComputeSessionExpiryCeiling(params: {
  storedExpiresAt: Date | null;
  createdAt: Date;
  runtimeMaxSessionMinutes: number;
  taskMaxDurationMinutes?: number | null;
}) {
  if (!params.storedExpiresAt) {
    throw new SessionError(409, "compute_session_expiry_missing");
  }
  const runtimeCeiling = new Date(
    params.createdAt.getTime() +
      resolveDelegationTaskSessionDurationMinutes({
        representativeMaxSessionMinutes: params.runtimeMaxSessionMinutes,
        resourcePolicy:
          typeof params.taskMaxDurationMinutes === "number"
            ? {
                allowedCapabilities: [],
                maxDurationMinutes: params.taskMaxDurationMinutes,
              }
            : null,
      }) * 60 * 1000,
  );
  return params.storedExpiresAt <= runtimeCeiling
    ? params.storedExpiresAt
    : runtimeCeiling;
}

type ExecutionPolicyDecision = {
  decision: "allow" | "ask" | "deny";
  reason: string;
  matchedRuleId?: string;
};

export function applyDelegationTaskResourcePolicyDecision(input: {
  decision: ExecutionPolicyDecision;
  capability: CapabilityKind;
  estimatedTokens: number;
  mcpBindingId?: string;
  taskMcpBindingId?: string;
  browserMode?: "deterministic" | "native";
  allowMutations?: boolean;
  serverVerifiedReadOnlyMcp?: boolean;
  delegatedExecution?: boolean;
  resourcePolicy: DelegationTaskResourcePolicyContext | null | undefined;
}): ExecutionPolicyDecision {
  const policy = input.resourcePolicy;
  if (input.delegatedExecution && !policy) {
    return {
      decision: "deny",
      reason: "delegation_task_resource_policy_missing",
    };
  }
  if (!policy) return input.decision;

  const allowedCapabilities = new Set(
    policy.allowedCapabilities.map((capability) => capability.toLowerCase()),
  );
  if (!allowedCapabilities.has(input.capability)) {
    return {
      decision: "deny",
      reason: "delegation_task_capability_not_allowed",
    };
  }
  const allowedMcpBindingIds = policy.allowedMcpBindingIds ?? [];
  if (
    input.capability === "mcp"
    && input.delegatedExecution
    && !input.taskMcpBindingId
  ) {
    return {
      decision: "deny",
      reason: "delegation_task_mcp_binding_missing",
    };
  }
  if (
    input.capability === "mcp"
    && input.taskMcpBindingId
    && input.mcpBindingId !== input.taskMcpBindingId
  ) {
    return {
      decision: "deny",
      reason: "delegation_task_mcp_binding_changed",
    };
  }
  if (
    input.capability === "mcp"
    && input.delegatedExecution
    && allowedMcpBindingIds.length === 0
  ) {
    return {
      decision: "deny",
      reason: "delegation_task_mcp_binding_allowlist_missing",
    };
  }
  if (
    input.capability === "mcp"
    && allowedMcpBindingIds.length > 0
    && (!input.mcpBindingId || !allowedMcpBindingIds.includes(input.mcpBindingId))
  ) {
    return {
      decision: "deny",
      reason: "delegation_task_mcp_binding_not_allowed",
    };
  }
  if (
    typeof policy.maxEstimatedTokens === "number"
    && input.estimatedTokens > policy.maxEstimatedTokens
  ) {
    return {
      decision: "deny",
      reason: "delegation_task_token_limit_exceeded",
    };
  }
  if (input.decision.decision === "deny") return input.decision;

  const externalSideEffect = (
    input.capability === "mcp"
    && !input.serverVerifiedReadOnlyMcp
  )
    || (
      input.capability === "browser"
      && input.browserMode === "native"
      && input.allowMutations === true
    );
  if (
    policy.requireApprovalForExternalSideEffects
    && externalSideEffect
    && input.decision.decision === "allow"
  ) {
    return {
      decision: "ask",
      reason: "delegation_task_external_side_effect_requires_approval",
    };
  }
  return input.decision;
}

function resolveRestrictiveDecision(
  current: "allow" | "ask" | "deny",
  ceiling: "allow" | "ask" | "deny",
): "allow" | "ask" | "deny" {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  return rank[current] >= rank[ceiling] ? current : ceiling;
}

export function restrictEvaluatedDecision(
  evaluated: { decision: "allow" | "ask" | "deny"; reason: string; matchedRuleId?: string },
  ceiling: "allow" | "ask" | "deny",
) {
  const decision = resolveRestrictiveDecision(evaluated.decision, ceiling);
  if (decision === evaluated.decision) return evaluated;
  return {
    decision,
    reason:
      decision === "deny"
        ? "published_version_capability_denied"
        : "published_version_capability_requires_approval",
  };
}

export function resolveSessionComputeSubagentId(
  rawSubagentId: string | null | undefined,
  capability: CapabilityKind,
): ComputeSubagentId {
  if (rawSubagentId) {
    return computeSubagentIdSchema.parse(rawSubagentId);
  }

  return resolveComputeSubagentIdForCapability(capability);
}

export function assertExecutionSubagentRoute(params: {
  sessionSubagentId: ComputeSubagentId;
  requestedSubagentId: ComputeSubagentId;
  capability: CapabilityKind;
}) {
  if (params.sessionSubagentId !== params.requestedSubagentId) {
    throw new SessionError(409, "compute_subagent_session_mismatch");
  }

  const expectedSubagentId = resolveComputeSubagentIdForCapability(params.capability);
  if (params.requestedSubagentId !== expectedSubagentId) {
    throw new SessionError(409, "compute_subagent_capability_mismatch");
  }
}

function resolvePolicyResourceScope(capability: CapabilityKind) {
  if (capability === "browser") {
    return "browser_lane" as const;
  }

  if (capability === "mcp") {
    return "remote_mcp" as const;
  }

  return "workspace" as const;
}

function normalizeContactTrustTier(
  rawTrustTier: string | null | undefined,
): "standard" | "verified" | "vip" | "restricted" {
  const normalized = rawTrustTier?.trim().toLowerCase();
  if (
    normalized === "verified" ||
    normalized === "vip" ||
    normalized === "restricted"
  ) {
    return normalized;
  }

  return "standard";
}
