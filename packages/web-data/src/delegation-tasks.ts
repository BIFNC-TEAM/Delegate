import { createHash } from "node:crypto";

import {
  AgentUsageChargeStatus,
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
import type { ParsedComputeRequest } from "@delegate/runtime";

import {
  releaseConversationWalletUsage,
  settleConversationWalletUsage,
  transferAgentUsageEntitlementReservation,
  type UsageChargeClient,
} from "./agent-wallet-usage-charge";
import {
  fenceGenerationWorkLease,
  readGenerationWalletReservation,
} from "./conversation-platform";
import { prisma } from "./prisma";
import { canonicalizeDelegationTaskEvent } from "./delegation-task-events";
import {
  buildExternalEffectActionAvailability,
  readDelegationExternalEffectRequest,
  readDelegationTaskStepRequest,
  selectNextDelegationTaskStep,
  validateDelegationStepDependencies,
} from "./delegation-task-orchestration";
import {
  buildDelegationApprovalPolicyExplanation,
  buildDelegationTaskOwnerActionAvailability,
} from "./delegation-task-product";
import {
  finalizeConversationEntitlementForGenerationRuns,
  transferConversationEntitlementByGenerationRunId,
  type ServiceEntitlementClient,
} from "./service-entitlements";

type ComputeCapability = "exec" | "read" | "write" | "process" | "browser" | "mcp";

export type AuthorizedDelegationKnowledge = {
  assetId: string;
  title: string;
};

export type DelegationTaskTerminalOutcome =
  | "completed"
  | "failed"
  | "blocked"
  | "rejected"
  | "expired";

export type DelegationTaskOwnerAction = "cancel" | "retry" | "continue";
export type DelegationExternalEffectOwnerAction = "reconcile" | "retry" | "record_compensation";

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
  request: ParsedComputeRequest;
  planSummary?: string;
  planSteps?: Array<{
    summary: string;
    request: ParsedComputeRequest;
    dependsOnStepIndexes?: number[];
  }>;
  capability: ComputeCapability;
  maxDurationMinutes: number;
  maxCostCents?: number | null;
  maxCredits?: number | null;
  authorizedKnowledge?: AuthorizedDelegationKnowledge[];
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
          include: { steps: { orderBy: { sequence: "asc" }, take: 8 } },
        })
      : await tx.delegationTask.findUnique({
          where: { idempotencyKey: `compute-generation:${input.generationRunId}` },
          include: { steps: { orderBy: { sequence: "asc" }, take: 8 } },
        });
    if (existing) {
      const currentStep = run.delegationTaskStepId
        ? existing.steps.find((step) => step.id === run.delegationTaskStepId)
        : existing.steps[0];
      if (run.delegationTaskStepId && !currentStep) {
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
        if (currentStep) {
          await tx.delegationTaskStep.update({
            where: { id: currentStep.id },
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
        ...(currentStep ? { stepId: currentStep.id } : {}),
        generationRunId: input.generationRunId,
        inputMessageId: input.inputMessageId,
        request: input.request,
      });
      return { task: current, step: currentStep ?? null };
    }

    const now = new Date();
    const planSteps = input.planSteps?.length
      ? input.planSteps
      : [{ summary: input.actionSummary, request: input.request }];
    if (planSteps.length > 5) throw new Error("Delegation task plan exceeds the five-step P1 limit.");
    if (planSteps[0]?.request.capability !== input.capability) {
      throw new Error("Delegation task first plan step does not match the requested capability.");
    }
    const allowedCapabilities = [...new Set(
      planSteps.map((planned) => mapCapability(planned.request.capability)),
    )] as CapabilityKind[];
    const task = await tx.delegationTask.create({
      data: {
        representativeId: input.representativeId,
        representativeVersionId: input.representativeVersionId ?? null,
        contactId: input.contactId,
        audienceIdentityId: conversation?.audienceIdentityId ?? null,
        originConversationId: input.conversationId,
        originEpisodeId: input.episodeId ?? null,
        kind: planSteps.length > 1
          ? "WORKFLOW"
          : input.capability === "browser"
            ? "BROWSER"
            : input.capability === "mcp"
              ? "MCP"
              : "COMPUTE",
        initiatorType: "AUDIENCE",
        initiatorId: input.contactId,
        title: truncate(input.planSummary || input.actionSummary, 160),
        objective: truncate(input.objective, 4_000),
        desiredOutcome: truncate(input.planSummary || input.actionSummary, 1_000),
        status: DelegationTaskStatus.READY,
        nextActionBy: DelegationTaskNextActor.SYSTEM,
        idempotencyKey: `compute-generation:${input.generationRunId}`,
        planSummary: input.planSummary || (planSteps.length > 1
          ? `按依赖顺序执行 ${planSteps.length} 个受策略约束的步骤，并把最终结果返回原会话。`
          : "在隔离沙盒中执行一个受策略约束的操作，并把结果返回原会话。"),
        contextSnapshot: {
          source: "public_web_conversation",
          generationRunId: input.generationRunId,
          inputMessageId: input.inputMessageId,
        },
        resourcePolicy: {
          create: {
            maxDurationMinutes: input.maxDurationMinutes,
            maxComputeMinutes: input.maxDurationMinutes,
            maxCostCents: input.maxCostCents && input.maxCostCents > 0
              ? input.maxCostCents
              : null,
            maxCredits: input.maxCredits ?? null,
            maxToolCalls: planSteps.length,
            maxSteps: planSteps.length,
            allowedCapabilities,
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
        startedAt: now,
      },
    });
    await recordAuthorizedKnowledge(tx, task.id, input.authorizedKnowledge ?? []);
    const steps: Array<{ id: string; sequence: number }> = [];
    for (const [index, planned] of planSteps.entries()) {
      const dependencyIndexes = planned.dependsOnStepIndexes?.length
        ? planned.dependsOnStepIndexes
        : index > 0 ? [index - 1] : [];
      validateDelegationStepDependencies(dependencyIndexes, index);
      const step = await tx.delegationTaskStep.create({
        data: {
          delegationTaskId: task.id,
          sequence: index + 1,
          kind: planned.request.capability === "mcp" ? "MCP" : "COMPUTE",
          title: truncate(planned.summary, 160),
          status: index === 0 ? DelegationTaskStepStatus.READY : DelegationTaskStepStatus.DRAFT,
          capability: mapCapability(planned.request.capability),
          dependsOnStepIds: dependencyIndexes.map((dependencyIndex) => steps[dependencyIndex]!.id),
          maxDurationSeconds: Math.max(60, Math.floor(input.maxDurationMinutes * 60 / planSteps.length)),
          inputSnapshot: {
            request: planned.request as unknown as Prisma.InputJsonValue,
            source: "delegation_plan",
          },
          idempotencyKey: `compute-step:${input.generationRunId}:${index + 1}`,
        },
      });
      steps.push(step);
      if (planned.request.capability === "mcp") {
        await tx.delegationTaskExternalEffect.create({
          data: {
            delegationTaskId: task.id,
            delegationTaskStepId: step.id,
            type: "mcp_tool_call",
            target: truncate(planned.summary, 500),
            action: "invoke",
            status: "PROPOSED",
            idempotencyKey: `mcp-effect:${task.id}:${step.id}`,
            requestPayload: {
              request: planned.request as unknown as Prisma.InputJsonValue,
              objective: truncate(input.objective, 4_000),
              actionSummary: truncate(planned.summary, 1_000),
            },
          },
        });
      }
    }
    const step = steps[0];
    if (!step) throw new Error("Delegation task compute step was not created.");

    await linkGenerationToTask(tx, {
      taskId: task.id,
      stepId: step.id,
      generationRunId: input.generationRunId,
      inputMessageId: input.inputMessageId,
      request: planSteps[0]!.request,
    });
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: "task.created",
      actorType: DelegationTaskActorType.AUDIENCE,
      actorId: input.contactId,
      toStatus: DelegationTaskStatus.READY,
      payload: { capability: input.capability, stepId: step.id },
    });
    return { task: { ...task, steps }, step };
  });
}

export async function createClarifyingDelegationTask(input: {
  representativeId: string;
  representativeVersionId?: string | null;
  contactId: string;
  conversationId: string;
  episodeId?: string | null;
  generationRunId: string;
  inputMessageId: string;
  objective: string;
  summary: string;
  question: string;
  missingFields: string[];
  authorizedKnowledge?: AuthorizedDelegationKnowledge[];
  maxDurationMinutes: number;
  networkMode: "NO_NETWORK" | "ALLOWLIST" | "FULL";
  filesystemMode: "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL";
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.generationRunId}))`;
    const [run, conversation] = await Promise.all([
      tx.generationRun.findUnique({
        where: { id: input.generationRunId },
        include: { inputMessage: { select: { text: true } } },
      }),
      tx.conversation.findUnique({ where: { id: input.conversationId } }),
    ]);
    if (
      !run || !conversation || run.conversationId !== input.conversationId ||
      run.inputMessageId !== input.inputMessageId || conversation.representativeId !== input.representativeId ||
      conversation.contactId !== input.contactId
    ) {
      throw new Error("Clarifying delegation task context does not match its generation run and conversation.");
    }
    const existing = await tx.delegationTask.findUnique({
      where: { idempotencyKey: `compute-generation:${input.generationRunId}` },
      include: { steps: { orderBy: { sequence: "asc" }, take: 1 } },
    });
    if (existing) return { task: existing, step: existing.steps[0] ?? null };
    const now = new Date();
    const task = await tx.delegationTask.create({
      data: {
        representativeId: input.representativeId,
        representativeVersionId: input.representativeVersionId ?? null,
        contactId: input.contactId,
        audienceIdentityId: conversation.audienceIdentityId,
        originConversationId: input.conversationId,
        originEpisodeId: input.episodeId ?? null,
        kind: "WORKFLOW",
        initiatorType: "AUDIENCE",
        initiatorId: input.contactId,
        title: truncate(input.summary, 160),
        objective: truncate(input.objective, 4_000),
        desiredOutcome: truncate(input.summary, 1_000),
        status: DelegationTaskStatus.CLARIFYING,
        nextActionBy: DelegationTaskNextActor.AUDIENCE,
        blockingReason: truncate(input.question, 1_000),
        idempotencyKey: `compute-generation:${input.generationRunId}`,
        planSummary: "等待用户补齐执行所需的明确输入，系统不会猜测路径、内容、命令或 URL。",
        contextSnapshot: { source: "public_web_conversation", generationRunId: input.generationRunId },
        resourcePolicy: {
          create: {
            maxDurationMinutes: input.maxDurationMinutes,
            maxComputeMinutes: input.maxDurationMinutes,
            maxToolCalls: 5,
            maxSteps: 5,
            allowedCapabilities: [],
            networkMode: input.networkMode,
            filesystemMode: input.filesystemMode,
            snapshot: { source: "representative_compute_policy", capturedAt: now.toISOString() },
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
      },
    });
    await recordAuthorizedKnowledge(tx, task.id, input.authorizedKnowledge ?? []);
    const step = await tx.delegationTaskStep.create({
      data: {
        delegationTaskId: task.id,
        sequence: 1,
        kind: "CLARIFICATION",
        title: truncate(input.question, 160),
        status: DelegationTaskStepStatus.WAITING_INPUT,
        inputSnapshot: { missingFields: input.missingFields, question: input.question },
        idempotencyKey: `clarification-step:${input.generationRunId}`,
      },
    });
    await linkGenerationToTask(tx, {
      taskId: task.id,
      stepId: step.id,
      generationRunId: input.generationRunId,
      inputMessageId: input.inputMessageId,
    });
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: "task.clarification_requested",
      actorType: DelegationTaskActorType.SYSTEM,
      toStatus: DelegationTaskStatus.CLARIFYING,
      payload: { stepId: step.id, missingFields: input.missingFields },
    });
    return { task, step };
  });
}

export async function findConversationClarifyingDelegationTask(input: {
  representativeId: string;
  contactId: string;
  conversationId: string;
}) {
  return prisma.delegationTask.findFirst({
    where: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      originConversationId: input.conversationId,
      status: DelegationTaskStatus.CLARIFYING,
      nextActionBy: DelegationTaskNextActor.AUDIENCE,
    },
    orderBy: { updatedAt: "desc" },
    include: { steps: { orderBy: { sequence: "asc" }, take: 8 } },
  });
}

export async function continueClarifyingDelegationTask(input: {
  taskId: string;
  generationRunId: string;
  inputMessageId: string;
  contactId: string;
  question?: string;
  missingFields?: string[];
  planSummary?: string;
  planSteps?: Array<{ summary: string; request: ParsedComputeRequest; dependsOnStepIndexes?: number[] }>;
  authorizedKnowledge?: AuthorizedDelegationKnowledge[];
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`;
    const [task, run] = await Promise.all([
      tx.delegationTask.findUnique({
        where: { id: input.taskId },
        include: { steps: { orderBy: { sequence: "asc" }, take: 8 }, resourcePolicy: true },
      }),
      tx.generationRun.findUnique({
        where: { id: input.generationRunId },
        include: { inputMessage: { select: { text: true } } },
      }),
    ]);
    if (
      !task || !run || task.status !== DelegationTaskStatus.CLARIFYING ||
      task.contactId !== input.contactId || task.originConversationId !== run.conversationId ||
      run.inputMessageId !== input.inputMessageId
    ) {
      throw new DelegationTaskActionError("Clarifying task continuation context is invalid.");
    }
    const clarificationStep = task.steps.find((step) => step.kind === "CLARIFICATION");
    if (!clarificationStep) throw new DelegationTaskActionError("Clarification step was not found.");
    await recordAuthorizedKnowledge(tx, task.id, input.authorizedKnowledge ?? []);
    const existingInput = await tx.delegationTaskInput.findFirst({
      where: {
        delegationTaskId: task.id,
        referenceType: "Message",
        referenceId: input.inputMessageId,
      },
    });
    if (!existingInput) {
      await tx.delegationTaskInput.create({
        data: {
          delegationTaskId: task.id,
          kind: "MESSAGE",
          referenceType: "Message",
          referenceId: input.inputMessageId,
          label: truncate(run.inputMessage.text || "用户补充输入", 240),
          providedByType: "AUDIENCE",
          providedById: input.contactId,
          authorizationRequired: false,
        },
      });
    } else if (!input.planSteps?.length) {
      return {
        taskId: task.id,
        step: clarificationStep,
        ready: false,
        question: input.question || task.blockingReason || "请继续补充任务所需的信息。",
      };
    }
    if (!input.planSteps?.length) {
      const question = input.question || task.blockingReason || "请继续补充任务所需的信息。";
      await tx.delegationTask.update({
        where: { id: task.id },
        data: { blockingReason: truncate(question, 1_000), version: { increment: 1 } },
      });
      await tx.delegationTaskStep.update({
        where: { id: clarificationStep.id },
        data: { inputSnapshot: { question, missingFields: input.missingFields ?? [] } },
      });
      await linkGenerationToTask(tx, {
        taskId: task.id,
        stepId: clarificationStep.id,
        generationRunId: run.id,
        inputMessageId: run.inputMessageId,
      });
      await appendTaskEvent(tx, {
        taskId: task.id,
        eventType: "task.clarification_updated",
        actorType: DelegationTaskActorType.AUDIENCE,
        actorId: input.contactId,
        fromStatus: DelegationTaskStatus.CLARIFYING,
        toStatus: DelegationTaskStatus.CLARIFYING,
        payload: { messageId: input.inputMessageId, missingFields: input.missingFields ?? [] },
      });
      return { taskId: task.id, step: clarificationStep, ready: false, question };
    }
    const planSteps = input.planSteps;
    if (planSteps.length > 5) throw new DelegationTaskActionError("Delegation plan exceeds five execution steps.");
    await tx.delegationTaskStep.update({
      where: { id: clarificationStep.id },
      data: { status: DelegationTaskStepStatus.COMPLETED, completedAt: new Date() },
    });
    const createdSteps: Array<{ id: string; sequence: number }> = [];
    for (const [index, planned] of planSteps.entries()) {
      const dependencyIndexes = planned.dependsOnStepIndexes?.length
        ? planned.dependsOnStepIndexes
        : index > 0 ? [index - 1] : [];
      validateDelegationStepDependencies(dependencyIndexes, index);
      const step = await tx.delegationTaskStep.create({
        data: {
          delegationTaskId: task.id,
          sequence: index + 2,
          kind: planned.request.capability === "mcp" ? "MCP" : "COMPUTE",
          title: truncate(planned.summary, 160),
          status: index === 0 ? DelegationTaskStepStatus.READY : DelegationTaskStepStatus.DRAFT,
          capability: mapCapability(planned.request.capability),
          dependsOnStepIds: index === 0
            ? [clarificationStep.id]
            : dependencyIndexes.map((dependencyIndex) => createdSteps[dependencyIndex]!.id),
          maxDurationSeconds: Math.max(60, Math.floor((task.resourcePolicy?.maxDurationMinutes ?? 15) * 60 / planSteps.length)),
          inputSnapshot: { request: planned.request as unknown as Prisma.InputJsonValue, source: "clarification_resolved" },
          idempotencyKey: `clarified-step:${task.id}:${index + 1}`,
        },
      });
      createdSteps.push(step);
    }
    const firstStep = createdSteps[0]!;
    await tx.delegationTaskResourcePolicy.update({
      where: { delegationTaskId: task.id },
      data: {
        maxSteps: planSteps.length,
        maxToolCalls: planSteps.length,
        allowedCapabilities: [...new Set(planSteps.map((planned) => mapCapability(planned.request.capability)))] as CapabilityKind[],
      },
    });
    await tx.delegationTask.update({
      where: { id: task.id },
      data: {
        status: DelegationTaskStatus.READY,
        nextActionBy: DelegationTaskNextActor.SYSTEM,
        blockingReason: null,
        planSummary: input.planSummary || task.planSummary,
        version: { increment: 1 },
      },
    });
    await linkGenerationToTask(tx, {
      taskId: task.id,
      stepId: firstStep.id,
      generationRunId: run.id,
      inputMessageId: run.inputMessageId,
      request: planSteps[0]!.request,
    });
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: "task.clarification_resolved",
      actorType: DelegationTaskActorType.AUDIENCE,
      actorId: input.contactId,
      fromStatus: DelegationTaskStatus.CLARIFYING,
      toStatus: DelegationTaskStatus.READY,
      payload: { messageId: input.inputMessageId, firstStepId: firstStep.id, stepCount: planSteps.length },
    });
    return { taskId: task.id, step: firstStep, ready: true };
  });
}

export async function markDelegationTaskRunning(taskId: string, stepId?: string) {
  return transitionDelegationTask({
    taskId,
    ...(stepId ? { stepId } : {}),
    status: DelegationTaskStatus.RUNNING,
    stepStatus: DelegationTaskStepStatus.RUNNING,
    nextActionBy: DelegationTaskNextActor.SYSTEM,
    eventType: "task.execution_started",
    externalEffectStatus: "EXECUTING",
  });
}

export async function markDelegationTaskAwaitingApproval(input: {
  taskId: string;
  stepId?: string;
  approvalId: string;
}) {
  return transitionDelegationTask({
    taskId: input.taskId,
    ...(input.stepId ? { stepId: input.stepId } : {}),
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
  stepId?: string;
  generationRunId?: string;
  outboxId?: string;
  leaseAttempt?: number;
  outcome: DelegationTaskTerminalOutcome;
  artifacts?: Array<{ id: string; kind: string; summary?: string | null }>;
  failureReason?: string;
  actualCredits?: number;
}) {
  const terminal = mapTerminalOutcome(input.outcome);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`;
    const hasLeaseFence =
      input.outboxId !== undefined || input.leaseAttempt !== undefined;
    if (hasLeaseFence) {
      if (
        !input.generationRunId
        || !input.outboxId
        || input.leaseAttempt === undefined
      ) {
        throw new Error(
          "Delegation task lease fencing requires generationRunId, outboxId, and leaseAttempt.",
        );
      }
      await fenceGenerationWorkLease(tx, {
        runId: input.generationRunId,
        outboxId: input.outboxId,
        leaseAttempt: input.leaseAttempt,
      });
    }
    const task = await tx.delegationTask.findUnique({
      where: { id: input.taskId },
      include: {
        steps: { orderBy: { sequence: "asc" }, take: 8 },
        generationRuns: { orderBy: { createdAt: "desc" }, take: 20 },
      },
    });
    if (!task) return null;
    if (isTerminalStatus(task.status)) {
      return { taskId: task.id, status: task.status, hasMoreSteps: false };
    }
    const generationRun = input.generationRunId
      ? task.generationRuns.find((run) => run.id === input.generationRunId)
      : task.generationRuns.find((run) => run.delegationTaskStepId === input.stepId) ?? task.generationRuns[0];
    const resolvedStepId = input.stepId ?? generationRun?.delegationTaskStepId ?? null;
    const step = resolvedStepId
      ? task.steps.find((candidate) => candidate.id === resolvedStepId)
      : task.steps.find((candidate) => ["RUNNING", "WAITING_APPROVAL", "READY", "QUEUED"].includes(candidate.status));
    if (!step) throw new Error("Delegation task finalization could not resolve the active step.");
    if (step.status === DelegationTaskStepStatus.COMPLETED && input.outcome === "completed") {
      return { taskId: task.id, status: task.status, hasMoreSteps: !isTerminalStatus(task.status) };
    }
    const now = new Date();
    const artifactIds = input.artifacts?.map((artifact) => artifact.id) ?? [];
    await tx.delegationTaskStep.update({
      where: { id: step.id },
      data: {
        status: terminal.stepStatus,
        outputSnapshot: {
          outcome: input.outcome,
          artifactIds,
          ...(typeof input.actualCredits === "number" ? { actualCredits: input.actualCredits } : {}),
          ...(input.failureReason ? { failureReason: input.failureReason } : {}),
        },
        completedAt: terminal.stepStatus === DelegationTaskStepStatus.COMPLETED ? now : null,
        failedAt: terminal.stepStatus === DelegationTaskStepStatus.FAILED ? now : null,
      },
    });
    const effects = await tx.delegationTaskExternalEffect.findMany({
      where: { delegationTaskId: task.id, delegationTaskStepId: step.id },
      select: { id: true, status: true, responseSnapshot: true },
    });
    const hasUnknownExternalOutcome = input.outcome === "failed" && effects.some((effect) => effect.status === "EXECUTING");
    if (effects.length) {
      const effectStatus = input.outcome === "completed"
        ? "SUCCEEDED"
        : input.outcome === "rejected" || input.outcome === "expired"
          ? "CANCELED"
          : hasUnknownExternalOutcome ? "RECONCILIATION_REQUIRED" : "FAILED";
      await tx.delegationTaskExternalEffect.updateMany({
        where: { delegationTaskId: task.id, delegationTaskStepId: step.id },
        data: {
          status: effectStatus,
          responseSnapshot: {
            previous: effects[0]?.responseSnapshot ?? null,
            outcome: input.outcome,
            artifactIds,
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
            delegationTaskStepId: step.id,
            kind: "EXTERNAL_EFFECT",
            externalEffectId: effect.id,
            title: input.outcome === "completed" ? "外部操作已完成" : "外部操作结果",
            summary: input.failureReason ?? input.outcome,
            isFinal: false,
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
        data: { delegationTaskId: task.id, delegationTaskStepId: step.id },
      });
      const existingOutputs = await tx.delegationTaskOutput.findMany({
        where: { delegationTaskId: task.id, artifactId: { in: artifactIds } },
        select: { artifactId: true },
      });
      const existingArtifactIds = new Set(existingOutputs.map((output) => output.artifactId));
      await tx.delegationTaskOutput.updateMany({
        where: { delegationTaskId: task.id, artifactId: { in: artifactIds } },
        data: { isFinal: false },
      });
      const missingOutputs = artifacts.filter((artifact) => !existingArtifactIds.has(artifact.id));
      if (missingOutputs.length) {
        await tx.delegationTaskOutput.createMany({
          data: missingOutputs.map((artifact) => ({
            delegationTaskId: task.id,
            delegationTaskStepId: step.id,
            kind: "ARTIFACT",
            artifactId: artifact.id,
            title: truncate(artifact.summary || artifact.kind, 160),
            summary: artifact.summary ?? null,
            isFinal: false,
          })),
        });
      }
    }
    if (!input.artifacts?.length && input.outcome !== "completed") {
      await tx.delegationTaskOutput.create({
        data: {
          delegationTaskId: task.id,
          delegationTaskStepId: step.id,
          kind: "SUMMARY",
          title: "任务执行结果",
          summary: input.failureReason ?? input.outcome,
          isFinal: false,
        },
      });
    }

    let orchestrationFailureReason: string | null = null;
    if (input.outcome === "completed") {
      const projectedSteps = task.steps.map((candidate) => ({
          ...candidate,
          status: candidate.id === step.id ? "COMPLETED" : candidate.status,
        }));
      const nextStep = selectNextDelegationTaskStep(projectedSteps);
      if (nextStep) {
        const nextRequest = readDelegationTaskStepRequest(nextStep);
        if (!nextRequest || !generationRun) {
          throw new Error("Delegation task next step is missing a persisted request or generation context.");
        }
        const billingContext = await prepareDelegationBillingTransfer(
          tx,
          task.steps,
          task.generationRuns,
        );
        const nextRun = await tx.generationRun.create({
          data: {
            conversationId: generationRun.conversationId,
            episodeId: generationRun.episodeId,
            inputMessageId: generationRun.inputMessageId,
            representativeVersionId: task.representativeVersionId,
            delegationTaskId: task.id,
            delegationTaskStepId: nextStep.id,
            status: GenerationRunStatus.QUEUED,
            idempotencyKey: `delegation-step:${task.id}:${nextStep.id}`,
            contextSnapshot: {
              source: "delegation_plan_step",
              request: nextRequest as unknown as Prisma.InputJsonValue,
              previousGenerationRunId: generationRun.id,
            },
            ...(billingContext
              ? {
                  runtimePolicySnapshot:
                    billingContext.runtimePolicySnapshot as Prisma.InputJsonValue,
                }
              : {}),
          },
        });
        await transferConversationEntitlementByGenerationRunId(
          {
            fromGenerationRunId: generationRun.id,
            toGenerationRunId: nextRun.id,
          },
          tx as unknown as ServiceEntitlementClient,
        );
        if (billingContext) {
          if (billingContext.mode === "service_credit") {
            await transferAgentUsageEntitlementReservation(
              {
                usageChargeId: billingContext.walletReservation.usageChargeId,
                fromGenerationRunId: billingContext.ownerRunId,
                toGenerationRunId: nextRun.id,
                conversationId: billingContext.conversationId,
              },
              tx as unknown as UsageChargeClient,
            );
          }
          await tx.generationRun.update({
            where: { id: billingContext.ownerRunId },
            data: {
              runtimePolicySnapshot: markDelegationBillingTransferred(
                billingContext.runtimePolicySnapshot,
                nextRun.id,
              ),
            },
          });
        }
        await tx.outboxEvent.create({
          data: {
            conversationId: generationRun.conversationId,
            aggregateType: "generation_run",
            aggregateId: nextRun.id,
            eventType: "generation.requested",
            payload: {
              runId: nextRun.id,
              conversationId: generationRun.conversationId,
              messageId: generationRun.inputMessageId,
              taskId: task.id,
              stepId: nextStep.id,
            },
            idempotencyKey: `generation.requested:${nextRun.id}`,
          },
        });
        await tx.delegationTaskStep.update({
          where: { id: nextStep.id },
          data: { status: DelegationTaskStepStatus.READY },
        });
        await tx.delegationTask.update({
          where: { id: task.id },
          data: {
            status: DelegationTaskStatus.READY,
            nextActionBy: DelegationTaskNextActor.SYSTEM,
            blockingReason: null,
            version: { increment: 1 },
          },
        });
        await tx.conversation.update({
          where: { id: generationRun.conversationId },
          data: { state: "AI_QUEUED", lastMessageAt: now },
        });
        if (generationRun.episodeId) {
          await tx.conversationEpisode.updateMany({
            where: { id: generationRun.episodeId },
            data: { status: ConversationEpisodeStatus.ACTIVE },
          });
        }
        await appendTaskEvent(tx, {
          taskId: task.id,
          eventType: "task.step_completed",
          actorType: DelegationTaskActorType.SYSTEM,
          fromStatus: task.status,
          toStatus: DelegationTaskStatus.READY,
          payload: { stepId: step.id, nextStepId: nextStep.id, generationRunId: nextRun.id, artifactIds },
        });
        return {
          taskId: task.id,
          status: DelegationTaskStatus.READY,
          hasMoreSteps: true,
          nextGenerationRunId: nextRun.id,
          completedStepId: step.id,
        };
      }
      if (projectedSteps.some((candidate) => !["COMPLETED", "SKIPPED"].includes(candidate.status))) {
        orchestrationFailureReason = "任务计划仍有未完成步骤，但没有满足依赖条件的下一步。";
      }
    }

    const finalTaskStatus = hasUnknownExternalOutcome
      ? DelegationTaskStatus.WAITING_FOR_OWNER
      : orchestrationFailureReason
        ? DelegationTaskStatus.FAILED
        : terminal.taskStatus;
    const finalNextActor = hasUnknownExternalOutcome
      ? DelegationTaskNextActor.OWNER
      : DelegationTaskNextActor.NONE;
    const finalReason = hasUnknownExternalOutcome
      ? "MCP 外部操作结果未知，需要 Owner 对账后才能重试或结束任务。"
      : orchestrationFailureReason
        ? orchestrationFailureReason
        : input.failureReason?.slice(0, 1_000) ?? null;
    await tx.delegationTask.update({
      where: { id: task.id },
      data: {
        status: finalTaskStatus,
        nextActionBy: finalNextActor,
        blockingReason: finalReason,
        completedAt: finalTaskStatus === DelegationTaskStatus.COMPLETED ? now : null,
        failedAt: finalTaskStatus === DelegationTaskStatus.FAILED ? now : null,
        canceledAt: finalTaskStatus === DelegationTaskStatus.CANCELED ? now : null,
        version: { increment: 1 },
      },
    });
    if (finalTaskStatus !== DelegationTaskStatus.COMPLETED) {
      await tx.delegationTaskStep.updateMany({
        where: {
          delegationTaskId: task.id,
          id: { not: step.id },
          status: { in: ["DRAFT", "READY", "QUEUED"] },
        },
        data: { status: DelegationTaskStepStatus.BLOCKED },
      });
    }
    if (finalTaskStatus === DelegationTaskStatus.COMPLETED) {
      const outputCount = await tx.delegationTaskOutput.count({ where: { delegationTaskId: task.id } });
      if (!outputCount) {
        await tx.delegationTaskOutput.create({
          data: {
            delegationTaskId: task.id,
            delegationTaskStepId: step.id,
            kind: "SUMMARY",
            title: "任务执行完成",
            summary: "completed",
            isFinal: true,
          },
        });
      } else {
        await tx.delegationTaskOutput.updateMany({
          where: { delegationTaskId: task.id },
          data: { isFinal: true },
        });
      }
    } else {
      await tx.delegationTaskOutput.updateMany({
        where: { delegationTaskId: task.id, delegationTaskStepId: step.id },
        data: { isFinal: true },
      });
    }
    if (isTerminalStatus(finalTaskStatus)) {
      await finalizeDelegationTaskBilling(tx, {
        taskId: task.id,
        status: finalTaskStatus,
        steps: task.steps,
        generationRuns: task.generationRuns,
      });
    }
    await appendTaskEvent(tx, {
      taskId: task.id,
      eventType: hasUnknownExternalOutcome
        ? "task.reconciliation_required"
        : orchestrationFailureReason ? "task.failed" : `task.${input.outcome}`,
      actorType: DelegationTaskActorType.SYSTEM,
      fromStatus: task.status,
      toStatus: finalTaskStatus,
      payload: {
        stepId: step.id,
        artifactIds,
        ...(typeof input.actualCredits === "number" ? { actualCredits: input.actualCredits } : {}),
        ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      },
    });
    return { taskId: task.id, status: finalTaskStatus, hasMoreSteps: false, completedStepId: step.id };
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
    hasExternalEffect: task.externalEffects.length > 0,
    hasUnreconciledExternalEffect: task.externalEffects.some((effect) => effect.status === "RECONCILIATION_REQUIRED"),
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
      actions: buildExternalEffectActionAvailability({
        status: effect.status,
        hasPersistedRequest: Boolean(readDelegationExternalEffectRequest(effect)),
      }),
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
        steps: { orderBy: { sequence: "asc" }, take: 8 },
        approvalRequests: { where: { status: "PENDING" }, take: 1 },
        externalEffects: { select: { id: true, status: true }, take: 20 },
      },
    });
    if (!task) throw new DelegationTaskActionError("Delegation task not found.", 404);
    const availability = buildDelegationTaskOwnerActionAvailability({
      status: task.status,
      kind: task.kind,
      hasGenerationRun: task.generationRuns.length > 0,
      hasPendingApproval: task.approvalRequests.length > 0,
      hasExternalEffect: task.externalEffects.length > 0,
      hasUnreconciledExternalEffect: task.externalEffects.some((effect) => effect.status === "RECONCILIATION_REQUIRED"),
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
      await finalizeDelegationTaskBilling(tx, {
        taskId: task.id,
        status: DelegationTaskStatus.CANCELED,
        steps: task.steps,
        generationRuns: task.generationRuns,
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

    const step = input.action === "retry"
      ? [...task.steps].reverse().find((candidate) => ["FAILED", "BLOCKED", "CANCELED"].includes(candidate.status)) ?? task.steps[0]
      : task.steps.find((candidate) => candidate.status === "WAITING_INPUT") ?? task.steps[0];
    const sourceRun = task.generationRuns.find((run) => run.delegationTaskStepId === step?.id) ?? task.generationRuns[0];
    if (!sourceRun || !step || !task.originConversationId) {
      throw new DelegationTaskActionError("The task does not have a resumable execution context.");
    }
    const now = new Date();
    const nextVersion = task.version + 1;
    const billingContext = await prepareDelegationBillingTransfer(
      tx,
      task.steps,
      task.generationRuns,
    );
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
        ...(billingContext
          ? {
              runtimePolicySnapshot:
                billingContext.runtimePolicySnapshot as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    await transferConversationEntitlementByGenerationRunId(
      {
        fromGenerationRunId: sourceRun.id,
        toGenerationRunId: run.id,
      },
      tx as unknown as ServiceEntitlementClient,
    );
    if (billingContext) {
      if (billingContext.mode === "service_credit") {
        await transferAgentUsageEntitlementReservation(
          {
            usageChargeId: billingContext.walletReservation.usageChargeId,
            fromGenerationRunId: billingContext.ownerRunId,
            toGenerationRunId: run.id,
            conversationId: billingContext.conversationId,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      await tx.generationRun.update({
        where: { id: billingContext.ownerRunId },
        data: {
          runtimePolicySnapshot: markDelegationBillingTransferred(
            billingContext.runtimePolicySnapshot,
            run.id,
          ),
        },
      });
    }
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

export async function applyRepresentativeDelegationExternalEffectAction(input: {
  representativeSlug: string;
  taskId: string;
  effectId: string;
  action: DelegationExternalEffectOwnerAction;
  actorId: string;
  observedOutcome?: "succeeded" | "failed";
  externalReferenceId?: string;
  note?: string;
}) {
  const note = input.note?.trim() ? truncate(input.note.trim(), 1_000) : undefined;
  const externalReferenceId = input.externalReferenceId?.trim()
    ? truncate(input.externalReferenceId.trim(), 500)
    : undefined;
  const finalizeRequests: Array<{
    effectId: string;
    effectStatus: "SUCCEEDED" | "FAILED";
    stepId: string;
    outcome: "completed" | "failed";
    failureReason?: string;
  }> = [];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`;
    const effect = await tx.delegationTaskExternalEffect.findFirst({
      where: {
        id: input.effectId,
        delegationTaskId: input.taskId,
        delegationTask: { representative: { slug: input.representativeSlug } },
      },
      include: {
        delegationTask: {
          include: { generationRuns: { orderBy: { createdAt: "desc" }, take: 20 } },
        },
        delegationTaskStep: true,
      },
    });
    if (!effect || !effect.delegationTaskStep) throw new DelegationTaskActionError("External effect not found.", 404);
    const request = readDelegationExternalEffectRequest(effect);
    const availability = buildExternalEffectActionAvailability({
      status: effect.status,
      hasPersistedRequest: Boolean(request),
    });
    const availabilityKey = input.action === "record_compensation" ? "recordCompensation" : input.action;
    const selected = availability[availabilityKey];
    if (!selected.enabled) throw new DelegationTaskActionError(selected.reason);
    const now = new Date();

    if (input.action === "reconcile") {
      if (!input.observedOutcome) throw new DelegationTaskActionError("Reconciliation requires an observed remote outcome.", 400);
      if (!note && !externalReferenceId) {
        throw new DelegationTaskActionError("Reconciliation requires a note or external reference as evidence.", 400);
      }
      const nextStatus = input.observedOutcome === "succeeded" ? "SUCCEEDED" : "FAILED";
      await tx.delegationTaskExternalEffect.update({
        where: { id: effect.id },
        data: {
          status: nextStatus,
          reconciledAt: now,
          ...(externalReferenceId ? { externalReferenceId } : {}),
          failureReason: input.observedOutcome === "failed" ? note || "Owner confirmed remote failure." : null,
          responseSnapshot: {
            previous: effect.responseSnapshot ?? null,
            reconciliation: {
              observedOutcome: input.observedOutcome,
              note: note || null,
              externalReferenceId: externalReferenceId || null,
              reconciledBy: input.actorId,
              reconciledAt: now.toISOString(),
            },
          },
        },
      });
      await appendTaskEvent(tx, {
        taskId: input.taskId,
        eventType: `external_effect.reconciled_${input.observedOutcome}`,
        actorType: DelegationTaskActorType.OWNER,
        actorId: input.actorId,
        fromStatus: effect.delegationTask.status,
        toStatus: effect.delegationTask.status,
        payload: { effectId: effect.id, externalReferenceId: externalReferenceId || null, note: note || null },
      });
      finalizeRequests.push({
        effectId: effect.id,
        effectStatus: nextStatus,
        stepId: effect.delegationTaskStep.id,
        outcome: input.observedOutcome === "succeeded" ? "completed" : "failed",
        ...(input.observedOutcome === "failed" ? { failureReason: note || "Owner confirmed remote failure." } : {}),
      });
      return;
    }

    if (input.action === "record_compensation") {
      if (!note) throw new DelegationTaskActionError("Compensation evidence note is required.", 400);
      await tx.delegationTaskExternalEffect.update({
        where: { id: effect.id },
        data: {
          status: "CANCELED",
          reconciledAt: now,
          ...(externalReferenceId ? { externalReferenceId } : {}),
          responseSnapshot: {
            previous: effect.responseSnapshot ?? null,
            compensation: {
              mode: "owner_confirmed_external_compensation",
              note,
              externalReferenceId: externalReferenceId || null,
              recordedBy: input.actorId,
              recordedAt: now.toISOString(),
            },
          },
        },
      });
      await appendTaskEvent(tx, {
        taskId: input.taskId,
        eventType: "external_effect.compensation_recorded",
        actorType: DelegationTaskActorType.OWNER,
        actorId: input.actorId,
        fromStatus: effect.delegationTask.status,
        toStatus: effect.delegationTask.status,
        payload: { effectId: effect.id, externalReferenceId: externalReferenceId || null, note },
      });
      await tx.delegationTaskOutput.updateMany({
        where: { externalEffectId: effect.id },
        data: { summary: `compensated: ${truncate(note, 500)}`, isFinal: true },
      });
      return;
    }

    if (!request) throw new DelegationTaskActionError("External effect retry request is unavailable.");
    const sourceRun = effect.delegationTask.generationRuns.find(
      (run) => run.delegationTaskStepId === effect.delegationTaskStepId,
    );
    if (!sourceRun) throw new DelegationTaskActionError("External effect retry has no generation context.");
    const billingContext = await prepareDelegationBillingTransfer(
      tx,
      [effect.delegationTaskStep],
      effect.delegationTask.generationRuns,
    );
    const run = await tx.generationRun.create({
      data: {
        conversationId: sourceRun.conversationId,
        episodeId: sourceRun.episodeId,
        inputMessageId: sourceRun.inputMessageId,
        representativeVersionId: effect.delegationTask.representativeVersionId,
        delegationTaskId: input.taskId,
        delegationTaskStepId: effect.delegationTaskStep.id,
        status: GenerationRunStatus.QUEUED,
        idempotencyKey: `external-effect-retry:${effect.id}:${effect.delegationTask.version + 1}`,
        contextSnapshot: {
          source: "external_effect_retry",
          request: request as unknown as Prisma.InputJsonValue,
          previousGenerationRunId: sourceRun.id,
          effectId: effect.id,
          requestedBy: input.actorId,
        },
        ...(billingContext
          ? {
              runtimePolicySnapshot:
                billingContext.runtimePolicySnapshot as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    await transferConversationEntitlementByGenerationRunId(
      {
        fromGenerationRunId: sourceRun.id,
        toGenerationRunId: run.id,
      },
      tx as unknown as ServiceEntitlementClient,
    );
    if (billingContext) {
      if (billingContext.mode === "service_credit") {
        await transferAgentUsageEntitlementReservation(
          {
            usageChargeId: billingContext.walletReservation.usageChargeId,
            fromGenerationRunId: billingContext.ownerRunId,
            toGenerationRunId: run.id,
            conversationId: billingContext.conversationId,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      await tx.generationRun.update({
        where: { id: billingContext.ownerRunId },
        data: {
          runtimePolicySnapshot: markDelegationBillingTransferred(
            billingContext.runtimePolicySnapshot,
            run.id,
          ),
        },
      });
    }
    await tx.outboxEvent.create({
      data: {
        conversationId: sourceRun.conversationId,
        aggregateType: "generation_run",
        aggregateId: run.id,
        eventType: "generation.requested",
        payload: { runId: run.id, taskId: input.taskId, stepId: effect.delegationTaskStep.id, effectId: effect.id },
        idempotencyKey: `generation.requested:${run.id}`,
      },
    });
    await tx.delegationTaskExternalEffect.update({
      where: { id: effect.id },
      data: { status: "PROPOSED", failureReason: null, reconciledAt: null },
    });
    await tx.delegationTaskStep.update({
      where: { id: effect.delegationTaskStep.id },
      data: { status: DelegationTaskStepStatus.READY, failedAt: null, completedAt: null },
    });
    await tx.delegationTask.update({
      where: { id: input.taskId },
      data: {
        status: DelegationTaskStatus.READY,
        nextActionBy: DelegationTaskNextActor.SYSTEM,
        blockingReason: null,
        failedAt: null,
        version: { increment: 1 },
      },
    });
    await tx.delegationTaskOutput.updateMany({
      where: { delegationTaskId: input.taskId, isFinal: true },
      data: { isFinal: false },
    });
    await tx.conversation.update({
      where: { id: sourceRun.conversationId },
      data: { state: "AI_QUEUED", lastMessageAt: now },
    });
    await appendTaskEvent(tx, {
      taskId: input.taskId,
      eventType: "external_effect.retry_scheduled",
      actorType: DelegationTaskActorType.OWNER,
      actorId: input.actorId,
      fromStatus: effect.delegationTask.status,
      toStatus: DelegationTaskStatus.READY,
      payload: { effectId: effect.id, generationRunId: run.id },
    });
  });
  const finalize = finalizeRequests[0];
  if (finalize) {
    try {
      await finalizeComputeDelegationTask({
        taskId: input.taskId,
        stepId: finalize.stepId,
        outcome: finalize.outcome,
        ...(finalize.failureReason ? { failureReason: finalize.failureReason } : {}),
      });
    } catch (error) {
      await restoreExternalEffectReconciliationAfterFinalizationFailure({
        taskId: input.taskId,
        effectId: finalize.effectId,
        expectedStatus: finalize.effectStatus,
      });
      throw error;
    }
  }
  return getRepresentativeDelegationTaskDetail(input.representativeSlug, input.taskId);
}

async function restoreExternalEffectReconciliationAfterFinalizationFailure(input: {
  taskId: string;
  effectId: string;
  expectedStatus: "SUCCEEDED" | "FAILED";
}) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`;
    const effect = await tx.delegationTaskExternalEffect.findFirst({
      where: {
        id: input.effectId,
        delegationTaskId: input.taskId,
        status: input.expectedStatus,
      },
      include: { delegationTask: { select: { status: true } } },
    });
    if (!effect) return;
    await tx.delegationTaskExternalEffect.update({
      where: { id: effect.id },
      data: {
        status: "RECONCILIATION_REQUIRED",
        failureReason: "reconciliation_finalization_failed",
      },
    });
    await appendTaskEvent(tx, {
      taskId: input.taskId,
      eventType: "external_effect.reconciliation_finalization_failed",
      actorType: DelegationTaskActorType.SYSTEM,
      fromStatus: effect.delegationTask.status,
      toStatus: effect.delegationTask.status,
      payload: { effectId: effect.id },
    });
  });
}

async function transitionDelegationTask(input: {
  taskId: string;
  stepId?: string;
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
      include: { steps: { orderBy: { sequence: "asc" }, take: 8 } },
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
    const step = input.stepId
      ? task.steps.find((candidate) => candidate.id === input.stepId)
      : task.steps.find((candidate) => ["READY", "QUEUED", "WAITING_APPROVAL", "RUNNING"].includes(candidate.status));
    if (input.stepId && !step) throw new Error("Delegation task step not found.");
    if (step) {
      await tx.delegationTaskStep.update({
        where: { id: step.id },
        data: {
          status: input.stepStatus,
          startedAt: step.startedAt ?? now,
          ...(input.approvalId ? { requiresApproval: true } : {}),
        },
      });
      if (input.externalEffectStatus === "EXECUTING") {
        await tx.delegationTaskExternalEffect.updateMany({
          where: { delegationTaskId: task.id, delegationTaskStepId: step.id, approvalRequestId: { not: null } },
          data: { approvedAt: now },
        });
      }
    }
    if (input.externalEffectStatus) {
      await tx.delegationTaskExternalEffect.updateMany({
        where: {
          delegationTaskId: task.id,
          ...(step ? { delegationTaskStepId: step.id } : {}),
        },
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
    request?: ParsedComputeRequest;
  },
) {
  await tx.generationRun.update({
    where: { id: input.generationRunId },
    data: {
      delegationTaskId: input.taskId,
      delegationTaskStepId: input.stepId ?? null,
      ...(input.request
        ? {
            contextSnapshot: {
              source: "delegation_plan_step",
              request: input.request as unknown as Prisma.InputJsonValue,
            },
          }
        : {}),
    },
  });
  await tx.message.update({
    where: { id: input.inputMessageId },
    data: { delegationTaskId: input.taskId },
  });
}

async function recordAuthorizedKnowledge(
  tx: Prisma.TransactionClient,
  taskId: string,
  knowledge: AuthorizedDelegationKnowledge[],
) {
  const uniqueKnowledge = [...new Map(
    knowledge
      .filter((item) => item.assetId.trim())
      .map((item) => [item.assetId.trim(), { assetId: item.assetId.trim(), title: item.title.trim() }]),
  ).values()];
  for (const item of uniqueKnowledge) {
    const existingInput = await tx.delegationTaskInput.findFirst({
      where: {
        delegationTaskId: taskId,
        kind: "KNOWLEDGE_ASSET",
        referenceType: "KnowledgeAsset",
        referenceId: item.assetId,
      },
      select: { id: true },
    });
    if (existingInput) continue;
    const taskInput = await tx.delegationTaskInput.create({
      data: {
        delegationTaskId: taskId,
        kind: "KNOWLEDGE_ASSET",
        referenceType: "KnowledgeAsset",
        referenceId: item.assetId,
        label: truncate(item.title || "公开知识资料", 240),
        providedByType: "OWNER",
        authorizationRequired: false,
      },
    });
    await tx.delegationTaskDataGrant.create({
      data: {
        delegationTaskId: taskId,
        taskInputId: taskInput.id,
        grantorType: "OWNER",
        resourceType: "KnowledgeAsset",
        resourceId: item.assetId,
        scopes: ["read", "use_for_task"],
        purpose: "delegated_task_public_knowledge",
        status: "ACTIVE",
        policySnapshot: {
          source: "representative_delegation_knowledge_scope",
          scope: "public_knowledge",
        },
      },
    });
  }
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

type DelegationBillingStep = {
  id: string;
  kind: string;
};

type DelegationBillingRun = {
  id: string;
  conversationId: string;
  delegationTaskStepId: string | null;
  runtimePolicySnapshot: Prisma.JsonValue | null;
};

type DelegationBillingContext =
  | {
      mode: "free";
      ownerRunId: string;
      conversationId: string;
      runtimePolicySnapshot: Prisma.JsonObject;
    }
  | {
      mode: "service_credit";
      ownerRunId: string;
      conversationId: string;
      runtimePolicySnapshot: Prisma.JsonObject;
      walletReservation: {
        usageChargeId: string;
        tokenAmount: number;
      };
    };

function resolveDelegationBillingContext(
  steps: DelegationBillingStep[],
  generationRuns: DelegationBillingRun[],
): DelegationBillingContext | null {
  const executionStepIds = new Set(
    steps
      .filter((step) => step.kind !== "CLARIFICATION")
      .map((step) => step.id),
  );
  const contexts: DelegationBillingContext[] = [];
  for (const run of generationRuns) {
    if (
      !run.delegationTaskStepId
      || !executionStepIds.has(run.delegationTaskStepId)
      || !run.runtimePolicySnapshot
      || typeof run.runtimePolicySnapshot !== "object"
      || Array.isArray(run.runtimePolicySnapshot)
    ) {
      continue;
    }
    const snapshot = run.runtimePolicySnapshot as Prisma.JsonObject;
    if (snapshot["billingMode"] === "free") {
      contexts.push({
        mode: "free" as const,
        ownerRunId: run.id,
        conversationId: run.conversationId,
        runtimePolicySnapshot: snapshot,
      });
      continue;
    }
    if (snapshot["billingMode"] !== "service_credit") continue;
    const walletReservation = readGenerationWalletReservation(snapshot);
    if (!walletReservation) {
      throw new Error("Delegation task paid billing context is invalid.");
    }
    contexts.push({
      mode: "service_credit" as const,
      ownerRunId: run.id,
      conversationId: run.conversationId,
      runtimePolicySnapshot: snapshot,
      walletReservation,
    });
  }
  if (contexts.length > 1) {
    throw new Error("Delegation task has multiple active billing context owners.");
  }
  return contexts[0] ?? null;
}

async function prepareDelegationBillingTransfer(
  tx: Prisma.TransactionClient,
  steps: DelegationBillingStep[],
  generationRuns: DelegationBillingRun[],
) {
  const context = resolveDelegationBillingContext(steps, generationRuns);
  if (!context) {
    const executionStepIds = new Set(
      steps
        .filter((step) => step.kind !== "CLARIFICATION")
        .map((step) => step.id),
    );
    const finalizedPaidContext = generationRuns.some((run) => {
      if (
        !run.delegationTaskStepId
        || !executionStepIds.has(run.delegationTaskStepId)
        || !run.runtimePolicySnapshot
        || typeof run.runtimePolicySnapshot !== "object"
        || Array.isArray(run.runtimePolicySnapshot)
      ) {
        return false;
      }
      const billingMode = (run.runtimePolicySnapshot as Prisma.JsonObject)["billingMode"];
      return typeof billingMode === "string"
        && billingMode.startsWith("service_credit_");
    });
    if (finalizedPaidContext) {
      throw new DelegationTaskActionError(
        "The paid authorization for this task has ended. The audience must submit a new request.",
      );
    }
    return null;
  }
  if (context.mode === "free") return context;
  const usageCharge = await tx.agentUsageCharge.findUnique({
    where: { id: context.walletReservation.usageChargeId },
    select: { status: true },
  });
  if (usageCharge?.status !== AgentUsageChargeStatus.RESERVED) {
    throw new DelegationTaskActionError(
      "The paid authorization for this task is no longer reserved. The audience must submit a new request.",
    );
  }
  return context;
}

function markDelegationBillingTransferred(
  snapshot: Prisma.JsonObject,
  nextGenerationRunId: string,
): Prisma.InputJsonObject {
  const {
    walletReservation: _walletReservation,
    ...rest
  } = snapshot;
  return {
    ...rest,
    billingMode: `${String(snapshot["billingMode"])}_transferred`,
    billingTransferredToGenerationRunId: nextGenerationRunId,
  } as Prisma.InputJsonObject;
}

function markDelegationPaidBillingFinalized(
  snapshot: Prisma.JsonObject,
  outcome: "settled" | "released",
): Prisma.InputJsonObject {
  const {
    walletReservation: _walletReservation,
    ...rest
  } = snapshot;
  return {
    ...rest,
    billingMode: `service_credit_${outcome}`,
    billingFinalizedAt: new Date().toISOString(),
  } as Prisma.InputJsonObject;
}

async function finalizeDelegationTaskBilling(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    status: DelegationTaskStatus;
    steps: DelegationBillingStep[];
    generationRuns: DelegationBillingRun[];
  },
) {
  await finalizeConversationEntitlementForGenerationRuns(
    {
      generationRunIds: input.generationRuns.map((run) => run.id),
      outcome:
        input.status === DelegationTaskStatus.COMPLETED
          ? "consume"
          : "release",
      reason: `delegation_task_${input.status.toLowerCase()}`,
    },
    tx as unknown as ServiceEntitlementClient,
  );
  const context = resolveDelegationBillingContext(
    input.steps,
    input.generationRuns,
  );
  if (!context) return;
  if (context.mode === "free") {
    if (input.status === DelegationTaskStatus.COMPLETED) {
      await tx.conversation.update({
        where: { id: context.conversationId },
        data: { freeRepliesUsed: { increment: 1 } },
      });
    }
    return;
  }

  const usageCharge = await tx.agentUsageCharge.findUnique({
    where: { id: context.walletReservation.usageChargeId },
    select: { status: true },
  });
  if (!usageCharge) {
    throw new Error("Delegation task usage reservation was not found.");
  }
  if (input.status === DelegationTaskStatus.COMPLETED) {
    if (usageCharge.status === AgentUsageChargeStatus.SETTLED) {
      await tx.generationRun.update({
        where: { id: context.ownerRunId },
        data: {
          runtimePolicySnapshot: markDelegationPaidBillingFinalized(
            context.runtimePolicySnapshot,
            "settled",
          ),
        },
      });
      return;
    }
    if (usageCharge.status !== AgentUsageChargeStatus.RESERVED) {
      throw new Error(
        `Delegation task usage reservation cannot settle from ${usageCharge.status}.`,
      );
    }
    await settleConversationWalletUsage(
      {
        usageChargeId: context.walletReservation.usageChargeId,
        settledTokenAmount: context.walletReservation.tokenAmount,
        provider: "compute",
        idempotencyKey: `delegation-task:${input.taskId}:settle`,
      },
      tx as unknown as UsageChargeClient,
    );
    await tx.generationRun.update({
      where: { id: context.ownerRunId },
      data: {
        runtimePolicySnapshot: markDelegationPaidBillingFinalized(
          context.runtimePolicySnapshot,
          "settled",
        ),
      },
    });
    return;
  }

  if (
    usageCharge.status === AgentUsageChargeStatus.RELEASED
    || usageCharge.status === AgentUsageChargeStatus.FAILED
  ) {
    await tx.generationRun.update({
      where: { id: context.ownerRunId },
      data: {
        runtimePolicySnapshot: markDelegationPaidBillingFinalized(
          context.runtimePolicySnapshot,
          "released",
        ),
      },
    });
    return;
  }
  if (usageCharge.status !== AgentUsageChargeStatus.RESERVED) {
    throw new Error(
      `Delegation task usage reservation cannot release from ${usageCharge.status}.`,
    );
  }
  await releaseConversationWalletUsage(
    {
      usageChargeId: context.walletReservation.usageChargeId,
      failed: input.status === DelegationTaskStatus.FAILED,
      reason: `delegation_task_${input.status.toLowerCase()}`,
      idempotencyKey: `delegation-task:${input.taskId}:release`,
    },
    tx as unknown as UsageChargeClient,
  );
  await tx.generationRun.update({
    where: { id: context.ownerRunId },
    data: {
      runtimePolicySnapshot: markDelegationPaidBillingFinalized(
        context.runtimePolicySnapshot,
        "released",
      ),
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
  if (outcome === "blocked") {
    return {
      taskStatus: DelegationTaskStatus.FAILED,
      stepStatus: DelegationTaskStepStatus.BLOCKED,
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
