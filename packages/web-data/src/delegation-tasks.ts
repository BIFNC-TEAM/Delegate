import { createHash } from "node:crypto";

import {
  CapabilityKind,
  ConversationEpisodeStatus,
  DelegationTaskActorType,
  DelegationTaskNextActor,
  DelegationTaskStatus,
  DelegationTaskStepStatus,
  GenerationRunStatus,
  MessageDeliveryStatus,
  MessageSenderType,
  Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import { canonicalizeDelegationTaskEvent } from "./delegation-task-events";
import {
  buildDelegationApprovalPolicyExplanation,
  buildDelegationTaskOwnerActionAvailability,
} from "./delegation-task-product";

type ComputeCapability = "exec" | "read" | "write" | "process" | "browser" | "mcp";

export type DelegationTaskTerminalOutcome =
  | "completed"
  | "failed"
  | "blocked"
  | "rejected"
  | "expired";

export type DelegationTaskOwnerAction = "cancel" | "retry" | "continue";

export class DelegationTaskActionError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
    this.name = "DelegationTaskActionError";
  }
}

export type DelegationTaskDetailSnapshot = NonNullable<Awaited<ReturnType<typeof getRepresentativeDelegationTaskDetail>>>;

export async function createComputeDelegationTask(input: {
  representativeId: string;
  representativeVersionId?: string | null;
  contactId: string;
  conversationId: string;
  episodeId?: string | null;
  generationRunId: string;
  inputMessageId: string;
  objective: string;
  actionSummary: string;
  capability: ComputeCapability;
  maxDurationMinutes: number;
  maxCredits?: number | null;
  networkMode: "NO_NETWORK" | "ALLOWLIST" | "FULL";
  filesystemMode: "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL";
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.generationRunId}))`;
    const [run, conversation] = await Promise.all([
      tx.generationRun.findUnique({
        where: { id: input.generationRunId },
        select: {
          conversationId: true,
          episodeId: true,
          inputMessageId: true,
          representativeVersionId: true,
          delegationTaskId: true,
          delegationTaskStepId: true,
        },
      }),
      tx.conversation.findUnique({
        where: { id: input.conversationId },
        select: {
          representativeId: true,
          contactId: true,
          audienceIdentityId: true,
        },
      }),
    ]);
    if (
      !run ||
      !conversation ||
      run.conversationId !== input.conversationId ||
      run.inputMessageId !== input.inputMessageId ||
      run.episodeId !== (input.episodeId ?? null) ||
      run.representativeVersionId !== (input.representativeVersionId ?? null) ||
      conversation.representativeId !== input.representativeId ||
      conversation.contactId !== input.contactId
    ) {
      throw new Error("Delegation task context does not match its generation run and conversation.");
    }
    if (run.delegationTaskId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${run.delegationTaskId}))`;
    }
    const existing = run.delegationTaskId
      ? await tx.delegationTask.findFirst({
          where: {
            id: run.delegationTaskId,
            representativeId: input.representativeId,
            originConversationId: input.conversationId,
          },
          include: { steps: { orderBy: { sequence: "asc" }, take: 1 } },
        })
      : await tx.delegationTask.findUnique({
          where: { idempotencyKey: `compute-generation:${input.generationRunId}` },
          include: { steps: { orderBy: { sequence: "asc" }, take: 1 } },
        });
    if (existing) {
      if (run.delegationTaskStepId && existing.steps[0]?.id !== run.delegationTaskStepId) {
        throw new Error("Generation run delegation step does not match the task execution plan.");
      }
      if (
        existing.status !== DelegationTaskStatus.READY &&
        existing.status !== DelegationTaskStatus.FAILED
      ) {
        throw new Error("Delegation task is no longer executable.");
      }
      let current = existing;
      if (existing.status === DelegationTaskStatus.FAILED) {
        const task = await tx.delegationTask.update({
          where: { id: existing.id },
          data: {
            status: DelegationTaskStatus.READY,
            nextActionBy: DelegationTaskNextActor.SYSTEM,
            blockingReason: null,
            failedAt: null,
            version: { increment: 1 },
          },
        });
        if (existing.steps[0]) {
          await tx.delegationTaskStep.update({
            where: { id: existing.steps[0].id },
            data: {
              status: DelegationTaskStepStatus.READY,
              failedAt: null,
              completedAt: null,
            },
          });
        }
        await appendTaskEvent(tx, {
          taskId: existing.id,
          eventType: "task.retry_scheduled",
          actorType: DelegationTaskActorType.SYSTEM,
          fromStatus: DelegationTaskStatus.FAILED,
          toStatus: DelegationTaskStatus.READY,
          payload: { generationRunId: input.generationRunId },
        });
        current = { ...existing, ...task };
      }
      await linkGenerationToTask(tx, {
        taskId: existing.id,
        ...(existing.steps[0] ? { stepId: existing.steps[0].id } : {}),
        generationRunId: input.generationRunId,
        inputMessageId: input.inputMessageId,
      });
      return { task: current, step: existing.steps[0] ?? null };
    }

    const now = new Date();
    const task = await tx.delegationTask.create({
      data: {
        representativeId: input.representativeId,
        representativeVersionId: input.representativeVersionId ?? null,
        contactId: input.contactId,
        audienceIdentityId: conversation?.audienceIdentityId ?? null,
        originConversationId: input.conversationId,
        originEpisodeId: input.episodeId ?? null,
        kind: input.capability === "browser"
          ? "BROWSER"
          : input.capability === "mcp"
            ? "MCP"
            : "COMPUTE",
        initiatorType: "AUDIENCE",
        initiatorId: input.contactId,
        title: truncate(input.actionSummary, 160),
        objective: truncate(input.objective, 4_000),
        desiredOutcome: truncate(input.actionSummary, 1_000),
        status: DelegationTaskStatus.READY,
        nextActionBy: DelegationTaskNextActor.SYSTEM,
        idempotencyKey: `compute-generation:${input.generationRunId}`,
        planSummary: "在隔离沙盒中执行一个受策略约束的操作，并把结果返回原会话。",
        contextSnapshot: {
          source: "public_web_conversation",
          generationRunId: input.generationRunId,
          inputMessageId: input.inputMessageId,
        },
        resourcePolicy: {
          create: {
            maxDurationMinutes: input.maxDurationMinutes,
            maxComputeMinutes: input.maxDurationMinutes,
            maxCredits: input.maxCredits ?? null,
            maxToolCalls: 1,
            maxSteps: 1,
            allowedCapabilities: [mapCapability(input.capability)],
            networkMode: input.networkMode,
            filesystemMode: input.filesystemMode,
            snapshot: {
              source: "representative_compute_policy",
              capturedAt: now.toISOString(),
            },
          },
        },
        inputs: {
          create: {
            kind: "MESSAGE",
            referenceType: "Message",
            referenceId: input.inputMessageId,
            label: truncate(input.objective, 240),
            providedByType: "AUDIENCE",
            providedById: input.contactId,
            authorizationRequired: false,
          },
        },
        steps: {
          create: {
            sequence: 1,
            kind: input.capability === "browser"
              ? "COMPUTE"
              : input.capability === "mcp"
                ? "MCP"
                : "COMPUTE",
            title: truncate(input.actionSummary, 160),
            status: DelegationTaskStepStatus.READY,
            capability: mapCapability(input.capability),
            maxDurationSeconds: input.maxDurationMinutes * 60,
            inputSnapshot: {
              generationRunId: input.generationRunId,
              capability: input.capability,
            },
            idempotencyKey: `compute-step:${input.generationRunId}`,
          },
        },
        startedAt: now,
      },
      include: { steps: { orderBy: { sequence: "asc" }, take: 1 } },
    });
    const step = task.steps[0];
    if (!step) throw new Error("Delegation task compute step was not created.");
    if (input.capability === "mcp") {
      await tx.delegationTaskExternalEffect.create({
        data: {
          delegationTaskId: task.id,
          delegationTaskStepId: step.id,
          type: "mcp_tool_call",
          target: truncate(input.actionSummary, 500),
          action: "invoke",
          status: "PROPOSED",
          idempotencyKey: `mcp-effect:${input.generationRunId}`,
          requestPayload: {
            objective: truncate(input.objective, 4_000),
            actionSummary: truncate(input.actionSummary, 1_000),
          },
        },
      });
    }

    await linkGenerationToTask(tx, {
      taskId: task.id,
      stepId: step.id,
      generationRunId: input.generationRunId,
      inputMessageId: input.inputMessageId,
    });
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: "task.created",
      actorType: DelegationTaskActorType.AUDIENCE,
      actorId: input.contactId,
      toStatus: DelegationTaskStatus.READY,
      payload: { capability: input.capability, stepId: step.id },
    });
    return { task, step };
  });
}

export async function markDelegationTaskRunning(taskId: string) {
  return transitionDelegationTask({
    taskId,
    status: DelegationTaskStatus.RUNNING,
    stepStatus: DelegationTaskStepStatus.RUNNING,
    nextActionBy: DelegationTaskNextActor.SYSTEM,
    eventType: "task.execution_started",
    externalEffectStatus: "EXECUTING",
  });
}

export async function markDelegationTaskAwaitingApproval(input: {
  taskId: string;
  approvalId: string;
}) {
  return transitionDelegationTask({
    taskId: input.taskId,
    status: DelegationTaskStatus.AWAITING_APPROVAL,
    stepStatus: DelegationTaskStepStatus.WAITING_APPROVAL,
    nextActionBy: DelegationTaskNextActor.OWNER,
    blockingReason: "等待代表所有者审批",
    eventType: "task.approval_requested",
    payload: { approvalId: input.approvalId },
    approvalId: input.approvalId,
    externalEffectStatus: "WAITING_APPROVAL",
  });
}

export async function finalizeComputeDelegationTask(input: {
  taskId: string;
  outcome: DelegationTaskTerminalOutcome;
  artifacts?: Array<{ id: string; kind: string; summary?: string | null }>;
  failureReason?: string;
  actualCredits?: number;
}) {
  const terminal = mapTerminalOutcome(input.outcome);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`;
    const task = await tx.delegationTask.findUnique({
      where: { id: input.taskId },
      include: { steps: { orderBy: { sequence: "asc" }, take: 1 } },
    });
    if (!task) return null;
    if (isTerminalStatus(task.status)) {
      return { taskId: task.id, status: task.status };
    }
    const step = task.steps[0];
    const now = new Date();
    await tx.delegationTask.update({
      where: { id: task.id },
      data: {
        status: terminal.taskStatus,
        nextActionBy: DelegationTaskNextActor.NONE,
        blockingReason: input.failureReason?.slice(0, 1_000) ?? null,
        completedAt: terminal.taskStatus === DelegationTaskStatus.COMPLETED ? now : null,
        failedAt: terminal.taskStatus === DelegationTaskStatus.FAILED ? now : null,
        canceledAt: terminal.taskStatus === DelegationTaskStatus.CANCELED ? now : null,
        version: { increment: 1 },
      },
    });
    if (step) {
      await tx.delegationTaskStep.update({
        where: { id: step.id },
        data: {
          status: terminal.stepStatus,
          outputSnapshot: {
            outcome: input.outcome,
            artifactIds: input.artifacts?.map((artifact) => artifact.id) ?? [],
            ...(typeof input.actualCredits === "number" ? { actualCredits: input.actualCredits } : {}),
            ...(input.failureReason ? { failureReason: input.failureReason } : {}),
          },
          completedAt: terminal.stepStatus === DelegationTaskStepStatus.COMPLETED ? now : null,
          failedAt: terminal.stepStatus === DelegationTaskStepStatus.FAILED ? now : null,
        },
      });
    }
    const effects = await tx.delegationTaskExternalEffect.findMany({
      where: { delegationTaskId: task.id },
      select: { id: true },
    });
    if (effects.length) {
      const effectStatus = input.outcome === "completed"
        ? "SUCCEEDED"
        : input.outcome === "rejected" || input.outcome === "expired"
          ? "CANCELED"
          : "FAILED";
      await tx.delegationTaskExternalEffect.updateMany({
        where: { delegationTaskId: task.id },
        data: {
          status: effectStatus,
          responseSnapshot: {
            outcome: input.outcome,
            artifactIds: input.artifacts?.map((artifact) => artifact.id) ?? [],
          },
          executedAt: input.outcome === "completed" ? now : null,
          failureReason: input.failureReason?.slice(0, 1_000) ?? null,
        },
      });
      const existingEffectOutputs = await tx.delegationTaskOutput.findMany({
        where: { externalEffectId: { in: effects.map((effect) => effect.id) } },
        select: { externalEffectId: true },
      });
      const outputEffectIds = new Set(existingEffectOutputs.map((output) => output.externalEffectId));
      const missingEffectOutputs = effects.filter((effect) => !outputEffectIds.has(effect.id));
      if (missingEffectOutputs.length) {
        await tx.delegationTaskOutput.createMany({
          data: missingEffectOutputs.map((effect) => ({
            delegationTaskId: task.id,
            delegationTaskStepId: step?.id ?? null,
            kind: "EXTERNAL_EFFECT",
            externalEffectId: effect.id,
            title: input.outcome === "completed" ? "外部操作已完成" : "外部操作结果",
            summary: input.failureReason ?? input.outcome,
            isFinal: true,
          })),
        });
      }
    }

    const artifacts = input.artifacts ?? [];
    if (artifacts.length) {
      const artifactIds = artifacts.map((artifact) => artifact.id);
      const ownedArtifacts = await tx.artifact.findMany({
        where: {
          id: { in: artifactIds },
          representativeId: task.representativeId,
          delegationTaskId: task.id,
        },
        select: { id: true },
      });
      if (new Set(ownedArtifacts.map((artifact) => artifact.id)).size !== new Set(artifactIds).size) {
        throw new Error("Delegation task output contains an artifact from another task context.");
      }
      await tx.artifact.updateMany({
        where: { id: { in: artifactIds } },
        data: { delegationTaskId: task.id, delegationTaskStepId: step?.id ?? null },
      });
      const existingOutputs = await tx.delegationTaskOutput.findMany({
        where: { delegationTaskId: task.id, artifactId: { in: artifactIds } },
        select: { artifactId: true },
      });
      const existingArtifactIds = new Set(existingOutputs.map((output) => output.artifactId));
      await tx.delegationTaskOutput.updateMany({
        where: { delegationTaskId: task.id, artifactId: { in: artifactIds } },
        data: { isFinal: input.outcome === "completed" },
      });
      const missingOutputs = artifacts.filter((artifact) => !existingArtifactIds.has(artifact.id));
      if (missingOutputs.length) {
        await tx.delegationTaskOutput.createMany({
          data: missingOutputs.map((artifact) => ({
            delegationTaskId: task.id,
            delegationTaskStepId: step?.id ?? null,
            kind: "ARTIFACT",
            artifactId: artifact.id,
            title: truncate(artifact.summary || artifact.kind, 160),
            summary: artifact.summary ?? null,
            isFinal: input.outcome === "completed",
          })),
        });
      }
    }
    if (!(input.artifacts?.length)) {
      await tx.delegationTaskOutput.create({
        data: {
          delegationTaskId: task.id,
          delegationTaskStepId: step?.id ?? null,
          kind: "SUMMARY",
          title: input.outcome === "completed" ? "任务执行完成" : "任务执行结果",
          summary: input.failureReason ?? input.outcome,
          isFinal: true,
        },
      });
    }
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: `task.${input.outcome}`,
      actorType: DelegationTaskActorType.SYSTEM,
      fromStatus: task.status,
      toStatus: terminal.taskStatus,
      payload: {
        artifactIds: input.artifacts?.map((artifact) => artifact.id) ?? [],
        ...(typeof input.actualCredits === "number" ? { actualCredits: input.actualCredits } : {}),
        ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      },
    });
    return { taskId: task.id, status: terminal.taskStatus };
  });
}

export async function getRepresentativeDelegationTaskDetail(
  representativeSlug: string,
  taskId: string,
) {
  const task = await prisma.delegationTask.findFirst({
    where: { id: taskId, representative: { slug: representativeSlug } },
    include: {
      representative: { select: { slug: true, displayName: true } },
      representativeVersion: { select: { versionNumber: true, publishedAt: true } },
      contact: { select: { id: true, displayName: true, username: true } },
      resourcePolicy: true,
      inputs: { orderBy: { createdAt: "asc" } },
      dataGrants: { orderBy: { createdAt: "asc" } },
      steps: { orderBy: { sequence: "asc" } },
      approvalRequests: { orderBy: { requestedAt: "desc" }, take: 20 },
      outputs: {
        orderBy: { createdAt: "desc" },
        include: {
          artifact: {
            select: {
              id: true,
              kind: true,
              mimeType: true,
              sizeBytes: true,
              summary: true,
              retentionUntil: true,
              createdAt: true,
            },
          },
          deliverable: { select: { id: true, title: true, kind: true, visibility: true } },
          externalEffect: { select: { id: true, type: true, target: true, action: true, status: true } },
        },
      },
      externalEffects: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { sequence: "desc" }, take: 50 },
      ledgerEntries: {
        orderBy: { createdAt: "desc" },
        select: { id: true, kind: true, creditDelta: true, costCents: true, quantity: true, unit: true, createdAt: true },
      },
      generationRuns: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, status: true, attemptCount: true, errorCode: true, errorMessage: true, createdAt: true },
      },
      computeSessions: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, status: true, leaseStatus: true, runnerType: true, createdAt: true, endedAt: true, failureReason: true },
      },
    },
  });
  if (!task) return null;

  const pendingApproval = task.approvalRequests.find((approval) => approval.status === "PENDING");
  const actionAvailability = buildDelegationTaskOwnerActionAvailability({
    status: task.status,
    kind: task.kind,
    hasGenerationRun: task.generationRuns.length > 0,
    hasPendingApproval: Boolean(pendingApproval),
  });
  const creditsUsed = task.ledgerEntries.reduce(
    (total, entry) => total + Math.max(0, -entry.creditDelta),
    0,
  );
  const costCents = task.ledgerEntries.reduce((total, entry) => total + entry.costCents, 0);

  return {
    representative: task.representative,
    task: {
      id: task.id,
      title: task.title,
      objective: task.objective,
      desiredOutcome: task.desiredOutcome,
      kind: task.kind.toLowerCase(),
      initiatorType: task.initiatorType.toLowerCase(),
      status: task.status.toLowerCase(),
      nextActionBy: task.nextActionBy.toLowerCase(),
      ...(task.blockingReason ? { blockingReason: task.blockingReason } : {}),
      priority: task.priority,
      version: task.version,
      ...(task.deadlineAt ? { deadlineAt: task.deadlineAt.toISOString() } : {}),
      ...(task.startedAt ? { startedAt: task.startedAt.toISOString() } : {}),
      ...(task.completedAt ? { completedAt: task.completedAt.toISOString() } : {}),
      ...(task.failedAt ? { failedAt: task.failedAt.toISOString() } : {}),
      ...(task.canceledAt ? { canceledAt: task.canceledAt.toISOString() } : {}),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      ...(task.originConversationId ? { conversationId: task.originConversationId } : {}),
      ...(task.representativeVersion
        ? {
            representativeVersion: {
              versionNumber: task.representativeVersion.versionNumber,
              publishedAt: task.representativeVersion.publishedAt.toISOString(),
            },
          }
        : {}),
      ...(task.contact
        ? {
            contact: {
              id: task.contact.id,
              displayName: task.contact.displayName || "Anonymous visitor",
              ...(task.contact.username ? { username: task.contact.username } : {}),
            },
          }
        : {}),
    },
    plan: {
      summary: task.planSummary || "尚未记录计划摘要。",
      steps: task.steps.map((step) => ({
        id: step.id,
        sequence: step.sequence,
        kind: step.kind.toLowerCase(),
        title: step.title,
        ...(step.description ? { description: step.description } : {}),
        status: step.status.toLowerCase(),
        ...(step.capability ? { capability: step.capability.toLowerCase() } : {}),
        requiresApproval: step.requiresApproval,
        ...(step.maxCostCents !== null ? { maxCostCents: step.maxCostCents } : {}),
        ...(step.maxDurationSeconds !== null ? { maxDurationSeconds: step.maxDurationSeconds } : {}),
        dependsOnStepIds: step.dependsOnStepIds,
      })),
      policy: task.resourcePolicy
        ? {
            maxDurationMinutes: task.resourcePolicy.maxDurationMinutes,
            maxCostCents: task.resourcePolicy.maxCostCents,
            maxCredits: task.resourcePolicy.maxCredits,
            maxComputeMinutes: task.resourcePolicy.maxComputeMinutes,
            maxToolCalls: task.resourcePolicy.maxToolCalls,
            maxSteps: task.resourcePolicy.maxSteps,
            maxArtifactBytes: task.resourcePolicy.maxArtifactBytes,
            allowedCapabilities: task.resourcePolicy.allowedCapabilities.map((capability) => capability.toLowerCase()),
            allowedSkillSlugs: task.resourcePolicy.allowedSkillSlugs,
            allowedMcpBindingIds: task.resourcePolicy.allowedMcpBindingIds,
            allowedExternalAccountIds: task.resourcePolicy.allowedExternalAccountIds,
            networkMode: task.resourcePolicy.networkMode.toLowerCase(),
            filesystemMode: task.resourcePolicy.filesystemMode.toLowerCase(),
            requireApprovalForExternalSideEffects: task.resourcePolicy.requireApprovalForExternalSideEffects,
          }
        : null,
    },
    inputs: task.inputs.map((input) => ({
      id: input.id,
      kind: input.kind.toLowerCase(),
      label: input.label,
      referenceType: input.referenceType,
      authorizationRequired: input.authorizationRequired,
      createdAt: input.createdAt.toISOString(),
    })),
    dataGrants: task.dataGrants.map((grant) => ({
      id: grant.id,
      resourceType: grant.resourceType,
      resourceId: grant.resourceId,
      scopes: grant.scopes,
      purpose: grant.purpose,
      status: grant.status.toLowerCase(),
      grantedAt: grant.grantedAt.toISOString(),
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt.toISOString() } : {}),
    })),
    approvals: task.approvalRequests.map((approval) => ({
      id: approval.id,
      status: approval.status.toLowerCase(),
      requestedActionSummary: approval.requestedActionSummary,
      riskSummary: approval.riskSummary,
      reason: approval.reason,
      policy: {
        decision: "ask" as const,
        matchedRuleId: approval.matchedPolicyRuleId || null,
        requestFingerprint: approval.requestPayloadHash || null,
        explanation: buildDelegationApprovalPolicyExplanation(approval.reason, approval.matchedPolicyRuleId),
      },
      requestedAt: approval.requestedAt.toISOString(),
      ...(approval.expiresAt ? { expiresAt: approval.expiresAt.toISOString() } : {}),
      ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt.toISOString() } : {}),
      ...(approval.resolvedBy ? { resolvedBy: approval.resolvedBy } : {}),
      ...(approval.decisionNote ? { decisionNote: approval.decisionNote } : {}),
    })),
    outputs: task.outputs.map((output) => ({
      id: output.id,
      kind: output.kind.toLowerCase(),
      title: output.title,
      ...(output.summary ? { summary: output.summary } : {}),
      isFinal: output.isFinal,
      createdAt: output.createdAt.toISOString(),
      ...(output.artifact
        ? {
            artifact: {
              id: output.artifact.id,
              kind: output.artifact.kind.toLowerCase(),
              mimeType: output.artifact.mimeType,
              sizeBytes: output.artifact.sizeBytes,
              ...(output.artifact.summary ? { summary: output.artifact.summary } : {}),
              ...(output.artifact.retentionUntil ? { retentionUntil: output.artifact.retentionUntil.toISOString() } : {}),
              downloadUrl: `/api/dashboard/representatives/${encodeURIComponent(representativeSlug)}/compute/artifacts/${encodeURIComponent(output.artifact.id)}/download`,
            },
          }
        : {}),
      ...(output.deliverable ? { deliverable: { ...output.deliverable, kind: output.deliverable.kind.toLowerCase(), visibility: output.deliverable.visibility.toLowerCase() } } : {}),
      ...(output.externalEffect ? { externalEffect: { ...output.externalEffect, status: output.externalEffect.status.toLowerCase() } } : {}),
    })),
    externalEffects: task.externalEffects.map((effect) => ({
      id: effect.id,
      type: effect.type,
      target: effect.target,
      action: effect.action,
      status: effect.status.toLowerCase(),
      ...(effect.externalReferenceId ? { externalReferenceId: effect.externalReferenceId } : {}),
      ...(effect.failureReason ? { failureReason: effect.failureReason } : {}),
      createdAt: effect.createdAt.toISOString(),
    })),
    usage: { creditsUsed, costCents, ledgerEntryCount: task.ledgerEntries.length },
    attempts: task.generationRuns.map((run) => ({
      id: run.id,
      status: run.status.toLowerCase(),
      attemptCount: run.attemptCount,
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
      createdAt: run.createdAt.toISOString(),
    })),
    sessions: task.computeSessions.map((session) => ({
      id: session.id,
      status: session.status.toLowerCase(),
      leaseStatus: session.leaseStatus.toLowerCase(),
      runnerType: session.runnerType.toLowerCase(),
      createdAt: session.createdAt.toISOString(),
      ...(session.endedAt ? { endedAt: session.endedAt.toISOString() } : {}),
      ...(session.failureReason ? { failureReason: session.failureReason } : {}),
    })),
    timeline: task.events.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      eventType: event.eventType,
      actorType: event.actorType.toLowerCase(),
      ...(event.actorId ? { actorId: event.actorId } : {}),
      ...(event.fromStatus ? { fromStatus: event.fromStatus.toLowerCase() } : {}),
      ...(event.toStatus ? { toStatus: event.toStatus.toLowerCase() } : {}),
      occurredAt: event.occurredAt.toISOString(),
      eventHash: event.eventHash,
    })),
    actions: actionAvailability,
    pendingApprovalId: pendingApproval?.id ?? null,
  };
}

export async function applyRepresentativeDelegationTaskAction(input: {
  representativeSlug: string;
  taskId: string;
  action: DelegationTaskOwnerAction;
  actorId: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`;
    const task = await tx.delegationTask.findFirst({
      where: { id: input.taskId, representative: { slug: input.representativeSlug } },
      include: {
        generationRuns: { orderBy: { createdAt: "desc" }, take: 10 },
        steps: { orderBy: { sequence: "asc" }, take: 1 },
        approvalRequests: { where: { status: "PENDING" }, take: 1 },
      },
    });
    if (!task) throw new DelegationTaskActionError("Delegation task not found.", 404);
    const availability = buildDelegationTaskOwnerActionAvailability({
      status: task.status,
      kind: task.kind,
      hasGenerationRun: task.generationRuns.length > 0,
      hasPendingApproval: task.approvalRequests.length > 0,
    });
    const selected = availability[input.action];
    if (!selected.enabled) throw new DelegationTaskActionError(selected.reason);

    if (input.action === "cancel") {
      if (task.approvalRequests.length) {
        throw new DelegationTaskActionError("Pending approval must be rejected through the approval workflow.");
      }
      if (task.generationRuns.some((run) => run.status === GenerationRunStatus.PROCESSING)) {
        throw new DelegationTaskActionError("The task started running before cancellation could be claimed.");
      }
      const now = new Date();
      const queuedRunIds = task.generationRuns
        .filter((run) => run.status === GenerationRunStatus.QUEUED)
        .map((run) => run.id);
      if (queuedRunIds.length) {
        const claimedOutbox = await tx.outboxEvent.updateMany({
          where: {
            aggregateType: "generation_run",
            aggregateId: { in: queuedRunIds },
            status: { in: ["PENDING", "FAILED"] },
          },
          data: { status: "PROCESSED", processedAt: now, lastError: "delegation_task_canceled" },
        });
        if (claimedOutbox.count !== queuedRunIds.length) {
          throw new DelegationTaskActionError("The task started running before cancellation could claim its queue item.");
        }
      }
      const canceledRuns = await tx.generationRun.updateMany({
        where: { id: { in: queuedRunIds }, status: GenerationRunStatus.QUEUED },
        data: { status: GenerationRunStatus.CANCELED, canceledAt: now },
      });
      if (canceledRuns.count !== queuedRunIds.length) {
        throw new DelegationTaskActionError("The task started running before cancellation could update its generation attempt.");
      }
      await tx.delegationTask.update({
        where: { id: task.id },
        data: {
          status: DelegationTaskStatus.CANCELED,
          nextActionBy: DelegationTaskNextActor.NONE,
          blockingReason: "代表所有者已取消任务",
          canceledAt: now,
          version: { increment: 1 },
        },
      });
      await tx.delegationTaskStep.updateMany({
        where: { delegationTaskId: task.id, status: { notIn: ["COMPLETED", "CANCELED", "SKIPPED"] } },
        data: { status: DelegationTaskStepStatus.CANCELED, completedAt: now },
      });
      await tx.delegationTaskExternalEffect.updateMany({
        where: { delegationTaskId: task.id, status: { in: ["PROPOSED", "WAITING_APPROVAL", "APPROVED"] } },
        data: { status: "CANCELED", failureReason: "delegation_task_canceled" },
      });
      await createTaskSystemMessage(tx, {
        taskId: task.id,
        conversationId: task.originConversationId,
        episodeId: task.originEpisodeId,
        clientMessageId: `delegation-task-canceled:${task.id}:${task.version + 1}`,
        text: "委托任务已由代表所有者取消。",
      });
      await settleConversationAfterTaskAction(tx, task.originConversationId, task.originEpisodeId);
      await appendTaskEvent(tx, {
        taskId: task.id,
        eventType: "task.canceled_by_owner",
        actorType: DelegationTaskActorType.OWNER,
        actorId: input.actorId,
        fromStatus: task.status,
        toStatus: DelegationTaskStatus.CANCELED,
      });
      return;
    }

    const sourceRun = task.generationRuns[0];
    const step = task.steps[0];
    if (!sourceRun || !step || !task.originConversationId) {
      throw new DelegationTaskActionError("The task does not have a resumable execution context.");
    }
    const now = new Date();
    const nextVersion = task.version + 1;
    const run = await tx.generationRun.create({
      data: {
        conversationId: sourceRun.conversationId,
        episodeId: sourceRun.episodeId,
        inputMessageId: sourceRun.inputMessageId,
        representativeVersionId: task.representativeVersionId,
        delegationTaskId: task.id,
        delegationTaskStepId: step.id,
        status: GenerationRunStatus.QUEUED,
        idempotencyKey: `delegation-task:${task.id}:${input.action}:${nextVersion}`,
        contextSnapshot: {
          source: `owner_${input.action}`,
          previousGenerationRunId: sourceRun.id,
          requestedBy: input.actorId,
        },
      },
    });
    await tx.outboxEvent.create({
      data: {
        conversationId: sourceRun.conversationId,
        aggregateType: "generation_run",
        aggregateId: run.id,
        eventType: "generation.requested",
        payload: { runId: run.id, conversationId: sourceRun.conversationId, messageId: sourceRun.inputMessageId, taskId: task.id },
        idempotencyKey: `generation.requested:${run.id}`,
      },
    });
    await tx.delegationTask.update({
      where: { id: task.id },
      data: {
        status: DelegationTaskStatus.READY,
        nextActionBy: DelegationTaskNextActor.SYSTEM,
        blockingReason: null,
        failedAt: null,
        canceledAt: null,
        completedAt: null,
        version: { increment: 1 },
      },
    });
    await tx.delegationTaskStep.update({
      where: { id: step.id },
      data: {
        status: DelegationTaskStepStatus.READY,
        requiresApproval: false,
        approvedAt: null,
        failedAt: null,
        completedAt: null,
        outputSnapshot: Prisma.DbNull,
      },
    });
    if (input.action === "retry") {
      await tx.delegationTaskOutput.updateMany({
        where: { delegationTaskId: task.id, isFinal: true },
        data: { isFinal: false },
      });
    }
    await tx.conversation.update({
      where: { id: sourceRun.conversationId },
      data: { state: "AI_QUEUED", lastMessageAt: now },
    });
    if (sourceRun.episodeId) {
      await tx.conversationEpisode.updateMany({
        where: { id: sourceRun.episodeId },
        data: { status: ConversationEpisodeStatus.ACTIVE },
      });
    }
    await createTaskSystemMessage(tx, {
      taskId: task.id,
      conversationId: sourceRun.conversationId,
      episodeId: sourceRun.episodeId,
      clientMessageId: `delegation-task-${input.action}:${task.id}:${nextVersion}`,
      text: input.action === "retry"
        ? "代表所有者已重新安排此委托任务，系统会重新检查当前策略后执行。"
        : "代表所有者已继续此委托任务。",
    });
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: input.action === "retry" ? "task.retry_scheduled" : "task.continued_by_owner",
      actorType: DelegationTaskActorType.OWNER,
      actorId: input.actorId,
      fromStatus: task.status,
      toStatus: DelegationTaskStatus.READY,
      payload: { generationRunId: run.id, previousGenerationRunId: sourceRun.id },
    });
  });

  return getRepresentativeDelegationTaskDetail(input.representativeSlug, input.taskId);
}

async function transitionDelegationTask(input: {
  taskId: string;
  status: DelegationTaskStatus;
  stepStatus: DelegationTaskStepStatus;
  nextActionBy: DelegationTaskNextActor;
  eventType: string;
  blockingReason?: string;
  payload?: Prisma.InputJsonValue;
  approvalId?: string;
  externalEffectStatus?: "WAITING_APPROVAL" | "EXECUTING";
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`;
    const task = await tx.delegationTask.findUnique({
      where: { id: input.taskId },
      include: { steps: { orderBy: { sequence: "asc" }, take: 1 } },
    });
    if (!task) throw new Error("Delegation task not found.");
    if (isTerminalStatus(task.status)) return task;
    const now = new Date();
    const updated = await tx.delegationTask.update({
      where: { id: task.id },
      data: {
        status: input.status,
        nextActionBy: input.nextActionBy,
        blockingReason: input.blockingReason ?? null,
        startedAt: task.startedAt ?? now,
        version: { increment: 1 },
      },
    });
    if (task.steps[0]) {
      await tx.delegationTaskStep.update({
        where: { id: task.steps[0].id },
        data: {
          status: input.stepStatus,
          startedAt: task.steps[0].startedAt ?? now,
          ...(input.approvalId ? { requiresApproval: true } : {}),
        },
      });
      if (input.externalEffectStatus === "EXECUTING") {
        await tx.delegationTaskExternalEffect.updateMany({
          where: { delegationTaskId: task.id, approvalRequestId: { not: null } },
          data: { approvedAt: now },
        });
      }
    }
    if (input.externalEffectStatus) {
      await tx.delegationTaskExternalEffect.updateMany({
        where: { delegationTaskId: task.id },
        data: {
          status: input.externalEffectStatus,
          ...(input.approvalId ? { approvalRequestId: input.approvalId } : {}),
        },
      });
    }
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: input.eventType,
      actorType: DelegationTaskActorType.SYSTEM,
      fromStatus: task.status,
      toStatus: input.status,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
    return updated;
  });
}

async function linkGenerationToTask(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    stepId?: string;
    generationRunId: string;
    inputMessageId: string;
  },
) {
  await tx.generationRun.update({
    where: { id: input.generationRunId },
    data: {
      delegationTaskId: input.taskId,
      delegationTaskStepId: input.stepId ?? null,
    },
  });
  await tx.message.update({
    where: { id: input.inputMessageId },
    data: { delegationTaskId: input.taskId },
  });
}

async function appendTaskEvent(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    eventType: string;
    actorType: DelegationTaskActorType;
    actorId?: string;
    fromStatus?: DelegationTaskStatus;
    toStatus?: DelegationTaskStatus;
    payload?: Prisma.InputJsonValue;
  },
) {
  const previous = await tx.delegationTaskEvent.findFirst({
    where: { delegationTaskId: input.taskId },
    orderBy: { sequence: "desc" },
    select: { sequence: true, eventHash: true },
  });
  const occurredAt = new Date();
  const sequence = (previous?.sequence ?? 0) + 1;
  const eventHash = createHash("sha256")
    .update(canonicalizeDelegationTaskEvent({
      taskId: input.taskId,
      sequence,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      payload: input.payload ?? null,
      previousHash: previous?.eventHash ?? null,
      occurredAt: occurredAt.toISOString(),
    }))
    .digest("hex");
  return tx.delegationTaskEvent.create({
    data: {
      delegationTaskId: input.taskId,
      sequence,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      previousHash: previous?.eventHash ?? null,
      eventHash,
      occurredAt,
    },
  });
}

async function createTaskSystemMessage(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    conversationId: string | null;
    episodeId: string | null;
    clientMessageId: string;
    text: string;
  },
) {
  if (!input.conversationId) return;
  await tx.message.upsert({
    where: {
      conversationId_clientMessageId: {
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
      },
    },
    create: {
      conversationId: input.conversationId,
      episodeId: input.episodeId,
      delegationTaskId: input.taskId,
      senderType: MessageSenderType.SYSTEM,
      senderDisplayName: "Delegate",
      text: input.text,
      content: { kind: "delegation_task_status" },
      clientMessageId: input.clientMessageId,
      deliveryStatus: MessageDeliveryStatus.SENT,
    },
    update: {},
  });
}

async function settleConversationAfterTaskAction(
  tx: Prisma.TransactionClient,
  conversationId: string | null,
  episodeId: string | null,
) {
  if (!conversationId) return;
  await tx.conversation.update({
    where: { id: conversationId },
    data: { state: "WAITING_USER", lastMessageAt: new Date() },
  });
  if (episodeId) {
    await tx.conversationEpisode.updateMany({
      where: { id: episodeId },
      data: { status: ConversationEpisodeStatus.WAITING_USER },
    });
  }
}

function mapCapability(capability: ComputeCapability) {
  return capability.toUpperCase() as CapabilityKind;
}

function mapTerminalOutcome(outcome: DelegationTaskTerminalOutcome) {
  if (outcome === "completed") {
    return {
      taskStatus: DelegationTaskStatus.COMPLETED,
      stepStatus: DelegationTaskStepStatus.COMPLETED,
    };
  }
  if (outcome === "rejected") {
    return {
      taskStatus: DelegationTaskStatus.CANCELED,
      stepStatus: DelegationTaskStepStatus.CANCELED,
    };
  }
  if (outcome === "expired") {
    return {
      taskStatus: DelegationTaskStatus.EXPIRED,
      stepStatus: DelegationTaskStepStatus.CANCELED,
    };
  }
  return {
    taskStatus: DelegationTaskStatus.FAILED,
    stepStatus: DelegationTaskStepStatus.FAILED,
  };
}

function isTerminalStatus(status: DelegationTaskStatus) {
  const terminalStatuses = new Set<DelegationTaskStatus>([
    DelegationTaskStatus.COMPLETED,
    DelegationTaskStatus.FAILED,
    DelegationTaskStatus.CANCELED,
    DelegationTaskStatus.EXPIRED,
  ]);
  return terminalStatuses.has(status);
}

function truncate(value: string, limit: number) {
  const normalized = value.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
