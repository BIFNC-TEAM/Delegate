import { evaluateCapabilityPolicyStack } from "@delegate/capability-policy";
import {
  computeSubagentIdSchema,
  resolveComputeSubagentIdForCapability,
  toolExecutionRequestSchema,
  type CapabilityKind,
  type ComputeSubagentId,
} from "@delegate/compute-protocol";

import {
  deriveConversationComputeEntitlements,
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
              wallet: true,
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
          computeBudgetRemainingCredits: true,
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
      networkMode: runtimeAuthority.compute.networkMode,
      networkAllowlist: [...runtimeAuthority.compute.networkAllowlist],
      filesystemMode: runtimeAuthority.compute.filesystemMode,
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
      estimatedCostCents: input.estimatedCostCents,
      hasPaidEntitlement: entitlements.hasPaidEntitlement,
      contactTrustTier: normalizeContactTrustTier(context.session.contact?.computeTrustTier),
      ...(context.session.contact?.customerAccountId
        ? { customerAccountId: context.session.contact.customerAccountId }
        : {}),
    },
  );
  const decision = restrictEvaluatedDecision(
    evaluatedDecision,
    context.runtimeAuthority.compute.capabilityModes[input.capability],
  );

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
    sessionSubagentId,
  };
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
