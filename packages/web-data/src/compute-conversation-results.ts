import {
  ConversationEpisodeStatus,
  GenerationRunStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
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
  const result = await runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.approvalId}))`;
    const approval = await tx.approvalRequest.findUnique({
      where: { id: input.approvalId },
      include: {
        generationRun: true,
        representative: { select: { displayName: true, slug: true } },
      },
    });
    const run = approval?.generationRun;
    if (!approval || !run) return null;
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

    const now = new Date();
    const walletReservation = readGenerationWalletReservation(
      run.runtimePolicySnapshot,
    );
    const delegationTaskOwnsBilling = Boolean(
      approval.delegationTaskId && approval.delegationTaskStepId,
    );
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

    await tx.generationRun.update({
      where: { id: run.id },
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
    await tx.conversation.update({
      where: { id: run.conversationId },
      data: {
        state: "WAITING_USER",
        lastMessageAt: now,
        ...(walletReservation || delegationTaskOwnsBilling || input.outcome !== "completed"
          ? {}
          : { freeRepliesUsed: { increment: 1 } }),
      },
    });
    await tx.conversationEpisode.updateMany({
      where: { id: run.episodeId || "__no_episode__" },
      data: { status: ConversationEpisodeStatus.WAITING_USER },
    });
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
    const [, message] = await prisma.$transaction([
      prisma.conversation.update({
        where: { id: result.conversationId },
        data: { state: "AI_QUEUED", lastMessageAt: new Date() },
      }),
      prisma.message.update({
        where: { id: result.message.id },
        data: { text },
      }),
      ...(result.episodeId
        ? [prisma.conversationEpisode.update({ where: { id: result.episodeId }, data: { status: ConversationEpisodeStatus.ACTIVE } })]
        : []),
    ]);
    return message;
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
