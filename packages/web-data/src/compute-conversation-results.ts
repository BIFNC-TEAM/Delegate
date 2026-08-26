import {
  ConversationEpisodeStatus,
  GenerationRunStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
  Prisma,
} from "@prisma/client";
import { buildMessageRetentionExpiry } from "@delegate/runtime";

import {
  readGenerationWalletReservation,
  runConversationWriteTransaction,
} from "./conversation-platform";
import {
  releaseConversationWalletUsage,
  type UsageChargeClient,
} from "./agent-wallet-usage-charge";
import { prisma } from "./prisma";
import { finalizeComputeDelegationTaskInTransaction } from "./delegation-tasks";
import {
  releaseConversationEntitlementByGenerationRunId,
  type ServiceEntitlementClient,
} from "./service-entitlements";

export type ComputeApprovalConversationOutcome =
  | "completed"
  | "failed"
  | "rejected"
  | "expired"
  | "policy_denied";

export async function finalizeComputeApprovalConversation(input: {
  approvalId: string;
  outcome: ComputeApprovalConversationOutcome;
  artifacts?: Array<{
    id: string;
    kind: string;
    summary?: string | null;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    fileName?: string;
  }>;
  failureReason?: string;
}) {
  const approvalReference = await prisma.approvalRequest.findUnique({
    where: { id: input.approvalId },
    select: {
      generationRun: {
        select: {
          id: true,
          conversationId: true,
        },
      },
    },
  });
  const runReference = approvalReference?.generationRun;
  if (!runReference) return null;

  const result = await runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${runReference.conversationId}))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${runReference.id}))
    `;
    const approval = await tx.approvalRequest.findUnique({
      where: { id: input.approvalId },
      include: {
        generationRun: true,
        representative: { select: { displayName: true, slug: true } },
      },
    });
    const run = approval?.generationRun;
    if (!approval || !run) return null;
    if (
      run.id !== runReference.id
      || run.conversationId !== runReference.conversationId
    ) {
      return null;
    }
    if (run.status === GenerationRunStatus.COMPLETED && run.outputMessageId) {
      let message = await tx.message.findUnique({ where: { id: run.outputMessageId } });
      if (!message) return null;
      if (
        message.deliveryStatus !== MessageDeliveryStatus.SENT
        && !message.externalMessageId
      ) {
        await enqueueComputeApprovalDeliveryInTransaction(tx, {
          runId: run.id,
          conversationId: run.conversationId,
          inputMessageId: run.inputMessageId,
          outputMessageId: message.id,
          approvalId: approval.id,
        });
      }
      const finalization = approval.delegationTaskId
        ? await finalizeComputeDelegationTaskInTransaction(tx, {
            taskId: approval.delegationTaskId,
            ...(approval.delegationTaskStepId
              ? { stepId: approval.delegationTaskStepId }
              : {}),
            generationRunId: run.id,
            outcome: mapComputeOutcomeToTaskOutcome(input.outcome),
            ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
            ...(input.failureReason ? { failureReason: input.failureReason } : {}),
          })
        : null;
      if (
        finalization?.hasMoreSteps
        && message.deliveryStatus !== MessageDeliveryStatus.SENT
      ) {
        message = await tx.message.update({
          where: { id: message.id },
          data: {
            text:
              "审批通过，当前步骤已完成，委托任务正在继续执行后续步骤。",
          },
        });
      }
      return {
        message,
      };
    }
    if (run.status !== GenerationRunStatus.WAITING_APPROVAL) {
      return null;
    }

    const now = new Date();
    const conversation = await tx.conversation.findUnique({
      where: { id: run.conversationId },
      select: { state: true },
    });
    if (!conversation) {
      throw new Error("Compute approval conversation not found.");
    }
    const walletReservation = readGenerationWalletReservation(
      run.runtimePolicySnapshot,
    );
    const delegationTaskOwnsBilling = Boolean(
      approval.delegationTaskId && approval.delegationTaskStepId,
    );
    if (
      conversation.state === "HUMAN_ACTIVE"
      || conversation.state === "NEEDS_HUMAN"
    ) {
      const releasedSnapshot =
        walletReservation && !delegationTaskOwnsBilling
          ? markComputeGenerationWalletReleased(
              run.runtimePolicySnapshot,
              now,
            )
          : null;
      const deferred = await tx.generationRun.updateMany({
        where: {
          id: run.id,
          status: GenerationRunStatus.WAITING_APPROVAL,
        },
        data: {
          status: GenerationRunStatus.WAITING_HUMAN,
          completedAt: null,
          canceledAt: null,
          ...(releasedSnapshot
            ? { runtimePolicySnapshot: releasedSnapshot }
            : {}),
        },
      });
      if (deferred.count !== 1) {
        throw new Error(
          "Compute generation changed while deferring its approval result to human control.",
        );
      }
      if (!delegationTaskOwnsBilling) {
        await releaseConversationEntitlementByGenerationRunId(
          {
            generationRunId: run.id,
            reason: "generation_deferred_for_human",
          },
          tx as unknown as ServiceEntitlementClient,
        );
      }
      if (walletReservation && !delegationTaskOwnsBilling) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            reason: "generation_deferred_to_human",
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      return null;
    }

    const text = formatComputeOutcome(input);
    const message = await tx.message.upsert({
      where: {
        conversationId_clientMessageId: {
          conversationId: run.conversationId,
          clientMessageId: `compute-approval-result:${approval.id}`,
        },
      },
      create: {
        conversationId: run.conversationId,
        episodeId: run.episodeId,
        senderType: MessageSenderType.REPRESENTATIVE,
        senderDisplayName: approval.representative.displayName,
        delegationTaskId: approval.delegationTaskId,
        contentType: MessageContentType.TOOL_RESULT,
        text,
        content: {
          kind: "compute_approval_result",
          approvalId: approval.id,
          outcome: input.outcome,
          artifactIds: input.artifacts?.map((artifact) => artifact.id) ?? [],
        },
        clientMessageId: `compute-approval-result:${approval.id}`,
        deliveryStatus: MessageDeliveryStatus.QUEUED,
        retentionExpiresAt: buildMessageRetentionExpiry(now),
        createdAt: now,
      },
      update: {
        text,
        content: {
          kind: "compute_approval_result",
          approvalId: approval.id,
          outcome: input.outcome,
          artifactIds: input.artifacts?.map((artifact) => artifact.id) ?? [],
        },
        deliveryStatus: MessageDeliveryStatus.QUEUED,
      },
    });

    await tx.messageAttachment.deleteMany({ where: { messageId: message.id } });
    if (input.artifacts?.length) {
      await tx.messageAttachment.createMany({
        data: input.artifacts.map((artifact) => ({
          messageId: message.id,
          fileName: resolveConversationArtifactFileName(artifact),
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          objectKey: artifact.id,
          externalUrl: `/reps/${approval.representative.slug}/chat/artifacts/${artifact.id}/download`,
        })),
      });
    }

    const completedRun = await tx.generationRun.updateMany({
      where: {
        id: run.id,
        status: GenerationRunStatus.WAITING_APPROVAL,
      },
      data: {
        status: GenerationRunStatus.COMPLETED,
        outputMessageId: message.id,
        completedAt: now,
        ...(input.outcome === "completed" && !delegationTaskOwnsBilling
          ? {
              contextSnapshot: markComputeGenerationDeliveryBillingPending(
                run.contextSnapshot,
              ),
            }
          : {}),
        errorCode: input.outcome === "failed" || input.outcome === "policy_denied"
          ? `compute_${input.outcome}`
          : null,
        errorMessage: input.failureReason?.slice(0, 1000) ?? null,
      },
    });
    if (completedRun.count !== 1) {
      throw new Error(
        "Compute generation changed while completing its approval result.",
      );
    }
    const settledConversation = await tx.conversation.updateMany({
      where: {
        id: run.conversationId,
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: {
        state: "WAITING_USER",
        lastMessageAt: now,
      },
    });
    if (settledConversation.count !== 1) {
      throw new Error(
        "Compute approval conversation changed while completing its result.",
      );
    }
    if (run.episodeId) {
      const settledEpisode = await tx.conversationEpisode.updateMany({
        where: {
          id: run.episodeId,
          status: {
            notIn: [
              ConversationEpisodeStatus.HUMAN_ACTIVE,
              ConversationEpisodeStatus.NEEDS_HUMAN,
            ],
          },
        },
        data: { status: ConversationEpisodeStatus.WAITING_USER },
      });
      if (settledEpisode.count !== 1) {
        throw new Error(
          "Compute approval episode changed while completing its result.",
        );
      }
    }
    if (!delegationTaskOwnsBilling) {
      if (input.outcome !== "completed") {
        await releaseConversationEntitlementByGenerationRunId(
          {
            generationRunId: run.id,
            reason: `compute_${input.outcome}`,
          },
          tx as unknown as ServiceEntitlementClient,
        );
      }
    }
    if (walletReservation && !delegationTaskOwnsBilling) {
      if (input.outcome !== "completed") {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            failed:
              input.outcome === "failed"
              || input.outcome === "policy_denied",
            reason: `compute_${input.outcome}`,
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
      }
    }
    await enqueueComputeApprovalDeliveryInTransaction(tx, {
      runId: run.id,
      conversationId: run.conversationId,
      inputMessageId: run.inputMessageId,
      outputMessageId: message.id,
      approvalId: approval.id,
    });
    const finalization = approval.delegationTaskId
      ? await finalizeComputeDelegationTaskInTransaction(tx, {
          taskId: approval.delegationTaskId,
          ...(approval.delegationTaskStepId
            ? { stepId: approval.delegationTaskStepId }
            : {}),
          generationRunId: run.id,
          outcome: mapComputeOutcomeToTaskOutcome(input.outcome),
          ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
          ...(input.failureReason ? { failureReason: input.failureReason } : {}),
        })
      : null;
    const composerResume =
      input.outcome === "completed"
      && approval.delegationTaskId
      && !finalization?.hasMoreSteps
        ? await findPendingV3ComposerResumeInTransaction(
            tx,
            approval.delegationTaskId,
          )
        : null;
    if (composerResume) {
      await tx.message.update({
        where: { id: message.id },
        data: {
          deliveryStatus: MessageDeliveryStatus.CANCELED,
          failureCode: "v3_composer_resume",
          failureReason:
            "The verified tool result is being composed into the final governed response.",
        },
      });
      await tx.outboxEvent.updateMany({
        where: {
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          status: { in: ["PENDING", "FAILED"] },
        },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: "superseded_by_v3_composer_resume",
        },
      });
      const currentContext = run.contextSnapshot
        && typeof run.contextSnapshot === "object"
        && !Array.isArray(run.contextSnapshot)
          ? run.contextSnapshot as Prisma.JsonObject
          : {};
      await tx.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.QUEUED,
          outputMessageId: null,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
          contextSnapshot: {
            ...currentContext,
            source: "v3_governed_composer_resume",
            delegationTaskId: approval.delegationTaskId,
            planId: composerResume.planId,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          conversationId: run.conversationId,
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          payload: {
            runId: run.id,
            conversationId: run.conversationId,
            messageId: run.inputMessageId,
            delegationTaskId: approval.delegationTaskId,
            planId: composerResume.planId,
            composerResume: true,
          },
          idempotencyKey:
            `generation.v3-composer.requested:${run.id}:${composerResume.planId}`,
        },
      });
      await tx.conversation.update({
        where: { id: run.conversationId },
        data: { state: "AI_QUEUED", lastMessageAt: now },
      });
      if (run.episodeId) {
        await tx.conversationEpisode.update({
          where: { id: run.episodeId },
          data: { status: ConversationEpisodeStatus.ACTIVE },
        });
      }
      return { message: null };
    }
    const deliveredMessage = finalization?.hasMoreSteps
      ? await tx.message.update({
          where: { id: message.id },
          data: {
            text:
              "审批通过，当前步骤已完成，委托任务正在继续执行后续步骤。",
          },
        })
      : message;
    return {
      message: deliveredMessage,
    };
  });
  if (!result) return null;
  if (!result.message) return null;
  return result.message;
}

async function findPendingV3ComposerResumeInTransaction(
  tx: Prisma.TransactionClient,
  delegationTaskId: string,
) {
  const plan = await tx.conversationTurnPlan.findFirst({
    where: {
      delegationTaskId,
      protocolVersion: 3,
      shadowMode: false,
      status: { in: ["VALIDATED", "EXECUTING"] },
      actions: {
        some: {
          capabilityKey: "response.compose",
          status: { in: ["PLANNED", "READY"] },
        },
      },
    },
    orderBy: { revision: "desc" },
    select: { id: true },
  });
  return plan ? { planId: plan.id } : null;
}

function mapComputeOutcomeToTaskOutcome(
  outcome: ComputeApprovalConversationOutcome,
) {
  return outcome === "completed"
    ? "completed" as const
    : outcome === "rejected"
      ? "rejected" as const
      : outcome === "expired"
        ? "expired" as const
        : outcome === "policy_denied"
          ? "blocked" as const
          : "failed" as const;
}

async function enqueueComputeApprovalDeliveryInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    conversationId: string;
    inputMessageId: string;
    outputMessageId: string;
    approvalId: string;
  },
) {
  return tx.outboxEvent.upsert({
    where: {
      idempotencyKey:
        `generation.delivery.requested:${input.runId}:${input.outputMessageId}`,
    },
    create: {
      conversationId: input.conversationId,
      aggregateType: "generation_run",
      aggregateId: input.runId,
      eventType: "generation.requested",
      payload: {
        runId: input.runId,
        conversationId: input.conversationId,
        messageId: input.inputMessageId,
        outputMessageId: input.outputMessageId,
        approvalId: input.approvalId,
        deliveryOnly: true,
      },
      idempotencyKey:
        `generation.delivery.requested:${input.runId}:${input.outputMessageId}`,
    },
    update: {},
  });
}

export function formatComputeOutcome(input: {
  outcome: ComputeApprovalConversationOutcome;
  artifacts?: Array<{
    id: string;
    kind: string;
    summary?: string | null;
    objectKey: string;
    mimeType: string;
    fileName?: string;
  }>;
  failureReason?: string;
}) {
  const publicFailureReason = input.failureReason
    ? renderPublicComputeFailureReason(input.failureReason)
    : null;
  if (input.outcome === "rejected") {
    return "委托任务未获批准，因此没有执行。";
  }
  if (input.outcome === "expired") {
    return "委托任务审批已超时，任务未执行。如仍需要，请重新提交请求。";
  }
  if (input.outcome === "policy_denied") {
    return `审批后安全策略复核未通过，任务没有执行。${publicFailureReason ? `\n\n原因：${publicFailureReason}` : ""}`;
  }

  const artifacts = input.artifacts?.length
    ? input.artifacts.map((artifact) => {
        const label = artifact.kind.toLowerCase() === "file" ? "已生成文件" : "已生成结果";
        return `${label}：${resolveConversationArtifactFileName(artifact)}`;
      }).join("\n")
    : "没有生成可展示的结果文件。";
  if (input.outcome === "failed") {
    return `审批已通过，但委托任务执行失败。\n\n${artifacts}${publicFailureReason ? `\n\n原因：${publicFailureReason}` : ""}`;
  }
  return `审批已通过，委托任务执行完成。\n\n${artifacts}`;
}

function markComputeGenerationWalletReleased(
  snapshot: Prisma.JsonValue | null,
  now: Date,
): Prisma.InputJsonObject | null {
  if (
    !snapshot
    || typeof snapshot !== "object"
    || Array.isArray(snapshot)
    || !readGenerationWalletReservation(snapshot)
  ) {
    return null;
  }
  const {
    walletReservation: _walletReservation,
    ...rest
  } = snapshot as Prisma.JsonObject;
  return {
    ...rest,
    billingMode: "service_credit_released",
    billingFinalizedAt: now.toISOString(),
  } as Prisma.InputJsonObject;
}

function markComputeGenerationDeliveryBillingPending(
  snapshot: Prisma.JsonValue | null,
): Prisma.InputJsonObject {
  const current = snapshot
    && typeof snapshot === "object"
    && !Array.isArray(snapshot)
      ? snapshot as Prisma.JsonObject
      : {};
  return {
    ...current,
    deliveryBilling: {
      version: 1,
      status: "pending",
    },
  };
}

function renderPublicComputeFailureReason(failureReason: string) {
  if (failureReason.includes("path_outside_allowed_workspace")) {
    return "输出位置不符合沙盒安全规则；请重新描述希望生成的内容，文件位置将由系统自动管理。";
  }
  return "执行过程中出现错误，详细原因已记录供代表所有者查看。";
}

function resolveConversationArtifactFileName(artifact: {
  id: string;
  kind: string;
  mimeType: string;
  summary?: string | null;
  fileName?: string;
}) {
  if (artifact.fileName?.trim()) return artifact.fileName.trim().split("/").pop() || artifact.fileName.trim();
  if (artifact.kind.toLowerCase() === "file" && artifact.summary?.includes(":")) {
    const path = artifact.summary.split(":", 1)[0]?.trim();
    if (path) return path.split("/").pop() || path;
  }
  const extension = artifact.mimeType.includes("json")
    ? "json"
    : artifact.mimeType.includes("csv")
      ? "csv"
      : artifact.mimeType.includes("png")
        ? "png"
        : artifact.mimeType.includes("jpeg")
          ? "jpg"
          : "txt";
  return `${artifact.kind.toLowerCase()}-${artifact.id}.${extension}`;
}
