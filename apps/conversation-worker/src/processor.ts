import {
  generateRepresentativeReply,
  planNaturalLanguageComputeRequest,
  type ModelRuntimeState,
} from "@delegate/model-runtime";
import {
  buildComputeRequestsFromDelegationPlan,
  advanceStructuredCollector,
  beginStructuredCollector,
  authorizeConversationAction,
  createConversationPlan,
  formatStructuredCollectorPrompt,
  formatStructuredCollectorSummary,
  hasMatchedExecutableSkill,
  isConversationCancellationRequest,
  parseComputeDirective,
  renderFailClosedReplyPreview,
  renderReplyPreview,
  readStructuredCollectorState,
  readPersistedDelegationStepRequest,
  resolveComputeSubagent,
  resolveConversationSubagent,
  shouldStartStructuredCollector,
  shouldConsiderNaturalLanguageCompute,
  type ParsedComputeRequest,
  type ConversationActionExecutionResult,
  type ConversationPlan,
  type ConversationTurnTrace,
  type PlannedConversationAction,
  type StructuredCollectorState,
} from "@delegate/runtime";
import {
  buildRepresentativeRuntimeProfile,
  assertConversationChannelDeliveryAvailable,
  authorizeGenerationRunFreeUsage,
  claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem,
  completeOperatorMessageDelivery,
  completeConversationIntake,
  completeInlineGenerationRun,
  contactMemorySharingConsentContractVersion,
  ContactMemorySharingError,
  createComputeDelegationTask,
  createClarifyingDelegationTask,
  createAudienceComputeSession,
  clearConversationCollectorState,
  createContactMemorySharingChallenge,
  deferOperatorMessageDelivery,
  deferGenerationRunForHuman,
  executeAudienceTool,
  failGenerationRun,
  getRepresentativeRuntimeSetupSnapshot,
  grantContactMemorySharingConsent,
  hasPersistedTelegramBotConnections,
  isDeterministicContactMemoryDeleteCommand,
  matrixServerNameFromUserId,
  loadGenerationRecentTurns,
  loadConversationOperationalContext,
  markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning,
  GENERATION_WORK_LEASE_DURATION_MS,
  GenerationMemoryDeliveryBlockedError,
  GenerationWorkLeaseLostError,
  finalizeComputeDelegationTask,
  findConversationCancelableDelegationTask,
  findConversationClarifyingDelegationTask,
  isGenerationMemoryDeliveryBlockedError,
  isGenerationWorkLeaseLostError,
  continueClarifyingDelegationTask,
  recallRepresentativeContext,
  applyRepresentativeDelegationTaskAction,
  prepareGenerationMessageChannelDelivery,
  privateChannelSourceVerificationUnavailableStatement,
  readContactMemorySharingChallengeToken,
  resolveGovernedPublicMaterialDeliveries,
  reserveGenerationConversationWalletUsage,
  renderPrivateChannelGenerationDeliveryText,
  renewGenerationWorkItemLease,
  resolveDeterministicContactMemorySharingCommand,
  resolveRepresentativeComputeApproval,
  revokeContactMemorySharingConsent,
  retryGenerationDelivery,
  retryOperatorMessageDelivery,
  setConversationCollectorState,
  resolveTelegramBotRuntimeCredential,
  withActiveTelegramRepresentativeChannelFence,
  withGenerationMessageProviderDeliveryFence,
  waitGenerationRunForComputeApproval,
  type AuthorizedDelegationKnowledge,
  type ConversationEntitlementReservation,
  type GenerationRuntimeOutcome,
} from "@delegate/web-data";

import type { ConversationWorkerConfig } from "./config";
import {
  isComputeExecutionClaimLostError,
  isComputeGenerationExecutionInProgressError,
} from "./compute-client";
import { sendMatrixRepresentativeMessage } from "./matrix-outbound";

function resolveFallbackReason(
  state: ModelRuntimeState,
): Extract<GenerationRuntimeOutcome, { mode: "fallback" }>["fallbackReason"] {
  if (
    state === "disabled"
    || state === "missing_credentials"
    || state === "unsupported_provider"
  ) {
    return "model_unavailable";
  }
  if (state === "invalid_subagent_route") {
    return "policy_fallback";
  }
  return "provider_failed";
}

function isCollectorCancelMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "取消" || normalized === "cancel" || normalized === "stop";
}

function isConversationStatusCommand(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, " ").toLowerCase();
  return normalized === "/status"
    || normalized === "!status"
    || normalized === "查询当前状态"
    || normalized === "查看当前状态";
}

function renderConversationOperationalStatus(
  context: Awaited<ReturnType<typeof loadConversationOperationalContext>>,
): string {
  if (!context) return "当前无法读取会话状态，请稍后重试。";
  const lines = [`会话状态：${context.conversationState}`];
  if (context.activeCollector) {
    lines.push("需求采集：等待你继续描述需求；发送“取消”可以结束本次采集。");
  }
  if (context.latestTask) {
    lines.push(
      `最近任务：${context.latestTask.status}（下一步：${context.latestTask.nextActionBy}）`,
    );
  }
  if (context.pendingApproval) {
    lines.push(`待审批动作：${context.pendingApproval.requestedActionSummary}`);
  }
  if (context.activeHandoff) {
    lines.push(`人工接手：${context.activeHandoff.status}`);
  }
  if (context.serviceEntitlement) {
    lines.push(`可用服务额度：${context.serviceEntitlement.remainingUnits}`);
  }
  if (lines.length === 1) lines.push("当前没有进行中的需求、审批或人工接手。");
  return lines.join("\n");
}

type PublicMaterialDelivery = {
  id: string;
  title: string;
  summary: string;
  url: string;
  processingVersion: number;
};

function buildConversationTurnTrace(
  plan: ConversationPlan,
  resolveExecution: (
    action: PlannedConversationAction,
  ) => ConversationActionExecutionResult,
  resolveAuthorization: (
    action: PlannedConversationAction,
  ) => ConversationTurnTrace["actions"][number]["authorization"] =
    authorizeConversationAction,
): ConversationTurnTrace {
  const intentResult = plan.intentResult ?? {
    primaryGoal: plan.goal,
    primaryIntent: plan.intent,
    businessLabels: [plan.intent],
    requestedOutcomes: [],
    entities: {},
    missingFields: [],
    confidence: 1,
    safetySignals: [],
  };
  const billingDecision = plan.billingDecision ?? {
    decision: plan.disposition === "payment_required"
      ? "payment_required" as const
      : plan.disposition === "handoff" || plan.disposition === "refuse"
        ? "no_charge" as const
        : "allow_free" as const,
    billable: !["payment_required", "handoff", "refuse"].includes(plan.disposition),
    reason: "Compatibility decision for a pre-protocol conversation plan.",
  };
  return {
    version: 1,
    plan: {
      goal: plan.goal,
      intent: plan.intent,
      businessLabels: intentResult.businessLabels,
      requestedOutcomes: intentResult.requestedOutcomes,
      disposition: plan.disposition,
      replyGoal: plan.replyGoal ?? "Produce the policy-selected conversation result.",
      reasons: plan.reasons ?? [],
    },
    billing: billingDecision,
    actions: (plan.actions ?? []).map((action) => ({
      id: action.id,
      kind: action.kind,
      authorization: resolveAuthorization(action),
      execution: resolveExecution(action),
    })),
  };
}

function isConversationPlanBillable(plan: ConversationPlan): boolean {
  return plan.billingDecision?.billable
    ?? !["payment_required", "handoff", "refuse"].includes(plan.disposition);
}

function buildCollectorTurnTrace(input: {
  state: StructuredCollectorState;
  continuationAuthorized: boolean;
  canceled: boolean;
  completed: boolean;
  serviceRequestId?: string | null;
}): ConversationTurnTrace {
  const billing = !input.continuationAuthorized || input.canceled
    ? {
        decision: "no_charge" as const,
        billable: false,
        reason: input.canceled
          ? "Canceled intake does not consume conversation usage."
          : "The intake is paused until service entitlement is available.",
      }
    : {
        decision: "allow_entitlement" as const,
        billable: true,
        reason: "The current conversation authorization permits intake continuation.",
      };
  const collectStatus: ConversationActionExecutionResult["status"] = input.canceled
    ? "denied"
    : input.completed
      ? "completed"
      : "waiting_input";
  const serviceStatus: ConversationActionExecutionResult["status"] = input.canceled
    ? "denied"
    : input.completed && input.serviceRequestId
      ? "completed"
      : "deferred";
  return {
    version: 1,
    plan: {
      goal: "provide_information",
      intent: input.state.intent,
      businessLabels: [input.state.intent],
      requestedOutcomes: ["create_service_request"],
      disposition: "collect",
      replyGoal: "继续收集一段需求描述并在完成后创建服务请求。",
      reasons: ["An existing request-description intake is active."],
    },
    billing,
    actions: [
      {
        id: `collect_request_description:${input.state.intent}`,
        kind: "collect_request_description",
        authorization: {
          decision: "allow",
          reason: "The user is continuing an existing request-description intake.",
        },
        execution: {
          actionId: `collect_request_description:${input.state.intent}`,
          status: collectStatus,
          summary: input.canceled
            ? "The user canceled request collection."
            : input.completed
              ? "The request description was collected."
              : "The intake is waiting for the request description.",
        },
      },
      {
        id: `create_service_request:${input.state.intent}`,
        kind: "create_service_request",
        authorization: {
          decision: "allow",
          reason: "Creating an internal service request grants no external authority.",
        },
        execution: {
          actionId: `create_service_request:${input.state.intent}`,
          status: serviceStatus,
          summary: input.serviceRequestId
            ? "The internal service request was created."
            : "Service-request creation remains deferred.",
          ...(input.serviceRequestId
            ? { output: { serviceRequestId: input.serviceRequestId } }
            : {}),
        },
      },
    ],
  };
}

async function selectPublicMaterialDeliveries(
  representative: ReturnType<typeof buildRepresentativeRuntimeProfile>,
  plan: ConversationPlan,
  userText: string,
): Promise<PublicMaterialDelivery[]> {
  if (!(plan.actions ?? []).some((action) => action.kind === "deliver_public_material")) {
    return [];
  }
  return resolveGovernedPublicMaterialDeliveries({
    representativeId: representative.id,
    representativeSlug: representative.slug,
    queryText: userText,
    businessLabels: plan.intentResult?.businessLabels ?? [],
    requestedOutcomes: plan.intentResult?.requestedOutcomes ?? [],
    legacyMaterials: representative.knowledgePack.materials,
  });
}

function renderPublicMaterialDeliveries(materials: PublicMaterialDelivery[]): string {
  if (!materials.length) {
    return "当前发布版本没有可直接发送的公开资料链接。";
  }
  return [
    "公开资料",
    ...materials.map((material) =>
      `${material.title}\n${material.summary}\n${material.url}`
    ),
  ].join("\n\n");
}

export async function processNextConversationWork(config: ConversationWorkerConfig) {
  const telegramWorkerEnabled =
    config.telegramConversationPlatformMode === "worker";
  const operatorItem = await claimNextOperatorMessageWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if (operatorItem) {
    try {
      await assertConversationChannelDeliveryAvailable({
        conversationId: operatorItem.conversationId,
        channel: operatorItem.channel,
        senderMode: "operator",
      });
      let externalMessageId: string | undefined;
      if (operatorItem.channel === "matrix") {
        if (!operatorItem.matrixSenderUserId) {
          throw new Error(
            "Matrix representative transport user is missing for Operator delivery.",
          );
        }
        if (!operatorItem.matrixEndpointLifecycleRevision) {
          throw new Error(
            "Matrix operator delivery is missing its channel lifecycle fence.",
          );
        }
        externalMessageId = await sendMatrixRepresentativeMessage({
          config,
          conversationId: operatorItem.conversationId,
          roomId: operatorItem.externalConversationId,
          senderUserId: operatorItem.matrixSenderUserId,
          expectedEndpointLifecycleRevision:
            operatorItem.matrixEndpointLifecycleRevision,
          deliveryId: `operator-${operatorItem.messageId}`,
          senderMode: "human_operator",
          text: `${operatorItem.operatorName.trim().slice(0, 80) || "Operator"}: ${operatorItem.text}`,
        });
      } else {
        externalMessageId = await sendTelegramOperatorMessage({
          config,
          conversationId: operatorItem.conversationId,
          chatId: operatorItem.externalConversationId,
          ...(operatorItem.telegramConnectionId
            ? { connectionId: operatorItem.telegramConnectionId }
            : {}),
          operatorName: operatorItem.operatorName,
          text: operatorItem.text,
        });
      }
      await completeOperatorMessageDelivery({
        outboxId: operatorItem.outboxId,
        messageId: operatorItem.messageId,
        ...(externalMessageId ? { externalMessageId } : {}),
      });
      return { processed: true as const, runId: operatorItem.messageId, status: "completed" as const };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Operator message delivery failed.";
      if (isRecoverableOperatorPause(error)) {
        await deferOperatorMessageDelivery({
          outboxId: operatorItem.outboxId,
          messageId: operatorItem.messageId,
          reason: error.code,
        });
        return {
          processed: true as const,
          runId: operatorItem.messageId,
          status: "deferred" as const,
        };
      }
      await retryOperatorMessageDelivery({
        outboxId: operatorItem.outboxId,
        messageId: operatorItem.messageId,
        errorMessage,
      });
      return { processed: true as const, runId: operatorItem.messageId, status: "failed" as const, error: errorMessage };
    }
  }

  const item = await claimNextGenerationWorkItem({
    telegramWorkerEnabled,
    ...(config.outboxProcessingLeaseMs
      ? { processingLeaseMs: config.outboxProcessingLeaseMs }
      : {}),
  });
  if (!item) return { processed: false as const };

  const leaseGuard = startGenerationLeaseHeartbeat(item);
  const workLease = {
    outboxId: item.outboxId,
    leaseAttempt: item.leaseAttempt,
  };

  if (item.deliveryOnly) {
    try {
      leaseGuard.assertOwned();
      if (!item.outputMessageId || !item.outputText) {
        const errorMessage =
          "Completed generation is missing its persisted delivery output.";
        await retryGenerationDelivery({
          runId: item.runId,
          ...workLease,
          ...(item.outputMessageId
            ? { outputMessageId: item.outputMessageId }
            : {}),
          errorMessage,
        });
        return {
          processed: true as const,
          runId: item.runId,
          status: "failed" as const,
          error: errorMessage,
        };
      }
      await deliverGenerationOutput({
        config,
        item,
        text: item.outputText,
        outputMessageId: item.outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    } catch (error) {
      if (isGenerationMemoryDeliveryBlockedError(error)) {
        return {
          processed: true as const,
          runId: item.runId,
          status: "canceled" as const,
        };
      }
      if (
        leaseGuard.isLost()
        || isGenerationWorkLeaseLostError(error)
        || isConversationHumanControlError(error)
      ) {
        return {
          processed: true as const,
          runId: item.runId,
          status: "lease_lost" as const,
        };
      }
      const errorMessage =
        error instanceof Error ? error.message : "Conversation delivery retry failed.";
      try {
        await retryGenerationDelivery({
          runId: item.runId,
          ...workLease,
          ...(item.outputMessageId
            ? { outputMessageId: item.outputMessageId }
            : {}),
          errorMessage,
        });
      } catch (commitError) {
        if (
          leaseGuard.isLost()
          || isGenerationWorkLeaseLostError(commitError)
        ) {
          return {
            processed: true as const,
            runId: item.runId,
            status: "lease_lost" as const,
          };
        }
        throw commitError;
      }
      return {
        processed: true as const,
        runId: item.runId,
        status: "failed" as const,
        error: errorMessage,
      };
    } finally {
      leaseGuard.stop();
    }
  }

  let outputMessageId: string | undefined;
  let entitlementReservation: ConversationEntitlementReservation | null = null;
  try {
    leaseGuard.assertOwned();
    if (item.controlState === "HUMAN_ACTIVE" || item.controlState === "NEEDS_HUMAN") {
      await deferGenerationRunForHuman({
        runId: item.runId,
        ...workLease,
      });
      return { processed: true as const, runId: item.runId, status: "waiting_human" as const };
    }

    if (
      (item.channel === "matrix" || item.channel === "telegram")
      && isDeterministicContactMemoryDeleteCommand(item.userText)
    ) {
      const replyText = renderContactMemoryDeleteConfirmation(item.channel);
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "contact_memory_delete_confirmation",
        completeOutbox: false,
        countUsage: false,
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "disabled",
          fallbackReason: "policy_fallback",
        },
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: replyText,
        outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    }

    const sharingCommand = item.channel === "matrix"
      ? resolveDeterministicContactMemorySharingCommand(item.userText)
      : null;
    if (sharingCommand) {
      let replyText: string;
      if (!item.audienceIdentityId) {
        replyText = renderContactMemorySharingFailure(
          "contact_memory_sharing_identity_ineligible",
        );
      } else if (sharingCommand === "INVALID_CONFIRM") {
        replyText = renderContactMemorySharingFailure(
          "contact_memory_sharing_challenge_invalid",
        );
      } else {
        try {
          if (sharingCommand === "REVOKE") {
            const revoked = await revokeContactMemorySharingConsent({
              representativeSlug: item.representativeSlug,
              audienceIdentityId: item.audienceIdentityId,
              sourceChannel: "MATRIX",
            });
            replyText = revoked.changed
              ? "已立即停止当前数字代表的跨渠道联系人记忆召回；共享记忆的远端投影已进入可重试清理队列。各渠道原始会话和渠道内记忆不受影响。"
              : "当前没有有效的跨渠道联系人记忆授权；系统已再次确认共享召回处于关闭状态。";
          } else {
            if (
              !item.sourceSenderId
              || !item.privateChannelConnectionId
            ) {
              throw new ContactMemorySharingError(
                "contact_memory_sharing_source_unverified",
                "Matrix source coordinates are missing.",
                403,
              );
            }
            const sourceEvidence = {
              sourceChannel: "MATRIX" as const,
              providerSubject: item.sourceSenderId,
              issuer: matrixServerNameFromUserId(item.sourceSenderId),
              connectionId: item.privateChannelConnectionId,
            };
            if (sharingCommand === "DISCLOSE") {
              const challenge = await createContactMemorySharingChallenge({
                representativeSlug: item.representativeSlug,
                audienceIdentityId: item.audienceIdentityId,
                disclosureContractVersion:
                  contactMemorySharingConsentContractVersion,
                sourceEventKey: `matrix:${item.inputMessageId}`,
                ...sourceEvidence,
              });
              replyText = renderContactMemorySharingDisclosure(
                challenge.challengeToken,
              );
            } else {
              const challengeToken = readContactMemorySharingChallengeToken(
                item.userText.trim().replace(/\s+/gu, " ").slice(
                  "!memory_share ".length,
                ),
              );
              if (!challengeToken) {
                throw new ContactMemorySharingError(
                  "contact_memory_sharing_challenge_invalid",
                  "Matrix memory-sharing challenge token is missing.",
                  409,
                );
              }
              const granted = await grantContactMemorySharingConsent({
                representativeSlug: item.representativeSlug,
                audienceIdentityId: item.audienceIdentityId,
                challengeToken,
                sourceEventKey: `matrix:${item.inputMessageId}`,
                ...sourceEvidence,
              });
              replyText = granted.active
                ? "已允许当前数字代表在已验证为同一 Delegate 用户的 Web、Matrix 和 Telegram 私聊之间使用联系人记忆。"
                : renderContactMemorySharingFailure(
                    "contact_memory_sharing_conflict",
                  );
            }
          }
        } catch (error) {
          if (!(error instanceof ContactMemorySharingError)) throw error;
          replyText = renderContactMemorySharingFailure(error.code);
        }
      }
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: `contact_memory_sharing_${sharingCommand.toLowerCase()}`,
        completeOutbox: false,
        countUsage: false,
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "disabled",
          fallbackReason: "policy_fallback",
        },
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: replyText,
        outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: "completed" as const,
      };
    }

    if (item.delegationTerminalRecovery) {
      const recovery = renderDelegationTerminalRecovery(
        item.delegationTerminalRecovery,
      );
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText: recovery.text,
        senderDisplayName: item.representativeName,
        intent: "delegation_terminal_recovery",
        completeOutbox: false,
        countUsage: false,
        keepConversationQueued: recovery.keepConversationQueued,
        ...(item.delegationTerminalRecovery.attachments.length
          ? { attachments: item.delegationTerminalRecovery.attachments }
          : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({
        config,
        item,
        text: recovery.text,
        outputMessageId,
      });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: recovery.keepConversationQueued
          ? "step_completed" as const
          : "completed" as const,
      };
    }

    const setup = await getRepresentativeRuntimeSetupSnapshot(
      item.representativeSlug,
      item.representativeVersionId,
    );
    leaseGuard.assertOwned();
    if (!setup) throw new Error(`Representative ${item.representativeSlug} was not found.`);
    if (isConversationStatusCommand(item.userText)) {
      const operationalContext = await loadConversationOperationalContext({
        representativeId: setup.id,
        conversationId: item.conversationId,
        ...(item.audienceIdentityId
          ? { audienceIdentityId: item.audienceIdentityId }
          : {}),
      });
      const replyText = renderConversationOperationalStatus(operationalContext);
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "conversation_status",
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }
    const delegationConfig = resolveDelegationConfig(setup);
    const representative = buildRepresentativeRuntimeProfile(setup);
    // Commerce policy is pinned on GenerationRun at ingress. Do not recompute
    // it from the mutable representative setup after the worker lease begins.
    const unlimitedFreeAccess = item.accessMode === "FREE";
    const pinnedTrialLimit =
      typeof item.effectiveFreeReplyLimit === "number"
      && Number.isSafeInteger(item.effectiveFreeReplyLimit)
      && item.effectiveFreeReplyLimit >= 0
        ? item.effectiveFreeReplyLimit
        : null;
    const effectiveFreeReplyLimit = item.accessMode === "CREDITS_ONLY"
      ? 0
      : item.accessMode === "TRIAL_THEN_CREDITS"
        && pinnedTrialLimit !== null
        ? pinnedTrialLimit
        : representative.contract.freeReplyLimit;
    const policyPinnedRepresentative = item.accessMode === "FREE"
      ? representative
      : {
          ...representative,
          contract: {
            ...representative.contract,
            freeReplyLimit: effectiveFreeReplyLimit,
          },
        };
    const matchedExecutableSkill = hasMatchedExecutableSkill(
      item.userText,
      policyPinnedRepresentative,
    );
    const requiresPaidContinuation = (freeRepliesUsed: number) =>
      !unlimitedFreeAccess
      && freeRepliesUsed >= effectiveFreeReplyLimit;
    let walletReservation = item.walletReservation ?? null;
    const reservePaidContinuation = async () => {
      if (
        !item.audienceIdentityId
        || walletReservation
        || entitlementReservation
      ) {
        return { walletReservation, entitlementReservation };
      }

      // Resolve the canonical audience wallet under the generation lease when
      // ingress did not already pin one. Legacy fixed-tier entitlements are
      // intentionally not consulted on any channel.
      const nextWalletReservation =
        await reserveGenerationConversationWalletUsage({
          runId: item.runId,
          ...workLease,
          audienceIdentityId: item.audienceIdentityId,
          representativeId: setup.id,
          tokenAmount: 1,
        });
      return {
        walletReservation: nextWalletReservation,
        entitlementReservation,
      };
    };

    const persistedRequest = readPersistedDelegationStepRequest(
      item.contextSnapshot && typeof item.contextSnapshot === "object"
        ? (item.contextSnapshot as Record<string, unknown>).request
        : null,
    );
    const activeCollector = readStructuredCollectorState(item.collectorState);
    if (isConversationCancellationRequest(item.userText) && !activeCollector) {
      const cancelPlan = createConversationPlan({
        text: item.userText,
        channel: "private_chat",
        representative: policyPinnedRepresentative,
        usage: item.usage,
      });
      const candidate = await findConversationCancelableDelegationTask({
        representativeId: setup.id,
        conversationId: item.conversationId,
        contactId: item.contactId,
        ...(item.audienceIdentityId
          ? { audienceIdentityId: item.audienceIdentityId }
          : {}),
      });
      let replyText: string;
      let executionStatus: ConversationActionExecutionResult["status"];
      let executionSummary: string;
      if (candidate.status === "cancelable") {
        if (candidate.pendingApprovalId) {
          await resolveRepresentativeComputeApproval({
            representativeSlug: item.representativeSlug,
            approvalId: candidate.pendingApprovalId,
            resolution: "rejected",
            resolvedBy: item.audienceIdentityId || item.contactId,
            decisionNote: "The audience canceled the pending action from its originating conversation.",
          });
        } else {
          await applyRepresentativeDelegationTaskAction({
            representativeSlug: item.representativeSlug,
            taskId: candidate.taskId,
            action: "cancel",
            actorId: item.audienceIdentityId || item.contactId,
            actorType: "audience",
          });
        }
        replyText = "已取消当前待处理任务；尚未消费的服务额度会按原支付边界释放。审批和审计记录会保留。";
        executionStatus = "completed";
        executionSummary = "The audience canceled the scoped pending task.";
      } else if (candidate.status === "already_canceled") {
        replyText = "当前任务已经取消，无需重复操作。";
        executionStatus = "completed";
        executionSummary = "The scoped task was already canceled; the command was idempotent.";
      } else if (candidate.status === "in_flight") {
        replyText = "当前任务已经开始执行，无法安全地声明为已取消。系统不会启动新的步骤；如已产生外部结果，将按审计记录处理。";
        executionStatus = "denied";
        executionSummary = "The task was already running and could not be safely canceled.";
      } else {
        replyText = "当前会话没有可取消的待处理任务。";
        executionStatus = "completed";
        executionSummary = "No scoped pending task was found.";
      }
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "delegation_cancel",
        turnTrace: buildConversationTurnTrace(cancelPlan, (action) => ({
          actionId: action.id,
          status: executionStatus,
          summary: executionSummary,
          ...(candidate.status === "none"
            ? {}
            : { output: { taskId: candidate.taskId } }),
        })),
        countUsage: false,
        completeOutbox: false,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }
    const clarifyingTask = !persistedRequest && !activeCollector
      ? await findConversationClarifyingDelegationTask({
          representativeId: setup.id,
          contactId: item.contactId,
          conversationId: item.conversationId,
        })
      : null;
    const computeDirective = !persistedRequest && !clarifyingTask && !activeCollector
      ? parseComputeDirective(item.userText)
      : { kind: "none" as const };
    if (
      computeDirective.kind !== "none" &&
      (!delegationConfig.enabled || !delegationConfig.explicitComputeEnabled)
    ) {
      const replyText = !delegationConfig.enabled
        ? "这个代表当前不接受委托任务。你仍然可以继续普通问答。"
        : "这个代表未开放高级 /compute 命令。请直接用自然语言描述目标；系统会在需要执行能力时自动创建任务。";
      return completeTerminalDelegationFailure(item, replyText);
    }
    if (computeDirective.kind === "help" || computeDirective.kind === "invalid") {
      const replyText = computeDirective.kind === "invalid"
        ? `${computeDirective.message}\n\n可用示例：\n${computeDirective.examples}`
        : [
            setup.compute.enabled
              ? "这个代表已启用隔离计算。你也可以直接用自然语言描述需要生成文件、运行命令或浏览网页的任务。"
              : "这个代表当前没有启用隔离计算。",
            `高级命令示例：\n${computeDirective.examples}`,
          ].join("\n\n");
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "compute_help",
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await markGenerationDeliveryComplete({
        runId: item.runId,
        ...workLease,
        outputMessageId,
      });
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }

    let parsedRequests: ParsedComputeRequest[] = persistedRequest
      ? [persistedRequest]
      : computeDirective.kind === "request" ? [computeDirective.request] : [];
    let planSummary = parsedRequests[0]?.displayTarget || "";
    let planSteps: Array<{ summary: string; request: ParsedComputeRequest }> | undefined;
    let authorizedKnowledge: AuthorizedDelegationKnowledge[] = [];
    let delegationOverride: { task: { id: string }; step: { id: string } } | undefined =
      item.delegationTaskId && item.delegationTaskStepId
        ? { task: { id: item.delegationTaskId }, step: { id: item.delegationTaskStepId } }
        : undefined;
    if (
      !parsedRequests.length &&
      setup.compute.enabled &&
      delegationConfig.enabled &&
      (
        Boolean(clarifyingTask) ||
        (
          delegationConfig.naturalLanguageEnabled &&
          (
            matchedExecutableSkill
            || shouldConsiderNaturalLanguageCompute(item.userText)
          )
        )
      )
    ) {
      const knownPaidContinuationRequired = requiresPaidContinuation(
        item.usage.freeRepliesUsed,
      );
      if (
        knownPaidContinuationRequired
        && !walletReservation
        && !entitlementReservation
        && item.audienceIdentityId
      ) {
        ({ walletReservation, entitlementReservation } =
          await reservePaidContinuation());
      }
      if (
        knownPaidContinuationRequired
        && !walletReservation
        && !entitlementReservation
      ) {
        const completed = await completeInlineGenerationRun({
          conversationId: item.conversationId,
          runId: item.runId,
          ...workLease,
          replyText:
            "免费额度已用完，当前没有可预占的服务权益。请先充值或购买服务额度后再继续委托任务。",
          senderDisplayName: item.representativeName,
          intent: "delegation_payment_required",
          countUsage: false,
          completeOutbox: false,
        });
        outputMessageId = completed.message.id;
        await markGenerationDeliveryComplete({
          runId: item.runId,
          ...workLease,
          outputMessageId,
        });
        return {
          processed: true as const,
          runId: item.runId,
          status: "completed" as const,
        };
      }
      const taskInput = clarifyingTask
        ? `原始任务：${clarifyingTask.objective}\n待补充：${clarifyingTask.blockingReason || "执行输入"}\n用户补充：${item.userText}`
        : item.userText;
      const plannerContext = await buildDelegationPlannerInput({
        setup,
        item,
        taskInput,
      });
      authorizedKnowledge = plannerContext.authorizedKnowledge;
      const planned = await planNaturalLanguageComputeRequest({
        userText: plannerContext.text,
        maxSteps: delegationConfig.maxSteps,
      });
      leaseGuard.assertOwned();
      if (planned.ok && planned.plan) {
        if (planned.plan.kind === "clarification") {
          const clarificationPlan = createConversationPlan({
            text: item.userText,
            channel: "private_chat",
            representative: policyPinnedRepresentative,
            usage: { ...item.usage, passUnlocked: true },
            proposedAction: {
              target: "compute:clarification",
              input: {
                source: "current_user_message",
                question: planned.plan.question,
                missingFields: planned.plan.missingFields,
              },
              requiredCapabilities: ["compute.plan"],
            },
          });
          clarificationPlan.billingDecision = {
            decision: "no_charge",
            billable: false,
            reason: "A planner clarification does not execute or complete a service step.",
          };
          if (clarifyingTask) {
            await continueClarifyingDelegationTask({
              taskId: clarifyingTask.id,
              generationRunId: item.runId,
              inputMessageId: item.inputMessageId,
              contactId: item.contactId,
              question: planned.plan.question,
              missingFields: planned.plan.missingFields,
              authorizedKnowledge,
            });
          } else {
            await createClarifyingDelegationTask({
              representativeId: setup.id,
              representativeVersionId: item.representativeVersionId,
              contactId: item.contactId,
              conversationId: item.conversationId,
              ...(item.episodeId ? { episodeId: item.episodeId } : {}),
              generationRunId: item.runId,
              inputMessageId: item.inputMessageId,
              objective: item.userText,
              summary: planned.plan.summary,
              question: planned.plan.question,
              missingFields: planned.plan.missingFields,
              authorizedKnowledge,
              maxDurationMinutes: setup.compute.maxSessionMinutes,
              networkMode: setup.compute.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
              filesystemMode: setup.compute.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
            });
          }
          const completed = await completeInlineGenerationRun({
            conversationId: item.conversationId,
            runId: item.runId,
            ...workLease,
            replyText: planned.plan.question,
            senderDisplayName: item.representativeName,
            intent: "delegation_clarification",
            turnTrace: buildConversationTurnTrace(
              clarificationPlan,
              (action) => ({
                actionId: action.id,
                status: "waiting_input",
                summary: "The governed Compute request is waiting for required input.",
              }),
              () => ({
                decision: "allow",
                reason: "Clarifying the requested tool input has no external side effect.",
              }),
            ),
            countUsage: false,
            completeOutbox: false,
            ...(entitlementReservation ? { entitlementReservation } : {}),
          });
          outputMessageId = completed.message.id;
          await markGenerationDeliveryComplete({
            runId: item.runId,
            ...workLease,
            outputMessageId,
          });
          return { processed: true as const, runId: item.runId, status: "waiting_input" as const };
        }
        parsedRequests = buildComputeRequestsFromDelegationPlan(planned.plan);
        planSummary = planned.plan.summary;
        planSteps = planned.plan.steps.map((step, index) => ({
          summary: step.summary,
          request: parsedRequests[index]!,
        }));
        if (parsedRequests.length !== planned.plan.steps.length) {
          throw new Error("Delegation planner produced an incomplete execution step.");
        }
        if (clarifyingTask) {
          const resumed = await continueClarifyingDelegationTask({
            taskId: clarifyingTask.id,
            generationRunId: item.runId,
            inputMessageId: item.inputMessageId,
            contactId: item.contactId,
            planSummary,
            planSteps,
            authorizedKnowledge,
          });
          if (!resumed.ready) throw new Error("Clarifying delegation task did not become ready.");
          delegationOverride = { task: { id: resumed.taskId }, step: { id: resumed.step.id } };
        }
      }
    }
    if (
      !parsedRequests.length &&
      item.delegationTaskId &&
      item.delegationTaskStepId &&
      !clarifyingTask
    ) {
      return completeTerminalDelegationFailure(
        item,
        "此前的委托任务未能继续执行，系统已停止本次任务，并且不会把它改成普通问答。请重新描述目标；文件位置将由系统自动管理。",
      );
    }

    let paidContinuationRequired = requiresPaidContinuation(
      item.usage.freeRepliesUsed,
    );
    if (
      !unlimitedFreeAccess
      && !walletReservation
      && !paidContinuationRequired
    ) {
      const freeAuthorized = await authorizeGenerationRunFreeUsage({
        runId: item.runId,
        ...workLease,
        freeReplyLimit: effectiveFreeReplyLimit,
      });
      paidContinuationRequired = !freeAuthorized;
    }
    if (
      item.audienceIdentityId
      && paidContinuationRequired
      && !walletReservation
      && !entitlementReservation
    ) {
      ({ walletReservation, entitlementReservation } =
        await reservePaidContinuation());
    }
    const effectiveUsage = entitlementReservation
      ? {
          ...item.usage,
          passUnlocked: true,
          deepHelpUnlocked: item.usage.deepHelpUnlocked,
        }
      : walletReservation
        ? {
            ...item.usage,
            passUnlocked: true,
          }
        : unlimitedFreeAccess
          ? {
              ...item.usage,
              // The legacy planner understands unlimited access through an
              // unlocked continuation flag; no service credit is consumed.
              passUnlocked: true,
            }
          : paidContinuationRequired && !walletReservation
            ? {
                ...item.usage,
                freeRepliesUsed: Math.max(
                  item.usage.freeRepliesUsed,
                  effectiveFreeReplyLimit,
                ),
                passUnlocked: false,
                deepHelpUnlocked: false,
              }
            : item.usage;
    const continuationAuthorized =
      !paidContinuationRequired
      || Boolean(walletReservation || entitlementReservation);

    if (activeCollector) {
      const canceled = isCollectorCancelMessage(item.userText);
      let replyText: string;
      let completedCollector = false;
      let completedState = activeCollector;
      let completedServiceRequestId: string | null = null;

      if (!continuationAuthorized) {
        replyText = "当前可用服务额度不足。补充额度后可以从当前采集步骤继续，不需要重新开始。";
      } else if (canceled) {
        await clearConversationCollectorState({ conversationId: item.conversationId });
        replyText = "已取消本次需求采集，没有创建服务请求。";
      } else {
        const advanced = advanceStructuredCollector(activeCollector, item.userText);
        completedState = advanced.state ?? activeCollector;
        completedCollector = advanced.completed;
        if (advanced.completed) {
          const summary = formatStructuredCollectorSummary(completedState);
          const completedIntake = await completeConversationIntake({
            representativeId: setup.id,
            representativeVersionId: item.representativeVersionId,
            contactId: item.contactId,
            conversationId: item.conversationId,
            ...(item.episodeId ? { episodeId: item.episodeId } : {}),
            inputMessageId: item.inputMessageId,
            intent: completedState.intent,
            collectorKind: completedState.kind,
            sourceChannel: item.channel,
            summary,
            objective: summary,
            desiredOutcome: "Owner review and a clear next-step response.",
            priority: 60,
            recommendedNextStep:
              completedState.kind === "scheduling"
                ? "owner_schedule_review"
                : completedState.kind === "quote"
                  ? "owner_quote_review"
                  : "owner_service_request_review",
            payload: {
              collectorKind: completedState.kind,
              sourceChannel: completedState.sourceChannel,
              suggestedPlan: completedState.suggestedPlan ?? null,
              startedAt: completedState.startedAt,
              completedAt: new Date().toISOString(),
              answers: completedState.answers,
              summary,
            },
          });
          completedServiceRequestId = completedIntake.serviceRequestId;
          replyText = completedIntake.serviceRequestId
            ? `需求已整理并创建服务请求。\n\n${summary}\n\n如需补充联系人、预算或时间等信息，真人接手后会继续询问。后续工具调用和外部操作仍会分别检查权限。`
            : `需求已整理。\n\n${summary}\n\n当前会话已进入人工处理状态，因此没有重复创建服务请求。`;
        } else {
          await setConversationCollectorState({
            conversationId: item.conversationId,
            collectorState: completedState,
          });
          replyText = formatStructuredCollectorPrompt(completedState);
        }
      }

      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: completedCollector ? "intake_completed" : canceled ? "intake_canceled" : "intake_collecting",
        turnTrace: buildCollectorTurnTrace({
          state: completedState,
          continuationAuthorized,
          canceled,
          completed: completedCollector,
          serviceRequestId: completedServiceRequestId,
        }),
        completeOutbox: false,
        countUsage: continuationAuthorized && !canceled,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return {
        processed: true as const,
        runId: item.runId,
        status: completedCollector || canceled
          ? "completed" as const
          : "waiting_input" as const,
      };
    }

    const primaryComputeRequest = parsedRequests[0];
    const plan = createConversationPlan({
      text: item.userText,
      channel: "private_chat",
      representative: policyPinnedRepresentative,
      usage: effectiveUsage,
      ...(primaryComputeRequest
        ? {
            proposedAction: {
              target: `compute:${primaryComputeRequest.capability}`,
              input: {
                source: "current_user_message",
                capability: primaryComputeRequest.capability,
                displayTarget: primaryComputeRequest.displayTarget,
              },
              requiredCapabilities: [primaryComputeRequest.capability],
              ...(primaryComputeRequest.estimatedCostCents !== undefined
                ? { estimatedCost: primaryComputeRequest.estimatedCostCents }
                : {}),
            },
          }
        : {}),
    });

    if (
      parsedRequests.length
      && paidContinuationRequired
      && !walletReservation
      && !entitlementReservation
    ) {
      return completeTerminalDelegationFailure(
        item,
        "免费额度已用完，当前没有可预占的服务权益。请先充值或购买服务额度后再执行委托任务。",
      );
    }

    if (parsedRequests.length) {
      const computeReply = await processConversationComputeRequest({
        item,
        setup,
        leaseGuard,
        parsed: parsedRequests[0]!,
        ...(planSteps ? { planSteps } : {}),
        ...(planSummary ? { planSummary } : {}),
        ...(authorizedKnowledge.length ? { authorizedKnowledge } : {}),
        ...(delegationOverride ? { delegation: delegationOverride } : {}),
      });

      if (computeReply.approvalId) {
        const waiting = await waitGenerationRunForComputeApproval({
          conversationId: item.conversationId,
          runId: item.runId,
          ...workLease,
          approvalId: computeReply.approvalId,
          replyText: computeReply.text,
          senderDisplayName: item.representativeName,
          turnTrace: buildConversationTurnTrace(
            {
              ...plan,
              billingDecision: {
                decision: "no_charge",
                billable: false,
                reason: "Waiting for approval does not consume conversation usage.",
              },
            },
            (action) => ({
              actionId: action.id,
              status: "waiting_approval",
              summary: "The tool action is blocked pending Owner approval.",
              output: { approvalId: computeReply.approvalId! },
            }),
            () => ({
              decision: "ask",
              reason: "The Compute policy requires Owner approval before execution.",
            }),
          ),
        });
        return {
          processed: true as const,
          runId: item.runId,
          status: waiting.run.status === "WAITING_APPROVAL"
            ? "waiting_approval" as const
            : "completed" as const,
        };
      }

      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText: computeReply.text,
        senderDisplayName: item.representativeName,
        intent: "compute",
        turnTrace: buildConversationTurnTrace(
          {
            ...plan,
            billingDecision: computeReply.billable && !persistedRequest
              ? {
                  decision: "allow_entitlement",
                  billable: true,
                  reason: "A governed Compute service step completed successfully.",
                }
              : {
                  decision: "no_charge",
                  billable: false,
                  reason: "The Compute step did not produce a newly billable completion.",
                },
          },
          (action) => ({
            actionId: action.id,
            status: computeReply.billable ? "completed" : "failed",
            summary: computeReply.billable
              ? "The governed Compute action completed."
              : "The governed Compute action did not complete a billable service step.",
            ...(computeReply.attachments?.length
              ? { output: { attachments: computeReply.attachments } }
              : {}),
          }),
          () => ({
            decision: "allow",
            reason: "The Compute broker authorized the executed capability.",
          }),
        ),
        ...(computeReply.attachments?.length ? { attachments: computeReply.attachments } : {}),
        completeOutbox: false,
        countUsage: computeReply.billable && !persistedRequest,
        keepConversationQueued: computeReply.hasMoreSteps,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await markGenerationDeliveryComplete({
        runId: item.runId,
        ...workLease,
        outputMessageId,
      });
      return {
        processed: true as const,
        runId: item.runId,
        status: computeReply.hasMoreSteps ? "step_completed" as const : "completed" as const,
      };
    }

    if ((plan.actions ?? []).some((action) => action.kind === "execute_tool")) {
      const replyText = "当前请求匹配到执行能力，但系统无法形成完整且安全的执行计划，因此没有调用工具。请补充希望完成的结果和必要输入后重试。";
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "compute_planning_failed",
        turnTrace: buildConversationTurnTrace(plan, (action) => ({
          actionId: action.id,
          status: "failed",
          summary: "No complete governed execution plan was produced; no tool was called.",
        })),
        countUsage: false,
        completeOutbox: false,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }

    const subagent = resolveConversationSubagent(plan);
    if (plan.disposition === "collect" && shouldStartStructuredCollector(plan)) {
      const publicMaterials = await selectPublicMaterialDeliveries(
        policyPinnedRepresentative,
        plan,
        item.userText,
      );
      const collector = beginStructuredCollector({
        plan,
        channel: "private_chat",
      });
      await setConversationCollectorState({
        conversationId: item.conversationId,
        collectorState: collector,
      });
      const replyText = [
        publicMaterials.length || (plan.actions ?? []).some((action) => action.kind === "deliver_public_material")
          ? renderPublicMaterialDeliveries(publicMaterials)
          : null,
        formatStructuredCollectorPrompt(collector),
        "如需中止，请发送“取消”。",
      ].filter(Boolean).join("\n\n");
      const turnTrace = buildConversationTurnTrace(plan, (action) => {
        if (action.kind === "deliver_public_material") {
          return {
            actionId: action.id,
            status: publicMaterials.length ? "completed" : "deferred",
            summary: publicMaterials.length
              ? "Published public-material links were added to the reply."
              : "No published public-material URL was available.",
            ...(publicMaterials.length
              ? { output: { materials: publicMaterials } }
              : {}),
          };
        }
        return {
          actionId: action.id,
          status: action.kind === "collect_request_description"
            ? "waiting_input"
            : "deferred",
          summary: action.kind === "collect_request_description"
            ? "The conversation is waiting for one request description."
            : "Service-request creation is deferred until intake completes.",
        };
      });
      const completed = await completeInlineGenerationRun({
        conversationId: item.conversationId,
        runId: item.runId,
        ...workLease,
        replyText,
        senderDisplayName: item.representativeName,
        intent: plan.intent,
        turnTrace,
        completeOutbox: false,
        countUsage: isConversationPlanBillable(plan) && continuationAuthorized,
        ...(entitlementReservation ? { entitlementReservation } : {}),
      });
      outputMessageId = completed.message.id;
      await deliverGenerationOutput({ config, item, text: replyText, outputMessageId });
      leaseGuard.assertOwned();
      return { processed: true as const, runId: item.runId, status: "waiting_input" as const };
    }
    const operationalContext = plan.disposition === "answer"
      ? await loadConversationOperationalContext({
          representativeId: setup.id,
          conversationId: item.conversationId,
          ...(item.audienceIdentityId
            ? { audienceIdentityId: item.audienceIdentityId }
            : {}),
        })
      : null;
    const recentTurns = await loadGenerationRecentTurns({
      representativeId: setup.id,
      conversationId: item.conversationId,
      beforeMessageId: item.inputMessageId,
    });
    const recalled = plan.disposition === "answer"
      ? await recallRepresentativeContext({
          representativeSlug: item.representativeSlug,
          conversationId: item.conversationId,
          contactId: item.contactId,
          sourceChannel: item.channel,
          generationRunId: item.runId,
          queryText: item.userText,
        })
      : { items: [], memoryUseRunId: undefined };
    // A source item without its generation-scoped UseRun cannot be finalized
    // into injection/citation truth. Never let such an orphan reach the model.
    const ledgerBackedRecalledItems = recalled.memoryUseRunId
      ? recalled.items
      : [];

    let replyText =
      plan.disposition === "payment_required"
      && paidContinuationRequired
      && !walletReservation
      && !entitlementReservation
        ? "当前可用服务额度不足，请前往这个数字代表的公开页面充值或购买服务套餐后再继续。"
        : plan.disposition === "answer"
          ? renderFailClosedReplyPreview(policyPinnedRepresentative, item.userText)
          : renderReplyPreview(policyPinnedRepresentative, plan);
    let runtime: { provider?: "openai" | "bailian" | "anthropic"; model?: string; inputTokens?: number; outputTokens?: number; costCents?: number } = {};
    let runtimeOutcome: GenerationRuntimeOutcome | undefined;
    let memoryUse:
      | {
          runId: string;
          outcome: "completed";
          injectedItemIds: string[];
          citedItemIds: string[];
        }
      | {
          runId: string;
          outcome: "generation_failed";
        }
      | undefined;
    if (plan.disposition === "answer") {
      const generated = await generateRepresentativeReply({
        representative: policyPinnedRepresentative,
        plan,
        subagent,
        userText: item.userText,
        recalled: ledgerBackedRecalledItems,
        recentTurns,
        collectorState: null,
        operationalContext,
      });
      leaseGuard.assertOwned();
      if (generated.ok) {
        replyText = generated.replyText;
        runtimeOutcome = { mode: "model" };
        if (recalled.memoryUseRunId) {
          memoryUse = {
            runId: recalled.memoryUseRunId,
            outcome: "completed",
            injectedItemIds: generated.contextTrace.selectedMemoryUseItemIds,
            citedItemIds: generated.citedMemoryUseItemIds,
          };
        }
        runtime = {
          provider: generated.provider,
          model: generated.model,
          ...(generated.usage?.inputTokens !== undefined ? { inputTokens: generated.usage.inputTokens } : {}),
          ...(generated.usage?.outputTokens !== undefined ? { outputTokens: generated.usage.outputTokens } : {}),
          ...(generated.usage?.costCents !== undefined ? { costCents: generated.usage.costCents } : {}),
        };
      } else {
        runtimeOutcome = {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: generated.state,
          fallbackReason: resolveFallbackReason(generated.state),
        };
        if (recalled.memoryUseRunId) {
          memoryUse = {
            runId: recalled.memoryUseRunId,
            outcome: "generation_failed",
          };
        }
      }
    }

    const publicMaterials = await selectPublicMaterialDeliveries(
      policyPinnedRepresentative,
      plan,
      item.userText,
    );
    if ((plan.actions ?? []).some((action) => action.kind === "deliver_public_material")) {
      replyText = [
        replyText,
        renderPublicMaterialDeliveries(publicMaterials),
      ].filter(Boolean).join("\n\n");
    }
    const turnTrace = buildConversationTurnTrace(plan, (action) => {
      const authorization = authorizeConversationAction(action);
      if (authorization.decision === "deny") {
        return {
          actionId: action.id,
          status: "denied",
          summary: authorization.reason,
        };
      }
      if (authorization.decision === "ask") {
        return {
          actionId: action.id,
          status: "waiting_approval",
          summary: authorization.reason,
        };
      }
      if (action.kind === "deliver_public_material") {
        return {
          actionId: action.id,
          status: publicMaterials.length ? "completed" : "deferred",
          summary: publicMaterials.length
            ? "Published public-material links were added to the reply."
            : "No published public-material URL was available.",
          ...(publicMaterials.length
            ? { output: { materials: publicMaterials } }
            : {}),
        };
      }
      if (action.kind === "answer_public_information") {
        return {
          actionId: action.id,
          status: "completed",
          summary: runtimeOutcome?.mode === "fallback"
            ? "A fail-closed answer was produced without unsupported factual claims."
            : "A grounded public answer was produced.",
        };
      }
      if (action.kind === "request_human_handoff") {
        return {
          actionId: action.id,
          status: "completed",
          summary: "A human-handoff request will be created atomically with the reply.",
        };
      }
      if (action.kind === "refuse_unsafe_request") {
        return {
          actionId: action.id,
          status: "completed",
          summary: "The unsafe request was refused with a safe alternative.",
        };
      }
      return {
        actionId: action.id,
        status: "deferred",
        summary: "The action was not eligible for inline execution.",
      };
    });
    const requestHandoff = plan.disposition === "handoff";
    const completed = await completeInlineGenerationRun({
      conversationId: item.conversationId,
      runId: item.runId,
      ...workLease,
      replyText,
      senderDisplayName: item.representativeName,
      intent: plan.intent,
      turnTrace,
      completeOutbox: false,
      countUsage: isConversationPlanBillable(plan) && continuationAuthorized,
      ...(requestHandoff
        ? {
            humanHandoff: {
              reason: "AI requested human follow-up",
              summary: item.userText.slice(0, 600),
              kind: plan.intent,
              priority: 80,
              source: item.channel,
            },
          }
        : {}),
      ...(entitlementReservation ? { entitlementReservation } : {}),
      ...(memoryUse ? { memoryUse } : {}),
      ...(runtimeOutcome ? { runtimeOutcome } : {}),
      ...runtime,
    });
    outputMessageId = completed.message.id;

    leaseGuard.assertOwned();
    await deliverGenerationOutput({
      config,
      item,
      text: replyText,
      outputMessageId,
    });
    leaseGuard.assertOwned();
    return { processed: true as const, runId: item.runId, status: "completed" as const };
  } catch (error) {
    if (isGenerationMemoryDeliveryBlockedError(error)) {
      return {
        processed: true as const,
        runId: item.runId,
        status: "canceled" as const,
      };
    }
    if (isComputeGenerationExecutionInProgressError(error)) {
      return {
        processed: true as const,
        runId: item.runId,
        status: "execution_in_progress" as const,
      };
    }
    if (
      leaseGuard.isLost()
      || isGenerationWorkLeaseLostError(error)
      || isComputeGenerationLeaseLostError(error)
      || isComputeExecutionClaimLostError(error)
      || isConversationHumanControlError(error)
    ) {
      return {
        processed: true as const,
        runId: item.runId,
        status: "lease_lost" as const,
      };
    }
    const errorMessage = error instanceof Error ? error.message : "Conversation processing failed.";
    const userFacingFailure = renderUserCorrectableDelegationFailure(errorMessage);
    try {
      if (!outputMessageId && userFacingFailure) {
        return await completeTerminalDelegationFailure(
          item,
          userFacingFailure,
          entitlementReservation ?? undefined,
        );
      }
      if (outputMessageId) {
        await retryGenerationDelivery({
          runId: item.runId,
          ...workLease,
          outputMessageId,
          errorMessage,
        });
      } else {
        await failGenerationRun({
          conversationId: item.conversationId,
          runId: item.runId,
          ...workLease,
          errorCode: "conversation_worker_failed",
          errorMessage,
        });
      }
    } catch (commitError) {
      if (leaseGuard.isLost() || isGenerationWorkLeaseLostError(commitError)) {
        return {
          processed: true as const,
          runId: item.runId,
          status: "lease_lost" as const,
        };
      }
      throw commitError;
    }
    return { processed: true as const, runId: item.runId, status: "failed" as const, error: errorMessage };
  } finally {
    leaseGuard.stop();
  }
}

function isRecoverableOperatorPause(
  error: unknown,
): error is Error & {
  code: "channel_paused" | "representative_paused" | "policy_disabled";
} {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return (
    (error instanceof Error || ("name" in error && error.name === "ChannelUnavailableError"))
    && (
      code === "channel_paused"
      || code === "representative_paused"
      || code === "policy_disabled"
    )
  );
}

function startGenerationLeaseHeartbeat(
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>,
) {
  // Runtime guard keeps older queued fixtures/workers harmless during a
  // rolling deploy even though new claims always include the lease attempt.
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
    lostError = new GenerationWorkLeaseLostError(
      item.outboxId,
      item.leaseAttempt,
    );
    if (heartbeat) clearInterval(heartbeat);
  };
  heartbeat = setInterval(() => {
    if (renewing || stopped || lostError) return;
    renewing = true;
    void renewGenerationWorkItemLease({
      outboxId: item.outboxId,
      leaseAttempt: item.leaseAttempt,
    })
      .then((renewed) => {
        if (!renewed) {
          markLost();
          console.warn(
            `Conversation work lease was lost for generation run ${item.runId}.`,
          );
        }
      })
      .catch((error) => {
        markLost();
        console.error(
          `Conversation work lease renewal failed for generation run ${item.runId}.`,
          error,
        );
      })
      .finally(() => {
        renewing = false;
      });
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
    isLost() {
      return Boolean(lostError);
    },
    stop() {
      stopped = true;
      clearInterval(heartbeat);
    },
  };
}

async function buildDelegationPlannerInput(input: {
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  taskInput: string;
}) {
  // Delegation planning is a separate model invocation and does not yet share
  // the answer UseRun. Until it has its own auditable usage ledger, fail closed
  // to caller input instead of silently injecting OpenViking recall.
  return {
    text: input.taskInput,
    authorizedKnowledge: [],
  };
}

function resolveDelegationConfig(
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>,
) {
  return (setup as typeof setup & { delegation?: typeof setup.delegation }).delegation ?? {
    enabled: true,
    naturalLanguageEnabled: true,
    explicitComputeEnabled: true,
    maxSteps: 5,
    maxCostCents: 0,
    knowledgeScope: "user_input_only" as const,
  };
}

function resolveCapabilityModes(
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>,
) {
  return (setup.compute as typeof setup.compute & {
    capabilityModes?: typeof setup.compute.capabilityModes;
  }).capabilityModes ?? {
    exec: "ask" as const,
    read: "allow" as const,
    write: "ask" as const,
    process: "ask" as const,
    browser: "ask" as const,
    mcp: "ask" as const,
  };
}

function renderDelegationTerminalRecovery(
  input: NonNullable<
    NonNullable<
      Awaited<ReturnType<typeof claimNextGenerationWorkItem>>
    >["delegationTerminalRecovery"]
  >,
) {
  const artifactSummary = input.attachments.length
    ? input.attachments
      .map((attachment) => `已生成文件：${attachment.fileName}`)
      .join("\n")
    : "没有生成可展示的结果文件。";
  const keepConversationQueued =
    input.taskStatus === "READY" && input.stepStatus === "COMPLETED";

  if (keepConversationQueued) {
    return {
      text: `委托任务当前步骤已完成，后续步骤已进入执行队列。\n\n${artifactSummary}`,
      keepConversationQueued,
    };
  }
  if (
    input.taskStatus === "COMPLETED"
    && input.stepStatus === "COMPLETED"
  ) {
    return {
      text: `委托任务已在隔离沙盒中执行完成。\n\n${artifactSummary}`,
      keepConversationQueued,
    };
  }
  if (input.stepStatus === "BLOCKED") {
    return {
      text: "委托任务被安全策略拒绝，未执行。",
      keepConversationQueued,
    };
  }
  if (input.taskStatus === "WAITING_FOR_OWNER") {
    return {
      text: "委托任务的外部操作结果需要代表所有者核对，确认前不会自动重试。",
      keepConversationQueued,
    };
  }
  if (
    input.taskStatus === "CANCELED"
    || input.taskStatus === "EXPIRED"
    || input.stepStatus === "CANCELED"
    || input.stepStatus === "SKIPPED"
  ) {
    return {
      text: "委托任务已取消或过期，系统不会继续执行。",
      keepConversationQueued,
    };
  }
  return {
    text: `委托任务已停止，未能完成。\n\n${artifactSummary}`,
    keepConversationQueued,
  };
}

async function completeTerminalDelegationFailure(
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>,
  replyText: string,
  entitlementReservation?: ConversationEntitlementReservation,
) {
  if (item.delegationTaskId && item.delegationTaskStepId) {
    await finalizeComputeDelegationTask({
      taskId: item.delegationTaskId,
      stepId: item.delegationTaskStepId,
      generationRunId: item.runId,
      ...delegationLeaseFence(item),
      outcome: "failed",
      failureReason: replyText,
    });
  }
  const completed = await completeInlineGenerationRun({
    conversationId: item.conversationId,
    runId: item.runId,
    outboxId: item.outboxId,
    leaseAttempt: item.leaseAttempt,
    replyText,
    senderDisplayName: item.representativeName,
    intent: "delegation_failed",
    countUsage: false,
    completeOutbox: false,
    ...(entitlementReservation ? { entitlementReservation } : {}),
  });
  await markGenerationDeliveryComplete({
    runId: item.runId,
    outboxId: item.outboxId,
    leaseAttempt: item.leaseAttempt,
    outputMessageId: completed.message.id,
  });
  return { processed: true as const, runId: item.runId, status: "completed" as const };
}

function renderUserCorrectableDelegationFailure(errorMessage: string) {
  if (errorMessage.includes("path_outside_allowed_workspace")) {
    return "委托任务未能执行：输出位置不符合沙盒安全规则。系统已停止本次任务；普通用户无需提供沙盒路径，请重新描述希望生成的内容，文件位置将由系统自动管理。";
  }
  return null;
}

async function processConversationComputeRequest(input: {
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  leaseGuard: ReturnType<typeof startGenerationLeaseHeartbeat>;
  parsed: ParsedComputeRequest;
  planSummary?: string;
  planSteps?: Array<{ summary: string; request: ParsedComputeRequest }>;
  authorizedKnowledge?: AuthorizedDelegationKnowledge[];
  delegation?: { task: { id: string }; step: { id: string } };
}): Promise<{
  text: string;
  billable: boolean;
  hasMoreSteps: boolean;
  approvalId?: string;
  attachments?: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
}> {
  await input.leaseGuard.confirmOwned();
  const delegationConfig = resolveDelegationConfig(input.setup);
  if (!input.setup.compute.enabled || !delegationConfig.enabled) {
    if (input.delegation) {
      input.leaseGuard.assertOwned();
      await finalizeComputeDelegationTask({
        taskId: input.delegation.task.id,
        stepId: input.delegation.step.id,
        generationRunId: input.item.runId,
        ...delegationLeaseFence(input.item),
        outcome: "blocked",
        failureReason: "Delegated execution was disabled before this step could start.",
      });
      input.leaseGuard.assertOwned();
    }
    return {
      text: input.setup.compute.enabled
        ? "这个代表当前不接受委托任务。"
        : "这个代表当前没有启用 Compute。请联系代表所有者在 Dashboard 中启用后再试。",
      billable: false,
      hasMoreSteps: false,
    };
  }

  await input.leaseGuard.confirmOwned();
  const delegation = input.delegation ?? await createComputeDelegationTask({
    representativeId: input.setup.id,
    representativeVersionId: input.item.representativeVersionId,
    contactId: input.item.contactId,
    conversationId: input.item.conversationId,
    ...(input.item.episodeId ? { episodeId: input.item.episodeId } : {}),
    generationRunId: input.item.runId,
    inputMessageId: input.item.inputMessageId,
    objective: input.item.userText,
    actionSummary: input.parsed.displayTarget,
    request: input.parsed,
    ...(input.planSummary ? { planSummary: input.planSummary } : {}),
    ...(input.planSteps ? { planSteps: input.planSteps } : {}),
    capability: input.parsed.capability,
    maxDurationMinutes: input.setup.compute.maxSessionMinutes,
    maxCostCents: delegationConfig.maxCostCents,
    ...(input.authorizedKnowledge?.length ? { authorizedKnowledge: input.authorizedKnowledge } : {}),
    networkMode: input.setup.compute.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
    filesystemMode: input.setup.compute.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
  });
  input.leaseGuard.assertOwned();
  if (!delegation.step) throw new Error("Delegation task is missing its compute step.");
  const delegationStepId = delegation.step.id;

  const blockDelegation = async (failureReason: string, text: string) => {
    input.leaseGuard.assertOwned();
    await finalizeComputeDelegationTask({
      taskId: delegation.task.id,
      stepId: delegationStepId,
      generationRunId: input.item.runId,
      ...delegationLeaseFence(input.item),
      outcome: "blocked",
      failureReason,
    });
    input.leaseGuard.assertOwned();
    return { text, billable: false, hasMoreSteps: false };
  };

  const plannedStepCount = input.planSteps?.length ?? 1;
  if (plannedStepCount > delegationConfig.maxSteps) {
    return blockDelegation(
      `Planned step count ${plannedStepCount} exceeds representative limit ${delegationConfig.maxSteps}.`,
      `这个任务需要 ${plannedStepCount} 个执行步骤，超过该代表允许的 ${delegationConfig.maxSteps} 步上限。系统未创建沙盒，请缩小任务范围后重试。`,
    );
  }

  const estimatedCostCents = (input.planSteps ?? [{ request: input.parsed }]).reduce(
    (total, step) => total + (step.request.estimatedCostCents ?? 0),
    0,
  );
  if (
    delegationConfig.maxCostCents > 0 &&
    estimatedCostCents > delegationConfig.maxCostCents
  ) {
    return blockDelegation(
      `Estimated cost ${estimatedCostCents} cents exceeds representative limit ${delegationConfig.maxCostCents} cents.`,
      `这个任务的预计执行成本为 ${estimatedCostCents} 美分，超过该代表设置的 ${delegationConfig.maxCostCents} 美分上限。系统未创建沙盒，请缩小任务范围。`,
    );
  }

  const capabilityMode = resolveCapabilityModes(input.setup)[input.parsed.capability];
  if (capabilityMode === "deny") {
    return blockDelegation(
      `Representative policy denies ${input.parsed.capability}.`,
      `这个代表的能力策略禁止${renderCapabilityLabel(input.parsed.capability)}，系统未执行。`,
    );
  }

  const subagent = resolveComputeSubagent(input.parsed.capability);

  let result: Awaited<ReturnType<typeof executeAudienceTool>>;
  try {
    await input.leaseGuard.confirmOwned();
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id,
      contactId: input.item.contactId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
      delegationTaskId: delegation.task.id,
      delegationTaskStepId: delegation.step.id,
      subagentId: subagent.id,
      requestedCapabilities: [input.parsed.capability],
      reason: `${input.item.channel}:${input.parsed.capability}`,
      requestedBaseImage: input.setup.compute.baseImage,
    });
    input.leaseGuard.assertOwned();
    await markDelegationTaskRunning(delegation.task.id, delegation.step.id);
    await input.leaseGuard.confirmOwned();
    result = await executeAudienceTool(session.session.id, {
      ...input.parsed,
      subagentId: subagent.id,
      generationWorkLease: {
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
      },
      // The compute broker derives paid plan authority from its server-side
      // conversation and generation-run context. Never elevate a client payload.
      hasPaidEntitlement: false,
    });
    input.leaseGuard.assertOwned();
  } catch (error) {
    if (
      isComputeGenerationLeaseLostError(error)
      || isComputeExecutionClaimLostError(error)
      || isComputeGenerationExecutionInProgressError(error)
    ) {
      throw error;
    }
    input.leaseGuard.assertOwned();
    await finalizeComputeDelegationTask({
      taskId: delegation.task.id,
      stepId: delegation.step.id,
      generationRunId: input.item.runId,
      ...delegationLeaseFence(input.item),
      outcome: "failed",
      failureReason: error instanceof Error ? error.message : "Compute execution failed.",
    });
    input.leaseGuard.assertOwned();
    throw error;
  }

  if (result.outcome === "pending_approval") {
    if (!result.approvalRequest) throw new Error("Compute approval response is missing.");
    input.leaseGuard.assertOwned();
    await markDelegationTaskAwaitingApproval({
      taskId: delegation.task.id,
      stepId: delegation.step.id,
      approvalId: result.approvalRequest.id,
    });
    input.leaseGuard.assertOwned();
    return {
      approvalId: result.approvalRequest.id,
      billable: false,
      hasMoreSteps: false,
      text: [
        `委托任务已提交，正在等待代表所有者审批。`,
        `操作：${renderPublicComputeAction(input.parsed)}`,
        `风险：${result.approvalRequest.riskSummary}`,
        "审批通过后会在此对话中自动返回执行结果。",
      ].join("\n\n"),
    };
  }

  const billing = result.billing?.actualCredits ?? result.billing?.estimatedCredits;
  const billingLine = typeof billing === "number" ? `\n\n消耗：${billing} credits` : "";
  const attachments = result.artifacts.map((artifact) => ({
    fileName: resolvePublicArtifactFileName(artifact, input.parsed),
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    artifactId: artifact.id,
    url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
  }));
  const artifactSummary = attachments.length
    ? attachments.map((attachment) => `已生成文件：${attachment.fileName}`).join("\n")
    : "没有生成可展示的结果文件。";

  await input.leaseGuard.confirmOwned();
  const finalization = await finalizeComputeDelegationTask({
    taskId: delegation.task.id,
    stepId: delegation.step.id,
    generationRunId: input.item.runId,
    ...delegationLeaseFence(input.item),
    outcome: result.outcome === "blocked"
      ? "blocked"
      : result.outcome === "failed"
        ? "failed"
        : "completed",
    artifacts: result.artifacts,
    ...(typeof billing === "number" ? { actualCredits: billing } : {}),
  });
  await input.leaseGuard.confirmOwned();

  if (result.outcome === "blocked") {
    return {
      text: `委托任务被安全策略拒绝，未执行。${billingLine}`,
      billable: false,
      hasMoreSteps: false,
    };
  }
  if (result.outcome === "failed") {
    return {
      text: `委托任务已执行，但未能完成。\n\n${artifactSummary}${billingLine}`,
      billable: false,
      hasMoreSteps: false,
      ...(attachments.length ? { attachments } : {}),
    };
  }
  return {
    text: finalization?.hasMoreSteps
      ? `委托任务当前步骤已完成，后续步骤已进入执行队列。\n\n${artifactSummary}${billingLine}`
      : `委托任务已在隔离沙盒中执行完成。\n\n${artifactSummary}${billingLine}`,
    billable: true,
    hasMoreSteps: Boolean(finalization?.hasMoreSteps),
    ...(attachments.length ? { attachments } : {}),
  };
}

function delegationLeaseFence(
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>,
) {
  return Number.isSafeInteger(item.leaseAttempt)
    ? {
        outboxId: item.outboxId,
        leaseAttempt: item.leaseAttempt,
      }
    : {};
}

function resolvePublicArtifactFileName(
  artifact: { id: string; kind: string; mimeType: string },
  request: ParsedComputeRequest,
) {
  if (artifact.kind === "file" && request.path) {
    return request.path.split("/").pop() || "result.txt";
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
  return `${artifact.kind}-${artifact.id}.${extension}`;
}

function renderPublicComputeAction(request: ParsedComputeRequest) {
  if (request.capability === "write") {
    if (/^outputs\/report-[a-f0-9]{8}\.md$/i.test(request.path || "")) {
      return "生成并保存文档";
    }
    return `写入文件：${request.path?.split("/").pop() || "系统管理的文件"}`;
  }
  if (request.capability === "read") {
    return `读取文件：${request.path?.split("/").pop() || "系统管理的文件"}`;
  }
  if (request.capability === "browser") return "访问用户提供的公开网页";
  if (request.capability === "mcp") return "调用已授权的外部工具";
  return "在隔离沙盒中运行用户提供的命令";
}

function renderCapabilityLabel(capability: ParsedComputeRequest["capability"]) {
  switch (capability) {
    case "read":
      return "读取工作区文件";
    case "write":
      return "写入工作区文件";
    case "browser":
      return "访问网页";
    case "mcp":
      return "调用外部工具";
    case "process":
      return "运行长期进程";
    case "exec":
    default:
      return "运行命令";
  }
}

async function sendTelegramOperatorMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  chatId: string;
  connectionId?: string;
  operatorName: string;
  text: string;
}) {
  if (input.config.telegramConversationPlatformMode !== "worker") {
    throw new Error("Telegram conversation worker is not the active delivery owner.");
  }
  return sendTelegramMessage({
    config: input.config,
    conversationId: input.conversationId,
    chatId: input.chatId,
    ...(input.connectionId
      ? { connectionId: input.connectionId }
      : {}),
    text: `${input.operatorName}: ${input.text}`,
  });
}

async function sendTelegramRepresentativeMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  chatId: string;
  connectionId?: string;
  generationDelivery: {
    runId: string;
    outboxId: string;
    leaseAttempt: number;
    outputMessageId: string;
  };
  text: string;
}) {
  return sendTelegramMessage(input);
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
  };
  text: string;
}) {
  const configuredConnectionId = input.connectionId?.trim();
  if (!configuredConnectionId) {
    throw new Error(
      "Telegram Bot connection is missing for this conversation.",
    );
  }
  const fencedDelivery =
    await withActiveTelegramRepresentativeChannelFence(
      {
        conversationId: input.conversationId,
        expectedConnectionId: configuredConnectionId,
      },
      async (tx) => {
        const credential = await resolveTelegramBotRuntimeCredential({
          connectionId: configuredConnectionId,
        });
        const hasPersistedConnections = credential
          ? true
          : await hasPersistedTelegramBotConnections();
        const token =
          credential?.token
          || (!hasPersistedConnections
            ? input.config.telegramBotToken
            : undefined);
        if (!token) {
          throw new Error(
            "Telegram Bot credential is unavailable for this conversation.",
          );
        }
        const tokenBotId = token.match(/^([1-9]\d*):/)?.[1];
        const expectedBotId =
          credential?.botId || configuredConnectionId;
        if (
          !tokenBotId
          || (expectedBotId && tokenBotId !== expectedBotId)
        ) {
          throw new Error(
            "Telegram Bot credential does not match the conversation connection.",
          );
        }
        const send = async () => {
          let response: Response;
          try {
            response = await fetch(
              `https://api.telegram.org/bot${token}/sendMessage`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: input.chatId,
                  text: input.text,
                }),
                signal: AbortSignal.timeout(
                  input.config.telegramRequestTimeoutMs ?? 15_000,
                ),
              },
            );
          } catch {
            throw new Error(
              "Telegram delivery could not reach the provider.",
            );
          }
          const payload =
            (await response.json().catch(() => ({}))) as {
              ok?: boolean;
              result?: { message_id?: number };
              description?: string;
            };
          if (
            !response.ok
            || !payload.ok
            || !payload.result?.message_id
          ) {
            throw new Error(
              payload.description
              || `Telegram operator delivery failed (${response.status}).`,
            );
          }
          return String(payload.result.message_id);
        };
        if (!input.generationDelivery) {
          return { executed: true as const, value: await send() };
        }
        return withGenerationMessageProviderDeliveryFence(
          tx,
          {
            conversationId: input.conversationId,
            ...input.generationDelivery,
          },
          send,
        );
      },
    );
  if (!fencedDelivery.executed) {
    throw new Error(
      "Telegram channel assignment changed before outbound delivery.",
    );
  }
  const providerDelivery = fencedDelivery.value;
  if (!providerDelivery.executed) {
    // The transaction above committed the terminal cancel/dead-letter writes.
    throw new GenerationMemoryDeliveryBlockedError();
  }
  return providerDelivery.value;
}

async function deliverGenerationOutput(input: {
  config: ConversationWorkerConfig;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  text: string;
  outputMessageId: string;
}) {
  const deliveryPreparation = await prepareGenerationMessageChannelDelivery({
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
    allowNeedsHumanDelivery:
      deliveryPreparation.allowNeedsHumanDelivery,
  });
  let deliveryText = input.text;
  const isContactMemoryDeleteConfirmation =
    (input.item.channel === "matrix" || input.item.channel === "telegram")
    && isDeterministicContactMemoryDeleteCommand(input.item.userText);
  if (
    (input.item.channel === "matrix" || input.item.channel === "telegram")
    && !isContactMemoryDeleteConfirmation
  ) {
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
  if (input.item.channel === "matrix") {
    if (!input.item.externalConversationId || !input.item.matrixSenderUserId) {
      throw new Error("Matrix room or representative virtual user is missing.");
    }
    if (!input.item.matrixEndpointLifecycleRevision) {
      throw new Error(
        "Matrix generation delivery is missing its channel lifecycle fence.",
      );
    }
    externalMessageId = await sendMatrixRepresentativeMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      roomId: input.item.externalConversationId,
      senderUserId: input.item.matrixSenderUserId,
      expectedEndpointLifecycleRevision:
        input.item.matrixEndpointLifecycleRevision,
      deliveryId: input.item.runId,
      senderMode: "ai",
      generationRunId: input.item.runId,
      generationDelivery: {
        runId: input.item.runId,
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
        outputMessageId: input.outputMessageId,
      },
      text: deliveryText,
    });
  } else if (input.item.channel === "telegram") {
    if (input.config.telegramConversationPlatformMode !== "worker") {
      throw new Error("Telegram conversation worker is not the active delivery owner.");
    }
    if (!input.item.externalConversationId) {
      throw new Error("Telegram chat binding is missing.");
    }
    externalMessageId = await sendTelegramRepresentativeMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      chatId: input.item.externalConversationId,
      ...(input.item.telegramConnectionId
        ? { connectionId: input.item.telegramConnectionId }
        : {}),
      generationDelivery: {
        runId: input.item.runId,
        outboxId: input.item.outboxId,
        leaseAttempt: input.item.leaseAttempt,
        outputMessageId: input.outputMessageId,
      },
      text: deliveryText,
    });
  }
  await markGenerationDeliveryComplete({
    runId: input.item.runId,
    outboxId: input.item.outboxId,
    leaseAttempt: input.item.leaseAttempt,
    outputMessageId: input.outputMessageId,
    ...(externalMessageId ? { externalMessageId } : {}),
  });
  return externalMessageId;
}

function renderContactMemoryDeleteConfirmation(
  channel: "matrix" | "telegram",
) {
  const channelName = channel === "matrix" ? "Matrix" : "Telegram";
  return `已完成：当前数字代表与当前 ${channelName} 渠道下的联系人记忆已立即停止召回，后台将异步清理对应长期记忆。代表经验和其他渠道的联系人记忆不受影响。`;
}

function renderContactMemorySharingDisclosure(challengeToken?: string) {
  return [
    "跨渠道联系人记忆只会共享给当前数字代表，并且只在已验证为同一 Delegate 用户的 Web、Matrix、Telegram 私聊之间使用。",
    "系统不会把原始聊天、付款或余额、凭据、Owner 私有备注、Compute 原始产物写入长期记忆；每次召回仍会检查当前身份、策略和渠道授权。",
    "你可以随时发送 !memory_unshare，立即停止共享记忆召回并异步清理远端投影；各渠道原始会话和渠道内记忆不受影响。",
    challengeToken
      ? `如果你同意，请在 10 分钟内发送：!memory_share confirm ${challengeToken}`
      : "请重新发送 !memory_share 获取一次性确认令牌。",
  ].join("\n\n");
}

function renderContactMemorySharingFailure(
  code: ContactMemorySharingError["code"],
) {
  if (code === "contact_memory_sharing_policy_disabled") {
    return "当前暂不提供联系人长期记忆能力，因此跨渠道授权未生效。";
  }
  if (code === "contact_memory_sharing_contract_mismatch") {
    return `${renderContactMemorySharingDisclosure()}\n\n披露内容已经更新，请重新获取一次性确认令牌。`;
  }
  if (
    code === "contact_memory_sharing_challenge_invalid"
    || code === "contact_memory_sharing_challenge_expired"
    || code === "contact_memory_sharing_challenge_consumed"
  ) {
    return "一次性确认令牌缺失、无效、已过期或已使用。请重新发送 !memory_share 阅读说明并获取新令牌。";
  }
  if (
    code === "contact_memory_sharing_identity_ineligible"
    || code === "contact_memory_sharing_source_unverified"
  ) {
    return "授权未生效：请先在当前代表的 Web 页面登录并把这个 Matrix 账号绑定到同一个 Delegate 用户。";
  }
  if (code === "contact_memory_sharing_representative_not_found") {
    return "当前数字代表已不可用，跨渠道联系人记忆授权未变更。";
  }
  return "跨渠道联系人记忆状态刚刚发生变化，请重试命令。";
}

function isConversationHumanControlError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "CONVERSATION_HUMAN_ACTIVE";
}

function isComputeGenerationLeaseLostError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "generation_work_lease_lost",
  );
}
