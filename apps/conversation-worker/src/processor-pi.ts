import { createHash } from "node:crypto";

import {
  createPiModelBindingFromEnv,
  delegatePiAgentRuntime,
  resolveHandoffActionIntent,
  requiresCurrentInformationEvidence,
  requiresOrganizationKnowledgeEvidence,
  requiresRepresentativeKnowledgeEvidence,
  requiresUnsignedAuthorshipGuard,
  type PiCapabilityAdapters,
  type PiCapabilityResult,
  type PiSandboxAdapter,
} from "@delegate/model-runtime";
import { isConversationCancellationRequest } from "@delegate/runtime";
import {
  admitGenerationMessageProviderDelivery,
  assertConversationChannelDeliveryAvailable,
  authorizeGenerationRunFreeUsage,
  buildRepresentativeRuntimeProfile,
  buildSandboxAttachmentFileName,
  buildSandboxAttachmentPath,
  claimNextConversationMessageDeliveryWorkItem,
  claimNextGenerationWorkItem,
  claimNextOperatorMessageWorkItem,
  completeConversationMessageDelivery,
  completeInlineGenerationRun,
  completeOperatorMessageDelivery,
  contactMemorySharingConsentContractVersion,
  ContactMemorySharingError,
  controlPublicAudienceHandoff,
  createAudienceComputeSession,
  createContactMemorySharingChallenge,
  deferConversationMessageDelivery,
  deferGenerationRunForHuman,
  deferOperatorMessageDelivery,
  ensureConversationLeadAndHandoff,
  executeAudienceTool,
  failGenerationRun,
  GENERATION_WORK_LEASE_DURATION_MS,
  GenerationMemoryDeliveryBlockedError,
  GenerationPlanDeliverySupersededError,
  GenerationWorkLeaseLostError,
  getRepresentativeComputeArtifactDetail,
  getRepresentativeRuntimeAuthoritySnapshot,
  getRepresentativeRuntimeSetupSnapshot,
  grantContactMemorySharingConsent,
  hasPersistedTelegramBotConnections,
  isDeterministicContactMemoryDeleteCommand,
  isGenerationMemoryDeliveryBlockedError,
  isGenerationPlanDeliverySupersededError,
  isGenerationWorkLeaseLostError,
  loadGenerationRecentTurns,
  loadGenerationInputAttachments,
  loadConversationOperationalContext,
  matrixServerNameFromUserId,
  markGenerationDeliveryComplete,
  prepareGenerationMessageChannelDelivery,
  privateChannelSourceVerificationUnavailableStatement,
  probeRepresentativeKnowledgeMetadata,
  readPiApprovalContinuation,
  recallRepresentativeContext,
  recordConversationMessageProviderAcceptance,
  recordGenerationMessageProviderAcceptance,
  recordOperatorMessageProviderAcceptance,
  renewGenerationWorkItemLease,
  reserveGenerationConversationWalletUsage,
  readContactMemorySharingChallengeToken,
  renderPrivateChannelGenerationDeliveryText,
  resolveDeterministicContactMemorySharingCommand,
  resolveTelegramBotRuntimeCredential,
  revokeContactMemorySharingConsent,
  retryConversationMessageDelivery,
  retryGenerationDelivery,
  retryOperatorMessageDelivery,
  updateGenerationPiStream,
  uploadAudienceComputeInput,
  waitGenerationRunForComputeApproval,
  withActiveTelegramRepresentativeChannelFence,
  withGenerationMessageProviderDeliveryFence,
  type GenerationMessageDeliveryAdmission,
} from "@delegate/web-data";

import type { ConversationWorkerConfig } from "./config";
import {
  isComputeExecutionClaimLostError,
  isComputeGenerationExecutionInProgressError,
} from "./compute-client";
import { sendMatrixRepresentativeMessage } from "./matrix-outbound";
import {
  compileBuiltinSpreadsheetRecovery,
  isStructuredDataAttachment,
  resolveDeclaredAttachmentIds,
  resolveRequestedOutputFileName,
  validateDeclaredAttachmentRead,
  type SpreadsheetSkillRecoveryPlan,
} from "./spreadsheet-skill-recovery";

type GenerationItem = NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
type GenerationLease = ReturnType<typeof startGenerationLeaseHeartbeat>;
type WorkLease = { outboxId: string; leaseAttempt: number };
type PiSandboxExecute = PiSandboxAdapter["execute"];

export async function processNextPiConversationWork(config: ConversationWorkerConfig) {
  const telegramWorkerEnabled = config.telegramConversationPlatformMode === "worker";
  const operatorItem = await claimNextOperatorMessageWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if (operatorItem) return deliverOperatorItem(config, operatorItem);

  const conversationMessageItem = await claimNextConversationMessageDeliveryWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if (conversationMessageItem) {
    return deliverConversationMessageItem(config, conversationMessageItem);
  }

  const item = await claimNextGenerationWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if (!item) return { processed: false as const };
  return processPiGenerationItem(config, item);
}

export const processNextConversationWork = processNextPiConversationWork;

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
    if (item.channel === "matrix") {
      if (!item.matrixSenderUserId || !item.matrixEndpointLifecycleRevision) {
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
    if (externalMessageId) {
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Operator message delivery failed.";
    if (isRecoverableOperatorPause(error)) {
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
    if (item.channel === "matrix") {
      if (!item.externalConversationId || !item.matrixSenderUserId || !item.matrixEndpointLifecycleRevision) {
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
    } else if (item.channel === "telegram") {
      if (!item.externalConversationId) {
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
    if (externalMessageId) {
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Conversation message delivery failed.";
    if (isRecoverableOperatorPause(error)) {
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

async function processPiGenerationItem(config: ConversationWorkerConfig, item: GenerationItem) {
  const leaseGuard = startGenerationLeaseHeartbeat(item);
  const workLease = { outboxId: item.outboxId, leaseAttempt: item.leaseAttempt };
  let outputMessageId: string | undefined;
  try {
    leaseGuard.assertOwned();
    if (item.deliveryOnly) {
      if (!item.outputMessageId || !item.outputText) {
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
    if (item.controlState === "HUMAN_ACTIVE" || item.controlState === "NEEDS_HUMAN") {
      await deferGenerationRunForHuman({ runId: item.runId, ...workLease });
      return { processed: true as const, runId: item.runId, status: "waiting_human" as const };
    }
    const setup = await getRepresentativeRuntimeSetupSnapshot(
      item.representativeSlug,
      item.representativeVersionId,
    );
    leaseGuard.assertOwned();
    if (!setup) throw new Error(`Representative ${item.representativeSlug} was not found.`);

    const handoffIntent = setup.humanInLoop
      ? resolveHandoffActionIntent(item.userText)
      : "none";

    if (
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
    if (sharingCommand) {
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

    if (isConversationStatusCommand(item.userText) || handoffIntent === "status") {
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

    if (
      isConversationCancellationRequest(item.userText)
      && delegatePiAgentRuntime.cancelSession(item.conversationId, "The audience requested cancellation.")
    ) {
      const replyText = "已取消当前正在执行的 Agent 任务；取消信号已传递到运行中的工具。";
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

    return await processPiConversationTurn({ config, item, setup, leaseGuard, workLease });
  } catch (error) {
    if (isGenerationMemoryDeliveryBlockedError(error) || isGenerationPlanDeliverySupersededError(error)) {
      return { processed: true as const, runId: item.runId, status: "canceled" as const };
    }
    if (isProviderAcceptancePendingCommit(error)) {
      return { processed: true as const, runId: item.runId, status: "accepted_pending_reconciliation" as const };
    }
    if (isComputeGenerationExecutionInProgressError(error)) {
      return { processed: true as const, runId: item.runId, status: "execution_in_progress" as const };
    }
    if (
      leaseGuard.isLost()
      || isGenerationWorkLeaseLostError(error)
      || isComputeExecutionClaimLostError(error)
      || isConversationHumanControlError(error)
    ) {
      return { processed: true as const, runId: item.runId, status: "lease_lost" as const };
    }
    const errorMessage = error instanceof Error ? error.message : "Pi conversation processing failed.";
    try {
      if (outputMessageId) {
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
    } catch (commitError) {
      if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(commitError)) {
        return { processed: true as const, runId: item.runId, status: "lease_lost" as const };
      }
      throw commitError;
    }
    return { processed: true as const, runId: item.runId, status: "failed" as const, error: errorMessage };
  } finally {
    leaseGuard.stop();
  }
}

async function processPiConversationTurn(input: {
  config: ConversationWorkerConfig;
  item: GenerationItem;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  leaseGuard: GenerationLease;
  workLease: WorkLease;
}) {
  const binding = createPiModelBindingFromEnv();
  if (!binding.ok) throw new Error(binding.reason);
  const handoffIntent = input.setup.humanInLoop
    ? resolveHandoffActionIntent(input.item.userText)
    : "none";
  const handoffOnly = handoffIntent === "request" || handoffIntent === "cancel";
  await input.leaseGuard.confirmOwned();
  const [recentTurns, authority, currentKnowledgeProbe] = await Promise.all([
    loadGenerationRecentTurns({
      representativeId: input.setup.id,
      conversationId: input.item.conversationId,
      beforeMessageId: input.item.inputMessageId,
    }),
    getRepresentativeRuntimeAuthoritySnapshot(
      input.item.representativeSlug,
      input.item.representativeVersionId,
    ),
    input.item.representativeVersionId && !handoffOnly
      ? probeRepresentativeKnowledgeMetadata({
          representativeSlug: input.item.representativeSlug,
          representativeVersionId: input.item.representativeVersionId,
          conversationId: input.item.conversationId,
          contactId: input.item.contactId,
          sourceChannel: input.item.channel,
          queryText: input.item.userText,
          allowedSourceKinds: ["PUBLIC_KNOWLEDGE"],
        }).catch(() => ({
          status: "unavailable" as const,
          candidateCount: 0,
          matchedTopics: [],
          probeRevision: "knowledge-probe:unavailable",
        }))
      : Promise.resolve({
          status: "unavailable" as const,
          candidateCount: 0,
          matchedTopics: [],
          probeRevision: "knowledge-probe:missing-version",
        }),
  ]);
  const representative = buildRepresentativeRuntimeProfile(input.setup);
  let memoryUseRunId: string | undefined;
  let injectedMemoryIds: string[] = [];
  let handoffRequested = false;
  let pendingApprovalId: string | undefined;
  let anyBillableCompletion = false;
  let hadComputeInvocation = false;
  const computeAttachments: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }> = [];
  const approvedContinuation = readPiApprovalContinuation(
    input.item.contextSnapshot,
  );

  let conversationUsageAuthorized = input.item.accessMode === "FREE"
    || Boolean(input.item.walletReservation);
  if (!conversationUsageAuthorized) {
    conversationUsageAuthorized = await authorizeGenerationRunFreeUsage({
      runId: input.item.runId,
      ...input.workLease,
      freeReplyLimit: input.item.effectiveFreeReplyLimit ?? representative.contract.freeReplyLimit,
    });
  }
  if (!conversationUsageAuthorized && input.item.audienceIdentityId) {
    conversationUsageAuthorized = Boolean(await reserveGenerationConversationWalletUsage({
      runId: input.item.runId,
      ...input.workLease,
      audienceIdentityId: input.item.audienceIdentityId,
      representativeId: input.setup.id,
      tokenAmount: 1,
    }));
  }
  if (!conversationUsageAuthorized) {
    const replyText = "当前没有可用的免费或已购服务额度，因此没有启动 Agent 或工具。补充服务额度后可以重新发送同一请求。";
    const completed = await completeInlineGenerationRun({
      conversationId: input.item.conversationId,
      runId: input.item.runId,
      ...input.workLease,
      replyText,
      senderDisplayName: input.item.representativeName,
      intent: "pi_agent_payment_required",
      countUsage: false,
      completeOutbox: false,
      runtimeOutcome: {
        mode: "fallback",
        fallbackStrategy: "deterministic_preview",
        modelRuntimeState: "ready",
        fallbackReason: "policy_fallback",
      },
    });
    const outputMessageId = completed.message.id;
    await deliverGenerationOutput({
      config: input.config,
      item: input.item,
      text: completed.message.text ?? replyText,
      outputMessageId,
    });
    return { processed: true as const, runId: input.item.runId, status: "completed" as const };
  }

  const piAttachments = input.item.inputAttachments.map((attachment) => ({
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    uri: buildSandboxAttachmentPath(attachment.id, attachment.fileName),
  }));
  const recoveryPlan = input.setup.compute.enabled
    ? compileBuiltinSpreadsheetRecovery({
        userText: input.item.userText,
        skills: input.setup.skillPacks,
        attachments: piAttachments,
      })
    : undefined;
  let recoverySandboxExecutor: PiSandboxExecute | undefined;
  const adapters: PiCapabilityAdapters = buildPiAdapters({
    ...input,
    authority,
    ...(recoveryPlan ? { trustedSpreadsheetPlan: recoveryPlan } : {}),
    computeAttachments,
    onMemoryUse: (runId, itemIds) => {
      memoryUseRunId = runId;
      injectedMemoryIds = itemIds;
    },
    onHandoff: () => { handoffRequested = true; },
    onPendingApproval: (approvalId) => { pendingApprovalId ??= approvalId; },
    onCompute: (billable) => {
      hadComputeInvocation = true;
      anyBillableCompletion ||= billable;
    },
    onSandboxExecutor: (executor) => { recoverySandboxExecutor = executor; },
  });
  const approvedToolResult = approvedContinuation?.status === "completed"
    ? await loadApprovedToolResult({
        representativeSlug: input.item.representativeSlug,
        approvalId: approvedContinuation.approvalId,
        artifacts: approvedContinuation.artifacts,
        computeAttachments,
      })
    : undefined;
  if (approvedToolResult) {
    delete adapters.sandbox;
    recoverySandboxExecutor = undefined;
  }
  const runtimeAdapters: PiCapabilityAdapters = handoffOnly && adapters.handoff
    ? { handoff: adapters.handoff }
    : adapters;

  let streamedText = "";
  let bufferedDelta = "";
  let streamSequence = 0;
  let firstStreamFlushQueued = false;
  let streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let knowledgeToolStarted = false;
  let knowledgeResolution: "unknown" | "found" | "missing" = "unknown";
  const organizationKnowledgeRequired = requiresOrganizationKnowledgeEvidence(
    input.item.userText,
  );
  const representativeKnowledgeRequired = requiresRepresentativeKnowledgeEvidence({
    userText: input.item.userText,
    representativeId: input.setup.id,
    representativeRole: input.setup.tagline || `代表 ${input.setup.ownerName} 的数字代表`,
  });
  const knowledgeMustPrecedeDraft = currentKnowledgeProbe.status === "hit"
    || organizationKnowledgeRequired
    || representativeKnowledgeRequired;
  const unsignedAuthorshipGuardRequired = requiresUnsignedAuthorshipGuard(
    input.item.userText,
  );
  const currentInformationGuardRequired = requiresCurrentInformationEvidence(
    input.item.userText,
  );
  const attachmentEvidenceGuardRequired = input.item.inputAttachments.length > 0;
  let suppressCurrentModelText = knowledgeMustPrecedeDraft
    || unsignedAuthorshipGuardRequired
    || currentInformationGuardRequired
    || attachmentEvidenceGuardRequired
    || handoffOnly;
  let streamFlushChain = Promise.resolve();
  const flushStreamBuffer = () => {
    if (!bufferedDelta) return;
    streamedText = `${streamedText}${bufferedDelta}`.slice(-32_000);
    bufferedDelta = "";
    firstStreamFlushQueued = true;
    const sequence = ++streamSequence;
    const text = streamedText;
    streamFlushChain = streamFlushChain.then(() => updateGenerationPiStream({
      runId: input.item.runId,
      ...input.workLease,
      sequence,
      text,
    }).then(() => undefined)).catch((error) => {
      console.error("Failed to persist Pi response stream chunk.", error);
    });
  };
  const queueStreamFlush = (force = false) => {
    if (force) {
      if (streamFlushTimer) clearTimeout(streamFlushTimer);
      streamFlushTimer = undefined;
      flushStreamBuffer();
      return;
    }
    if (!bufferedDelta) return;
    if (!firstStreamFlushQueued || bufferedDelta.length >= 64) {
      if (streamFlushTimer) clearTimeout(streamFlushTimer);
      streamFlushTimer = undefined;
      flushStreamBuffer();
      return;
    }
    streamFlushTimer ??= setTimeout(() => {
      streamFlushTimer = undefined;
      flushStreamBuffer();
    }, 75);
  };

  const result = await delegatePiAgentRuntime.run({
    runId: input.item.runId,
    sessionId: input.item.conversationId,
    userText: input.item.userText,
    conversationId: input.item.conversationId,
    ...(input.item.audienceIdentityId ? { userId: input.item.audienceIdentityId } : {}),
    representative: {
      id: input.setup.id,
      ...(input.item.representativeVersionId ? { versionId: input.item.representativeVersionId } : {}),
      name: input.item.representativeName,
      ownerName: input.setup.ownerName,
      role: input.setup.tagline || `代表 ${input.setup.ownerName} 的数字代表`,
      instructions: [
        `语气：${input.setup.tone}`,
        ...(currentKnowledgeProbe.status === "hit"
          ? [
              "服务端已确认当前问题与该代表的已发布授权知识范围匹配。在起草答案前必须先调用 retrieve_authorized_knowledge；元数据命中本身不是答案依据。",
            ]
          : []),
      ].join("\n"),
      capabilities: handoffOnly
        ? ["真人转接"]
        : [
            "普通问答",
            "授权知识检索",
            ...(authority?.mcpBindings.length ? ["MCP"] : []),
            ...(input.setup.skillPacks.some((skill) => skill.enabled) ? ["Skill"] : []),
            ...(input.setup.compute.enabled ? ["隔离沙盒"] : []),
            ...(input.setup.humanInLoop ? ["真人转接"] : []),
          ],
    },
    audience: {
      kind: input.item.audienceIdentityId ? "authenticated_visitor" : "external_visitor",
      relationshipToOwner: "unverified",
    },
    model: binding.binding,
    capabilities: runtimeAdapters,
    ...(approvedToolResult ? { approvedToolResult } : {}),
    ...(recoveryPlan && recoverySandboxExecutor
      ? { attachmentEvidenceRecovery: {
          skill: recoveryPlan.skill,
          execute: ({ context, signal }: { context: Parameters<PiSandboxExecute>[0]["context"]; signal: AbortSignal }) =>
            recoverySandboxExecutor!({
              ...recoveryPlan.request,
              context,
              signal,
            }),
        } }
      : {}),
    history: recentTurns.map((turn) => ({
      role: turn.direction === "inbound" ? "user" as const : "assistant" as const,
      text: turn.messageText,
    })),
    attachments: piAttachments,
    timezone: "Asia/Shanghai",
    maxSteps: resolvePiMaxSteps(),
    timeoutMs: 120_000,
    onEvent: (event) => {
      if (event.type === "model.started") {
        suppressCurrentModelText = unsignedAuthorshipGuardRequired
          || currentInformationGuardRequired
          || attachmentEvidenceGuardRequired
          || handoffOnly
          || (!knowledgeToolStarted
            ? knowledgeMustPrecedeDraft
            : (organizationKnowledgeRequired || representativeKnowledgeRequired)
              && knowledgeResolution !== "found");
      }
      if (
        event.type === "tool.started"
        && event.toolName === "retrieve_authorized_knowledge"
      ) {
        knowledgeToolStarted = true;
      }
      if (event.type === "retrieval.completed" && event.module === "knowledge") {
        const sourceCount = typeof event.data?.sourceCount === "number"
          ? event.data.sourceCount
          : 0;
        knowledgeResolution = sourceCount > 0 ? "found" : "missing";
      }
      if (event.type === "response.delta" && event.delta) {
        if (suppressCurrentModelText) return;
        bufferedDelta += event.delta;
        queueStreamFlush(false);
      }
    },
  });
  queueStreamFlush(true);
  await streamFlushChain;
  await input.leaseGuard.confirmOwned();
  if (result.status === "failed") throw new Error(result.error ?? "Pi Agent failed without a final response.");
  if (result.status === "cancelled") throw new Error(result.error ?? "Pi Agent run was cancelled.");

  const modelSpans = result.spans.filter((span) => span.module === "model");
  const agentTrace = {
    runtime: result.runtime,
    traceId: result.traceId,
    status: result.status,
    ...(result.firstModelEventMs !== undefined ? { firstModelEventMs: result.firstModelEventMs } : {}),
    ...(result.firstTextMs !== undefined ? { firstTextMs: result.firstTextMs } : {}),
    totalDurationMs: result.totalDurationMs,
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    sources: result.sources.map((source) => ({
      id: source.id,
      title: source.title,
      channel: source.channel,
      ...(source.provider ? { provider: source.provider } : {}),
      ...(source.dataTime ? { dataTime: source.dataTime } : {}),
      ...(source.version ? { version: source.version } : {}),
    })),
    events: result.events.map((event) => ({ ...event })),
    spans: result.spans.map((span) => ({ ...span })),
  };
  if (pendingApprovalId) {
    const waiting = await waitGenerationRunForComputeApproval({
      conversationId: input.item.conversationId,
      runId: input.item.runId,
      ...input.workLease,
      approvalId: pendingApprovalId,
      replyText: result.text,
      senderDisplayName: input.item.representativeName,
    });
    const outputMessageId = waiting.message.id;
    await deliverGenerationOutput({
      config: input.config,
      item: input.item,
      text: waiting.message.text ?? result.text,
      outputMessageId,
    });
    return {
      processed: true as const,
      runId: input.item.runId,
      status: waiting.run.status === "WAITING_APPROVAL"
        ? "waiting_approval" as const : "completed" as const,
    };
  }

  const citedItemIds = result.sources
    .filter((source) =>
      source.channel === "knowledge"
      && injectedMemoryIds.includes(source.id))
    .map((source) => source.id);
  const completed = await completeInlineGenerationRun({
    conversationId: input.item.conversationId,
    runId: input.item.runId,
    ...input.workLease,
    replyText: result.text,
    senderDisplayName: input.item.representativeName,
    intent: "pi_agent",
    provider: binding.binding.provider as "agicto" | "openai" | "bailian" | "anthropic",
    model: binding.binding.modelId,
    inputTokens: modelSpans.reduce((sum, span) => sum + (span.inputTokens ?? 0), 0),
    outputTokens: modelSpans.reduce((sum, span) => sum + (span.outputTokens ?? 0), 0),
    runtimeOutcome: {
      mode: "model",
      ...(anyBillableCompletion
        || approvedToolResult
        || result.sources.some((source) =>
          source.channel === "web" || source.channel === "mcp")
        || result.artifacts.length
        ? { verifiedToolEvidence: true }
        : {}),
    },
    agentTrace,
    completeOutbox: false,
    countUsage: !handoffRequested && (hadComputeInvocation ? anyBillableCompletion : result.modelCalls > 0),
    ...(handoffRequested
      ? { humanHandoff: {
          reason: "Pi Agent requested human follow-up.",
          summary: input.item.userText.slice(0, 600),
          kind: "pi_agent_handoff",
          priority: 80,
          source: input.item.channel,
        } }
      : {}),
    ...(computeAttachments.length ? { attachments: computeAttachments } : {}),
    ...(memoryUseRunId
      ? { memoryUse: {
          runId: memoryUseRunId,
          outcome: "completed" as const,
          injectedItemIds: injectedMemoryIds,
          citedItemIds,
        } }
      : {}),
  });
  const outputMessageId = completed.message.id;
  await deliverGenerationOutput({
    config: input.config,
    item: input.item,
    text: completed.message.text ?? result.text,
    outputMessageId,
  });
  return {
    processed: true as const,
    runId: input.item.runId,
    status: handoffRequested ? "waiting_human" as const : "completed" as const,
  };
}

async function loadApprovedToolResult(input: {
  representativeSlug: string;
  approvalId: string;
  artifacts: Array<{
    id: string;
    kind: string;
    mimeType: string;
    sizeBytes: number;
    fileName?: string;
  }>;
  computeAttachments: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
}) {
  const evidence = (
    await Promise.all(input.artifacts.slice(0, 8).map(async (artifact) => {
      const detail = await getRepresentativeComputeArtifactDetail(
        input.representativeSlug,
        artifact.id,
      ).catch(() => null);
      const content = detail?.contentText?.trim();
      return content ? `${artifact.kind}:${artifact.id}\n${content}` : null;
    }))
  ).filter((value): value is string => Boolean(value)).join("\n\n").slice(0, 40_000);
  const fileArtifacts = input.artifacts.filter((artifact) =>
    artifact.kind.toLocaleLowerCase() === "file");
  for (const artifact of fileArtifacts) {
    input.computeAttachments.push({
      fileName: artifact.fileName ?? resolvePublicArtifactFileName(artifact),
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      artifactId: artifact.id,
      url: `/reps/${input.representativeSlug}/chat/artifacts/${artifact.id}/download`,
    });
  }
  return {
    approvalId: input.approvalId,
    toolName: "execute_in_sandbox",
    status: "completed" as const,
    text: evidence || "The approved sandbox operation completed without textual output.",
    artifacts: fileArtifacts.map((artifact) => ({
      id: artifact.id,
      fileName: artifact.fileName ?? resolvePublicArtifactFileName(artifact),
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      url: `/reps/${input.representativeSlug}/chat/artifacts/${artifact.id}/download`,
    })),
  };
}

function buildPiAdapters(input: {
  config: ConversationWorkerConfig;
  item: GenerationItem;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  leaseGuard: GenerationLease;
  workLease: WorkLease;
  authority: Awaited<ReturnType<typeof getRepresentativeRuntimeAuthoritySnapshot>>;
  trustedSpreadsheetPlan?: SpreadsheetSkillRecoveryPlan;
  computeAttachments: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
  onMemoryUse(runId: string | undefined, itemIds: string[]): void;
  onHandoff(): void;
  onPendingApproval(approvalId: string): void;
  onCompute(billable: boolean): void;
  onSandboxExecutor(executor: PiSandboxExecute): void;
}): PiCapabilityAdapters {
  const hasStructuredDataAttachment = input.setup.compute.enabled
    && input.item.inputAttachments.some(isStructuredDataAttachment);
  const attachmentValidationFailures = new Map<string, number>();
  const executeMcp = async (request: {
    bindingId: string;
    bindingSlug: string;
    toolName: string;
    toolArguments: Record<string, unknown>;
    estimatedTokens: number;
    readOnly: boolean;
  }) => {
    input.onCompute(false);
    await input.leaseGuard.confirmOwned();
    if (!input.setup.compute.enabled) {
      return { status: "failed", text: "这个代表当前没有启用外部工具执行。", details: {} };
    }
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id,
      contactId: input.item.contactId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      generationWorkLease: input.workLease,
      subagentId: "compute-agent",
      requestedCapabilities: ["mcp"],
      reason: `${input.item.channel}:pi_mcp`,
      requestedBaseImage: input.setup.compute.baseImage,
    });
    const execution = await executeAudienceTool(session.session.id, {
      capability: "mcp",
      bindingId: request.bindingId,
      bindingSlug: request.bindingSlug,
      toolName: request.toolName,
      toolArguments: request.toolArguments,
      estimatedTokens: request.estimatedTokens,
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
      subagentId: "compute-agent",
      generationWorkLease: input.workLease,
    });
    input.leaseGuard.assertOwned();
    if (execution.outcome === "pending_approval") {
      if (!execution.approvalRequest) throw new Error("Compute approval response is missing.");
      input.onPendingApproval(execution.approvalRequest.id);
      return {
        status: "pending_approval",
        text: "外部工具调用正在等待代表所有者审批，尚未执行。",
        details: { approvalId: execution.approvalRequest.id },
      };
    }
    const attachments = execution.artifacts.map((artifact) => ({
      fileName: resolvePublicArtifactFileName(artifact),
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      artifactId: artifact.id,
      url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
    }));
    const authoritativeSummary = (
      await Promise.all(execution.artifacts.slice(0, 8).map(async (artifact) => {
        const detail = await getRepresentativeComputeArtifactDetail(
          input.item.representativeSlug,
          artifact.id,
        ).catch(() => null);
        const content = detail?.contentText?.trim();
        return content ? `${artifact.kind}:${artifact.id}\n${content}` : null;
      }))
    ).filter((value): value is string => Boolean(value)).join("\n\n").slice(0, 40_000);
    const semanticOutcome = execution.execution?.semanticOutcome;
    const transportOutcome = execution.execution?.transportOutcome;
    const failureCode = safeCapabilityFailureCode(
      execution.blockReasonCode ?? execution.session.failureReason,
    );
    const completed = execution.outcome === "completed" && semanticOutcome !== "failed"
      && semanticOutcome !== "unknown" && semanticOutcome !== "partial";
    input.onCompute(completed);
    return {
      status: completed ? "completed" : "failed",
      text: completed
        ? authoritativeSummary || "外部工具已执行并返回可验证结果。"
        : transportOutcome === "outcome_unknown"
          ? "外部操作最终结果无法确认；系统不会自动重试或宣称完成。"
          : failureCode === "mcp_tool_schema_drift_replan_required"
            ? "MCP 工具目录已发生变化，本次调用在发送前安全停止；目录刷新后可以重新规划。"
            : "外部工具调用未满足业务成功条件。",
      details: {
        executionId: execution.execution.id,
        semanticOutcome: semanticOutcome ?? "unknown",
        transportOutcome: transportOutcome ?? "unknown",
        ...(failureCode ? { failureCode } : {}),
      },
      artifacts: request.readOnly ? [] : attachments.map((attachment) => ({
        id: attachment.artifactId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
      })),
      ...(!request.readOnly && authoritativeSummary ? { authoritativeSummary } : {}),
    };
  };

  const executeSandbox: PiSandboxExecute = async (request) => {
    request.signal.throwIfAborted();
    const effectiveRequest = input.trustedSpreadsheetPlan
      ? {
          ...request,
          ...input.trustedSpreadsheetPlan.request,
          context: request.context,
          signal: request.signal,
        }
      : request;
    input.onCompute(false);
    const declaredRead = validateDeclaredAttachmentRead({
      code: effectiveRequest.code,
      attachmentIds: effectiveRequest.attachmentIds,
      attachments: input.item.inputAttachments.map((attachment) => ({
        ...attachment,
        uri: buildSandboxAttachmentPath(attachment.id, attachment.fileName),
      })),
    });
    if (!declaredRead.ok) {
      const failureCount = (attachmentValidationFailures.get(declaredRead.reason) ?? 0) + 1;
      attachmentValidationFailures.set(declaredRead.reason, failureCount);
      const terminal = failureCount >= 2;
      return {
        status: "failed",
        text: "沙盒请求没有声明并读取本轮附件的可信路径，未执行，也没有生成结果文件。",
        details: {
          reason: declaredRead.reason,
          deterministicFailure: true,
          ...(terminal ? { verifiedFailure: true } : {}),
        },
        ...(terminal
          ? { authoritativeSummary: "附件处理未执行：连续两次请求都没有以可验证方式读取已声明的附件路径，系统已停止重复调用。" }
          : {}),
        artifacts: [],
      };
    }
    const declaredAttachmentIds = resolveDeclaredAttachmentIds({
      code: effectiveRequest.code,
      attachmentIds: effectiveRequest.attachmentIds,
      attachments: input.item.inputAttachments.map((attachment) => ({
        ...attachment,
        uri: buildSandboxAttachmentPath(attachment.id, attachment.fileName),
      })),
    });
    const requestedOutputs = normalizeExpectedSandboxOutputs(
      effectiveRequest.expectedOutputs,
    );
    const inferredOutput = requestedOutputs.length === 0
      ? resolveRequestedOutputFileName(
          input.item.userText,
          input.item.inputAttachments.map((attachment) => attachment.fileName),
        )
      : undefined;
    const expectedOutputs = requestedOutputs.length
      ? requestedOutputs
      : inferredOutput ? [inferredOutput] : [];
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id,
      contactId: input.item.contactId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      generationWorkLease: input.workLease,
      subagentId: "compute-agent",
      requestedCapabilities: expectedOutputs.length ? ["exec", "write"] : ["exec"],
      reason: `${input.item.channel}:pi_sandbox`,
      requestedBaseImage: input.setup.compute.baseImage,
    });
    request.signal.throwIfAborted();
    const common = {
      subagentId: "compute-agent" as const,
      generationWorkLease: input.workLease,
      estimatedTokens: 600 + 100 * Math.ceil(effectiveRequest.code.length / 256),
      hasPaidEntitlement: false,
      browserMode: "deterministic" as const,
      maxSteps: 1,
      allowMutations: false,
    };
    const stagedAttachments = input.item.inputAttachments.length
      ? await loadGenerationInputAttachments({
          generationRunId: input.item.runId,
          attachmentIds: declaredAttachmentIds,
        })
      : [];
    if (input.item.inputAttachments.length && stagedAttachments.length === 0) {
      return {
        status: "failed",
        text: "沙盒未找到工具请求中声明的会话附件，未执行分析。",
        details: { requestedAttachmentIds: effectiveRequest.attachmentIds },
        artifacts: [],
      };
    }
    const transferStartedAt = performance.now();
    const transferredAttachments = await Promise.all(stagedAttachments.map((attachment) =>
      uploadAudienceComputeInput(session.session.id, {
        ...attachment,
        fileName: buildSandboxAttachmentFileName(
          attachment.id,
          attachment.fileName,
        ),
      })));
    request.signal.throwIfAborted();
    const attachmentTransferMs = performance.now() - transferStartedAt;
    const normalizedProgramSource = normalizeInlineProgramSource(effectiveRequest.code);
    const execution = await executeAudienceTool(session.session.id, {
      ...common,
      capability: "exec",
      command: buildInlineSandboxCommand(effectiveRequest.language, normalizedProgramSource),
      workingDirectory: "/workspace",
      compiledTask: {
        compilerVersion: "sandbox-task-compiler.v1" as const,
        instructionHash: sha256Text(input.item.userText.trim()),
        codeHash: sha256Text(normalizedProgramSource),
        riskClass: "self_contained_compute" as const,
        compilerProvider: "delegate-pi-runtime",
      },
    });
    request.signal.throwIfAborted();
    if (execution.outcome !== "completed") {
      if (execution.approvalRequest) input.onPendingApproval(execution.approvalRequest.id);
      return {
        status: execution.outcome,
        text: execution.outcome === "pending_approval"
          ? "沙盒执行正在等待审批，尚未生成结果。" : "沙盒执行失败，未生成结果。",
        details: execution.approvalRequest ? { approvalId: execution.approvalRequest.id } : {},
        artifacts: [],
      };
    }
    const stdoutParts = (
      await Promise.all(execution.artifacts.map(async (artifact) => {
        if (artifact.kind !== "stdout") return null;
        const detail = await getRepresentativeComputeArtifactDetail(
          input.item.representativeSlug,
          artifact.id,
        ).catch(() => null);
        return detail?.contentText?.trimEnd() || null;
      }))
    ).filter((value): value is string => Boolean(value));
    const verifiedStdout = stdoutParts.join("\n");
    if (expectedOutputs.length > 0 && !verifiedStdout) {
      return { status: "failed", text: "沙盒已运行，但没有产生可用于交付文件的标准输出。", details: {}, artifacts: [] };
    }
    if (expectedOutputs.length > 1) {
      return { status: "failed", text: "当前沙盒交付一次只支持一个明确的输出文件。", details: {}, artifacts: [] };
    }
    if (expectedOutputs[0]?.toLocaleLowerCase().endsWith(".csv") && !hasValidCsvHeader(verifiedStdout)) {
      return { status: "failed", text: "沙盒已运行，但 CSV 标准输出缺少有效字段名表头。", details: {}, artifacts: [] };
    }
    const delivered = expectedOutputs[0]
      ? await executeAudienceTool(session.session.id, {
          ...common,
          capability: "write",
          path: `outputs/${expectedOutputs[0].split("/").pop()}`,
          content: `${verifiedStdout}\n`,
          workingDirectory: "/workspace",
        })
      : execution;
    if (delivered.outcome !== "completed") {
      if (delivered.approvalRequest) input.onPendingApproval(delivered.approvalRequest.id);
      return {
        status: delivered.outcome,
        text: delivered.outcome === "pending_approval" ? "结果文件交付正在等待审批。" : "沙盒结果文件交付失败。",
        details: delivered.approvalRequest ? { approvalId: delivered.approvalRequest.id } : {},
        artifacts: [],
      };
    }
    const attachments = delivered.artifacts
      .filter((artifact) => artifact.kind === "file")
      .map((artifact) => ({
        fileName: expectedOutputs[0]?.split("/").pop() ?? resolvePublicArtifactFileName(artifact),
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        artifactId: artifact.id,
        url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
      }));
    for (const attachment of attachments) {
      if (!input.computeAttachments.some((candidate) => candidate.artifactId === attachment.artifactId)) {
        const staleIndex = input.computeAttachments.findIndex((candidate) =>
          candidate.fileName === attachment.fileName);
        if (staleIndex >= 0) input.computeAttachments.splice(staleIndex, 1);
        input.computeAttachments.push(attachment);
      }
    }
    input.onCompute(true);
    return {
      status: "completed",
      text: attachments.length
        ? `沙盒真实执行完成并生成文件：${attachments.map((item) => item.fileName).join(", ")}`
        : "沙盒真实执行完成。",
      details: {
        executionId: execution.execution.id,
        attachmentTransferMs,
        transferredAttachments: transferredAttachments.map((attachment) => ({
          fileName: attachment.fileName,
          sandboxPath: attachment.sandboxPath,
          checksum: attachment.checksum,
          provider: attachment.provider,
        })),
      },
      artifacts: attachments.map((attachment) => ({
        id: attachment.artifactId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
      })),
      ...(verifiedStdout ? { authoritativeSummary: verifiedStdout.slice(0, 40_000) } : {}),
    };
  };

  input.onSandboxExecutor(executeSandbox);

  return {
    knowledge: {
      retrieve: async ({ query }) => {
        const retrievalQuery = await resolveKnowledgeRetrievalQuery({
          item: input.item,
          modelQuery: query,
        });
        const recalled = await recallRepresentativeContext({
          representativeSlug: input.item.representativeSlug,
          conversationId: input.item.conversationId,
          contactId: input.item.contactId,
          sourceChannel: input.item.channel,
          generationRunId: input.item.runId,
          queryText: retrievalQuery,
          allowedSourceKinds: ["PUBLIC_KNOWLEDGE", "CONTACT_MEMORY", "REPRESENTATIVE_EXPERIENCE"],
        }).catch(() => ({ items: [], citations: [], memoryUseRunId: undefined }));
        input.onMemoryUse(
          recalled.memoryUseRunId,
          recalled.memoryUseRunId ? recalled.items.map((entry) => entry.memoryUseItemId) : [],
        );
        const sources = recalled.items.map((entry, index) => ({
          id: entry.memoryUseItemId,
          title: entry.internalSource.publicTitle
            ?? recalled.citations[index]?.title
            ?? `知识资料 ${index + 1}`,
          channel: "knowledge" as const,
        }));
        const snapshotItems = recalled.items.length
          ? [] : retrievePublishedSnapshotKnowledge(input.setup.knowledgePack, query);
        const snapshotSources = snapshotItems.map((entry) => ({
          id: entry.id,
          title: entry.title,
          channel: "knowledge" as const,
        }));
        return {
          status: recalled.items.length || snapshotItems.length
            ? "found" : recalled.memoryUseRunId ? "not_found" : "unavailable",
          text: recalled.items.length
            ? [
                "仅使用下列授权资料回答。正文不要列出资料标题、内部 ID、版本或来源清单；产品会在回答下方统一显示来源说明。不得补充或声称未在结果中出现的课程标准、教材、网站或其他权威来源。",
                ...recalled.items.map((entry, index) => `[${sources[index]!.title}] ${entry.abstract}`),
              ].join("\n\n")
            : snapshotItems.length
              ? snapshotItems.map((entry) => `[${entry.title}] ${entry.summary}`).join("\n\n")
              : recalled.memoryUseRunId ? "授权知识库没有找到支持该问题的资料。" : "授权知识检索当前不可用。",
          sources: [...sources, ...snapshotSources],
          details: {
            querySource: retrievalQuery === input.item.userText.trim()
              ? "current_user_request"
              : "model_refinement",
            allowedCitationTitles: [...sources, ...snapshotSources].map(
              (source) => source.title,
            ),
          },
        };
      },
    },
    ...(input.authority?.mcpBindings.length
      ? { mcp: {
          listTools: async () => input.authority!.mcpBindings.flatMap((binding) =>
            (binding.toolDefinitions ?? [])
              .filter((tool) => !binding.allowedToolNames.length || binding.allowedToolNames.includes(tool.exactToolName))
              .map((tool) => ({
                server: binding.slug,
                name: tool.exactToolName,
                description: tool.description || `Call ${tool.exactToolName} on ${binding.slug}.`,
                inputSchema: tool.inputSchema,
                readOnly: !binding.approvalRequired,
                idempotent: !binding.approvalRequired,
              }))),
          callTool: async ({ server, tool, arguments: toolArguments }) => {
            const binding = input.authority!.mcpBindings.find((candidate) => candidate.slug === server);
            if (!binding) throw new Error(`MCP binding ${server} is unavailable.`);
            const result = await executeMcp({
              bindingId: binding.id,
              bindingSlug: binding.slug,
              toolName: tool,
              toolArguments,
              estimatedTokens: binding.estimatedTokensPerCall,
              readOnly: !binding.approvalRequired,
            });
            return attachVerifiedMcpSource(result, {
              server,
              tool,
              runId: input.item.runId,
            });
          },
        } }
      : {}),
    ...(input.setup.skillPacks.some((skill) => skill.enabled)
      ? { skills: {
          discover: async ({ query, maximumResults }) => {
            const queryTerms = searchableTerms(query);
            const configured = input.setup.skillPacks
              .filter((skill) => skill.enabled)
              .map((skill) => ({
              descriptor: {
                id: skill.slug,
                version: skill.version ?? "1",
                name: skill.displayName,
                description: skill.summary,
              },
              score: [...searchableTerms([skill.displayName, skill.summary, ...skill.capabilityTags].join(" "))]
                .filter((term) => queryTerms.has(term)).length,
            }));
            const ranked = configured.sort((left, right) => right.score - left.score);
            const matching = ranked.filter((entry) => entry.score > 0);
            return (matching.length ? matching : ranked).slice(0, maximumResults).map((entry) => entry.descriptor);
          },
          load: async ({ id, version }) => {
            const skill = input.setup.skillPacks.find((candidate) =>
              candidate.enabled && candidate.slug === id && (!version || (candidate.version ?? "1") === version));
            if (!skill) throw new Error(`Skill ${id} is not installed at the requested version.`);
            if (hasStructuredDataAttachment && !isConfiguredStructuredDataSkill(skill)) {
              throw new Error(`Skill ${id} is not applicable to structured-data attachment analysis.`);
            }
            return {
              descriptor: {
                id: skill.slug,
                version: skill.version ?? "1",
                name: skill.displayName,
                description: skill.summary,
              },
              instructions: [
                `Skill: ${skill.displayName}@${skill.version ?? "1"}`,
                skill.instructions ?? skill.summary,
                skill.capabilityTags.length ? `Required capability tags: ${skill.capabilityTags.join(", ")}` : "",
                skill.executesCode
                  ? "Use the isolated sandbox capability for all code execution. Loading this Skill does not mean the requested work is complete."
                  : "Apply this method to the current request and verify the resulting output.",
              ].filter(Boolean).join("\n"),
              ...(skill.instructionsSha256
                ? { instructionsDigest: skill.instructionsSha256 }
                : {}),
              ...((skill.resources?.length || skill.sourceUrl)
                ? { resources: [...(skill.resources ?? []), ...(skill.sourceUrl ? [skill.sourceUrl] : [])] }
                : {}),
            };
          },
        } }
      : {}),
    ...(input.setup.compute.enabled ? { sandbox: { execute: executeSandbox } } : {}),
    ...(input.setup.humanInLoop
      ? { handoff: {
          request: async ({ reason, summary, priority }) => {
            if (resolveHandoffActionIntent(input.item.userText) !== "request") {
              return {
                status: "confirmation_required",
                text: "当前消息没有明确要求立即转接真人，因此未创建转接。请明确回复“确认转接真人”后再执行。",
                details: { status: "confirmation_required" },
              };
            }
            const outcome = await ensureConversationLeadAndHandoff({
              conversationId: input.item.conversationId,
              reason,
              summary,
              kind: "pi_agent_handoff",
              priority: priority ?? 80,
              source: input.item.channel,
              requestHandoff: true,
            });
            if (outcome.skipped === "human_active") {
              input.onHandoff();
              return { status: "connected", text: "当前会话已经由真人处理。", details: { status: "connected" } };
            }
            if (!outcome.handoff) {
              return {
                status: "failed",
                text: `真人转接未建立：${outcome.skipped ?? "unavailable"}`,
                details: { status: "failed", reason: outcome.skipped ?? "unavailable" },
              };
            }
            input.onHandoff();
            return {
              status: "queued",
              text: "真人转接请求已创建，当前处于排队/待负责人接手状态。",
              details: { status: "queued", queueId: outcome.handoff.id },
            };
          },
          ...(input.item.channel === "web" && input.item.audienceIdentityId && input.item.sourceSenderId
            ? { cancel: async () => {
                if (resolveHandoffActionIntent(input.item.userText) !== "cancel") {
                  return {
                    status: "confirmation_required",
                    text: "当前消息没有明确要求取消真人转接，因此未改变排队状态。",
                    details: { status: "confirmation_required" },
                  };
                }
                const outcome = await controlPublicAudienceHandoff({
                  representativeSlug: input.item.representativeSlug,
                  audienceIdentityId: input.item.audienceIdentityId!,
                  audienceId: input.item.sourceSenderId!,
                  action: "cancel_request",
                });
                return outcome.changed
                  ? { status: "cancelled", text: "真人转接排队已确认取消。", details: { status: "cancelled" } }
                  : { status: "not_found", text: "当前没有可取消的真人转接排队。", details: { status: "not_found" } };
              } }
            : {}),
        } }
      : {}),
  };
}

export function buildInlineSandboxCommand(
  language: "python" | "javascript" | "shell",
  code: string,
) {
  const encoded = Buffer.from(normalizeInlineProgramSource(code), "utf8").toString("base64");
  if (language === "python") {
    return `python -c "import base64;exec(compile(base64.b64decode('${encoded}'),'<pi-agent>','exec'))"`;
  }
  if (language === "javascript") {
    return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
  }
  return `printf '%s' '${encoded}' | base64 -d | sh`;
}

export function normalizeExpectedSandboxOutputs(outputs: readonly string[]) {
  return outputs.map((output) => output.trim()).filter((output) =>
    Boolean(output)
    && !/^(?:-|stdout|\/dev\/stdout)$/iu.test(output));
}

export function normalizeInlineProgramSource(code: string) {
  if (code.includes("\n")) return code;
  if (!/\\n\s*(?:import\b|from\b|with\b|def\b|class\b|if\b|for\b|while\b|try\b|except\b|print\b|[A-Za-z_][A-Za-z0-9_]*\s*=)/u.test(code)) {
    return code;
  }
  return code.replace(/\\r\\n|\\n/gu, "\n");
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function attachVerifiedMcpSource(
  result: PiCapabilityResult,
  input: { server: string; tool: string; runId: string },
): PiCapabilityResult {
  const successful = typeof result.status === "string"
    && ["completed", "succeeded", "success", "found", "ok"].includes(
      result.status.toLowerCase(),
    );
  if (!successful) return { ...result, sources: [] };
  return {
    ...result,
    sources: [
      ...(result.sources ?? []),
      {
        id: `${input.server}:${input.tool}:${input.runId}`,
        title: `${input.server}/${input.tool}`,
        channel: "mcp",
        provider: input.server,
      },
    ],
  };
}

function safeCapabilityFailureCode(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_:-]{1,160}$/u.test(value)
    ? value
    : undefined;
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
  if (!input.item.audienceIdentityId) {
    return renderContactMemorySharingFailure("contact_memory_sharing_identity_ineligible");
  }
  if (input.command === "INVALID_CONFIRM") {
    return renderContactMemorySharingFailure("contact_memory_sharing_challenge_invalid");
  }
  try {
    if (input.command === "REVOKE") {
      const revoked = await revokeContactMemorySharingConsent({
        representativeSlug: input.item.representativeSlug,
        audienceIdentityId: input.item.audienceIdentityId,
        sourceChannel: "MATRIX",
      });
      return revoked.changed
        ? "已立即停止当前对外代理的跨渠道联系人记忆召回；共享记忆的远端投影已进入可重试清理队列。各渠道原始会话和渠道内记忆不受影响。"
        : "当前没有有效的跨渠道联系人记忆授权；系统已再次确认共享召回处于关闭状态。";
    }
    if (!input.item.sourceSenderId || !input.item.privateChannelConnectionId) {
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
    if (input.command === "DISCLOSE") {
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
    if (!challengeToken) {
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
  } catch (error) {
    if (!(error instanceof ContactMemorySharingError)) throw error;
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
  if (!context) return "当前无法读取会话状态，请稍后重试。";
  const lines = [`会话状态：${context.conversationState}`];
  if (context.activeCollector) lines.push("需求采集：等待你继续描述需求；发送“取消”可以结束本次采集。");
  if (context.pendingApproval) lines.push(`待审批动作：${context.pendingApproval.requestedActionSummary}`);
  if (context.activeHandoff) lines.push(`人工接手：${context.activeHandoff.status}`);
  if (context.serviceEntitlement) lines.push(`可用服务额度：${context.serviceEntitlement.remainingUnits}`);
  if (lines.length === 1) lines.push("当前没有进行中的需求、审批或人工接手。");
  return lines.join("\n");
}

function resolvePiMaxSteps() {
  const parsed = Number.parseInt(
    process.env.DELEGATE_PI_MAX_STEPS?.trim() || "16",
    10,
  );
  return Number.isFinite(parsed) ? Math.min(64, Math.max(2, parsed)) : 16;
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
  if (code === "contact_memory_sharing_policy_disabled") return "当前暂不提供联系人长期记忆能力，因此跨渠道授权未生效。";
  if (code === "contact_memory_sharing_contract_mismatch") return `${renderContactMemorySharingDisclosure()}\n\n披露内容已经更新，请重新获取一次性确认令牌。`;
  if (
    code === "contact_memory_sharing_challenge_invalid"
    || code === "contact_memory_sharing_challenge_expired"
    || code === "contact_memory_sharing_challenge_consumed"
  ) return "一次性确认令牌缺失、无效、已过期或已使用。请重新发送 !memory_share 阅读说明并获取新令牌。";
  if (code === "contact_memory_sharing_identity_ineligible" || code === "contact_memory_sharing_source_unverified") {
    return "授权未生效：请先在当前代表的 Web 页面登录并把这个 Matrix 账号绑定到同一个 Delegate 用户。";
  }
  if (code === "contact_memory_sharing_representative_not_found") return "当前对外代理已不可用，跨渠道联系人记忆授权未变更。";
  return "跨渠道联系人记忆状态刚刚发生变化，请重试命令。";
}

function retrievePublishedSnapshotKnowledge(
  knowledgePack: {
    identitySummary: string;
    faq: Array<{ title: string; summary: string }>;
    materials: Array<{ title: string; summary: string }>;
    policies: Array<{ title: string; summary: string }>;
  },
  query: string,
) {
  const documents = [
    { id: "published:identity", title: "Representative identity", summary: knowledgePack.identitySummary },
    ...(["faq", "materials", "policies"] as const).flatMap((kind) =>
      knowledgePack[kind].map((document, index) => ({
        id: `published:${kind}:${index + 1}`,
        title: document.title,
        summary: document.summary,
      }))),
  ];
  const queryTerms = searchableTerms(query);
  return documents.map((document) => ({
    ...document,
    score: [...searchableTerms(`${document.title} ${document.summary}`)]
      .filter((term) => queryTerms.has(term)).length,
  })).filter((document) => document.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);
}

export async function resolveKnowledgeRetrievalQuery(input: {
  item: Pick<
    GenerationItem,
    | "userText"
    | "representativeVersionId"
    | "representativeSlug"
    | "conversationId"
    | "contactId"
    | "channel"
  >;
  modelQuery: string;
}) {
  const currentUserQuery = input.item.userText.trim();
  const modelQuery = input.modelQuery.trim();
  if (
    !currentUserQuery
    || !modelQuery
    || currentUserQuery === modelQuery
    || !input.item.representativeVersionId
  ) {
    return currentUserQuery || modelQuery;
  }
  const probe = (queryText: string) => probeRepresentativeKnowledgeMetadata({
    representativeSlug: input.item.representativeSlug,
    representativeVersionId: input.item.representativeVersionId!,
    conversationId: input.item.conversationId,
    contactId: input.item.contactId,
    sourceChannel: input.item.channel,
    queryText,
    allowedSourceKinds: ["PUBLIC_KNOWLEDGE"],
  });
  try {
    const currentProbe = await probe(currentUserQuery);
    if (currentProbe.status === "hit") return currentUserQuery;
    const refinedProbe = await probe(modelQuery);
    return refinedProbe.status === "hit" ? modelQuery : currentUserQuery;
  } catch {
    // The visitor-authored query is the only safe fallback when the routing
    // probe itself is unavailable. The model may not add unsupported source
    // assumptions at this trust boundary.
    return currentUserQuery;
  }
}

function searchableTerms(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9_-]{2,}|\p{Script=Han}{2,}/gu) ?? []);
  for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2));
  }
  return terms;
}

function isConfiguredStructuredDataSkill(skill: {
  slug: string;
  displayName: string;
  summary: string;
  capabilityTags: string[];
}) {
  const value = [
    skill.slug,
    skill.displayName,
    skill.summary,
    ...skill.capabilityTags,
  ].join(" ").toLocaleLowerCase();
  return /spreadsheet|csv|excel|tabular|data[-_ ]?analysis|sales[-_ ]?ranking|表格|数据分析|销售排名/u.test(value);
}

function hasValidCsvHeader(value: string) {
  const firstLine = value.trimStart().split(/\r?\n/u, 1)[0] ?? "";
  const fields = firstLine.split(",").map((field) => field.trim());
  return fields.length >= 2 && fields.every((field) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field));
}

function resolvePublicArtifactFileName(artifact: { id: string; kind: string; mimeType: string }) {
  const extension = artifact.mimeType.includes("json") ? "json"
    : artifact.mimeType.includes("csv") ? "csv"
      : artifact.mimeType.includes("png") ? "png"
        : artifact.mimeType.includes("jpeg") ? "jpg" : "txt";
  return `${artifact.kind}-${artifact.id}.${extension}`;
}

function startGenerationLeaseHeartbeat(item: GenerationItem) {
  if (!Number.isSafeInteger(item.leaseAttempt)) {
    return {
      assertOwned: () => {},
      confirmOwned: async () => {},
      isLost: () => false,
      stop: () => {},
    };
  }
  let renewing = false;
  let lostError: GenerationWorkLeaseLostError | undefined;
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval>;
  const markLost = () => {
    if (lostError) return;
    lostError = new GenerationWorkLeaseLostError(item.outboxId, item.leaseAttempt);
    if (heartbeat) clearInterval(heartbeat);
  };
  heartbeat = setInterval(() => {
    if (renewing || stopped || lostError) return;
    renewing = true;
    void renewGenerationWorkItemLease({
      outboxId: item.outboxId,
      leaseAttempt: item.leaseAttempt,
    }).then((renewed) => {
      if (!renewed) markLost();
    }).catch((error) => {
      markLost();
      console.error(`Pi generation lease renewal failed for ${item.runId}.`, error);
    }).finally(() => { renewing = false; });
  }, Math.max(1_000, Math.floor(GENERATION_WORK_LEASE_DURATION_MS / 3)));
  heartbeat.unref?.();
  return {
    assertOwned() {
      if (lostError) throw lostError;
    },
    async confirmOwned() {
      if (lostError) throw lostError;
      let renewed: boolean;
      try {
        renewed = await renewGenerationWorkItemLease({
          outboxId: item.outboxId,
          leaseAttempt: item.leaseAttempt,
        });
      } catch (error) {
        markLost();
        throw error;
      }
      if (!renewed) {
        markLost();
        throw lostError;
      }
    },
    isLost: () => Boolean(lostError),
    stop() {
      stopped = true;
      clearInterval(heartbeat);
    },
  };
}

async function deliverGenerationOutput(input: {
  config: ConversationWorkerConfig;
  item: GenerationItem;
  text: string;
  outputMessageId: string;
}) {
  const preparation = await prepareGenerationMessageChannelDelivery({
    conversationId: input.item.conversationId,
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    outputMessageId: input.outputMessageId,
  });
  await assertConversationChannelDeliveryAvailable({
    conversationId: input.item.conversationId,
    channel: input.item.channel,
    senderMode: "ai",
    allowNeedsHumanDelivery: preparation.allowNeedsHumanDelivery,
  });
  let deliveryText = input.text;
  const isMemoryDeleteConfirmation = (input.item.channel === "matrix" || input.item.channel === "telegram")
    && isDeterministicContactMemoryDeleteCommand(input.item.userText);
  if ((input.item.channel === "matrix" || input.item.channel === "telegram") && !isMemoryDeleteConfirmation) {
    try {
      deliveryText = await renderPrivateChannelGenerationDeliveryText({
        generationRunId: input.item.runId,
        outputMessageId: input.outputMessageId,
        text: input.text,
      });
    } catch {
      deliveryText = privateChannelSourceVerificationUnavailableStatement;
    }
  }
  let externalMessageId: string | undefined;
  const providerDeliveryFence = {
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    outputMessageId: input.outputMessageId,
    deliveryAdmission: preparation.deliveryAdmission,
  };
  if (input.item.channel === "matrix" || input.item.channel === "telegram") {
    await admitGenerationMessageProviderDelivery({
      conversationId: input.item.conversationId,
      ...providerDeliveryFence,
    });
  }
  if (input.item.channel === "matrix") {
    if (!input.item.externalConversationId || !input.item.matrixSenderUserId || !input.item.matrixEndpointLifecycleRevision) {
      throw new Error("Matrix generation delivery is missing its room, sender, or lifecycle fence.");
    }
    externalMessageId = await sendMatrixRepresentativeMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      roomId: input.item.externalConversationId,
      senderUserId: input.item.matrixSenderUserId,
      expectedEndpointLifecycleRevision: input.item.matrixEndpointLifecycleRevision,
      deliveryId: input.item.runId,
      senderMode: "ai",
      generationRunId: input.item.runId,
      generationDelivery: providerDeliveryFence,
      text: deliveryText,
    });
  } else if (input.item.channel === "telegram") {
    if (!input.item.externalConversationId) throw new Error("Telegram chat binding is missing.");
    externalMessageId = await sendTelegramMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      chatId: input.item.externalConversationId,
      ...(input.item.telegramConnectionId ? { connectionId: input.item.telegramConnectionId } : {}),
      generationDelivery: providerDeliveryFence,
      text: deliveryText,
    });
  }
  if (externalMessageId) {
    await recordGenerationMessageProviderAcceptance({
      runId: input.item.runId,
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
      outputMessageId: input.outputMessageId,
      externalMessageId,
      deliveryAdmission: preparation.deliveryAdmission,
    });
  }
  try {
    await markGenerationDeliveryComplete({
      runId: input.item.runId,
      outboxId: input.item.outboxId,
      leaseAttempt: input.item.leaseAttempt,
      outputMessageId: input.outputMessageId,
      deliveryAdmission: preparation.deliveryAdmission,
      ...(externalMessageId ? { externalMessageId } : {}),
    });
  } catch (error) {
    if (externalMessageId) throw new ProviderAcceptancePendingCommitError(error);
    throw error;
  }
  return externalMessageId;
}

async function sendTelegramMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  chatId: string;
  connectionId?: string;
  generationDelivery?: {
    runId: string;
    outboxId: string;
    leaseAttempt: number;
    outputMessageId: string;
    deliveryAdmission: GenerationMessageDeliveryAdmission;
  };
  text: string;
}) {
  if (input.config.telegramConversationPlatformMode !== "worker") {
    throw new Error("Telegram conversation worker is not the active delivery owner.");
  }
  const connectionId = input.connectionId?.trim();
  if (!connectionId) throw new Error("Telegram Bot connection is missing for this conversation.");
  const fenced = await withActiveTelegramRepresentativeChannelFence({
    conversationId: input.conversationId,
    expectedConnectionId: connectionId,
  }, async (tx) => {
    const credential = await resolveTelegramBotRuntimeCredential({ connectionId });
    const hasPersistedConnections = credential ? true : await hasPersistedTelegramBotConnections();
    const token = credential?.token || (!hasPersistedConnections ? input.config.telegramBotToken : undefined);
    if (!token) throw new Error("Telegram Bot credential is unavailable for this conversation.");
    const tokenBotId = token.match(/^([1-9]\d*):/)?.[1];
    const expectedBotId = credential?.botId || connectionId;
    if (!tokenBotId || (expectedBotId && tokenBotId !== expectedBotId)) {
      throw new Error("Telegram Bot credential does not match the conversation connection.");
    }
    const send = async () => {
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
          signal: AbortSignal.timeout(input.config.telegramRequestTimeoutMs ?? 15_000),
        });
      } catch (error) {
        throw new TelegramProviderOutcomeUnknownError(error);
      }
      let payload: { ok?: boolean; result?: { message_id?: number }; description?: string };
      try {
        payload = await response.json() as typeof payload;
      } catch (error) {
        if (response.ok) throw new TelegramProviderOutcomeUnknownError(error);
        throw new Error(`Telegram delivery failed with an unreadable provider response (${response.status}).`);
      }
      if (!response.ok || !payload.ok) {
        throw new Error(payload.description || `Telegram delivery failed (${response.status}).`);
      }
      if (!payload.result?.message_id) {
        throw new TelegramProviderOutcomeUnknownError(
          new Error("Telegram accepted the request without returning a message id."),
        );
      }
      return String(payload.result.message_id);
    };
    if (!input.generationDelivery) return { executed: true as const, value: await send() };
    return withGenerationMessageProviderDeliveryFence(tx, {
      conversationId: input.conversationId,
      ...input.generationDelivery,
    }, send);
  });
  if (!fenced.executed) throw new Error("Telegram channel assignment changed before outbound delivery.");
  const providerDelivery = fenced.value;
  if (!providerDelivery.executed) {
    if (providerDelivery.reason === "turn_plan_superseded_before_delivery") {
      throw new GenerationPlanDeliverySupersededError();
    }
    throw new GenerationMemoryDeliveryBlockedError();
  }
  return providerDelivery.value;
}

function isRecoverableOperatorPause(error: unknown): error is Error & {
  code: "channel_paused" | "representative_paused" | "policy_disabled";
} {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return (error instanceof Error || ("name" in error && error.name === "ChannelUnavailableError"))
    && (code === "channel_paused" || code === "representative_paused" || code === "policy_disabled");
}

class TelegramProviderOutcomeUnknownError extends Error {
  readonly code = "telegram_provider_outcome_unknown";
  constructor(cause: unknown) {
    super("Telegram provider outcome is unknown; automatic retry is disabled to prevent duplicate delivery.", { cause });
    this.name = "TelegramProviderOutcomeUnknownError";
  }
}

class ProviderAcceptancePendingCommitError extends Error {
  readonly code = "provider_acceptance_pending_commit";
  constructor(cause: unknown) {
    super("Provider acceptance is durable, but the current work lease could not finalize delivery.", { cause });
    this.name = "ProviderAcceptancePendingCommitError";
  }
}

function isProviderAcceptancePendingCommit(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "provider_acceptance_pending_commit");
}

function buildProviderOutcomeUnknownRetry(error: unknown): Record<string, never> | {
  providerOutcomeUnknown: true;
  providerOutcomeCode: "telegram_provider_outcome_unknown" | "matrix_provider_outcome_unknown";
} {
  if (!error || typeof error !== "object" || !("code" in error)) return {};
  if (error.code !== "telegram_provider_outcome_unknown" && error.code !== "matrix_provider_outcome_unknown") return {};
  return { providerOutcomeUnknown: true, providerOutcomeCode: error.code };
}

function isConversationHumanControlError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "CONVERSATION_HUMAN_ACTIVE");
}
