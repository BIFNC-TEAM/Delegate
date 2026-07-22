import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";

import {
  executeToolResponseSchema,
  getComputeSubagentBudgetCredits,
  listApprovalsResponseSchema,
  listArtifactsResponseSchema,
  nativeComputerUseExecutionResponseSchema,
  resolveComputeSubagentIdForCapability,
  resolveApprovalRequestSchema,
  resolveApprovalResponseSchema,
  type CapabilityKind,
  type BrowserExecutionMode,
  type ComputeFilesystemMode,
  type ComputeSubagentId,
  type NativeComputerProvider,
  type ToolExecutionRequest,
} from "@delegate/compute-protocol";
import type { Prisma } from "@prisma/client";
import { finalizeComputeApprovalConversation } from "@delegate/web-data";

import { createApprovalRequestForExecution } from "./approvals";
import {
  applyExecutionBilling,
  estimateCreditUsage,
  summarizeBudgetAvailability,
  type ExecutionBillingSummary,
} from "./billing";
import {
  buildOpenCodeCaptureCommand,
  buildOpenCodeComputerUseCommand,
  buildPlaywrightBrowseCommand,
  buildPlaywrightNativeCommand,
  parsePlaywrightBrowseArtifactPayload,
} from "./browser";
import { recordBrowserNavigation } from "./browser-sessions";
import { computeBrokerConfig } from "./config";
import { ensureComputeSessionLease } from "./leases";
import {
  persistExecutionArtifacts,
  persistFileArtifact,
  persistJsonArtifact,
  persistScreenshotArtifact,
  readPersistedArtifactObject,
} from "./artifacts";
import { computeLifecycleHooks } from "./lifecycle-hooks";
import {
  loadRepresentativeMcpBinding,
  recordRepresentativeMcpBindingFailure,
  recordRepresentativeMcpBindingSuccess,
  resolveMcpToolName,
} from "./mcp-bindings";
import { callRemoteMcpTool, McpTransportError } from "./mcp";
import { executeNativeComputerUseLoop } from "./native-browser";
import { extractHostname, isHostnameAllowed, normalizeNetworkAllowlist } from "./network-allowlist";
import { normalizeContainerPath } from "./path-utils";
import { prisma } from "./prisma";
import { evaluateExecutionRequest, loadSessionPolicyContext } from "./policy";
import { runRunnerExecution } from "./runner";
import {
  createDockerSandboxProvider,
  createSandboxProviderFromConfig,
  type SandboxProviderLease,
} from "./sandbox-provider";
import {
  mapCapabilityFromDb,
  mapCapabilityToDb,
  mapRunnerTypeFromDb,
  mapPolicyDecisionToDb,
  serializeApprovalRequest,
  serializeArtifact,
  serializeExecution,
  serializeSession,
} from "./serializers";
import { SessionError } from "./session-error";

type PolicyExecutionContext = Awaited<ReturnType<typeof loadSessionPolicyContext>>;
type LeasedSessionRecord = {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  runnerType: string;
  runnerLeaseId: string | null;
  sandboxLeaseId: string | null;
  containerId: string | null;
  startedAt: Date | null;
};
type NormalizedExecutionInput = {
  capability: CapabilityKind;
  subagentId: ComputeSubagentId;
  browserMode: BrowserExecutionMode;
  command: string | undefined;
  content: string | undefined;
  path: string | undefined;
  domain: string | undefined;
  url: string | undefined;
  task: string | undefined;
  nativeProvider: NativeComputerProvider | undefined;
  maxSteps: number;
  allowMutations: boolean;
  bindingId: string | undefined;
  bindingSlug: string | undefined;
  toolName: string | undefined;
  toolArguments: Record<string, unknown> | undefined;
  approvalRequired: boolean;
  workingDirectory: string | undefined;
  estimatedCostCents: number | undefined;
  hasPaidEntitlement: boolean;
};

type ExecutionPlan = {
  capability: CapabilityKind;
  requestedCommand: string | undefined;
  requestedPath: string | undefined;
  workingDirectory: string | undefined;
  runnerImage: string;
  command: string;
  networkMode: PolicyExecutionContext["profile"]["networkMode"];
  filesystemMode: PolicyExecutionContext["profile"]["filesystemMode"];
};

type SandboxLeaseForExecution = {
  id: string;
  provider: string;
  providerSandboxId: string | null;
  runnerLeaseId: string | null;
  containerId: string | null;
  sessionRoot: string | null;
  sandboxIdentityId: string;
};

type BrowserCaptureSummary = {
  transportKind: "playwright" | "openai_computer" | "claude_computer_use" | "opencode_computer_use";
  profilePath?: string;
  title?: string;
  finalUrl?: string;
  textSnippet?: string;
  screenshotArtifactId?: string;
  jsonArtifactId?: string;
  traceArtifactId?: string;
  nativeFinalText?: string | undefined;
};

type RuntimeExecutionResult = {
  exitCode: number;
  wallMs: number;
  bytesRead: number;
  artifacts: Awaited<ReturnType<typeof persistExecutionArtifacts>>;
  failureSummary?: string | undefined;
  browserCapture?: BrowserCaptureSummary | undefined;
  transport: "docker" | "mcp";
  remoteUrl?: string | undefined;
  providerCostCents?: number | undefined;
  browserCostCents?: number | undefined;
  mcpCostCents?: number | undefined;
  nativeComputerUse?:
    | {
        provider: NativeComputerProvider;
        executionMode: "native";
        maxSteps: number;
        allowMutations: boolean;
        traceArtifactId?: string | null | undefined;
        finalText?: string | null | undefined;
      }
    | undefined;
};

export async function executeTool(sessionId: string, rawInput: unknown) {
  const { input, context, decision, mcpBinding, sessionSubagentId } =
    await evaluateExecutionRequest(sessionId, rawInput);
  const normalized = normalizeExecutionInput(input, mcpBinding);
  const estimatedCredits = estimateCreditUsage({
    capability: normalized.capability,
    ...(typeof normalized.estimatedCostCents === "number"
      ? { estimatedCostCents: normalized.estimatedCostCents }
      : {}),
  });
  const budgetAvailability = summarizeBudgetAvailability(context.session);
  const effectiveDecision = resolveEffectiveDecision({
    context,
    input: normalized,
    decision,
    estimatedCredits,
    totalAvailableCredits: budgetAvailability.totalAvailableCredits,
  });

  await computeLifecycleHooks.emit({
    kind: "tool_preflight",
    scope: {
      representativeId: context.session.representativeId,
      representativeSlug: context.session.representative.slug,
      contactId: context.session.contactId ?? null,
      conversationId: context.session.conversationId ?? null,
    },
    sessionId,
    subagentId: sessionSubagentId,
    capability: normalized.capability,
    decision: effectiveDecision.decision,
    reason: effectiveDecision.reason,
    ...(normalized.command ? { requestedCommand: normalized.command } : {}),
    ...(normalized.path ? { requestedPath: normalized.path } : {}),
    ...(normalized.workingDirectory ? { workingDirectory: normalized.workingDirectory } : {}),
    estimatedCredits,
    ...(normalized.capability === "mcp"
      ? {
          transport: "mcp",
          ...(normalized.bindingId ? { bindingId: normalized.bindingId } : {}),
          ...(normalized.url ? { remoteUrl: normalized.url } : {}),
        }
      : {}),
  });

  if (effectiveDecision.decision === "deny") {
    const requestPayload = buildExecutionRequestPayload(normalized);
    return blockExecution({
      session: context.session,
      subagentId: sessionSubagentId,
      capability: normalized.capability,
      requestedCommand: getPersistedCommand(normalized),
      requestedPath: normalized.path,
      workingDirectory: normalized.workingDirectory,
      policyDecision: "deny",
      reason: effectiveDecision.reason,
      ...(requestPayload ? { requestPayload } : {}),
      mcpBindingId: normalized.bindingId,
      billing: {
        estimatedCredits,
        conversationBudgetRemainingCredits: budgetAvailability.conversationCredits,
        ownerBalanceCredits: budgetAvailability.ownerBalanceCredits,
        sponsorPoolCredit: budgetAvailability.sponsorPoolCredit,
      },
    });
  }

  if (effectiveDecision.decision === "ask") {
    const requestPayload = buildExecutionRequestPayload(normalized);
    const execution = await prisma.toolExecution.create({
      data: {
        sessionId,
        capability: mapCapabilityToDb(normalized.capability),
        subagentId: sessionSubagentId,
        status: "BLOCKED",
        requestedCommand: getPersistedCommand(normalized) ?? null,
        requestedPath: normalized.path ?? null,
        ...(requestPayload ? { requestPayload } : {}),
        workingDirectory: normalized.workingDirectory ?? null,
        mcpBindingId: normalized.bindingId ?? null,
        policyDecision: mapPolicyDecisionToDb("ask"),
      },
    });

    const approval = await createApprovalRequestForExecution({
      representativeId: context.session.representativeId,
      contactId: context.session.contactId ?? null,
      conversationId: context.session.conversationId ?? null,
      generationRunId: context.session.generationRunId ?? null,
      sessionId,
      executionId: execution.id,
      subagentId: sessionSubagentId,
      reason: effectiveDecision.reason,
      requestedActionSummary: summarizeAction(normalized),
      riskSummary: buildRiskSummary(effectiveDecision.reason),
      ...(requestPayload ? { requestPayloadHash: hashRequestPayload(requestPayload) } : {}),
      ...(effectiveDecision.matchedRuleId
        ? { matchedPolicyRuleId: effectiveDecision.matchedRuleId }
        : {}),
    });

    const session = await touchSessionIdle(sessionId);

    await prisma.eventAudit.create({
      data: {
        representativeId: context.session.representativeId,
        contactId: context.session.contactId ?? null,
        conversationId: context.session.conversationId ?? null,
        type: "TOOL_EXECUTION_BLOCKED",
        payload: {
          sessionId,
          executionId: execution.id,
          subagentId: sessionSubagentId,
          decision: "ask",
          reason: effectiveDecision.reason,
          approvalRequestId: approval.id,
        },
      },
    });

    return executeToolResponseSchema.parse({
      outcome: "pending_approval",
      session: serializeSession(session),
      execution: serializeExecution({
        ...execution,
        approvalRequestId: approval.id,
      }),
      approvalRequest: serializeApprovalRequest(approval),
      artifacts: [],
      billing: {
        estimatedCredits,
        conversationBudgetRemainingCredits: budgetAvailability.conversationCredits,
        ownerBalanceCredits: budgetAvailability.ownerBalanceCredits,
        sponsorPoolCredit: budgetAvailability.sponsorPoolCredit,
      },
    });
  }

  return runAllowedExecution({
    context,
    input: {
      ...normalized,
      subagentId: sessionSubagentId,
    },
    estimatedCredits,
  });
}

export async function resolveApproval(approvalId: string, rawInput: unknown) {
  const input = resolveApprovalRequestSchema.parse(rawInput);

  const approval = await prisma.approvalRequest.findUnique({
    where: { id: approvalId },
    include: {
      representative: {
        select: { computeMaxSessionMinutes: true },
      },
    },
  });

  if (!approval) {
    throw new SessionError(404, "approval_request_not_found");
  }

  if (approval.status !== "PENDING") {
    throw new SessionError(409, "approval_request_already_resolved");
  }

  const resolutionStartedAt = new Date();
  if (approval.expiresAt && approval.expiresAt <= resolutionStartedAt) {
    const didExpire = await prisma.$transaction(async (tx) => {
      const expired = await tx.approvalRequest.updateMany({
        where: {
          id: approval.id,
          status: "PENDING",
          expiresAt: { lte: resolutionStartedAt },
        },
        data: {
          status: "EXPIRED",
          resolvedAt: resolutionStartedAt,
          resolvedBy: "compute-broker",
        },
      });
      if (expired.count !== 1) return false;

      await tx.toolExecution.updateMany({
        where: {
          approvalRequestId: approval.id,
          status: "BLOCKED",
        },
        data: {
          status: "CANCELED",
          finishedAt: resolutionStartedAt,
        },
      });
      await tx.eventAudit.create({
        data: {
          representativeId: approval.representativeId,
          contactId: approval.contactId ?? null,
          conversationId: approval.conversationId ?? null,
          type: "APPROVAL_RESOLVED",
          payload: {
            approvalRequestId: approval.id,
            resolution: "expired",
            resolvedBy: "compute-broker",
          },
        },
      });
      await cancelApprovalWorkflowsTx(tx, {
        approvalId: approval.id,
        resolvedAt: resolutionStartedAt,
        outcome: "canceled_after_expiration",
      });
      return true;
    });

    if (didExpire) {
      await finalizeComputeApprovalConversation({
        approvalId: approval.id,
        outcome: "expired",
      });
      throw new SessionError(409, "approval_request_expired");
    }
    throw new SessionError(409, "approval_request_already_resolved");
  }

  const blockedExecution =
    approval.toolExecutionId
      ? await prisma.toolExecution.findUnique({
          where: { id: approval.toolExecutionId },
        })
      : null;

  if (approval.toolExecutionId && !blockedExecution) {
    throw new SessionError(409, "approval_request_execution_missing");
  }

  if (input.resolution === "rejected") {
    const resolvedAt = new Date();
    const { updatedApproval, updatedExecution, updatedSession } = await prisma.$transaction(
      async (tx) => {
        const claimedApproval = await tx.approvalRequest.updateMany({
          where: { id: approval.id, status: "PENDING" },
          data: {
            status: "REJECTED",
            resolvedAt,
            resolvedBy: input.resolvedBy ?? "owner-dashboard",
            decisionNote: input.decisionNote ?? null,
          },
        });
        if (claimedApproval.count !== 1) {
          throw new SessionError(409, "approval_request_already_resolved");
        }
        const nextApproval = await tx.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        });

        const nextExecution =
          blockedExecution
            ? await tx.toolExecution.update({
                where: { id: blockedExecution.id },
                data: {
                  status: "CANCELED",
                  finishedAt: resolvedAt,
                },
              })
            : null;

        const nextSession =
          approval.sessionId
            ? await tx.computeSession.update({
                where: { id: approval.sessionId },
                data: {
                  status: "IDLE",
                  lastHeartbeatAt: resolvedAt,
                },
              })
            : null;

        await tx.eventAudit.create({
          data: {
            representativeId: approval.representativeId,
            contactId: approval.contactId ?? null,
            conversationId: approval.conversationId ?? null,
            type: "APPROVAL_RESOLVED",
            payload: {
              approvalRequestId: approval.id,
              resolution: "rejected",
              toolExecutionId: approval.toolExecutionId ?? null,
              subagentId: blockedExecution?.subagentId ?? null,
            },
          },
        });

        await cancelApprovalWorkflowsTx(tx, {
          approvalId: approval.id,
          resolvedAt,
          outcome: "canceled_after_manual_rejection",
        });

        return {
          updatedApproval: nextApproval,
          updatedExecution: nextExecution,
          updatedSession: nextSession,
        };
      },
    );

    await finalizeComputeApprovalConversation({
      approvalId: approval.id,
      outcome: "rejected",
    });

    return resolveApprovalResponseSchema.parse({
      outcome: "rejected",
      approvalRequest: serializeApprovalRequest(updatedApproval),
      session: updatedSession ? serializeSession(updatedSession) : null,
      execution: updatedExecution ? serializeExecution(updatedExecution) : null,
      artifacts: [],
    });
  }

  const resolvedAt = new Date();
  const updatedApproval = await prisma.$transaction(async (tx) => {
    const claimedApproval = await tx.approvalRequest.updateMany({
      where: { id: approval.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        resolvedAt,
        resolvedBy: input.resolvedBy ?? "owner-dashboard",
        decisionNote: input.decisionNote ?? null,
      },
    });
    if (claimedApproval.count !== 1) {
      throw new SessionError(409, "approval_request_already_resolved");
    }
    const nextApproval = await tx.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    });

    if (blockedExecution) {
      const queued = await tx.toolExecution.updateMany({
        where: { id: blockedExecution.id, status: "BLOCKED" },
        data: { status: "QUEUED" },
      });
      if (queued.count !== 1) {
        throw new SessionError(409, "approval_request_execution_not_blocked");
      }
    }

    await tx.eventAudit.create({
      data: {
        representativeId: approval.representativeId,
        contactId: approval.contactId ?? null,
        conversationId: approval.conversationId ?? null,
        type: "APPROVAL_RESOLVED",
        payload: {
          approvalRequestId: approval.id,
          resolution: "approved",
          toolExecutionId: approval.toolExecutionId ?? null,
          subagentId: blockedExecution?.subagentId ?? null,
        },
      },
    });

    await cancelApprovalWorkflowsTx(tx, {
      approvalId: approval.id,
      resolvedAt,
      outcome: "canceled_after_manual_approval",
    });

    if (approval.contactId) {
      await tx.contact.update({
        where: { id: approval.contactId },
        data: {
          lastApprovalGrantedAt: resolvedAt,
        },
      });
    }

    if (approval.sessionId) {
      await tx.computeSession.update({
        where: { id: approval.sessionId },
        data: {
          expiresAt: new Date(
            resolvedAt.getTime() + approval.representative.computeMaxSessionMinutes * 60 * 1000,
          ),
          lastHeartbeatAt: resolvedAt,
          failureReason: null,
        },
      });
    }

    return nextApproval;
  });

  return resolveApprovalResponseSchema.parse({
    outcome: "approved",
    approvalRequest: serializeApprovalRequest(updatedApproval),
    execution: blockedExecution
      ? serializeExecution({ ...blockedExecution, status: "QUEUED" })
      : null,
    artifacts: [],
  });
}

export async function processNextApprovedExecution() {
  const queuedExecutions = await prisma.toolExecution.findMany({
    where: {
      status: "QUEUED",
      approvalRequestId: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let execution: (typeof queuedExecutions)[number] | null = null;
  let approval: Awaited<ReturnType<typeof prisma.approvalRequest.findUnique>> = null;
  for (const candidate of queuedExecutions) {
    if (!candidate.approvalRequestId) continue;
    const candidateApproval = await prisma.approvalRequest.findUnique({
      where: { id: candidate.approvalRequestId },
    });
    if (candidateApproval?.status === "APPROVED") {
      execution = candidate;
      approval = candidateApproval;
      break;
    }
  }
  if (!execution || !approval) return false;

  const claimed = await prisma.toolExecution.updateMany({
    where: { id: execution.id, status: "QUEUED" },
    data: { status: "RUNNING" },
  });
  if (claimed.count !== 1) return true;

  try {
    if (
      approval.requestPayloadHash &&
      hashRequestPayload(normalizePersistedRequestPayload(execution.requestPayload)) !==
        approval.requestPayloadHash
    ) {
      throw new SessionError(409, "approval_request_payload_changed");
    }
    const reconstructed = reconstructExecutionInput(execution);
    const rawRequest = toToolExecutionRequest(reconstructed);
    const evaluated = await evaluateExecutionRequest(execution.sessionId, rawRequest);
    const normalized = normalizeExecutionInput(evaluated.input, evaluated.mcpBinding);
    const estimatedCredits = estimateCreditUsage({
      capability: normalized.capability,
      ...(typeof normalized.estimatedCostCents === "number"
        ? { estimatedCostCents: normalized.estimatedCostCents }
        : {}),
    });
    const budget = summarizeBudgetAvailability(evaluated.context.session);
    const decision = resolveEffectiveDecision({
      context: evaluated.context,
      input: normalized,
      decision: evaluated.decision,
      estimatedCredits,
      totalAvailableCredits: budget.totalAvailableCredits,
    });

    if (decision.decision === "deny") {
      const now = new Date();
      await prisma.$transaction([
        prisma.toolExecution.update({
          where: { id: execution.id },
          data: { status: "CANCELED", finishedAt: now, policyDecision: "DENY" },
        }),
        prisma.computeSession.update({
          where: { id: execution.sessionId },
          data: { status: "IDLE", failureReason: decision.reason, lastHeartbeatAt: now },
        }),
      ]);
      await finalizeComputeApprovalConversation({
        approvalId: approval.id,
        outcome: "policy_denied",
        failureReason: decision.reason,
      });
      return true;
    }

    const result = await runAllowedExecution({
      context: evaluated.context,
      input: normalized,
      estimatedCredits,
      existingExecutionId: execution.id,
    });
    await finalizeComputeApprovalConversation({
      approvalId: approval.id,
      outcome: result.outcome === "completed" ? "completed" : "failed",
      artifacts: result.artifacts.map((artifact) => ({
        ...artifact,
        ...(artifact.kind === "file" && normalized.path
          ? { fileName: normalized.path.split("/").pop() || "result.txt" }
          : {}),
      })),
      ...(typeof result.billing?.actualCredits === "number"
        ? { actualCredits: result.billing.actualCredits }
        : {}),
      ...(result.session.failureReason ? { failureReason: result.session.failureReason } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "approved_compute_execution_failed";
    const now = new Date();
    await prisma.$transaction([
      prisma.toolExecution.updateMany({
        where: { id: execution.id, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: now },
      }),
      prisma.computeSession.updateMany({
        where: { id: execution.sessionId },
        data: { status: "IDLE", failureReason: reason.slice(0, 240), lastHeartbeatAt: now },
      }),
    ]);
    await finalizeComputeApprovalConversation({
      approvalId: approval.id,
      outcome: "failed",
      failureReason: reason,
    });
  }

  return true;
}

export async function listSessionArtifacts(sessionId: string) {
  const session = await prisma.computeSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new SessionError(404, "compute_session_not_found");
  }

  const artifacts = await prisma.artifact.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: "desc" }],
  });

  return listArtifactsResponseSchema.parse({
    session: serializeSession(session),
    artifacts: artifacts.map((artifact) => serializeArtifact(artifact)),
  });
}

export async function listSessionApprovals(sessionId: string) {
  const session = await prisma.computeSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new SessionError(404, "compute_session_not_found");
  }

  const approvals = await prisma.approvalRequest.findMany({
    where: { sessionId },
    orderBy: [{ requestedAt: "desc" }],
  });

  return listApprovalsResponseSchema.parse({
    session: serializeSession(session),
    approvals: approvals.map((approval) => serializeApprovalRequest(approval)),
  });
}

async function runAllowedExecution(params: {
  context: PolicyExecutionContext;
  input: NormalizedExecutionInput;
  estimatedCredits?: number;
  existingExecutionId?: string;
}) {
  const startedAt = new Date();
  const executionContext = resolveExecutionIsolationContext(params.context);
  const leasedSession = await ensureComputeSessionLease({
    session: executionContext.session,
    networkMode: executionContext.profile.networkMode,
    filesystemMode: executionContext.profile.filesystemMode,
  });
  const executionDescriptor = describeExecution(executionContext, params.input);
  const requestPayload = buildExecutionRequestPayload(params.input);
  const execution = params.existingExecutionId
    ? await prisma.toolExecution.update({
        where: { id: params.existingExecutionId },
        data: {
          status: "RUNNING",
          capability: mapCapabilityToDb(executionDescriptor.capability),
          subagentId: params.input.subagentId,
          requestedCommand: executionDescriptor.requestedCommand ?? null,
          requestedPath: executionDescriptor.requestedPath ?? null,
          ...(requestPayload ? { requestPayload } : {}),
          workingDirectory: executionDescriptor.workingDirectory ?? null,
          mcpBindingId: params.input.bindingId ?? null,
          policyDecision: mapPolicyDecisionToDb("allow"),
          startedAt,
          finishedAt: null,
          exitCode: null,
          cpuMs: null,
          wallMs: null,
          bytesRead: null,
          bytesWritten: null,
        },
      })
      : await prisma.toolExecution.create({
        data: {
          sessionId: params.context.session.id,
          capability: mapCapabilityToDb(executionDescriptor.capability),
          subagentId: params.input.subagentId,
          status: "RUNNING",
          requestedCommand: executionDescriptor.requestedCommand ?? null,
          requestedPath: executionDescriptor.requestedPath ?? null,
          ...(requestPayload ? { requestPayload } : {}),
          workingDirectory: executionDescriptor.workingDirectory ?? null,
          mcpBindingId: params.input.bindingId ?? null,
          policyDecision: mapPolicyDecisionToDb("allow"),
          startedAt,
        },
      });

  await prisma.computeSession.update({
    where: { id: leasedSession.id },
    data: {
      status: "RUNNING",
      startedAt: leasedSession.startedAt ?? startedAt,
      leaseLastUsedAt: startedAt,
      lastHeartbeatAt: startedAt,
      failureReason: null,
    },
  });

  const runtimeStartedAt = Date.now();
  const runtimeResult =
    await (async () => {
      try {
        return params.input.capability === "mcp"
          ? await runMcpExecution({
              context: executionContext,
              leasedSession,
              executionId: execution.id,
              input: params.input,
            })
          : await runContainerExecution({
              context: executionContext,
              leasedSession,
              executionId: execution.id,
              input: params.input,
            });
      } catch (error) {
        return {
          exitCode: 1,
          wallMs: Math.max(1, Date.now() - runtimeStartedAt),
          bytesRead: 0,
          artifacts: [],
          failureSummary:
            error instanceof Error ? error.message : "compute_execution_failed",
          browserCapture: undefined,
          transport: params.input.capability === "mcp" ? ("mcp" as const) : ("docker" as const),
          remoteUrl: undefined,
        } satisfies RuntimeExecutionResult;
      }
    })();

  const finishedAt = new Date();
  const totalArtifactBytes = runtimeResult.artifacts.reduce(
    (sum, artifact) => sum + artifact.sizeBytes,
    0,
  );
  const updatedExecution = await prisma.toolExecution.update({
    where: { id: execution.id },
    data: {
      status: runtimeResult.exitCode === 0 ? "SUCCEEDED" : "FAILED",
      finishedAt,
      exitCode: runtimeResult.exitCode,
      wallMs: runtimeResult.wallMs,
      cpuMs: null,
      bytesRead: runtimeResult.bytesRead,
      bytesWritten: totalArtifactBytes,
    },
  });

  const updatedSession = await prisma.computeSession.update({
    where: { id: leasedSession.id },
    data: {
      status: "IDLE",
      leaseLastUsedAt: finishedAt,
      lastHeartbeatAt: finishedAt,
      failureReason:
        runtimeResult.exitCode === 0 ? null : truncate(runtimeResult.failureSummary ?? "", 240),
    },
  });

  if (executionDescriptor.capability === "browser") {
    await recordBrowserNavigation({
      representativeId: params.context.session.representativeId,
      representativeSlug: params.context.session.representative.slug,
      contactId: params.context.session.contactId ?? null,
      conversationId: params.context.session.conversationId ?? null,
      computeSessionId: leasedSession.id,
      sandboxIdentityId: await resolveSandboxIdentityId(leasedSession),
      sandboxLeaseId: leasedSession.sandboxLeaseId,
      toolExecutionId: execution.id,
      transportKind: runtimeResult.browserCapture?.transportKind ?? "playwright",
      requestedUrl: params.input.url ?? executionDescriptor.requestedCommand ?? "https://invalid.local/",
      finalUrl: runtimeResult.browserCapture?.finalUrl,
      pageTitle: runtimeResult.browserCapture?.title,
      textSnippet: runtimeResult.browserCapture?.textSnippet,
      screenshotArtifactId: runtimeResult.browserCapture?.screenshotArtifactId,
      jsonArtifactId: runtimeResult.browserCapture?.jsonArtifactId,
      errorMessage: runtimeResult.exitCode === 0 ? null : runtimeResult.failureSummary,
      profilePath: runtimeResult.browserCapture?.profilePath ?? null,
      status: runtimeResult.exitCode === 0 ? "succeeded" : "failed",
    });
  }

  const computeCostCents = Math.max(1, Math.ceil(runtimeResult.wallMs / 1000));
  const storageCostCents = totalArtifactBytes > 0 ? Math.max(1, Math.ceil(totalArtifactBytes / 65536)) : 0;
  const computeCredits = estimateCreditUsage({
    capability: executionDescriptor.capability,
    estimatedCostCents:
      computeCostCents +
      (runtimeResult.browserCostCents ?? 0) +
      (runtimeResult.mcpCostCents ?? 0) +
      (runtimeResult.providerCostCents ?? 0),
  });
  const storageCredits = totalArtifactBytes > 0 ? Math.ceil(totalArtifactBytes / 65536) : 0;
  const billing = await applyExecutionBilling({
    representativeId: params.context.session.representativeId,
    contactId: params.context.session.contactId ?? null,
    conversationId: params.context.session.conversationId ?? null,
    sessionId: leasedSession.id,
    toolExecutionId: execution.id,
    ownerId: params.context.session.representative.owner.id,
    computeCredits,
    storageCredits,
    computeCostCents,
    browserCostCents: runtimeResult.browserCostCents ?? 0,
    providerCostCents: runtimeResult.providerCostCents ?? 0,
    mcpCostCents: runtimeResult.mcpCostCents ?? 0,
    storageCostCents,
    capability: executionDescriptor.capability,
    wallMs: runtimeResult.wallMs,
    artifactBytes: totalArtifactBytes,
    finishedAt,
  });

  await computeLifecycleHooks.emit({
    kind: "tool_completed",
    scope: {
      representativeId: params.context.session.representativeId,
      representativeSlug: params.context.session.representative.slug,
      contactId: params.context.session.contactId ?? null,
      conversationId: params.context.session.conversationId ?? null,
    },
    sessionId: params.context.session.id,
    executionId: execution.id,
    subagentId: params.input.subagentId,
    capability: executionDescriptor.capability,
    exitCode: runtimeResult.exitCode,
    wallMs: runtimeResult.wallMs,
    artifactCount: runtimeResult.artifacts.length,
    actualCredits: billing.actualCredits,
    ...(runtimeResult.transport
      ? {
          transport: runtimeResult.transport,
          ...(params.input.bindingId ? { bindingId: params.input.bindingId } : {}),
          ...(runtimeResult.remoteUrl ? { remoteUrl: runtimeResult.remoteUrl } : {}),
        }
      : {}),
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: params.context.session.representativeId,
      contactId: params.context.session.contactId ?? null,
      conversationId: params.context.session.conversationId ?? null,
      type: "BILLING_LEDGER_RECORDED",
      payload: {
        sessionId: leasedSession.id,
        executionId: execution.id,
        subagentId: params.input.subagentId,
        kinds:
          [
            "COMPUTE_MINUTES",
            ...(executionDescriptor.capability === "browser" ? ["BROWSER_MINUTES"] : []),
            ...(runtimeResult.providerCostCents && runtimeResult.providerCostCents > 0
              ? ["MODEL_USAGE"]
              : []),
            ...(runtimeResult.mcpCostCents && runtimeResult.mcpCostCents > 0
              ? ["MCP_CALLS"]
              : []),
            "STORAGE_BYTES",
          ],
        actualCredits: billing.actualCredits,
      },
    },
  });

  if (runtimeResult.nativeComputerUse) {
    return nativeComputerUseExecutionResponseSchema.parse({
      outcome: runtimeResult.exitCode === 0 ? "completed" : "failed",
      session: serializeSession(updatedSession),
      execution: serializeExecution(updatedExecution),
      artifacts: runtimeResult.artifacts.map((artifact) => serializeArtifact(artifact)),
      billing: {
        estimatedCredits: params.estimatedCredits,
        ...billing,
      },
      nativeComputerUse: runtimeResult.nativeComputerUse,
    });
  }

  return executeToolResponseSchema.parse({
    outcome: runtimeResult.exitCode === 0 ? "completed" : "failed",
    session: serializeSession(updatedSession),
    execution: serializeExecution(updatedExecution),
    artifacts: runtimeResult.artifacts.map((artifact) => serializeArtifact(artifact)),
    billing: {
      estimatedCredits: params.estimatedCredits,
      ...billing,
    },
  });
}

function resolveExecutionIsolationContext(context: PolicyExecutionContext): PolicyExecutionContext {
  if (context.session.requestedBy !== "AUDIENCE") return context;

  return {
    ...context,
    profile: {
      ...context.profile,
      filesystemMode: "ephemeral_full",
    },
  };
}

function describeExecution(
  context: PolicyExecutionContext,
  input: NormalizedExecutionInput,
) {
  if (input.capability === "mcp") {
    return {
      capability: "mcp" as const,
      subagentId: input.subagentId,
      requestedCommand: input.toolName,
      requestedPath: input.bindingSlug ?? input.bindingId,
      workingDirectory: undefined,
    };
  }

  if (input.capability === "browser" && input.browserMode === "native") {
    return {
      capability: "browser" as const,
      subagentId: input.subagentId,
      requestedCommand: input.url ?? input.task,
      requestedPath: undefined,
      workingDirectory: undefined,
    };
  }

  const plan = buildExecutionPlan(context, input);
  return {
    capability: plan.capability,
    subagentId: input.subagentId,
    requestedCommand: plan.requestedCommand,
    requestedPath: plan.requestedPath,
    workingDirectory: plan.workingDirectory,
  };
}

async function runContainerExecution(params: {
  context: PolicyExecutionContext;
  leasedSession: LeasedSessionRecord;
  executionId: string;
  input: NormalizedExecutionInput;
}): Promise<RuntimeExecutionResult> {
  if (params.input.capability === "browser" && params.input.browserMode === "native") {
    return runNativeBrowserExecution(params);
  }

  const executionPlan = buildExecutionPlan(params.context, params.input);
  const runnerResult = await runSandboxAwareExecution({
    leasedSession: params.leasedSession,
    command: executionPlan.command,
    maxCommandSeconds:
      executionPlan.capability === "browser"
        ? Math.max(params.context.profile.maxCommandSeconds, computeBrokerConfig.browserMaxCommandSeconds)
        : params.context.profile.maxCommandSeconds,
    filesystemMode: executionPlan.filesystemMode,
    workingDirectory: executionPlan.workingDirectory,
    sessionId: params.context.session.id,
    executionId: params.executionId,
  });

  const artifactResult =
    executionPlan.capability === "browser"
      ? await persistBrowserExecutionArtifacts({
          representativeId: params.context.session.representativeId,
          representativeSlug: params.context.session.representative.slug,
          contactId: params.context.session.contactId ?? null,
          conversationId: params.context.session.conversationId ?? null,
          sessionId: params.context.session.id,
          executionId: params.executionId,
          retentionDays: params.context.profile.artifactRetentionDays,
          stdout: runnerResult.stdout,
          stderr: runnerResult.stderr,
        })
      : {
          artifacts: await persistExecutionArtifacts({
            representativeId: params.context.session.representativeId,
            representativeSlug: params.context.session.representative.slug,
            contactId: params.context.session.contactId ?? null,
            conversationId: params.context.session.conversationId ?? null,
            sessionId: params.context.session.id,
            executionId: params.executionId,
            retentionDays: params.context.profile.artifactRetentionDays,
            stdout: runnerResult.stdout,
            stderr: runnerResult.stderr,
          }),
          browserCapture: undefined,
        };

  if (
    runnerResult.exitCode === 0 &&
    executionPlan.capability === "write" &&
    params.input.path &&
    typeof params.input.content === "string"
  ) {
    artifactResult.artifacts.unshift(
      await persistFileArtifact({
        representativeId: params.context.session.representativeId,
        representativeSlug: params.context.session.representative.slug,
        contactId: params.context.session.contactId ?? null,
        conversationId: params.context.session.conversationId ?? null,
        sessionId: params.context.session.id,
        executionId: params.executionId,
        retentionDays: params.context.profile.artifactRetentionDays,
        path: params.input.path,
        content: params.input.content,
      }),
    );
  }

  return {
    exitCode: runnerResult.exitCode,
    wallMs: runnerResult.wallMs,
    bytesRead: Buffer.byteLength(runnerResult.stdout, "utf8"),
    artifacts: artifactResult.artifacts,
    failureSummary: runnerResult.stderr || runnerResult.stdout,
    browserCapture: artifactResult.browserCapture,
    transport: "docker" as const,
    remoteUrl: undefined,
    providerCostCents: 0,
    browserCostCents:
      executionPlan.capability === "browser"
        ? Math.max(
            1,
            Math.ceil(
              (runnerResult.wallMs / 60000) * computeBrokerConfig.browserCostCentsPerMinute,
            ),
          )
        : 0,
    mcpCostCents: 0,
  };
}

async function runSandboxAwareExecution(params: {
  leasedSession: LeasedSessionRecord;
  command: string;
  maxCommandSeconds: number;
  filesystemMode: ComputeFilesystemMode;
  workingDirectory?: string | null | undefined;
  sessionId: string;
  executionId: string;
}) {
  const sandboxLease = await loadSandboxLeaseForExecution(params.leasedSession);
  const runnerType = mapRunnerTypeFromDb(params.leasedSession.runnerType);
  if (!sandboxLease) {
    return runRunnerExecution({
      runnerType,
      lease: {
        runnerType,
        leaseId: params.leasedSession.runnerLeaseId ?? params.leasedSession.id,
        containerId: params.leasedSession.containerId,
        containerName: params.leasedSession.containerId,
        sessionRoot: "/delegate-session",
      },
      command: params.command,
      maxCommandSeconds: params.maxCommandSeconds,
      filesystemMode: params.filesystemMode,
      workingDirectory: params.workingDirectory,
      sessionId: params.sessionId,
      executionId: params.executionId,
    });
  }

  const providerKind = mapSandboxProviderFromDb(sandboxLease.provider);
  const provider = await createSandboxProviderForExecution(providerKind);
  return provider.execute({
    runnerType,
    lease: buildSandboxProviderLease({
      leasedSession: params.leasedSession,
      sandboxLease,
      providerKind,
    }),
    command: params.command,
    maxCommandSeconds: params.maxCommandSeconds,
    filesystemMode: params.filesystemMode,
    workingDirectory: params.workingDirectory,
    sessionId: params.sessionId,
    executionId: params.executionId,
  });
}

async function createSandboxProviderForExecution(providerKind: "docker" | "daytona") {
  if (providerKind === "docker") {
    return createDockerSandboxProvider();
  }

  const configured = await createSandboxProviderFromConfig({
    ...computeBrokerConfig,
    sandboxProvider: "daytona",
  });
  if (configured.providerKind !== "daytona") {
    throw new Error("Daytona sandbox provider is not configured.");
  }
  return configured.provider;
}

function buildSandboxProviderLease(params: {
  leasedSession: LeasedSessionRecord;
  sandboxLease: SandboxLeaseForExecution;
  providerKind: "docker" | "daytona";
}): SandboxProviderLease {
  const runnerType = mapRunnerTypeFromDb(params.leasedSession.runnerType);
  const providerSandboxId =
    params.sandboxLease.providerSandboxId ??
    params.sandboxLease.runnerLeaseId ??
    params.leasedSession.runnerLeaseId ??
    params.sandboxLease.id;

  return {
    id: params.sandboxLease.id,
    provider: params.providerKind,
    runnerType,
    leaseId: params.sandboxLease.runnerLeaseId ?? params.leasedSession.runnerLeaseId ?? providerSandboxId,
    providerSandboxId,
    containerId: params.sandboxLease.containerId ?? params.leasedSession.containerId,
    containerName: params.sandboxLease.containerId ?? params.leasedSession.containerId,
    sessionRoot: params.sandboxLease.sessionRoot ?? "/delegate-session",
  };
}

async function loadSandboxLeaseForExecution(
  leasedSession: LeasedSessionRecord,
): Promise<SandboxLeaseForExecution | null> {
  if (!leasedSession.sandboxLeaseId) {
    return null;
  }

  return prisma.sandboxLease.findUnique({
    where: { id: leasedSession.sandboxLeaseId },
    select: {
      id: true,
      provider: true,
      providerSandboxId: true,
      runnerLeaseId: true,
      containerId: true,
      sessionRoot: true,
      sandboxIdentityId: true,
    },
  });
}

async function resolveSandboxIdentityId(leasedSession: LeasedSessionRecord) {
  const sandboxLease = await loadSandboxLeaseForExecution(leasedSession);
  return sandboxLease?.sandboxIdentityId ?? null;
}

function mapSandboxProviderFromDb(value: string) {
  return value.toLowerCase() as "docker" | "daytona";
}

async function runNativeBrowserExecution(params: {
  context: PolicyExecutionContext;
  leasedSession: LeasedSessionRecord;
  executionId: string;
  input: NormalizedExecutionInput;
}): Promise<RuntimeExecutionResult> {
  const seed = await loadLatestNativeBrowserSeed({
    computeSessionId: params.context.session.id,
    sandboxIdentityId: await resolveSandboxIdentityId(params.leasedSession),
  });
  const nativeResult = await executeNativeComputerUseLoop({
    task: params.input.task ?? "Inspect the retained browser session.",
    maxSteps: params.input.maxSteps,
    allowMutations: params.input.allowMutations,
    currentUrl: seed.currentUrl,
    currentTitle: seed.currentTitle,
    textSnippet: seed.textSnippet,
    screenshotBase64: seed.screenshotBase64,
    screenshotMimeType: seed.screenshotMimeType,
    ...(params.input.nativeProvider ? { provider: params.input.nativeProvider } : {}),
    executeActionBatch: async ({ transportKind, actions, currentUrl }) => {
      const runnerResult = await runSandboxAwareExecution({
        leasedSession: params.leasedSession,
        command: buildPlaywrightNativeCommand({
          transportKind,
          playwrightVersion: computeBrokerConfig.browserPlaywrightVersion,
          actions,
          currentUrl,
        }),
        maxCommandSeconds: Math.max(
          params.context.profile.maxCommandSeconds,
          computeBrokerConfig.browserMaxCommandSeconds,
        ),
        filesystemMode: "ephemeral_full",
        workingDirectory: undefined,
        sessionId: params.context.session.id,
        executionId: params.executionId,
      });

      const payload = parsePlaywrightBrowseArtifactPayload(runnerResult.stdout);
      if (!payload) {
        throw new SessionError(500, "native_browser_capture_invalid");
      }

      return payload;
    },
    executeOpenCodeComputerUse: async (input) => {
      const openCodeResult = await runSandboxAwareExecution({
        leasedSession: params.leasedSession,
        command: buildOpenCodeComputerUseCommand({
          opencodeCommand: input.providerConfig.command ?? "opencode",
          model: input.providerConfig.model,
          playwrightVersion: computeBrokerConfig.browserPlaywrightVersion,
          task: input.task,
          maxSteps: input.maxSteps,
          allowMutations: input.allowMutations,
          currentUrl: input.currentUrl,
          currentTitle: input.currentTitle,
          textSnippet: input.textSnippet,
          screenshotBase64: input.screenshotBase64,
          screenshotMimeType: input.screenshotMimeType,
        }),
        maxCommandSeconds: Math.max(
          params.context.profile.maxCommandSeconds,
          computeBrokerConfig.browserMaxCommandSeconds,
        ),
        filesystemMode: "ephemeral_full",
        workingDirectory: undefined,
        sessionId: params.context.session.id,
        executionId: params.executionId,
      });

      if (openCodeResult.exitCode !== 0) {
        throw new SessionError(500, "opencode_browser_run_failed");
      }

      const captureResult = await runSandboxAwareExecution({
        leasedSession: params.leasedSession,
        command: buildOpenCodeCaptureCommand(),
        maxCommandSeconds: Math.max(
          params.context.profile.maxCommandSeconds,
          computeBrokerConfig.browserMaxCommandSeconds,
        ),
        filesystemMode: "ephemeral_full",
        workingDirectory: undefined,
        sessionId: params.context.session.id,
        executionId: `${params.executionId}:capture`,
      });

      if (captureResult.exitCode !== 0) {
        throw new SessionError(500, "opencode_browser_capture_failed");
      }

      const payload = parsePlaywrightBrowseArtifactPayload(captureResult.stdout);
      if (!payload) {
        throw new SessionError(500, "opencode_browser_capture_invalid");
      }

      return {
        capture: payload,
        stdout: [openCodeResult.stdout, captureResult.stdout].filter(Boolean).join("\n"),
        stderr: [openCodeResult.stderr, captureResult.stderr].filter(Boolean).join("\n"),
      };
    },
  });

  const artifacts: Awaited<ReturnType<typeof persistExecutionArtifacts>> = [];
  let browserCapture: BrowserCaptureSummary | undefined;
  if (nativeResult.capture) {
    const captureArtifacts = await persistBrowserExecutionArtifacts({
      representativeId: params.context.session.representativeId,
      representativeSlug: params.context.session.representative.slug,
      contactId: params.context.session.contactId ?? null,
      conversationId: params.context.session.conversationId ?? null,
      sessionId: params.context.session.id,
      executionId: params.executionId,
      retentionDays: params.context.profile.artifactRetentionDays,
      stdout: JSON.stringify(nativeResult.capture),
      stderr: "",
    });
    artifacts.push(...captureArtifacts.artifacts);
    browserCapture = {
      ...captureArtifacts.browserCapture,
      transportKind: nativeResult.transportKind,
      nativeFinalText: nativeResult.finalText ?? undefined,
    };
  }

  const traceArtifact = await persistJsonArtifact({
    representativeId: params.context.session.representativeId,
    representativeSlug: params.context.session.representative.slug,
    contactId: params.context.session.contactId ?? null,
    conversationId: params.context.session.conversationId ?? null,
    sessionId: params.context.session.id,
    executionId: params.executionId,
    kind: "TRACE",
    retentionDays: params.context.profile.artifactRetentionDays,
    value: nativeResult.trace,
    summary: `${nativeResult.provider} native browser trace`,
  });
  artifacts.push(traceArtifact);

  browserCapture = {
    ...(browserCapture ?? {
      transportKind: nativeResult.transportKind,
    }),
    traceArtifactId: traceArtifact.id,
    nativeFinalText: nativeResult.finalText ?? undefined,
  };

  const traceBytes = Buffer.byteLength(JSON.stringify(nativeResult.trace), "utf8");

  return {
    exitCode: nativeResult.finalText || nativeResult.capture ? 0 : 1,
    wallMs: nativeResult.wallMs,
    bytesRead: traceBytes,
    artifacts,
    failureSummary: nativeResult.finalText ? undefined : "native_browser_loop_completed_without_final_text",
    browserCapture,
    transport: "docker",
    providerCostCents: nativeResult.usage.providerCostCents,
    browserCostCents: Math.max(
      1,
      Math.ceil((nativeResult.wallMs / 60000) * computeBrokerConfig.browserCostCentsPerMinute),
    ),
    mcpCostCents: 0,
    nativeComputerUse: {
      provider: nativeResult.provider,
      executionMode: "native",
      maxSteps: params.input.maxSteps,
      allowMutations: params.input.allowMutations,
      traceArtifactId: traceArtifact.id,
      finalText: nativeResult.finalText,
    },
  };
}

async function loadLatestNativeBrowserSeed(input: {
  computeSessionId: string;
  sandboxIdentityId?: string | null | undefined;
}): Promise<{
  currentUrl?: string | null;
  currentTitle?: string | null;
  textSnippet?: string | null;
  screenshotBase64: string;
  screenshotMimeType: "image/png" | "image/jpeg";
}> {
  const browserSession = input.sandboxIdentityId
    ? await prisma.browserSession.findFirst({
        where: {
          sandboxIdentityId: input.sandboxIdentityId,
        },
        orderBy: [{ updatedAt: "desc" }],
        include: {
          navigations: {
            orderBy: [{ createdAt: "desc" }],
            take: 1,
          },
        },
      })
    : await prisma.browserSession.findUnique({
        where: {
          computeSessionId: input.computeSessionId,
        },
        include: {
          navigations: {
            orderBy: [{ createdAt: "desc" }],
            take: 1,
          },
        },
      });

  const latestNavigation = browserSession?.navigations[0];
  if (!browserSession || !latestNavigation?.screenshotArtifactId) {
    throw new SessionError(409, "native_browser_seed_missing");
  }

  const screenshotArtifact = await prisma.artifact.findUnique({
    where: {
      id: latestNavigation.screenshotArtifactId,
    },
    select: {
      objectKey: true,
      mimeType: true,
    },
  });

  if (!screenshotArtifact) {
    throw new SessionError(409, "native_browser_screenshot_missing");
  }

  const screenshotBuffer = await readPersistedArtifactObject(screenshotArtifact.objectKey);

  return {
    currentUrl: browserSession.currentUrl,
    currentTitle: browserSession.currentTitle,
    textSnippet: latestNavigation.textSnippet,
    screenshotBase64: screenshotBuffer.toString("base64"),
    screenshotMimeType:
      screenshotArtifact.mimeType === "image/png" ? "image/png" : "image/jpeg",
  };
}

async function persistBrowserExecutionArtifacts(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  sessionId: string;
  executionId: string;
  retentionDays: number;
  stdout: string;
  stderr: string;
}) {
  const parsed = parsePlaywrightBrowseArtifactPayload(params.stdout);
  if (!parsed) {
    return {
      artifacts: await persistExecutionArtifacts(params),
      browserCapture: undefined,
    };
  }

  const artifacts = [];
  const summary = [parsed.title, parsed.finalUrl].filter(Boolean).join(" · ").slice(0, 240);

  const jsonArtifact = await persistJsonArtifact({
      representativeId: params.representativeId,
      representativeSlug: params.representativeSlug,
      contactId: params.contactId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      executionId: params.executionId,
      retentionDays: params.retentionDays,
      value: {
        title: parsed.title,
        finalUrl: parsed.finalUrl,
        textSnippet: parsed.textSnippet,
        contentSnippet: parsed.contentSnippet,
        links: parsed.links,
      },
      summary,
    });
  artifacts.push(jsonArtifact);

  const screenshotArtifact = await persistScreenshotArtifact({
      representativeId: params.representativeId,
      representativeSlug: params.representativeSlug,
      contactId: params.contactId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      executionId: params.executionId,
      retentionDays: params.retentionDays,
      body: Buffer.from(parsed.screenshotBase64, "base64"),
      mimeType: parsed.screenshotMimeType,
      summary,
    });
  artifacts.push(screenshotArtifact);

  if (params.stderr.length > 0) {
    const stderrArtifacts = await persistExecutionArtifacts({
      ...params,
      stdout: "",
      stderr: params.stderr,
    });
    artifacts.push(...stderrArtifacts);
  }

  return {
    artifacts,
    browserCapture: {
      transportKind: parsed.transportKind,
      profilePath: parsed.profilePath,
      title: parsed.title,
      finalUrl: parsed.finalUrl,
      textSnippet: parsed.textSnippet,
      screenshotArtifactId: screenshotArtifact.id,
      jsonArtifactId: jsonArtifact.id,
    },
  };
}

async function runMcpExecution(params: {
  context: PolicyExecutionContext;
  leasedSession: LeasedSessionRecord;
  executionId: string;
  input: NormalizedExecutionInput;
}): Promise<RuntimeExecutionResult> {
  const binding = await loadRepresentativeMcpBinding({
    representativeId: params.context.session.representativeId,
    bindingId: params.input.bindingId,
    bindingSlug: params.input.bindingSlug,
  });
  const resolved = resolveMcpToolName({
    binding,
    requestedToolName: params.input.toolName,
  });
  const startedAt = Date.now();
  let toolResult: Awaited<ReturnType<typeof callRemoteMcpTool>>;
  try {
    toolResult = await callRemoteMcpTool({
      binding: {
        ...binding,
        transportKind: binding.transportKind.toLowerCase() as "streamable_http" | "sse",
      },
      requestedToolName: resolved.toolName,
      toolArguments: params.input.toolArguments,
    });
    await recordRepresentativeMcpBindingSuccess(binding.id);
  } catch (error) {
    const failureReason =
      error instanceof McpTransportError
        ? truncate(error.message, 180)
        : error instanceof Error
          ? truncate(error.message, 180)
          : truncate(String(error), 180);

    await recordRepresentativeMcpBindingFailure({
      bindingId: binding.id,
      failureReason,
    });
    throw error;
  }

  const payload = {
    binding: {
      id: binding.id,
      slug: binding.slug,
      displayName: binding.displayName,
      serverUrl: binding.serverUrl,
      transportKind: binding.transportKind.toLowerCase(),
      toolName: toolResult.toolName,
      allowedToolNames: toolResult.allowedToolNames,
      availableToolNames: toolResult.availableToolNames,
      maxRetries: binding.maxRetries,
      retryBackoffMs: binding.retryBackoffMs,
      attempts: toolResult.attempts,
    },
    arguments: params.input.toolArguments ?? {},
    result: toolResult.result,
  };
  const artifact = await persistJsonArtifact({
    representativeId: params.context.session.representativeId,
    representativeSlug: params.context.session.representative.slug,
    contactId: params.context.session.contactId ?? null,
    conversationId: params.context.session.conversationId ?? null,
    sessionId: params.leasedSession.id,
    executionId: params.executionId,
    retentionDays: params.context.profile.artifactRetentionDays,
    value: payload,
    summary: toolResult.summary,
  });

  return {
    exitCode: 0,
    wallMs: Date.now() - startedAt,
    bytesRead: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    artifacts: [artifact],
    failureSummary: undefined,
    browserCapture: undefined,
    transport: "mcp" as const,
    remoteUrl: binding.serverUrl,
    providerCostCents: 0,
    browserCostCents: 0,
    mcpCostCents:
      typeof binding.estimatedCostCentsPerCall === "number"
        ? binding.estimatedCostCentsPerCall
        : computeBrokerConfig.mcpDefaultCostCentsPerCall,
  };
}

async function touchSessionIdle(sessionId: string) {
  return prisma.computeSession.update({
    where: { id: sessionId },
    data: {
      status: "IDLE",
      lastHeartbeatAt: new Date(),
    },
  });
}

async function blockExecution(params: {
  session: {
    id: string;
    representativeId: string;
    contactId: string | null;
    conversationId: string | null;
    subagentId: string | null;
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
    policyProfileId: string | null;
  };
  capability: CapabilityKind;
  subagentId: ComputeSubagentId;
  requestedCommand: string | undefined;
  requestedPath: string | undefined;
  workingDirectory: string | undefined;
  policyDecision: "deny" | "ask";
  reason: string;
  requestPayload?: string | undefined;
  mcpBindingId?: string | undefined;
  billing?: ExecutionBillingSummary;
}) {
  const execution = await prisma.toolExecution.create({
    data: {
      sessionId: params.session.id,
      capability: mapCapabilityToDb(params.capability),
      subagentId: params.subagentId,
      status: "BLOCKED",
      requestedCommand: params.requestedCommand ?? null,
      requestedPath: params.requestedPath ?? null,
      ...(params.requestPayload ? { requestPayload: params.requestPayload } : {}),
      workingDirectory: params.workingDirectory ?? null,
      mcpBindingId: params.mcpBindingId ?? null,
      policyDecision: mapPolicyDecisionToDb(params.policyDecision),
    },
  });

  const session = await touchSessionIdle(params.session.id);

  await prisma.eventAudit.create({
    data: {
      representativeId: params.session.representativeId,
      contactId: params.session.contactId ?? null,
      conversationId: params.session.conversationId ?? null,
      type: "TOOL_EXECUTION_BLOCKED",
      payload: {
        sessionId: params.session.id,
        executionId: execution.id,
        subagentId: params.subagentId,
        decision: params.policyDecision,
        reason: params.reason,
      },
    },
  });

  return executeToolResponseSchema.parse({
    outcome: "blocked",
    session: serializeSession(session),
    execution: serializeExecution(execution),
    artifacts: [],
    billing: params.billing,
  });
}

export function resolveEffectiveDecision(params: {
  context: PolicyExecutionContext;
  input: NormalizedExecutionInput;
  decision: {
    decision: "allow" | "ask" | "deny";
    reason: string;
    matchedRuleId?: string;
  };
  estimatedCredits: number;
  totalAvailableCredits: number;
}) {
  if (params.decision.decision === "deny") {
    return params.decision;
  }

  if (
    (params.input.capability === "exec" || params.input.capability === "process") &&
    params.input.command &&
    !isSimpleExecCommand(params.input.command)
  ) {
    return {
      decision: "ask" as const,
      reason: "complex_shell_command",
    };
  }

  if (params.input.capability === "browser" && params.context.profile.networkMode === "no_network") {
    return {
      decision: "deny" as const,
      reason: "browser_requires_network",
    };
  }

  if (params.input.capability === "browser" && params.context.profile.networkMode === "allowlist") {
    return {
      decision: "deny" as const,
      reason: "browser_allowlist_not_supported_yet",
    };
  }

  if (
    params.input.capability === "browser" &&
    params.input.browserMode === "native" &&
    params.input.allowMutations &&
    params.decision.decision === "allow"
  ) {
    return {
      decision: "ask" as const,
      reason: "native_browser_mutation_requires_approval",
    };
  }

  const subagentBudgetCredits = getComputeSubagentBudgetCredits(params.input.subagentId);
  if (params.estimatedCredits > subagentBudgetCredits && params.decision.decision === "allow") {
    return {
      decision: "ask" as const,
      reason: "subagent_budget_exceeded",
    };
  }

  if (params.input.capability === "mcp" && params.context.profile.networkMode === "no_network") {
    return {
      decision: "deny" as const,
      reason: "mcp_requires_network",
    };
  }

  if (params.input.capability === "mcp" && params.context.profile.networkMode === "allowlist") {
    const allowlist = normalizeNetworkAllowlist(params.context.profile.networkAllowlist);
    if (!allowlist.length) {
      return {
        decision: "deny" as const,
        reason: "network_allowlist_empty",
      };
    }

    const hostname = params.input.url ? extractHostname(params.input.url) : null;
    if (!hostname || !isHostnameAllowed(hostname, allowlist)) {
      return {
        decision: "deny" as const,
        reason: "domain_not_in_network_allowlist",
      };
    }
  }

  if (
    params.input.capability === "write" &&
    params.context.profile.filesystemMode === "read_only_workspace"
  ) {
    return {
      decision: "deny" as const,
      reason: "filesystem_read_only",
    };
  }

  if (
    params.context.session.representative.computeAutoApproveBudgetCents > 0 &&
    typeof params.input.estimatedCostCents === "number" &&
    params.input.estimatedCostCents > params.context.session.representative.computeAutoApproveBudgetCents &&
    params.decision.decision === "allow"
  ) {
    return {
      decision: "ask" as const,
      reason: "auto_approve_budget_exceeded",
    };
  }

  if (
    params.input.capability === "mcp" &&
    params.input.approvalRequired &&
    params.decision.decision === "allow"
  ) {
    return {
      decision: "ask" as const,
      reason: "mcp_binding_requires_approval",
    };
  }

  if (params.estimatedCredits > params.totalAvailableCredits) {
    return {
      decision: "deny" as const,
      reason: "insufficient_compute_budget",
    };
  }

  return params.decision;
}

function normalizeExecutionInput(
  input: ToolExecutionRequest,
  mcpBinding?: {
    id: string;
    slug: string;
    serverUrl: string;
    approvalRequired: boolean;
  } | null,
): NormalizedExecutionInput {
  switch (input.capability) {
    case "read": {
      if (!input.path) {
        throw new SessionError(400, "path_required_for_read");
      }
      return {
        capability: "read",
        subagentId: input.subagentId,
        browserMode: input.browserMode,
        command: undefined,
        content: undefined,
        path: input.path,
        domain: undefined,
        url: undefined,
        task: undefined,
        nativeProvider: undefined,
        maxSteps: input.maxSteps,
        allowMutations: input.allowMutations,
        bindingId: undefined,
        bindingSlug: undefined,
        toolName: undefined,
        toolArguments: undefined,
        approvalRequired: false,
        workingDirectory: input.workingDirectory,
        estimatedCostCents: input.estimatedCostCents,
        hasPaidEntitlement: input.hasPaidEntitlement,
      };
    }
    case "write": {
      const content = input.content ?? input.command;
      if (!input.path) {
        throw new SessionError(400, "path_required_for_write");
      }
      if (!content) {
        throw new SessionError(400, "content_required_for_write");
      }
      return {
        capability: "write",
        subagentId: input.subagentId,
        browserMode: input.browserMode,
        command: undefined,
        path: input.path,
        content,
        domain: undefined,
        url: undefined,
        task: undefined,
        nativeProvider: undefined,
        maxSteps: input.maxSteps,
        allowMutations: input.allowMutations,
        bindingId: undefined,
        bindingSlug: undefined,
        toolName: undefined,
        toolArguments: undefined,
        approvalRequired: false,
        workingDirectory: input.workingDirectory,
        estimatedCostCents: input.estimatedCostCents,
        hasPaidEntitlement: input.hasPaidEntitlement,
      };
    }
    case "browser": {
      const browserMode = input.browserMode ?? "deterministic";
      const url = input.url ?? input.command;
      if (browserMode === "deterministic" && !url) {
        throw new SessionError(400, "url_required_for_browser");
      }
      if (browserMode === "native" && !input.task) {
        throw new SessionError(400, "task_required_for_native_browser");
      }
      const parsed = url ? new URL(url) : null;
      return {
        capability: "browser",
        subagentId: input.subagentId,
        browserMode,
        command: undefined,
        content: undefined,
        path: undefined,
        url: parsed?.toString(),
        domain: input.domain ?? parsed?.hostname,
        task: browserMode === "native" ? input.task : undefined,
        nativeProvider: browserMode === "native" ? input.nativeProvider : undefined,
        maxSteps: browserMode === "native" ? input.maxSteps : 1,
        allowMutations: browserMode === "native" ? input.allowMutations : false,
        bindingId: undefined,
        bindingSlug: undefined,
        toolName: undefined,
        toolArguments: undefined,
        approvalRequired: false,
        workingDirectory: undefined,
        estimatedCostCents: input.estimatedCostCents,
        hasPaidEntitlement: input.hasPaidEntitlement,
      };
    }
    case "mcp": {
      if (!mcpBinding && !input.bindingId && !input.bindingSlug) {
        throw new SessionError(400, "mcp_binding_reference_required");
      }

      const bindingId = mcpBinding?.id ?? input.bindingId;
      const bindingSlug = mcpBinding?.slug ?? input.bindingSlug;
      const serverUrl = mcpBinding?.serverUrl;
      const toolName = input.toolName ?? input.command;

      if (!bindingId && !bindingSlug) {
        throw new SessionError(400, "mcp_binding_reference_required");
      }

      return {
        capability: "mcp",
        subagentId: input.subagentId,
        browserMode: input.browserMode,
        command: toolName,
        content: undefined,
        path: bindingSlug,
        domain: input.domain,
        url: serverUrl,
        task: undefined,
        nativeProvider: undefined,
        maxSteps: input.maxSteps,
        allowMutations: input.allowMutations,
        bindingId,
        bindingSlug,
        toolName,
        toolArguments: input.toolArguments,
        approvalRequired: mcpBinding?.approvalRequired ?? true,
        workingDirectory: undefined,
        estimatedCostCents: input.estimatedCostCents,
        hasPaidEntitlement: input.hasPaidEntitlement,
      };
    }
    case "process":
    case "exec":
    default: {
      if (!input.command) {
        throw new SessionError(400, "command_required_for_exec");
      }
      return {
        capability: input.capability,
        subagentId: input.subagentId,
        browserMode: input.browserMode,
        command: input.command,
        content: undefined,
        path: input.path,
        domain: input.domain,
        url: undefined,
        task: undefined,
        nativeProvider: undefined,
        maxSteps: input.maxSteps,
        allowMutations: input.allowMutations,
        bindingId: undefined,
        bindingSlug: undefined,
        toolName: undefined,
        toolArguments: undefined,
        approvalRequired: false,
        workingDirectory: input.workingDirectory,
        estimatedCostCents: input.estimatedCostCents,
        hasPaidEntitlement: input.hasPaidEntitlement,
      };
    }
  }
}

async function cancelApprovalWorkflowsTx(
  tx: Prisma.TransactionClient,
  params: {
    approvalId: string;
    resolvedAt: Date;
    outcome: string;
  },
) {
  const workflows = await tx.workflowRun.findMany({
    where: {
      approvalRequestId: params.approvalId,
      status: {
        in: ["QUEUED", "RUNNING"],
      },
    },
    select: {
      id: true,
      engine: true,
      externalWorkflowId: true,
    },
  });

  for (const workflow of workflows) {
    const needsTemporalCancel =
      workflow.engine === "TEMPORAL" && Boolean(workflow.externalWorkflowId);

    await tx.workflowRun.update({
      where: { id: workflow.id },
      data: {
        status: "CANCELED",
        enginePhase: needsTemporalCancel ? "CANCEL_REQUESTED" : "CANCELED",
        nextWakeAt: null,
        completedAt: params.resolvedAt,
        cancelRequestedAt: params.resolvedAt,
        lastObservedAt: params.resolvedAt,
        lastEngineError: null,
        output: {
          outcome: params.outcome,
        },
      },
    });

    if (needsTemporalCancel) {
      await tx.workflowCommandOutbox.create({
        data: {
          workflowRunId: workflow.id,
          commandType: "CANCEL",
          payload: {
            source: params.outcome,
            requestedAt: params.resolvedAt.toISOString(),
          },
        },
      });
    }
  }
}

function reconstructExecutionInput(execution: {
  capability: string;
  subagentId: string | null;
  mcpBindingId: string | null;
  requestedCommand: string | null;
  requestedPath: string | null;
  requestPayload: unknown;
  workingDirectory: string | null;
}) {
  const capability = mapCapabilityFromDb(execution.capability);
  const subagentId = resolveStoredExecutionSubagentId(execution.subagentId, capability);
  const persistedPayload =
    typeof execution.requestPayload === "string"
      ? safeParseExecutionPayload(execution.requestPayload)
      : execution.requestPayload && typeof execution.requestPayload === "object"
        ? (execution.requestPayload as Record<string, unknown>)
        : null;
  const hasPaidEntitlement = persistedPayload?.hasPaidEntitlement === true;
  const estimatedCostCents =
    typeof persistedPayload?.estimatedCostCents === "number"
      ? persistedPayload.estimatedCostCents
      : undefined;

  if (capability === "read") {
    if (!execution.requestedPath) {
      throw new SessionError(409, "approved_read_missing_path");
    }
    return normalizeExecutionInput({
      capability,
      subagentId,
      path: execution.requestedPath,
      hasPaidEntitlement,
      ...(estimatedCostCents !== undefined ? { estimatedCostCents } : {}),
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    });
  }

  if (capability === "write") {
    if (!execution.requestedPath || !execution.requestedCommand) {
      throw new SessionError(409, "approved_write_missing_payload");
    }
    return normalizeExecutionInput({
      capability,
      subagentId,
      path: execution.requestedPath,
      content: execution.requestedCommand,
      workingDirectory: execution.workingDirectory ?? undefined,
      hasPaidEntitlement,
      ...(estimatedCostCents !== undefined ? { estimatedCostCents } : {}),
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    });
  }

  if (capability === "browser") {
    const payload = persistedPayload;
    const browserMode =
      payload?.browserMode === "native" ? "native" : "deterministic";
    const task = typeof payload?.task === "string" ? payload.task : undefined;
    const nativeProvider =
      payload?.nativeProvider === "openai" ||
      payload?.nativeProvider === "anthropic" ||
      payload?.nativeProvider === "opencode"
        ? payload.nativeProvider
        : undefined;
    const maxSteps =
      typeof payload?.maxSteps === "number" && payload.maxSteps > 0
        ? payload.maxSteps
        : undefined;
    const allowMutations = payload?.allowMutations === true;
    if (browserMode === "deterministic" && !execution.requestedCommand) {
      throw new SessionError(409, "approved_browser_missing_url");
    }
    return normalizeExecutionInput({
      capability,
      subagentId,
      command: undefined,
      content: undefined,
      path: undefined,
      url: execution.requestedCommand ?? undefined,
      domain: undefined,
      workingDirectory: undefined,
      ...(estimatedCostCents !== undefined ? { estimatedCostCents } : {}),
      hasPaidEntitlement,
      browserMode,
      ...(task ? { task } : {}),
      ...(nativeProvider ? { nativeProvider } : {}),
      maxSteps: typeof maxSteps === "number" ? maxSteps : 3,
      allowMutations,
    });
  }

  if (capability === "mcp") {
    const payload = persistedPayload;
    const bindingId =
      typeof payload?.bindingId === "string" ? payload.bindingId : execution.mcpBindingId ?? undefined;
    const bindingSlug = typeof payload?.bindingSlug === "string" ? payload.bindingSlug : undefined;
    const toolName =
      typeof payload?.toolName === "string" ? payload.toolName : execution.requestedCommand ?? undefined;
    const toolArguments =
      payload?.toolArguments && typeof payload.toolArguments === "object"
        ? (payload.toolArguments as Record<string, unknown>)
        : undefined;

    return normalizeExecutionInput({
      capability,
      subagentId,
      bindingId,
      bindingSlug,
      toolName,
      toolArguments,
      hasPaidEntitlement,
      ...(estimatedCostCents !== undefined ? { estimatedCostCents } : {}),
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    });
  }

  if (!execution.requestedCommand) {
    throw new SessionError(409, "approved_execution_missing_command");
  }

  return normalizeExecutionInput({
    capability,
    subagentId,
    command: execution.requestedCommand,
    content: undefined,
    ...(execution.requestedPath ? { path: execution.requestedPath } : {}),
    domain: undefined,
    url: undefined,
    ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
    ...(estimatedCostCents !== undefined ? { estimatedCostCents } : {}),
    hasPaidEntitlement,
    browserMode: "deterministic",
    maxSteps: 1,
    allowMutations: false,
  });
}

function toToolExecutionRequest(input: NormalizedExecutionInput): ToolExecutionRequest {
  return {
    capability: input.capability,
    subagentId: input.subagentId,
    ...(input.command ? { command: input.command } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.path ? { path: input.path } : {}),
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.bindingId ? { bindingId: input.bindingId } : {}),
    ...(input.bindingSlug ? { bindingSlug: input.bindingSlug } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.toolArguments ? { toolArguments: input.toolArguments } : {}),
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    ...(typeof input.estimatedCostCents === "number"
      ? { estimatedCostCents: input.estimatedCostCents }
      : {}),
    hasPaidEntitlement: input.hasPaidEntitlement,
    browserMode: input.browserMode,
    ...(input.task ? { task: input.task } : {}),
    ...(input.nativeProvider ? { nativeProvider: input.nativeProvider } : {}),
    maxSteps: input.maxSteps,
    allowMutations: input.allowMutations,
  };
}

function resolveStoredExecutionSubagentId(
  rawSubagentId: string | null,
  capability: CapabilityKind,
): ComputeSubagentId {
  if (rawSubagentId === "compute-agent" || rawSubagentId === "browser-agent") {
    return rawSubagentId;
  }

  return resolveComputeSubagentIdForCapability(capability);
}

function safeParseExecutionPayload(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildExecutionPlan(
  context: PolicyExecutionContext,
  input: NormalizedExecutionInput,
): ExecutionPlan {
  switch (input.capability) {
    case "read":
      return {
        capability: "read",
        requestedCommand: input.path,
        requestedPath: input.path,
        workingDirectory: input.workingDirectory,
        runnerImage: context.session.baseImage,
        command: buildReadCommand(input.path!),
        networkMode: context.profile.networkMode,
        filesystemMode: context.profile.filesystemMode,
      };
    case "write":
      return {
        capability: "write",
        requestedCommand: input.content,
        requestedPath: input.path,
        workingDirectory: input.workingDirectory,
        runnerImage: context.session.baseImage,
        command: buildWriteCommand(input.path!, input.content!),
        networkMode: context.profile.networkMode,
        filesystemMode: context.profile.filesystemMode,
      };
    case "browser":
      return {
        capability: "browser",
        requestedCommand: input.url,
        requestedPath: undefined,
        workingDirectory: undefined,
        runnerImage: computeBrokerConfig.browserImage,
        command: buildPlaywrightBrowseCommand({
          url: input.url!,
          playwrightVersion: computeBrokerConfig.browserPlaywrightVersion,
        }),
        networkMode: context.profile.networkMode,
        filesystemMode: "ephemeral_full",
      };
    case "mcp":
      throw new SessionError(500, "mcp_execution_plan_not_supported");
    case "process":
      return {
        capability: "process",
        requestedCommand: input.command,
        requestedPath: input.path,
        workingDirectory: input.workingDirectory,
        runnerImage: context.session.baseImage,
        command: input.command!,
        networkMode: context.profile.networkMode,
        filesystemMode: context.profile.filesystemMode,
      };
    case "exec":
    default:
      return {
        capability: "exec",
        requestedCommand: input.command,
        requestedPath: input.path,
        workingDirectory: input.workingDirectory,
        runnerImage: context.session.baseImage,
        command: input.command!,
        networkMode: context.profile.networkMode,
        filesystemMode: context.profile.filesystemMode,
      };
  }
}

function getPersistedCommand(input: NormalizedExecutionInput) {
  switch (input.capability) {
    case "write":
      return input.content;
    case "browser":
      return input.browserMode === "native" ? input.url ?? input.task : input.url;
    case "mcp":
      return input.toolName;
    case "read":
      return input.path;
    case "process":
    case "exec":
    default:
      return input.command;
  }
}

function buildExecutionRequestPayload(input: NormalizedExecutionInput) {
  return JSON.stringify(toToolExecutionRequest(input));
}

function normalizePersistedRequestPayload(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function hashRequestPayload(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function buildRiskSummary(reason: string): string {
  switch (reason) {
    case "human_approval_required":
      return "This request matched a rule that requires explicit owner approval.";
    case "mcp_binding_requires_approval":
      return "This MCP binding is configured to require owner approval before any remote tool call.";
    case "cost_above_rule_limit":
    case "auto_approve_budget_exceeded":
      return "The estimated execution cost is above the current auto-approval ceiling.";
    case "paid_plan_required":
      return "This request requires a paid entitlement before execution.";
    case "complex_shell_command":
      return "The command uses shell control operators and must be reviewed before execution.";
    case "browser_requires_network":
      return "Browser automation requires a network-enabled policy profile.";
    case "native_browser_mutation_requires_approval":
      return "Native browser runs that may click, type, or submit data must be explicitly approved before execution.";
    case "mcp_requires_network":
      return "Remote MCP tools require a network-enabled policy profile.";
    case "filesystem_read_only":
      return "This representative is currently running with a read-only filesystem policy.";
    case "insufficient_compute_budget":
      return "The available compute credits are below the estimated charge for this run.";
    case "subagent_budget_exceeded":
      return "This request exceeds the credit cap for its delegated compute lane and must be reviewed.";
    default:
      return `Policy requested review before execution (${reason}).`;
  }
}

function summarizeAction(input: NormalizedExecutionInput) {
  switch (input.capability) {
    case "read":
      return `Read "${truncate(input.path ?? "", 120)}".`;
    case "write":
      return `Write to "${truncate(input.path ?? "", 120)}".`;
    case "browser":
      return input.browserMode === "native"
        ? `Run native browser task "${truncate(input.task ?? "", 120)}"${input.nativeProvider ? ` via ${input.nativeProvider}` : ""}.`
        : `Browse "${truncate(input.url ?? "", 120)}" in the isolated Playwright lane.`;
    case "mcp":
      return `Call MCP tool "${truncate(input.toolName ?? "", 120)}" via "${truncate(input.bindingSlug ?? input.bindingId ?? "", 120)}".`;
    case "process":
      return `Run process "${truncate(input.command ?? "", 120)}"${input.workingDirectory ? ` in ${input.workingDirectory}` : ""}.`;
    case "exec":
    default:
      return `Run "${truncate(input.command ?? "", 120)}"${input.workingDirectory ? ` in ${input.workingDirectory}` : ""}.`;
  }
}

function buildReadCommand(rawPath: string) {
  const target = shellQuote(normalizeContainerPath(rawPath));
  return [
    `target=${target}`,
    'if [ -d "$target" ]; then',
    '  ls -la "$target";',
    'elif [ -f "$target" ]; then',
    '  sed -n "1,200p" "$target";',
    "else",
    '  echo "Path not found: $target" >&2;',
    "  exit 2;",
    "fi",
  ].join("\n");
}

function buildWriteCommand(rawPath: string, content: string) {
  const target = normalizeContainerPath(rawPath);
  const delimiter = resolveHeredocDelimiter(content);
  return [
    `mkdir -p ${shellQuote(pathPosix.dirname(target))}`,
    `cat <<'${delimiter}' > ${shellQuote(target)}`,
    content,
    delimiter,
  ].join("\n");
}

function resolveHeredocDelimiter(content: string) {
  let delimiter = "DELEGATE_CONTENT";
  while (content.includes(delimiter)) {
    delimiter = `${delimiter}_${Math.random().toString(16).slice(2, 8)}`;
  }
  return delimiter;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function isSimpleExecCommand(value: string) {
  return !/[;&|><`$()\\\n\r]/.test(value);
}
