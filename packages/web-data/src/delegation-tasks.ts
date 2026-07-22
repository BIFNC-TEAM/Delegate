import { createHash } from "node:crypto";

import {
  CapabilityKind,
  DelegationTaskActorType,
  DelegationTaskNextActor,
  DelegationTaskStatus,
  DelegationTaskStepStatus,
  Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import { canonicalizeDelegationTaskEvent } from "./delegation-task-events";

type ComputeCapability = "exec" | "read" | "write" | "process" | "browser" | "mcp";

export type DelegationTaskTerminalOutcome =
  | "completed"
  | "failed"
  | "blocked"
  | "rejected"
  | "expired";

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
    const existing = await tx.delegationTask.findUnique({
      where: { idempotencyKey: `compute-generation:${input.generationRunId}` },
      include: { steps: { orderBy: { sequence: "asc" }, take: 1 } },
    });
    if (existing) {
      if (existing.status === DelegationTaskStatus.FAILED) {
        await tx.delegationTask.update({
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
      }
      await linkGenerationToTask(tx, {
        taskId: existing.id,
        ...(existing.steps[0] ? { stepId: existing.steps[0].id } : {}),
        generationRunId: input.generationRunId,
        inputMessageId: input.inputMessageId,
      });
      return { task: existing, step: existing.steps[0] ?? null };
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
      const summaryExists = await tx.delegationTaskOutput.findFirst({
        where: { delegationTaskId: task.id, kind: "SUMMARY" },
        select: { id: true },
      });
      if (!summaryExists) {
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
