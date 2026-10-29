import { createHash } from "node:crypto";
import { evaluateCodeExecutionPreflight, evaluatePythonExecutionPreflight } from "./code-preflight";
import { validatePythonRequest } from "./isolated-python/request";

import { evaluateCapabilityPolicyStack } from "@delegate/capability-policy";
import {
  computeSubagentIdSchema,
  resolveComputeSubagentIdForCapability,
  toolExecutionRequestSchema,
  type CapabilityKind,
  type ComputeSubagentId,
  type ToolExecutionRequest,
} from "@delegate/compute-protocol";
import {
  resolveServerOwnedMcpCapabilityPolicy,
  assertAgentContextForExecution,
  type RepresentativeRuntimeMcpBindingGrant,
} from "@delegate/web-data";
import {
  requireAudienceGenerationRunAuthorization,
} from "./entitlements";
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
      generationRun: {
        select: {
          inputMessage: {
            select: { text: true },
          },
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
  if (audienceAuthorization && session.generationRunId) await assertAgentContextForExecution(session.generationRunId);
  const effectiveExpiresAt = resolveComputeSessionExpiryCeiling({
    storedExpiresAt: session.expiresAt,
    createdAt: session.createdAt,
    runtimeMaxSessionMinutes: runtimeAuthority.compute.maxSessionMinutes,
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
  const representativeNetworkMode = resolveRestrictiveNetworkMode(
    currentProfile.networkMode,
    runtimeAuthority.compute.networkMode,
  );
  const representativeFilesystemMode =
    resolveRestrictiveFilesystemMode(
      currentProfile.filesystemMode,
      runtimeAuthority.compute.filesystemMode,
    );
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
      maxSessionMinutes: Math.min(
        currentProfile.maxSessionMinutes,
        runtimeAuthority.compute.maxSessionMinutes,
      ),
      artifactRetentionDays: Math.min(
        currentProfile.artifactRetentionDays,
        runtimeAuthority.compute.artifactRetentionDays,
      ),
      networkMode: representativeNetworkMode,
      networkAllowlist: [...runtimeAuthority.compute.networkAllowlist],
      filesystemMode: representativeFilesystemMode,
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

export async function getCodeExecutionPreflight(sessionId: string) {
  // Applies the same current session/audience/published-policy checks as execution.
  const context = await loadSessionPolicyContext(sessionId);
  return context.audienceAuthorization && context.session.runtimeClass === "CODE" && context.session.generationRunId
    ? evaluatePythonExecutionPreflight(context.profile) : evaluateCodeExecutionPreflight(context.profile);
}

export async function evaluateExecutionRequest(sessionId: string, rawInput: unknown, trusted?: { approvedExecutionId: string }) {
  const input = toolExecutionRequestSchema.parse(rawInput);
  const normalizedPath =
    (input.capability === "read" || input.capability === "write") && input.path
      ? normalizeContainerPath(input.path)
      : input.path;
  const context = await loadSessionPolicyContext(sessionId);
  if (input.isolatedPython) {
    if (input.capability !== "exec" || input.command || input.compiledTask || input.path || input.content
      || context.session.runtimeClass !== "CODE" || !context.audienceAuthorization || !context.session.generationRunId) {
      throw new SessionError(400, "isolated_python_route_invalid");
    }
    input.isolatedPython = validatePythonRequest(input.isolatedPython);
    if (input.isolatedPython.timeoutMs > context.profile.maxCommandSeconds * 1000) throw new SessionError(400, "isolated_python_timeout_exceeds_policy");
    if (!trusted?.approvedExecutionId) {
      const lease = input.generationWorkLease;
      const current = lease ? await prisma.outboxEvent.findFirst({ where: {
        id: lease.outboxId, aggregateType: "generation_run", aggregateId: context.session.generationRunId,
        eventType: "generation.requested", status: "PROCESSING", attemptCount: lease.leaseAttempt, availableAt: { gt: new Date() },
      }, select: { id: true } }) : null;
      if (!current) throw new SessionError(409, "isolated_python_work_lease_lost");
    }
  }
  const inlineCodeIntegrityVerified = verifyInlineCodeIntegrity({
    input,
    ...(context.session.generationRun?.inputMessage.text !== undefined
      ? { generationInputText: context.session.generationRun.inputMessage.text }
      : {}),
  });
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
  const mcpBehavior =
    input.capability === "mcp" && mcpBinding && mcpToolName
      ? resolveServerVerifiedMcpBehavior({
          binding: mcpBinding,
          runtimeGrants: context.runtimeAuthority.mcpBindings,
          toolName: mcpToolName,
        })
      : "unknown";
  const serverVerifiedReadOnlyMcp = input.capability === "mcp" && mcpBehavior === "read";
  const estimatedTokens = Math.max(
    input.estimatedTokens ?? 0,
    mcpBinding?.estimatedTokensPerCall ?? 0,
  );
  const evaluatedDecision = evaluateCapabilityPolicyStack(
    [...context.managedProfiles, context.profile],
    {
      capability: input.capability,
      command: input.capability === "mcp" ? mcpToolName : input.isolatedPython ? "python" : input.command,
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
      estimatedTokens,
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
  let decision = input.capability === "mcp" && mcpBehavior === "unknown"
    ? { decision: "deny" as const, reason: "mcp_tool_behavior_unclassified" }
    : restrictEvaluatedDecision(policyDecision, publishedCapabilityMode);
  if (input.isolatedPython?.outputFileName) {
    const outputDecision = evaluateCapabilityPolicyStack([...context.managedProfiles, context.profile], {
      capability: "write", path: `/workspace/outputs/${input.isolatedPython.outputFileName}`,
      resourceScope: resolvePolicyResourceScope("write"), estimatedTokens,
      contactTrustTier: normalizeContactTrustTier(context.session.contact?.computeTrustTier),
      ...(context.session.conversation?.channel ? { channel: context.session.conversation.channel.toLowerCase() as "private_chat" | "group_mention" | "group_reply" | "channel_entry" } : {}),
      ...(context.session.contact?.customerAccountId ? { customerAccountId: context.session.contact.customerAccountId } : {}),
    });
    const writeDecision = restrictEvaluatedDecision(outputDecision, context.runtimeAuthority.compute.capabilityModes.write);
    if (writeDecision.decision === "deny" || (decision.decision === "allow" && writeDecision.decision === "ask")) decision = writeDecision;
  }
  if (
    process.env.NODE_ENV === "test"
    && process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS === "true"
    && input.capability === "mcp"
  ) {
    console.info("agent_test_mcp_policy", {
      bindingId: mcpBinding?.id,
      toolName: mcpToolName,
      serverVerifiedReadOnlyMcp,
      evaluatedDecision,
      policyDecision,
      publishedCapabilityMode,
      finalDecision: decision,
    });
  }

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
    mcpBinding,
    serverVerifiedReadOnlyMcp,
    inlineCodeIntegrityVerified,
    sessionSubagentId,
  };
}

export function verifyInlineCodeIntegrity(input: {
  input: ToolExecutionRequest;
  generationInputText?: string | null;
}) {
  const request = input.input;
  const metadata = request.compiledTask;
  if (
    request.capability !== "exec"
    || !request.command
    || !metadata
    || metadata.compilerProvider !== "delegate-pi-runtime"
    || !input.generationInputText
  ) return false;
  const source = decodeInlineProgram(request.command);
  if (source === null) return false;
  return metadata.instructionHash === sha256Text(input.generationInputText.trim())
    && metadata.codeHash === sha256Text(source);
}

// Compatibility for existing diagnostic probes; this proves consistency only.
export const verifyInlineCompiledTask = verifyInlineCodeIntegrity;

function decodeInlineProgram(command: string) {
  const patterns = [
    /^python -c "import base64;exec\(compile\(base64\.b64decode\('([A-Za-z0-9+/]+={0,2})'\),'<pi-agent>','exec'\)\)"$/u,
    /^node -e "eval\(Buffer\.from\('([A-Za-z0-9+/]+={0,2})','base64'\)\.toString\('utf8'\)\)"$/u,
    /^printf '%s' '([A-Za-z0-9+/]+={0,2})' \| base64 -d \| sh$/u,
  ];
  const encoded = patterns
    .map((pattern) => command.match(pattern)?.[1])
    .find((value): value is string => Boolean(value));
  if (!encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64") === encoded
    ? decoded
    : null;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function resolveServerVerifiedMcpBehavior(input: {
  binding: {
    id: string;
    serverUrl: string;
    transportKind: string;
    configRevision: number;
  };
  runtimeGrants: RepresentativeRuntimeMcpBindingGrant[];
  toolName: string;
}): "read" | "write" | "unknown" {
  const grant = input.runtimeGrants.find(
    (candidate) => candidate.id === input.binding.id,
  );
  if (!grant || (grant.allowedToolNames.length > 0 && !grant.allowedToolNames.includes(input.toolName))) return "unknown";
  if (
    isConfiguredTestReadOnlyMcp(input.binding.id, input.toolName)
    && (
      grant.allowedToolNames.length === 0
      || grant.allowedToolNames.includes(input.toolName)
    )
  ) {
    return "read";
  }
  const definition = grant?.toolDefinitions?.find(
    (candidate) =>
      candidate.exactToolName === input.toolName
      && candidate.bindingRevision === input.binding.configRevision,
  );
  if (!definition) return "unknown";
  const policy = resolveServerOwnedMcpCapabilityPolicy({
    serverUrl: input.binding.serverUrl,
    transportKind: input.binding.transportKind,
    toolName: input.toolName,
    toolSchemaHash: definition.toolSchemaHash,
    inputSchema: definition.inputSchema,
  });
  if (!policy) return "unknown";
  return policy.effect.mutation === "none" ? "read" : "write";
}

export function resolveServerVerifiedReadOnlyMcp(
  input: Parameters<typeof resolveServerVerifiedMcpBehavior>[0],
) {
  return resolveServerVerifiedMcpBehavior(input) === "read";
}

function isConfiguredTestReadOnlyMcp(bindingId: string, toolName: string) {
  if (
    process.env.NODE_ENV !== "test"
    || process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS !== "true"
  ) return false;
  const coordinates = new Set(
    (process.env.DELEGATE_MCP_READ_ONLY_TEST_TOOLS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return coordinates.has(`${bindingId}:${toolName}`);
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
}) {
  if (!params.storedExpiresAt) {
    throw new SessionError(409, "compute_session_expiry_missing");
  }
  const runtimeCeiling = new Date(
    params.createdAt.getTime() +
      Math.max(0, params.runtimeMaxSessionMinutes) * 60 * 1000,
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

function resolveRestrictiveDecision(
  current: "allow" | "ask" | "deny",
  ceiling: "allow" | "ask" | "deny",
): "allow" | "ask" | "deny" {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  return rank[current] >= rank[ceiling] ? current : ceiling;
}

function resolveRestrictiveNetworkMode(
  profileMode: "no_network" | "allowlist" | "full",
  runtimeMode: "no_network" | "allowlist" | "full",
) {
  const rank = { full: 0, allowlist: 1, no_network: 2 } as const;
  return rank[profileMode] >= rank[runtimeMode] ? profileMode : runtimeMode;
}

function resolveRestrictiveFilesystemMode(
  profileMode: "workspace_only" | "read_only_workspace" | "ephemeral_full",
  runtimeMode: "workspace_only" | "read_only_workspace" | "ephemeral_full",
) {
  const rank = {
    ephemeral_full: 0,
    workspace_only: 1,
    read_only_workspace: 2,
  } as const;
  return rank[profileMode] >= rank[runtimeMode] ? profileMode : runtimeMode;
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
