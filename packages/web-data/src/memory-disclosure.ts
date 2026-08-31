import { createHash, randomUUID } from "node:crypto";

import {
  MemoryDisclosureDeliveryStatus,
  MemoryDisclosureEvidenceKind,
  Prisma,
  RepresentativeChannelKind,
  type RepresentativeMemoryPolicy,
} from "@prisma/client";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

export const memoryChannelDisclosureContractVersion =
  "private-channel-memory-v2";
export const contactMemorySharingConsentContractVersion =
  "cross-channel-contact-memory-v1";

/**
 * Reserved payload field written only by Delegate when a Matrix provider
 * event first enters ChannelEventInbox. Provider input with this field is
 * stripped before persistence, so the immutable inbox payload is the trusted
 * arrival-time lifecycle snapshot used by later asynchronous admission.
 */
export const matrixProviderArrivalFencePayloadKey =
  "com.delegate.arrival_fence" as const;

export type MatrixProviderArrivalFence = {
  version: 1;
  representativeBindingId: string;
  endpointAssignmentRevision: number;
  endpointLifecycleRevision: number;
  arrivedDesiredState: "ACTIVE" | "PAUSED" | "DISCONNECTED";
};

export function readMatrixProviderArrivalFence(
  payload: unknown,
): MatrixProviderArrivalFence | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = payload as Record<string, unknown>;
  if (
    value.version !== 1
    || typeof value.representativeBindingId !== "string"
    || !value.representativeBindingId.trim()
    || !isPositiveSafeInteger(value.endpointAssignmentRevision)
    || !isPositiveSafeInteger(value.endpointLifecycleRevision)
    || !["ACTIVE", "PAUSED", "DISCONNECTED"].includes(
      typeof value.arrivedDesiredState === "string"
        ? value.arrivedDesiredState
        : "",
    )
  ) return null;
  return {
    version: 1,
    representativeBindingId: value.representativeBindingId.trim(),
    endpointAssignmentRevision: value.endpointAssignmentRevision,
    endpointLifecycleRevision: value.endpointLifecycleRevision,
    arrivedDesiredState: value.arrivedDesiredState as
      MatrixProviderArrivalFence["arrivedDesiredState"],
  };
}

export function matrixProviderArrivalFenceMatches(input: {
  arrivalFence: MatrixProviderArrivalFence | null;
  representativeBindingId: string | null | undefined;
  representativeAssignmentRevision: number | null | undefined;
  currentBinding: {
    id: string;
    endpointAssignmentRevision: number;
    endpointLifecycleRevision: number;
    desiredState: "ACTIVE" | "PAUSED" | "DISCONNECTED";
  } | null | undefined;
}): boolean {
  const { arrivalFence, currentBinding } = input;
  return Boolean(
    arrivalFence
    && arrivalFence.arrivedDesiredState === "ACTIVE"
    && currentBinding
    && currentBinding.desiredState === "ACTIVE"
    && input.representativeBindingId === arrivalFence.representativeBindingId
    && currentBinding.id === arrivalFence.representativeBindingId
    && input.representativeAssignmentRevision
      === arrivalFence.endpointAssignmentRevision
    && currentBinding.endpointAssignmentRevision
      === arrivalFence.endpointAssignmentRevision
    && currentBinding.endpointLifecycleRevision
      === arrivalFence.endpointLifecycleRevision,
  );
}

const disclosureLeaseMilliseconds = 60_000;
const disclosureRetryDelayMilliseconds = 5_000;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const base64UrlSha256Pattern = /^[A-Za-z0-9_-]{43}$/u;

export type MemoryDisclosureChannel = "matrix" | "telegram";
export type MemoryDisclosureCapability = "extract" | "recall";

type MemoryDisclosurePolicy = Pick<
  RepresentativeMemoryPolicy,
  | "revision"
  | "longTermMemoryEnabled"
  | "shortTermMemoryEnabled"
  | "contactMemoryEnabled"
  | "contactMemoryCrossChannelEnabled"
  | "representativeExperienceEnabled"
  | "autoExtract"
  | "matrixRecallEnabled"
  | "matrixExtractEnabled"
  | "telegramRecallEnabled"
  | "telegramExtractEnabled"
  | "retentionDays"
  | "expiryAction"
>;

export type MemoryChannelDisclosureSnapshot = {
  channel: MemoryDisclosureChannel;
  policyRevision: number;
  longTermMemoryEnabled: boolean;
  shortTermMemoryEnabled: boolean;
  contactMemoryEnabled: boolean;
  representativeExperienceEnabled: boolean;
  automaticExtractionEnabled: boolean;
  recallEnabled: boolean;
  retentionDays: number | null;
  expiryAction: "ARCHIVE" | "DELETE" | null;
  crossChannelSharingEnabled: boolean;
  crossChannelDisclosureCommand: "/memory_share" | "!memory_share";
  crossChannelShareCommand:
    | "/memory_share confirm <一次性令牌>"
    | "!memory_share confirm <一次性令牌>";
  crossChannelUnshareCommand: "/memory_unshare" | "!memory_unshare";
  contactDeleteCommand: "删除我的记忆";
  ordinaryMessageDeletionObservable: boolean;
  chatMessageDeletionDeletesMemory: false;
};

export type MemoryChannelDisclosureDescriptor = {
  contractVersion: typeof memoryChannelDisclosureContractVersion;
  snapshot: MemoryChannelDisclosureSnapshot;
  fingerprint: string;
  disclosureHash: string;
  text: string;
};

export type MemoryChannelDisclosureClaim =
  | {
      send: false;
      status: "current" | "in_flight";
      deliveryId: string;
    }
  | {
      send: true;
      status: "claimed";
      deliveryId: string;
      leaseToken: string;
      conversationId: string;
      channelBindingId: string;
      channel: MemoryDisclosureChannel;
      text: string;
      fingerprint: string;
      disclosureHash: string;
      contractVersion: string;
    };

export function buildMemoryChannelDisclosureDescriptor(input: {
  channel: MemoryDisclosureChannel;
  policy: MemoryDisclosurePolicy | null | undefined;
}): MemoryChannelDisclosureDescriptor {
  const policyRevision = Number.isInteger(input.policy?.revision)
    && (input.policy?.revision ?? -1) >= 0
    ? input.policy!.revision
    : 0;
  const hasLongTermType = Boolean(
    input.policy?.longTermMemoryEnabled
    && (
      input.policy.contactMemoryEnabled
      || input.policy.representativeExperienceEnabled
    ),
  );
  const recallEnabled = hasLongTermType && channelFlag(
    input.policy,
    input.channel,
    "recall",
  );
  const automaticExtractionEnabled = Boolean(
    hasLongTermType
    && input.policy?.autoExtract
    && channelFlag(input.policy, input.channel, "extract"),
  );
  const snapshot: MemoryChannelDisclosureSnapshot = {
    channel: input.channel,
    policyRevision,
    longTermMemoryEnabled: hasLongTermType,
    shortTermMemoryEnabled: input.policy?.shortTermMemoryEnabled ?? true,
    contactMemoryEnabled: Boolean(
      hasLongTermType && input.policy?.contactMemoryEnabled,
    ),
    representativeExperienceEnabled: Boolean(
      hasLongTermType && input.policy?.representativeExperienceEnabled,
    ),
    automaticExtractionEnabled,
    recallEnabled,
    retentionDays: hasLongTermType
      ? Math.max(1, Math.trunc(input.policy?.retentionDays ?? 30))
      : null,
    expiryAction: hasLongTermType
      ? input.policy?.expiryAction ?? "ARCHIVE"
      : null,
    crossChannelSharingEnabled: Boolean(
      hasLongTermType
      && input.policy?.contactMemoryEnabled
      && input.policy.contactMemoryCrossChannelEnabled,
    ),
    crossChannelDisclosureCommand: input.channel === "matrix"
      ? "!memory_share"
      : "/memory_share",
    crossChannelShareCommand: input.channel === "matrix"
      ? "!memory_share confirm <一次性令牌>"
      : "/memory_share confirm <一次性令牌>",
    crossChannelUnshareCommand: input.channel === "matrix"
      ? "!memory_unshare"
      : "/memory_unshare",
    contactDeleteCommand: "删除我的记忆",
    ordinaryMessageDeletionObservable: input.channel === "matrix",
    chatMessageDeletionDeletesMemory: false,
  };
  const text = renderMemoryChannelDisclosure(snapshot);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([
      memoryChannelDisclosureContractVersion,
      snapshot,
    ]))
    .digest("base64url");
  const disclosureHash = createHash("sha256").update(text).digest("hex");
  return {
    contractVersion: memoryChannelDisclosureContractVersion,
    snapshot,
    fingerprint,
    disclosureHash,
    text,
  };
}

export function renderMemoryChannelDisclosure(
  snapshot: MemoryChannelDisclosureSnapshot,
): string {
  const channelName = snapshot.channel === "matrix" ? "Matrix" : "Telegram";
  const deletionZh = snapshot.channel === "telegram"
    ? "Telegram Bot 无法收到普通消息删除事件；在客户端删除消息不会撤回或清除长期记忆。必须发送 /forget、/delete_memory 或精确命令“删除我的记忆”，才能清除当前代表与当前 Telegram 渠道下的联系人记忆。编辑普通消息最多只会失效由该消息产生的记忆。"
    : "撤回或编辑普通聊天消息最多只会失效由该消息产生的记忆，不等于清除当前渠道的全部长期记忆；可发送 /forget、/delete_memory 或精确命令“删除我的记忆”，单独清除当前代表与当前 Matrix 渠道下的联系人记忆。";
  const deletionEn = snapshot.channel === "telegram"
    ? "Telegram Bots do not receive ordinary message-deletion events, so deleting a message in the client does not revoke or clear long-term memory. Use /forget, /delete_memory, or the exact command “删除我的记忆” to clear this representative's Contact Memory in this Telegram channel. Editing an ordinary message can at most invalidate memory derived from that message."
    : "Redacting or editing an ordinary message can at most invalidate memory derived from that message and does not clear all long-term memory in the channel. Use /forget, /delete_memory, or the exact command “删除我的记忆” to clear this representative's Contact Memory in this Matrix channel.";
  const shortTermZh = snapshot.shortTermMemoryEnabled
    ? "本次会话可使用有界的近期消息作为短期上下文；短期上下文不写入 OpenViking。"
    : "短期上下文已关闭。";
  const shortTermEn = snapshot.shortTermMemoryEnabled
    ? "Bounded recent messages may be used as same-conversation context and are not written to OpenViking."
    : "Short-term context is disabled.";
  const sharingZh = snapshot.crossChannelSharingEnabled
    ? `只有解析到同一已验证身份，且你先发送 ${snapshot.crossChannelDisclosureCommand} 查看当前说明、再明确发送 ${snapshot.crossChannelShareCommand} 同意后，联系人记忆才会在本对外代理已验证并启用的 Web、Matrix 和 Telegram 渠道间共享。发送 ${snapshot.crossChannelUnshareCommand} 会撤回同意、立即停止全部跨渠道召回，并异步删除共享投影。`
    : "跨渠道共享保持关闭。";
  const sharingEn = snapshot.crossChannelSharingEnabled
    ? `Contact Memory is shared across this representative's enabled, verified Web, Matrix, and Telegram channels only after they resolve to the same verified identity, you review the current disclosure with ${snapshot.crossChannelDisclosureCommand}, and then explicitly consent with ${snapshot.crossChannelShareCommand}. Use ${snapshot.crossChannelUnshareCommand} to withdraw consent, block all shared recall immediately, and asynchronously delete shared projections.`
    : "Cross-channel sharing remains off.";

  if (!snapshot.longTermMemoryEnabled) {
    return [
      "记忆说明 / Memory notice",
      `当前对外代理未在 ${channelName} 启用跨会话长期记忆。${shortTermZh}`,
      `原始聊天全文、私有备注、工具或 Compute 原始产物、凭据、支付、余额、退款和权益信息不会直接进入长期记忆。${deletionZh}${sharingZh}`,
      `Cross-conversation long-term memory is disabled for this representative on ${channelName}. ${shortTermEn} Raw transcripts, private notes, raw tool or Compute output, credentials, and payment or entitlement facts are excluded. ${deletionEn} ${sharingEn}`,
    ].join("\n\n");
  }

  const kindsZh = [
    snapshot.contactMemoryEnabled
      ? snapshot.crossChannelSharingEnabled
        ? "当前联系人在当前代表内的低风险结构化偏好"
        : "当前联系人在当前代表和当前渠道内的低风险结构化偏好"
      : null,
    snapshot.representativeExperienceEnabled
      ? "经过去标识化和多来源聚合的代表经验"
      : null,
  ].filter((value): value is string => Boolean(value)).join("；");
  const kindsEn = [
    snapshot.contactMemoryEnabled
      ? snapshot.crossChannelSharingEnabled
        ? "low-risk structured preferences scoped to this contact and representative"
        : "low-risk structured preferences scoped to this contact, representative, and channel"
      : null,
    snapshot.representativeExperienceEnabled
      ? "deidentified representative experience aggregated from multiple eligible sources"
      : null,
  ].filter((value): value is string => Boolean(value)).join("; ");
  const extractionZh = snapshot.automaticExtractionEnabled
    ? "符合白名单且通过来源、范围与安全检查的内容可自动提取；不确定或敏感内容会被阻止。"
    : "新消息的长期记忆自动提取已关闭。";
  const extractionEn = snapshot.automaticExtractionEnabled
    ? "Allowlisted content may be extracted only after source, scope, and safety checks; uncertain or sensitive content is blocked."
    : "Automatic extraction from new messages is disabled.";
  const recallZh = snapshot.recallEnabled
    ? "已生效且仍通过当前策略的记忆可用于后续回答。"
    : "长期记忆召回当前关闭，已有记忆不会用于回答。";
  const recallEn = snapshot.recallEnabled
    ? "Active memory that still passes current policy may support later replies."
    : "Long-term recall is disabled, so existing memory is not used in replies.";
  const expiryZh = snapshot.expiryAction === "DELETE"
    ? "到期先停止召回，再异步物理清理"
    : "到期归档并停止召回";
  const expiryEn = snapshot.expiryAction === "DELETE"
    ? "recall stops first and asynchronous physical cleanup follows"
    : "it is archived and recall stops";

  return [
    "记忆说明 / Memory notice",
    `本对外代理在 ${channelName} 可使用：${kindsZh}。${extractionZh}${recallZh}${shortTermZh}`,
    `长期记忆保留 ${snapshot.retentionDays} 天，${expiryZh}。联系人记忆绝不会与其他联系人或代表共享。${sharingZh}原始聊天全文、私有备注、工具或 Compute 原始产物、身份字段、凭据、商业机密、支付、余额、退款和权益信息不会直接进入长期记忆。${deletionZh}`,
    `On ${channelName}, eligible memory includes ${kindsEn}. ${extractionEn} ${recallEn} ${shortTermEn} Active memory is retained for ${snapshot.retentionDays} days; ${expiryEn}. Contact memory is never shared with another contact or representative. ${sharingEn} Raw transcripts, private notes, raw tool or Compute output, identity fields, credentials, commercial secrets, and payment or entitlement facts are excluded. ${deletionEn}`,
  ].join("\n\n");
}

export async function claimMemoryChannelDisclosureDelivery(input: {
  conversationId: string;
  channel: MemoryDisclosureChannel;
  /**
   * Every provider message in the inbound batch currently being admitted.
   * If delivery is not already durable, all IDs become immutable exclusions.
   */
  inboundExternalMessageIds: readonly string[];
}): Promise<MemoryChannelDisclosureClaim> {
  const inboundExternalMessageIds = normalizeInboundExternalMessageIds(
    input.inboundExternalMessageIds,
  );
  return runWithPrismaWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const channel = toChannelKind(input.channel);
    const lockKey = memoryDisclosureScopeLockKey(
      input.conversationId,
      input.channel,
    );
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        id: true,
        representativeId: true,
        contactId: true,
        sourceChannel: true,
        representative: {
          select: { memoryPolicy: { select: memoryDisclosurePolicySelect } },
        },
        channelBindings: {
          where: { kind: channel },
          take: 1,
          select: {
            id: true,
            kind: true,
            connectionId: true,
            externalConversationId: true,
            representativeAssignmentRevision: true,
          },
        },
      },
    });
    const binding = conversation?.channelBindings[0];
    if (
      !conversation
      || !binding
      || binding.kind !== channel
      || normalizeChannel(conversation.sourceChannel) !== input.channel
    ) {
      throw new Error("Memory disclosure conversation scope is unavailable.");
    }
    const descriptor = buildMemoryChannelDisclosureDescriptor({
      channel: input.channel,
      policy: conversation.representative.memoryPolicy,
    });
    const bindingEpoch = buildBindingEpoch(binding);
    const now = new Date();
    let current = await tx.memoryChannelDisclosureDelivery.findUnique({
      where: {
        channelBindingId_policyRevision_disclosureContractVersion_bindingEpoch: {
          channelBindingId: binding.id,
          policyRevision: descriptor.snapshot.policyRevision,
          disclosureContractVersion: descriptor.contractVersion,
          bindingEpoch,
        },
      },
    });
    if (current) {
      // Completion and concurrent claims serialize on the delivery row. A
      // claim appends exclusions iff the locked row is not already DELIVERED.
      await tx.$queryRaw`
        SELECT "id"
          FROM "MemoryChannelDisclosureDelivery"
         WHERE "id" = ${current.id}
         FOR UPDATE
      `;
      current = await tx.memoryChannelDisclosureDelivery.findUnique({
        where: { id: current.id },
      });
      if (!current) {
        throw new Error("Memory disclosure delivery disappeared while locked.");
      }
      if (current.status !== MemoryDisclosureDeliveryStatus.DELIVERED) {
        const durableArrivalIds = await loadPendingMatrixProviderArrivalIds(
          tx,
          {
            conversationId: conversation.id,
            connectionId: binding.connectionId,
            externalConversationId: binding.externalConversationId,
            channel: input.channel,
          },
        );
        await recordMemoryDisclosureInboundExclusions(
          tx,
          current.id,
          mergeInboundExternalMessageIds(
            inboundExternalMessageIds,
            durableArrivalIds,
          ),
        );
      }
    }
    if (current?.status === MemoryDisclosureDeliveryStatus.DELIVERED) {
      if (
        current.disclosureFingerprint !== descriptor.fingerprint
        || current.disclosureHash !== descriptor.disclosureHash
      ) {
        throw new Error(
          "Memory disclosure content changed without a contract version bump.",
        );
      }
      return { send: false, status: "current", deliveryId: current.id };
    }
    if (
      current?.status === MemoryDisclosureDeliveryStatus.PENDING
      && current.leaseToken
      && current.leaseExpiresAt
      && current.leaseExpiresAt > now
    ) {
      return { send: false, status: "in_flight", deliveryId: current.id };
    }
    if (
      current?.status === MemoryDisclosureDeliveryStatus.FAILED
      && current.availableAt > now
    ) {
      return { send: false, status: "in_flight", deliveryId: current.id };
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + disclosureLeaseMilliseconds);
    const evidenceKind = input.channel === "matrix"
      ? MemoryDisclosureEvidenceKind.MATRIX_MESSAGE
      : MemoryDisclosureEvidenceKind.TELEGRAM_MESSAGE;
    const record = current
      ? await tx.memoryChannelDisclosureDelivery.update({
          where: { id: current.id },
          data: {
            status: MemoryDisclosureDeliveryStatus.PENDING,
            disclosureFingerprint: descriptor.fingerprint,
            disclosureHash: descriptor.disclosureHash,
            disclosureSnapshot: descriptor.snapshot,
            evidenceKind,
            representativeAssignmentRevision:
              binding.representativeAssignmentRevision,
            connectionId: binding.connectionId,
            externalMessageId: null,
            proofHash: null,
            attemptCount: { increment: 1 },
            availableAt: now,
            leaseToken,
            leaseExpiresAt,
            deliveredAt: null,
            lastErrorCode: null,
          },
        })
      : await tx.memoryChannelDisclosureDelivery.create({
          data: {
            representativeId: conversation.representativeId,
            contactId: conversation.contactId,
            conversationId: conversation.id,
            channelBindingId: binding.id,
            bindingEpoch,
            sourceChannel: channel,
            policyRevision: descriptor.snapshot.policyRevision,
            disclosureContractVersion: descriptor.contractVersion,
            disclosureFingerprint: descriptor.fingerprint,
            disclosureHash: descriptor.disclosureHash,
            disclosureSnapshot: descriptor.snapshot,
            evidenceKind,
            representativeAssignmentRevision:
              binding.representativeAssignmentRevision,
            connectionId: binding.connectionId,
            status: MemoryDisclosureDeliveryStatus.PENDING,
            attemptCount: 1,
            availableAt: now,
            leaseToken,
            leaseExpiresAt,
          },
        });
    if (!current) {
      const durableArrivalIds = await loadPendingMatrixProviderArrivalIds(
        tx,
        {
          conversationId: conversation.id,
          connectionId: binding.connectionId,
          externalConversationId: binding.externalConversationId,
          channel: input.channel,
        },
      );
      await recordMemoryDisclosureInboundExclusions(
        tx,
        record.id,
        mergeInboundExternalMessageIds(
          inboundExternalMessageIds,
          durableArrivalIds,
        ),
      );
    }
    return {
      send: true,
      status: "claimed",
      deliveryId: record.id,
      leaseToken,
      conversationId: conversation.id,
      channelBindingId: binding.id,
      channel: input.channel,
      text: descriptor.text,
      fingerprint: descriptor.fingerprint,
      disclosureHash: descriptor.disclosureHash,
      contractVersion: descriptor.contractVersion,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function completeMemoryChannelDisclosureDelivery(input: {
  deliveryId: string;
  leaseToken: string;
  externalMessageId: string;
  deliveredAt?: Date;
}): Promise<boolean> {
  const externalMessageId = input.externalMessageId.trim();
  if (!externalMessageId) throw new Error("Disclosure external message ID is required.");
  const deliveredAt = input.deliveredAt ?? new Date();
  return runWithPrismaWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const scope = await tx.memoryChannelDisclosureDelivery.findUnique({
      where: { id: input.deliveryId },
      select: {
        conversationId: true,
        sourceChannel: true,
        channelBinding: {
          select: { externalConversationId: true },
        },
      },
    });
    if (!scope) return false;
    const scopeChannel = normalizeChannel(scope.sourceChannel);
    if (!scopeChannel) return false;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${memoryDisclosureScopeLockKey(
          scope.conversationId,
          scopeChannel,
        )})
      )
    `;
    // Serialize with acceptInboundConversationMessage, which assigns the
    // authoritative per-conversation ingress sequence under this same lock.
    // This makes the completion boundary linearizable without trusting any
    // provider timestamp or application clock.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${scope.conversationId}))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.deliveryId}))
    `;
    await tx.$queryRaw`
      SELECT "id"
        FROM "MemoryChannelDisclosureDelivery"
       WHERE "id" = ${input.deliveryId}
       FOR UPDATE
    `;
    const current = await tx.memoryChannelDisclosureDelivery.findUnique({
      where: { id: input.deliveryId },
    });
    if (!current) return false;
    if (current.status === MemoryDisclosureDeliveryStatus.DELIVERED) {
      return current.externalMessageId === externalMessageId;
    }
    if (
      current.status !== MemoryDisclosureDeliveryStatus.PENDING
      || current.leaseToken !== input.leaseToken
      || !current.leaseExpiresAt
      || current.leaseExpiresAt <= deliveredAt
      || !base64UrlSha256Pattern.test(current.disclosureFingerprint)
      || !sha256Pattern.test(current.disclosureHash)
    ) return false;
    const ingressBoundary = await tx.message.aggregate({
      where: {
        conversationId: current.conversationId,
        senderType: "AUDIENCE",
        ingressSequence: { not: null },
      },
      _max: { ingressSequence: true },
    });
    const deliveredAfterIngressSequence =
      ingressBoundary._max.ingressSequence ?? 0;
    if (
      !Number.isSafeInteger(deliveredAfterIngressSequence)
      || deliveredAfterIngressSequence < 0
    ) return false;
    const durableArrivalIds = await loadPendingMatrixProviderArrivalIds(tx, {
      conversationId: current.conversationId,
      connectionId: current.connectionId,
      externalConversationId: scope.channelBinding.externalConversationId,
      channel: scopeChannel,
    });
    if (durableArrivalIds.length > 0) {
      await recordMemoryDisclosureInboundExclusions(
        tx,
        current.id,
        durableArrivalIds,
      );
    }
    const proofHash = sha256([
      "memory-channel-disclosure-delivery-v2",
      current.id,
      current.representativeId,
      current.contactId,
      current.conversationId,
      current.channelBindingId,
      current.bindingEpoch,
      current.sourceChannel,
      current.policyRevision,
      current.disclosureContractVersion,
      current.disclosureFingerprint,
      current.disclosureHash,
      current.evidenceKind,
      deliveredAfterIngressSequence,
      externalMessageId,
      deliveredAt.toISOString(),
    ]);
    const updated = await tx.memoryChannelDisclosureDelivery.updateMany({
      where: {
        id: current.id,
        status: MemoryDisclosureDeliveryStatus.PENDING,
        leaseToken: input.leaseToken,
      },
      data: {
        status: MemoryDisclosureDeliveryStatus.DELIVERED,
        externalMessageId,
        proofHash,
        deliveredAt,
        deliveredAfterIngressSequence,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      },
    });
    return updated.count === 1;
  }));
}

export async function failMemoryChannelDisclosureDelivery(input: {
  deliveryId: string;
  leaseToken: string;
  errorCode: string;
}): Promise<boolean> {
  const errorCode = normalizeErrorCode(input.errorCode);
  const now = new Date();
  const updated = await prisma.memoryChannelDisclosureDelivery.updateMany({
    where: {
      id: input.deliveryId,
      status: MemoryDisclosureDeliveryStatus.PENDING,
      leaseToken: input.leaseToken,
    },
    data: {
      status: MemoryDisclosureDeliveryStatus.FAILED,
      availableAt: new Date(now.getTime() + disclosureRetryDelayMilliseconds),
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode,
    },
  });
  return updated.count === 1;
}

/**
 * Seals the immutable receive-order boundary for the current private-channel
 * disclosure. The first audience message observed after delivery is always
 * excluded from both extraction and recall; only later messages may pass.
 *
 * This deliberately uses the database-assigned ingress sequence instead of a
 * provider timestamp or application clock. A missing delegate/sequence fails
 * closed in authorization and is tolerated here only for rolling deploys.
 */
export async function activateCurrentMemoryChannelDisclosureAfterMessage(
  tx: Prisma.TransactionClient,
  input: {
    representativeId: string;
    contactId: string;
    conversationId: string;
    messageId: string;
    channel: MemoryDisclosureChannel;
  },
): Promise<boolean> {
  if (!hasDisclosureActivationDelegate(tx)) return false;
  const [message, policy] = await Promise.all([
    tx.message.findFirst({
      where: {
        id: input.messageId,
        conversationId: input.conversationId,
        senderType: "AUDIENCE",
        conversation: {
          representativeId: input.representativeId,
          contactId: input.contactId,
          sourceChannel: input.channel,
        },
      },
      select: {
        id: true,
        ingressSequence: true,
        channelBindingId: true,
        channelBinding: {
          select: {
            id: true,
            kind: true,
            connectionId: true,
            representativeAssignmentRevision: true,
          },
        },
      },
    }),
    tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: input.representativeId },
      select: memoryDisclosurePolicySelect,
    }),
  ]);
  const binding = message?.channelBinding;
  if (
    !message
    || !Number.isSafeInteger(message.ingressSequence)
    || (message.ingressSequence ?? 0) <= 0
    || !message.channelBindingId
    || !binding
    || binding.kind !== toChannelKind(input.channel)
  ) return false;

  const descriptor = buildMemoryChannelDisclosureDescriptor({
    channel: input.channel,
    policy,
  });
  const delivery = await tx.memoryChannelDisclosureDelivery.findFirst({
    where: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      channelBindingId: binding.id,
      bindingEpoch: buildBindingEpoch(binding),
      sourceChannel: toChannelKind(input.channel),
      policyRevision: descriptor.snapshot.policyRevision,
      disclosureContractVersion: descriptor.contractVersion,
      disclosureFingerprint: descriptor.fingerprint,
      disclosureHash: descriptor.disclosureHash,
      status: MemoryDisclosureDeliveryStatus.DELIVERED,
      externalMessageId: { not: null },
      proofHash: { not: null },
    },
    select: {
      id: true,
      deliveredAfterIngressSequence: true,
      connectionId: true,
      representativeAssignmentRevision: true,
      evidenceKind: true,
      proofHash: true,
      activation: {
        select: {
          firstExcludedMessageId: true,
          firstExcludedIngressSequence: true,
        },
      },
    },
  });
  if (
    !delivery
    || !Number.isSafeInteger(delivery.deliveredAfterIngressSequence)
    || (delivery.deliveredAfterIngressSequence ?? -1) < 0
    || message.ingressSequence! <= delivery.deliveredAfterIngressSequence!
    || !delivery.proofHash
    || !sha256Pattern.test(delivery.proofHash)
    || delivery.connectionId !== binding.connectionId
    || delivery.representativeAssignmentRevision
      !== binding.representativeAssignmentRevision
    || (
      input.channel === "matrix"
        ? delivery.evidenceKind !== MemoryDisclosureEvidenceKind.MATRIX_MESSAGE
        : delivery.evidenceKind !== MemoryDisclosureEvidenceKind.TELEGRAM_MESSAGE
    )
  ) return false;
  if (delivery.activation) {
    return delivery.activation.firstExcludedMessageId === message.id
      || delivery.activation.firstExcludedIngressSequence
        < message.ingressSequence!;
  }

  const boundaryMessage = await tx.message.findFirst({
    where: {
      conversationId: input.conversationId,
      channelBindingId: binding.id,
      senderType: "AUDIENCE",
      ingressSequence: {
        gt: delivery.deliveredAfterIngressSequence!,
        lte: message.ingressSequence!,
      },
    },
    orderBy: { ingressSequence: "asc" },
    select: { id: true, ingressSequence: true },
  });
  if (
    !boundaryMessage
    || !Number.isSafeInteger(boundaryMessage.ingressSequence)
    || boundaryMessage.ingressSequence
      !== delivery.deliveredAfterIngressSequence! + 1
  ) return false;

  const created = await tx.memoryChannelDisclosureActivation.createMany({
    data: [{
      deliveryId: delivery.id,
      firstExcludedMessageId: boundaryMessage.id,
      firstExcludedIngressSequence: boundaryMessage.ingressSequence!,
    }],
    skipDuplicates: true,
  });
  return created.count === 1;
}

/**
 * Authorizes one governed-memory capability for one exact inbound message.
 * Web uses its request-bound proof. Private channels require a successfully
 * delivered, current disclosure on the exact channel binding. The first
 * server-ordered message after disclosure is an explicit exclusion boundary;
 * only later messages may use memory.
 */
export async function hasCurrentMemoryChannelDisclosureForMessage(
  tx: Prisma.TransactionClient | typeof prisma,
  input: {
    representativeId: string;
    contactId: string;
    conversationId: string;
    messageId: string;
    channel: "web" | MemoryDisclosureChannel;
    capability: MemoryDisclosureCapability;
  },
): Promise<boolean> {
  if (input.channel === "web") return true;
  if (!hasDisclosureDelegate(tx)) return false;
  const [message, policy] = await Promise.all([
    tx.message.findFirst({
      where: {
        id: input.messageId,
        conversationId: input.conversationId,
        conversation: {
          representativeId: input.representativeId,
          contactId: input.contactId,
          sourceChannel: input.channel,
        },
      },
      select: {
        id: true,
        ingressSequence: true,
        externalMessageId: true,
        channelBindingId: true,
        channelBinding: {
          select: {
            id: true,
            kind: true,
            connectionId: true,
            representativeAssignmentRevision: true,
          },
        },
      },
    }),
    tx.representativeMemoryPolicy.findUnique({
      where: { representativeId: input.representativeId },
      select: memoryDisclosurePolicySelect,
    }),
  ]);
  const descriptor = buildMemoryChannelDisclosureDescriptor({
    channel: input.channel,
    policy,
  });
  const capabilityEnabled = input.capability === "recall"
    ? descriptor.snapshot.recallEnabled
    : descriptor.snapshot.automaticExtractionEnabled;
  const binding = message?.channelBinding;
  if (
    !capabilityEnabled
    || !message
    || !Number.isSafeInteger(message.ingressSequence)
    || (message.ingressSequence ?? 0) <= 0
    || !message.externalMessageId?.trim()
    || !message.channelBindingId
    || !binding
    || binding.kind !== toChannelKind(input.channel)
  ) return false;

  const delivery = await tx.memoryChannelDisclosureDelivery.findFirst({
    where: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      channelBindingId: binding.id,
      bindingEpoch: buildBindingEpoch(binding),
      sourceChannel: toChannelKind(input.channel),
      policyRevision: descriptor.snapshot.policyRevision,
      disclosureContractVersion: descriptor.contractVersion,
      disclosureFingerprint: descriptor.fingerprint,
      disclosureHash: descriptor.disclosureHash,
      status: MemoryDisclosureDeliveryStatus.DELIVERED,
      excludedInboundMessages: {
        none: {
          externalInboundMessageId: message.externalMessageId,
        },
      },
    },
    select: {
      deliveredAt: true,
      deliveredAfterIngressSequence: true,
      externalMessageId: true,
      proofHash: true,
      connectionId: true,
      representativeAssignmentRevision: true,
      evidenceKind: true,
      activation: {
        select: {
          firstExcludedMessageId: true,
          firstExcludedIngressSequence: true,
          firstExcludedMessage: {
            select: {
              conversationId: true,
              channelBindingId: true,
              ingressSequence: true,
            },
          },
        },
      },
    },
  });
  const activation = delivery?.activation;
  if (
    !delivery?.deliveredAt
    || !Number.isSafeInteger(delivery.deliveredAfterIngressSequence)
    || (delivery.deliveredAfterIngressSequence ?? -1) < 0
    || !delivery.externalMessageId
    || !delivery.proofHash
    || !sha256Pattern.test(delivery.proofHash)
    || delivery.connectionId !== binding.connectionId
    || delivery.representativeAssignmentRevision
      !== binding.representativeAssignmentRevision
    || !activation
    || activation.firstExcludedMessage.conversationId !== input.conversationId
    || activation.firstExcludedMessage.channelBindingId !== binding.id
    || activation.firstExcludedMessage.ingressSequence
      !== activation.firstExcludedIngressSequence
    || activation.firstExcludedIngressSequence
      !== delivery.deliveredAfterIngressSequence! + 1
    || activation.firstExcludedIngressSequence >= message.ingressSequence!
  ) return false;
  return input.channel === "matrix"
    ? delivery.evidenceKind === MemoryDisclosureEvidenceKind.MATRIX_MESSAGE
    : delivery.evidenceKind === MemoryDisclosureEvidenceKind.TELEGRAM_MESSAGE;
}

const memoryDisclosurePolicySelect = {
  revision: true,
  longTermMemoryEnabled: true,
  shortTermMemoryEnabled: true,
  contactMemoryEnabled: true,
  contactMemoryCrossChannelEnabled: true,
  representativeExperienceEnabled: true,
  autoExtract: true,
  matrixRecallEnabled: true,
  matrixExtractEnabled: true,
  telegramRecallEnabled: true,
  telegramExtractEnabled: true,
  retentionDays: true,
  expiryAction: true,
} as const;

function channelFlag(
  policy: MemoryDisclosurePolicy | null | undefined,
  channel: MemoryDisclosureChannel,
  capability: MemoryDisclosureCapability,
) {
  if (!policy) return false;
  if (channel === "matrix") {
    return capability === "recall"
      ? policy.matrixRecallEnabled
      : policy.matrixExtractEnabled;
  }
  return capability === "recall"
    ? policy.telegramRecallEnabled
    : policy.telegramExtractEnabled;
}

function toChannelKind(channel: MemoryDisclosureChannel) {
  return channel === "matrix"
    ? RepresentativeChannelKind.MATRIX
    : RepresentativeChannelKind.TELEGRAM;
}

function normalizeChannel(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "matrix" || normalized === "telegram"
    ? normalized
    : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function buildBindingEpoch(input: {
  connectionId: string | null;
  representativeAssignmentRevision: number | null;
}) {
  return sha256([
    "memory-channel-binding-epoch-v1",
    input.connectionId,
    input.representativeAssignmentRevision,
  ]);
}

function hasDisclosureDelegate(tx: Prisma.TransactionClient | typeof prisma) {
  return Boolean(
    (tx as unknown as Record<string, unknown>)["memoryChannelDisclosureDelivery"],
  );
}

function hasDisclosureActivationDelegate(tx: Prisma.TransactionClient) {
  const delegates = tx as unknown as Record<string, unknown>;
  return Boolean(
    delegates["memoryChannelDisclosureDelivery"]
    && delegates["memoryChannelDisclosureActivation"],
  );
}

function normalizeErrorCode(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_:-]/gu, "_");
  return normalized.slice(0, 120) || "memory_disclosure_delivery_failed";
}

function memoryDisclosureScopeLockKey(
  conversationId: string,
  channel: MemoryDisclosureChannel,
) {
  return `memory-disclosure:${conversationId}:${toChannelKind(channel)}`;
}

function normalizeInboundExternalMessageIds(values: readonly string[]) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 128) {
    throw new Error(
      "Memory disclosure requires 1 to 128 inbound provider message IDs.",
    );
  }
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (
    normalized.length === 0
    || normalized.some((value) => !value || value.length > 512)
  ) {
    throw new Error("Memory disclosure inbound provider message ID is invalid.");
  }
  return normalized;
}

async function recordMemoryDisclosureInboundExclusions(
  tx: Prisma.TransactionClient,
  deliveryId: string,
  externalInboundMessageIds: readonly string[],
) {
  const batchSize = 256;
  for (let offset = 0; offset < externalInboundMessageIds.length; offset += batchSize) {
    const batch = externalInboundMessageIds.slice(offset, offset + batchSize);
    await tx.memoryChannelDisclosureExcludedInbound.createMany({
      data: batch.map((externalInboundMessageId) => ({
        deliveryId,
        externalInboundMessageId,
      })),
      skipDuplicates: true,
    });
  }
}

async function loadPendingMatrixProviderArrivalIds(
  tx: Prisma.TransactionClient,
  input: {
    conversationId: string;
    connectionId: string | null;
    externalConversationId: string;
    channel: MemoryDisclosureChannel;
  },
) {
  if (input.channel !== "matrix" || !input.connectionId) return [];
  const rows = await tx.channelEventInbox.findMany({
    where: {
      kind: RepresentativeChannelKind.MATRIX,
      connectionId: input.connectionId,
      eventType: "m.room.message",
      status: { not: "PROCESSED" },
      // A provider event is durable before remote room validation and may not
      // yet be associated with the conversation. Include that exact provider
      // room without mutating ownership; normal business ingestion performs
      // the authoritative association after validation.
      OR: [
        { conversationId: input.conversationId },
        {
          conversationId: null,
          payload: {
            path: ["room_id"],
            equals: input.externalConversationId,
          },
        },
      ],
    },
    select: {
      externalEventId: true,
      payload: true,
    },
  });
  return rows.flatMap((row) => (
    isOrdinaryMatrixMemoryProviderArrival(row.payload)
      ? [row.externalEventId]
      : []
  ));
}

function isOrdinaryMatrixMemoryProviderArrival(payload: Prisma.JsonValue) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const content = payload.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return false;
  }
  if (
    content.msgtype !== "m.text"
    || typeof content.body !== "string"
    || !content.body.trim()
  ) return false;
  const relatesTo = content["m.relates_to"];
  return !(
    relatesTo
    && typeof relatesTo === "object"
    && !Array.isArray(relatesTo)
    && relatesTo.rel_type === "m.replace"
  );
}

function mergeInboundExternalMessageIds(
  left: readonly string[],
  right: readonly string[],
) {
  return [...new Set([...left, ...right])];
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
