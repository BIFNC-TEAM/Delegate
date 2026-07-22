import {
  ConversationEpisodeStatus,
  GenerationRunStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
} from "@prisma/client";
import { buildMessageRetentionExpiry } from "@delegate/runtime";

import { prisma } from "./prisma";

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
  return prisma.$transaction(async (tx) => {
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
      return tx.message.findUnique({ where: { id: run.outputMessageId } });
    }

    const now = new Date();
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
    await tx.conversation.update({
      where: { id: run.conversationId },
      data: {
        state: "WAITING_USER",
        lastMessageAt: now,
        freeRepliesUsed: { increment: 1 },
      },
    });
    await tx.conversationEpisode.updateMany({
      where: { id: run.episodeId || "__no_episode__" },
      data: { status: ConversationEpisodeStatus.WAITING_USER },
    });
    return message;
  });
}

function formatComputeOutcome(input: {
  outcome: ComputeApprovalConversationOutcome;
  artifacts?: Array<{ kind: string; summary?: string | null; objectKey: string }>;
  actualCredits?: number;
  failureReason?: string;
}) {
  if (input.outcome === "rejected") {
    return "Compute 请求未获批准，因此没有执行。";
  }
  if (input.outcome === "expired") {
    return "Compute 审批已超时，任务未执行。如仍需要，请重新提交请求。";
  }
  if (input.outcome === "policy_denied") {
    return `审批后安全策略复核未通过，任务没有执行。${input.failureReason ? `\n\n原因：${input.failureReason}` : ""}`;
  }

  const artifacts = input.artifacts?.length
    ? input.artifacts.map((artifact) => `${artifact.kind}: ${artifact.summary ?? artifact.objectKey}`).join("\n")
    : "没有生成可展示的结果文件。";
  const billing = typeof input.actualCredits === "number" ? `\n\n消耗：${input.actualCredits} credits` : "";
  if (input.outcome === "failed") {
    return `审批已通过，但 Compute 执行失败。\n\n${artifacts}${input.failureReason ? `\n\n原因：${input.failureReason}` : ""}${billing}`;
  }
  return `审批已通过，Compute 执行完成。\n\n${artifacts}${billing}`;
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
