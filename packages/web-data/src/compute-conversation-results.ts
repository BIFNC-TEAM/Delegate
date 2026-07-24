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
  settleConversationWalletUsage,
  type UsageChargeClient,
} from "./agent-wallet-usage-charge";
import { prisma } from "./prisma";
import { finalizeComputeDelegationTask } from "./delegation-tasks";
import {
  consumeConversationEntitlementByGenerationRunId,
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
  actualCredits?: number;
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
      const message = await tx.message.findUnique({ where: { id: run.outputMessageId } });
      return {
        message,
        delegationTaskId: approval.delegationTaskId,
        delegationTaskStepId: approval.delegationTaskStepId,
        generationRunId: run.id,
        conversationId: run.conversationId,
        episodeId: run.episodeId,
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
          ...(typeof input.actualCredits === "number" ? { actualCredits: input.actualCredits } : {}),
          artifactIds: input.artifacts?.map((artifact) => artifact.id) ?? [],
        },
        clientMessageId: `compute-approval-result:${approval.id}`,
        deliveryStatus: MessageDeliveryStatus.SENT,
        retentionExpiresAt: buildMessageRetentionExpiry(now),
        createdAt: now,
      },
      update: {
        text,
        content: {
          kind: "compute_approval_result",
          approvalId: approval.id,
          outcome: input.outcome,
          ...(typeof input.actualCredits === "number" ? { actualCredits: input.actualCredits } : {}),
          artifactIds: input.artifacts?.map((artifact) => artifact.id) ?? [],
        },
        deliveryStatus: MessageDeliveryStatus.SENT,
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
        ...(walletReservation || delegationTaskOwnsBilling || input.outcome !== "completed"
          ? {}
          : { freeRepliesUsed: { increment: 1 } }),
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
      if (input.outcome === "completed") {
        await consumeConversationEntitlementByGenerationRunId(
          { generationRunId: run.id },
          tx as unknown as ServiceEntitlementClient,
        );
      } else {
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
      if (input.outcome === "completed") {
        await settleConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            settledTokenAmount: walletReservation.tokenAmount,
            provider: "compute",
            idempotencyKey: `generation:${run.id}:settle`,
          },
          tx as unknown as UsageChargeClient,
        );
      } else {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
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
    return {
      message,
      delegationTaskId: approval.delegationTaskId,
      delegationTaskStepId: approval.delegationTaskStepId,
      generationRunId: run.id,
      conversationId: run.conversationId,
      episodeId: run.episodeId,
    };
  });
  if (!result) return null;
  if (!result.message) return null;
  const resultMessage = result.message;
  let hasMoreSteps = false;
  if (result.delegationTaskId) {
    const finalization = await finalizeComputeDelegationTask({
      taskId: result.delegationTaskId,
      ...(result.delegationTaskStepId ? { stepId: result.delegationTaskStepId } : {}),
      generationRunId: result.generationRunId,
      outcome: input.outcome === "completed"
        ? "completed"
        : input.outcome === "rejected"
          ? "rejected"
          : input.outcome === "expired"
            ? "expired"
            : input.outcome === "policy_denied"
              ? "blocked"
              : "failed",
      ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      ...(typeof input.actualCredits === "number" ? { actualCredits: input.actualCredits } : {}),
    });
    hasMoreSteps = Boolean(finalization?.hasMoreSteps);
  }
  if (hasMoreSteps) {
    const text = "审批通过，当前步骤已完成，委托任务正在继续执行后续步骤。";
    return runConversationWriteTransaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${result.conversationId}))
      `;
      const writable = await tx.$executeRaw`
        UPDATE "Conversation"
        SET "state" = "state"
        WHERE "id" = ${result.conversationId}
          AND "state" NOT IN ('HUMAN_ACTIVE', 'NEEDS_HUMAN')
      `;
      if (writable !== 1) {
        return resultMessage;
      }
      await tx.conversation.update({
        where: { id: result.conversationId },
        data: { state: "AI_QUEUED", lastMessageAt: new Date() },
      });
      const message = await tx.message.update({
        where: { id: resultMessage.id },
        data: { text },
      });
      if (result.episodeId) {
        await tx.conversationEpisode.update({
          where: { id: result.episodeId },
          data: { status: ConversationEpisodeStatus.ACTIVE },
        });
      }
      return message;
    });
  }
  return result.message;
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
  actualCredits?: number;
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
  const billing = typeof input.actualCredits === "number" ? `\n\n消耗：${input.actualCredits} credits` : "";
  if (input.outcome === "failed") {
    return `审批已通过，但委托任务执行失败。\n\n${artifacts}${publicFailureReason ? `\n\n原因：${publicFailureReason}` : ""}${billing}`;
  }
  return `审批已通过，委托任务执行完成。\n\n${artifacts}${billing}`;
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
