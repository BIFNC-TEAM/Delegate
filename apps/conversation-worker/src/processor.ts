import { processV2ConversationTurn } from "./processor-v2";

import { isConversationCancellationRequest } from "@delegate/runtime";

import {
  ContactMemorySharingError,
  assertConversationChannelDeliveryAvailable,
  cancelGenerationPendingApprovals,
  claimNextConversationMessageDeliveryWorkItem,
  claimNextGenerationWorkItem,
  claimNextOperatorMessageWorkItem,
  completeConversationMessageDelivery,
  completeInlineGenerationRun,
  completeOperatorMessageDelivery,
  contactMemorySharingConsentContractVersion,
  createContactMemorySharingChallenge,
  deferConversationMessageDelivery,
  deferGenerationRunForHuman,
  deferOperatorMessageDelivery,
  failGenerationRun,
  getRepresentativeRuntimeSetupSnapshot,
  grantContactMemorySharingConsent,
  isDeterministicContactMemoryDeleteCommand,
  isGenerationMemoryDeliveryBlockedError,
  isGenerationPlanDeliverySupersededError,
  isGenerationWorkLeaseLostError,
  loadConversationOperationalContext,
  matrixServerNameFromUserId,
  pinGenerationAgentVariant,
  readContactMemorySharingChallengeToken,
  recordConversationMessageProviderAcceptance,
  recordOperatorMessageProviderAcceptance,
  resolveDeterministicContactMemorySharingCommand,
  retryConversationMessageDelivery,
  retryGenerationDelivery,
  retryOperatorMessageDelivery,
  revokeContactMemorySharingConsent
} from "@delegate/web-data";

import { agentContextBlockedMessage, isAgentContextAuthorizationError } from "@delegate/runtime";

import type { ConversationWorkerConfig } from "./config";

import {
  isComputeExecutionClaimLostError,
  isComputeGenerationExecutionInProgressError,
} from "./compute-client";

import { sendMatrixRepresentativeMessage } from "./matrix-outbound";

import { delegateAgentV2 } from "@delegate/model-runtime/v2";
import { buildProviderOutcomeUnknownRetry, deliverGenerationOutput, isConversationHumanControlError, isProviderAcceptancePendingCommit, isRecoverableOperatorPause, sendTelegramMessage } from "./generation-delivery";
import { startGenerationLeaseHeartbeat, type GenerationItem, type WorkLease } from "./generation-lease";
export async function processNextConversationWork(config: ConversationWorkerConfig) {
  const telegramWorkerEnabled = config.telegramConversationPlatformMode === "worker";
  const operatorItem = await claimNextOperatorMessageWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if(operatorItem) return deliverOperatorItem(config, operatorItem);

  const conversationMessageItem = await claimNextConversationMessageDeliveryWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if(conversationMessageItem) {
    return deliverConversationMessageItem(config, conversationMessageItem);
  }

  const item = await claimNextGenerationWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if(!item) return { processed: false as const };
  return processGenerationItem(config, item);
}

async function deliverOperatorItem(
  config: ConversationWorkerConfig,
  item: NonNullable<Awaited<ReturnType<typeof claimNextOperatorMessageWorkItem>>>,
) {
  const leaseAttempt = Number.isSafeInteger(item.leaseAttempt) ? item.leaseAttempt : 1;
  try {
    await assertConversationChannelDeliveryAvailable({
      conversationId: item.conversationId,
      channel: item.channel,
      senderMode: "operator",
    });
    let externalMessageId: string | undefined;
    if(item.channel === "matrix") {
      if(!item.matrixSenderUserId || !item.matrixEndpointLifecycleRevision) {
        throw new Error("Matrix operator delivery is missing its sender or lifecycle fence.");
      }
      externalMessageId = await sendMatrixRepresentativeMessage({
        config,
        conversationId: item.conversationId,
        roomId: item.externalConversationId,
        senderUserId: item.matrixSenderUserId,
        expectedEndpointLifecycleRevision: item.matrixEndpointLifecycleRevision,
        deliveryId: `operator-${item.messageId}`,
        senderMode: "human_operator",
        text: `${item.operatorName.trim().slice(0, 80) || "Operator"}: ${item.text}`,
      });
    } else {
      externalMessageId = await sendTelegramMessage({
        config,
        conversationId: item.conversationId,
        chatId: item.externalConversationId,
        ...(item.telegramConnectionId ? { connectionId: item.telegramConnectionId } : {}),
        text: `${item.operatorName}: ${item.text}`,
      });
    }
    if(externalMessageId) {
      await recordOperatorMessageProviderAcceptance({
        outboxId: item.outboxId,
        leaseAttempt,
        messageId: item.messageId,
        externalMessageId,
      });
    }
    const completed = await completeOperatorMessageDelivery({
      outboxId: item.outboxId,
      leaseAttempt,
      messageId: item.messageId,
      ...(externalMessageId ? { externalMessageId } : {}),
    });
    return {
      processed: true as const,
      runId: item.messageId,
      status: completed
        ? "completed" as const
        : externalMessageId ? "accepted_pending_reconciliation" as const : "lease_lost" as const,
    };
  } catch(error) {
    const errorMessage = error instanceof Error ? error.message : "Operator message delivery failed.";
    if(isRecoverableOperatorPause(error)) {
      await deferOperatorMessageDelivery({
        outboxId: item.outboxId,
        leaseAttempt,
        messageId: item.messageId,
        reason: error.code,
      });
      return { processed: true as const, runId: item.messageId, status: "deferred" as const };
    }
    await retryOperatorMessageDelivery({
      outboxId: item.outboxId,
      leaseAttempt,
      messageId: item.messageId,
      errorMessage,
      ...buildProviderOutcomeUnknownRetry(error),
    });
    return { processed: true as const, runId: item.messageId, status: "failed" as const, error: errorMessage };
  }
}

async function deliverConversationMessageItem(
  config: ConversationWorkerConfig,
  item: NonNullable<Awaited<ReturnType<typeof claimNextConversationMessageDeliveryWorkItem>>>,
) {
  try {
    const systemDelivery = item.deliveryKind === "system_notification";
    await assertConversationChannelDeliveryAvailable({
      conversationId: item.conversationId,
      channel: item.channel,
      senderMode: systemDelivery ? "system" : "ai",
      allowNeedsHumanDelivery: systemDelivery,
    });
    let externalMessageId: string | undefined;
    if(item.channel === "matrix") {
      if(!item.externalConversationId || !item.matrixSenderUserId || !item.matrixEndpointLifecycleRevision) {
        throw new Error("Matrix conversation-message delivery is missing its room, sender, or lifecycle fence.");
      }
      externalMessageId = await sendMatrixRepresentativeMessage({
        config,
        conversationId: item.conversationId,
        roomId: item.externalConversationId,
        senderUserId: item.matrixSenderUserId,
        expectedEndpointLifecycleRevision: item.matrixEndpointLifecycleRevision,
        deliveryId: `conversation-message-${item.messageId}`,
        senderMode: "ai",
        text: item.text,
      });
    } else if(item.channel === "telegram") {
      if(!item.externalConversationId) {
        throw new Error("Telegram conversation-message delivery is missing its chat binding.");
      }
      externalMessageId = await sendTelegramMessage({
        config,
        conversationId: item.conversationId,
        chatId: item.externalConversationId,
        ...(item.telegramConnectionId ? { connectionId: item.telegramConnectionId } : {}),
        text: item.text,
      });
    }
    if(externalMessageId) {
      await recordConversationMessageProviderAcceptance({
        outboxId: item.outboxId,
        leaseAttempt: item.leaseAttempt,
        messageId: item.messageId,
        externalMessageId,
      });
    }
    const completed = await completeConversationMessageDelivery({
      outboxId: item.outboxId,
      leaseAttempt: item.leaseAttempt,
      messageId: item.messageId,
      ...(externalMessageId ? { externalMessageId } : {}),
    });
    return {
      processed: true as const,
      runId: item.messageId,
      status: completed
        ? "completed" as const
        : externalMessageId ? "accepted_pending_reconciliation" as const : "lease_lost" as const,
    };
  } catch(error) {
    const errorMessage = error instanceof Error ? error.message : "Conversation message delivery failed.";
    if(isRecoverableOperatorPause(error)) {
      await deferConversationMessageDelivery({
        outboxId: item.outboxId,
        leaseAttempt: item.leaseAttempt,
        messageId: item.messageId,
        reason: error.code,
      });
      return { processed: true as const, runId: item.messageId, status: "deferred" as const };
    }
    await retryConversationMessageDelivery({
      outboxId: item.outboxId,
      leaseAttempt: item.leaseAttempt,
      messageId: item.messageId,
      errorMessage,
      ...buildProviderOutcomeUnknownRetry(error),
    });
    return { processed: true as const, runId: item.messageId, status: "failed" as const, error: errorMessage };
  }
}

async function processGenerationItem(config: ConversationWorkerConfig, item: GenerationItem) {
  const leaseGuard = startGenerationLeaseHeartbeat(item);
  const workLease = { outboxId: item.outboxId, leaseAttempt: item.leaseAttempt };
  let outputMessageId: string | undefined;
  try {
    leaseGuard.assertOwned();
    if(item.deliveryOnly) {
      if(!item.outputMessageId || !item.outputText) {
        throw new Error("Completed generation is missing its persisted delivery output.");
      }
      await deliverGenerationOutput({
        config,
        item,
        text: item.outputText,
        outputMessageId: item.outputMessageId,
      });
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }
    if(item.controlState === "HUMAN_ACTIVE" || item.controlState === "NEEDS_HUMAN") {
      await deferGenerationRunForHuman({ runId: item.runId, ...workLease });
      return { processed: true as const, runId: item.runId, status: "waiting_human" as const };
    }
    const setup = await getRepresentativeRuntimeSetupSnapshot(
      item.representativeSlug,
      item.representativeVersionId,
    );
    leaseGuard.assertOwned();
    if(!setup) throw new Error(`Representative ${item.representativeSlug} was not found.`);

    if(
      (item.channel === "matrix" || item.channel === "telegram")
      && isDeterministicContactMemoryDeleteCommand(item.userText)
    ) {
      return completeDeterministicGenerationTurn({
        config,
        item,
        workLease,
        replyText: renderContactMemoryDeleteConfirmation(item.channel),
        intent: "contact_memory_delete_confirmation",
      });
    }

    const sharingCommand = item.channel === "matrix"
      ? resolveDeterministicContactMemorySharingCommand(item.userText)
      : null;
    if(sharingCommand) {
      const replyText = await executeContactMemorySharingCommand({
        item,
        command: sharingCommand,
      });
      return completeDeterministicGenerationTurn({
        config,
        item,
        workLease,
        replyText,
        intent: `contact_memory_sharing_${sharingCommand.toLowerCase()}`,
      });
    }

    // A persisted old run can contain an uncertain write or approval checkpoint.
    // Preserve its record and stop; never replay it through a different loop.
    const variant = await pinGenerationAgentVariant({ runId: item.runId, ...workLease });
    if(variant !== "v2") {
      await failGenerationRun({
        conversationId: item.conversationId, runId: item.runId, ...workLease,
        errorCode: "legacy_agent_runtime_retired",
        errorMessage: "旧版任务已停止自动续跑，请先查看原执行回执；确认后可提交新请求。",
        retryable: false
      });
      return { processed: true as const, runId: item.runId, status: "legacy_retired" as const };
    }

    if(isConversationStatusCommand(item.userText)) {
      const context = await loadConversationOperationalContext({
        representativeId: setup.id,
        conversationId: item.conversationId,
        ...(item.audienceIdentityId ? { audienceIdentityId: item.audienceIdentityId } : {}),
      });
      return completeDeterministicGenerationTurn({
        config,
        item,
        workLease,
        replyText: renderConversationOperationalStatus(context),
        intent: "conversation_status",
      });
    }

    if(isConversationCancellationRequest(item.userText)) {
      const activeCanceled = delegateAgentV2.cancel(item.conversationId);
      const pending = await cancelGenerationPendingApprovals({ conversationId: item.conversationId, runId: item.runId, ...workLease });
      const replyText = pending.canceledCount > 0
        ? "已取消等待审批的任务，尚未执行的操作不会再继续。"
        : activeCanceled ? "已向运行中的任务发送取消信号；已经发生的操作不会自动撤销。"
          : "当前没有正在运行或等待审批的任务需要取消。";
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "pi_agent_cancel",
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }

    return await processV2ConversationTurn({ config, item, setup, leaseGuard, workLease });
  } catch(error) {
    if(isGenerationMemoryDeliveryBlockedError(error) || isGenerationPlanDeliverySupersededError(error)) {
      return { processed: true as const, runId: item.runId, status: "canceled" as const };
    }
    if(isProviderAcceptancePendingCommit(error)) {
      return { processed: true as const, runId: item.runId, status: "accepted_pending_reconciliation" as const };
    }
    if(isComputeGenerationExecutionInProgressError(error)) {
      return { processed: true as const, runId: item.runId, status: "execution_in_progress" as const };
    }
    if(
      leaseGuard.isLost()
      || isGenerationWorkLeaseLostError(error)
      || isComputeExecutionClaimLostError(error)
      || isConversationHumanControlError(error)
    ) {
      return { processed: true as const, runId: item.runId, status: "lease_lost" as const };
    }
    if(isAgentContextAuthorizationError(error)) {
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId, runId: item.runId, ...workLease,
        replyText: agentContextBlockedMessage, senderDisplayName: item.representativeName, intent: "agent_context_blocked", countUsage: false,
        evidenceIndependentSystemFailure: { failureCode: "agent_context_authorization_failed" }
      });
      return { processed: true as const, runId: item.runId, status: "context_blocked" as const };
    }
    const errorMessage = error instanceof Error ? error.message : "Pi conversation processing failed.";
    try {
      if(outputMessageId) {
        await retryGenerationDelivery({
          runId: item.runId,
          ...workLease,
          outputMessageId,
          errorMessage,
          ...buildProviderOutcomeUnknownRetry(error),
        });
      } else {
        await failGenerationRun({
          conversationId: item.conversationId,
          runId: item.runId,
          ...workLease,
          errorCode: errorMessage === "legacy_generation_not_supported_after_pi_cutover"
            ? "legacy_generation_not_supported_after_pi_cutover"
            : "pi_conversation_worker_failed",
          errorMessage,
        });
      }
    } catch(commitError) {
      if(leaseGuard.isLost() || isGenerationWorkLeaseLostError(commitError)) {
        return { processed: true as const, runId: item.runId, status: "lease_lost" as const };
      }
      throw commitError;
    }
    return { processed: true as const, runId: item.runId, status: "failed" as const, error: errorMessage };
  } finally {
    leaseGuard.stop();
  }
}

async function completeDeterministicGenerationTurn(input: {
  config: ConversationWorkerConfig;
  item: GenerationItem;
  workLease: WorkLease;
  replyText: string;
  intent: string;
}) {
  const completed = await completeInlineGenerationRun({
    conversationId: input.item.conversationId,
    runId: input.item.runId,
    ...input.workLease,
    replyText: input.replyText,
    senderDisplayName: input.item.representativeName,
    intent: input.intent,
    completeOutbox: false,
    countUsage: false,
    runtimeOutcome: {
      mode: "fallback",
      fallbackStrategy: "deterministic_preview",
      modelRuntimeState: "disabled",
      fallbackReason: "policy_fallback",
    },
  });
  const outputMessageId = completed.message.id;
  await deliverGenerationOutput({
    config: input.config,
    item: input.item,
    text: completed.message.text ?? input.replyText,
    outputMessageId,
  });
  return { processed: true as const, runId: input.item.runId, status: "completed" as const };
}

async function executeContactMemorySharingCommand(input: {
  item: GenerationItem;
  command: "DISCLOSE" | "GRANT" | "REVOKE" | "INVALID_CONFIRM";
}) {
  if(!input.item.audienceIdentityId) {
    return renderContactMemorySharingFailure("contact_memory_sharing_identity_ineligible");
  }
  if(input.command === "INVALID_CONFIRM") {
    return renderContactMemorySharingFailure("contact_memory_sharing_challenge_invalid");
  }
  try {
    if(input.command === "REVOKE") {
      const revoked = await revokeContactMemorySharingConsent({
        representativeSlug: input.item.representativeSlug,
        audienceIdentityId: input.item.audienceIdentityId,
        sourceChannel: "MATRIX",
      });
      return revoked.changed
        ? "已立即停止当前对外代理的跨渠道联系人记忆召回；共享记忆的远端投影已进入可重试清理队列。各渠道原始会话和渠道内记忆不受影响。"
        : "当前没有有效的跨渠道联系人记忆授权；系统已再次确认共享召回处于关闭状态。";
    }
    if(!input.item.sourceSenderId || !input.item.privateChannelConnectionId) {
      throw new ContactMemorySharingError(
        "contact_memory_sharing_source_unverified",
        "Matrix source coordinates are missing.",
        403,
      );
    }
    const sourceEvidence = {
      sourceChannel: "MATRIX" as const,
      providerSubject: input.item.sourceSenderId,
      issuer: matrixServerNameFromUserId(input.item.sourceSenderId),
      connectionId: input.item.privateChannelConnectionId,
    };
    if(input.command === "DISCLOSE") {
      const challenge = await createContactMemorySharingChallenge({
        representativeSlug: input.item.representativeSlug,
        audienceIdentityId: input.item.audienceIdentityId,
        disclosureContractVersion: contactMemorySharingConsentContractVersion,
        sourceEventKey: `matrix:${input.item.inputMessageId}`,
        ...sourceEvidence,
      });
      return renderContactMemorySharingDisclosure(challenge.challengeToken);
    }
    const challengeToken = readContactMemorySharingChallengeToken(
      input.item.userText.trim().replace(/\s+/gu, " ").slice("!memory_share ".length),
    );
    if(!challengeToken) {
      throw new ContactMemorySharingError(
        "contact_memory_sharing_challenge_invalid",
        "Matrix memory-sharing challenge token is missing.",
        409,
      );
    }
    const granted = await grantContactMemorySharingConsent({
      representativeSlug: input.item.representativeSlug,
      audienceIdentityId: input.item.audienceIdentityId,
      challengeToken,
      sourceEventKey: `matrix:${input.item.inputMessageId}`,
      ...sourceEvidence,
    });
    return granted.active
      ? "已允许当前对外代理在已验证为同一 Delegate 用户的 Web、Matrix 和 Telegram 私聊之间使用联系人记忆。"
      : renderContactMemorySharingFailure("contact_memory_sharing_conflict");
  } catch(error) {
    if(!(error instanceof ContactMemorySharingError)) throw error;
    return renderContactMemorySharingFailure(error.code);
  }
}

function isConversationStatusCommand(text: string) {
  const normalized = text.trim().replace(/\s+/gu, " ").toLowerCase();
  return normalized === "/status" || normalized === "!status"
    || normalized === "查询当前状态" || normalized === "查看当前状态";
}

function renderConversationOperationalStatus(
  context: Awaited<ReturnType<typeof loadConversationOperationalContext>>,
) {
  if(!context) return "当前无法读取会话状态，请稍后重试。";
  const lines = [`会话状态：${context.conversationState}`];
  if(context.activeCollector) lines.push("需求采集：等待你继续描述需求；发送“取消”可以结束本次采集。");
  if(context.pendingApproval) lines.push("待审批动作：存在等待审批的任务。");
  if(context.activeHandoff) lines.push(`人工接手：${context.activeHandoff.status}`);
  if(context.serviceEntitlement) lines.push(`可用服务额度：${context.serviceEntitlement.remainingUnits}`);
  if(lines.length === 1) lines.push("当前没有进行中的需求、审批或人工接手。");
  return lines.join("\n");
}

function renderContactMemoryDeleteConfirmation(channel: "matrix" | "telegram") {
  const channelName = channel === "matrix" ? "Matrix" : "Telegram";
  return `已完成：当前对外代理与当前 ${channelName} 渠道下的联系人记忆已立即停止召回，后台将异步清理对应长期记忆。代表经验和其他渠道的联系人记忆不受影响。`;
}

function renderContactMemorySharingDisclosure(challengeToken?: string) {
  return [
    "跨渠道联系人记忆只会共享给当前对外代理，并且只在已验证为同一 Delegate 用户的 Web、Matrix、Telegram 私聊之间使用。",
    "系统不会把原始聊天、付款或余额、凭据、Owner 私有备注、Compute 原始产物写入长期记忆；每次召回仍会检查当前身份、策略和渠道授权。",
    "你可以随时发送 !memory_unshare，立即停止共享记忆召回并异步清理远端投影；各渠道原始会话和渠道内记忆不受影响。",
    challengeToken ? `如果你同意，请在 10 分钟内发送：!memory_share confirm ${challengeToken}` : "请重新发送 !memory_share 获取一次性确认令牌。",
  ].join("\n\n");
}

function renderContactMemorySharingFailure(code: ContactMemorySharingError["code"]) {
  if(code === "contact_memory_sharing_policy_disabled") return "当前暂不提供联系人长期记忆能力，因此跨渠道授权未生效。";
  if(code === "contact_memory_sharing_contract_mismatch") return `${renderContactMemorySharingDisclosure()}\n\n披露内容已经更新，请重新获取一次性确认令牌。`;
  if(
    code === "contact_memory_sharing_challenge_invalid"
    || code === "contact_memory_sharing_challenge_expired"
    || code === "contact_memory_sharing_challenge_consumed"
  ) return "一次性确认令牌缺失、无效、已过期或已使用。请重新发送 !memory_share 阅读说明并获取新令牌。";
  if(code === "contact_memory_sharing_identity_ineligible" || code === "contact_memory_sharing_source_unverified") {
    return "授权未生效：请先在当前代表的 Web 页面登录并把这个 Matrix 账号绑定到同一个 Delegate 用户。";
  }
  if(code === "contact_memory_sharing_representative_not_found") return "当前对外代理已不可用，跨渠道联系人记忆授权未变更。";
  return "跨渠道联系人记忆状态刚刚发生变化，请重试命令。";
}
