import {
  generateRepresentativeReply,
  planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallback,
  type ModelRuntimeState,
} from "@delegate/model-runtime";
import {
  buildComputeRequestsFromDelegationPlan,
  createConversationPlan,
  parseComputeDirective,
  renderReplyPreview,
  readPersistedDelegationStepRequest,
  resolveComputeSubagent,
  resolveConversationSubagent,
  shouldConsiderNaturalLanguageCompute,
  type ParsedComputeRequest,
} from "@delegate/runtime";
import {
  buildRepresentativeRuntimeProfile,
  assertConversationChannelDeliveryAvailable,
  authorizeGenerationRunFreeUsage,
  claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem,
  completeOperatorMessageDelivery,
  completeInlineGenerationRun,
  createComputeDelegationTask,
  createClarifyingDelegationTask,
  createAudienceComputeSession,
  deferOperatorMessageDelivery,
  deferGenerationRunForHuman,
  executeAudienceTool,
  ensureConversationLeadAndHandoff,
  failGenerationRun,
  getRepresentativeRuntimeSetupSnapshot,
  hasPersistedTelegramBotConnections,
  loadGenerationRecentTurns,
  markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning,
  GENERATION_WORK_LEASE_DURATION_MS,
  GenerationWorkLeaseLostError,
  finalizeComputeDelegationTask,
  findConversationClarifyingDelegationTask,
  isGenerationWorkLeaseLostError,
  continueClarifyingDelegationTask,
  recallRepresentativeContext,
  prepareGenerationMessageChannelDelivery,
  reserveGenerationConversationEntitlement,
  renewGenerationWorkItemLease,
  retryGenerationDelivery,
  retryOperatorMessageDelivery,
  resolveTelegramBotRuntimeCredential,
  withActiveTelegramRepresentativeChannelFence,
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
        externalMessageId = await sendMatrixRepresentativeMessage({
          config,
          conversationId: operatorItem.conversationId,
          roomId: operatorItem.externalConversationId,
          senderUserId: operatorItem.matrixSenderUserId,
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
    const delegationConfig = resolveDelegationConfig(setup);
    const representative = buildRepresentativeRuntimeProfile(setup);

    const persistedRequest = readPersistedDelegationStepRequest(
      item.contextSnapshot && typeof item.contextSnapshot === "object"
        ? (item.contextSnapshot as Record<string, unknown>).request
        : null,
    );
    const clarifyingTask = !persistedRequest && item.channel === "web"
      ? await findConversationClarifyingDelegationTask({
          representativeId: setup.id,
          contactId: item.contactId,
          conversationId: item.conversationId,
        })
      : null;
    const computeDirective = item.channel === "web" && !persistedRequest && !clarifyingTask
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
      item.channel === "web" &&
      setup.compute.enabled &&
      delegationConfig.enabled &&
      (
        Boolean(clarifyingTask) ||
        (
          delegationConfig.naturalLanguageEnabled &&
          shouldConsiderNaturalLanguageCompute(item.userText)
        )
      )
    ) {
      const knownPaidContinuationRequired =
        item.usage.freeRepliesUsed >= representative.contract.freeReplyLimit;
      if (
        knownPaidContinuationRequired
        && !item.walletReservation
        && !entitlementReservation
        && item.audienceIdentityId
      ) {
        entitlementReservation = await reserveGenerationConversationEntitlement({
          runId: item.runId,
          ...workLease,
          audienceIdentityId: item.audienceIdentityId,
          representativeId: setup.id,
        });
      }
      if (
        knownPaidContinuationRequired
        && !item.walletReservation
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

    let paidContinuationRequired =
      item.usage.freeRepliesUsed >= representative.contract.freeReplyLimit;
    if (!item.walletReservation && !paidContinuationRequired) {
      const freeAuthorized = await authorizeGenerationRunFreeUsage({
        runId: item.runId,
        ...workLease,
        freeReplyLimit: representative.contract.freeReplyLimit,
      });
      paidContinuationRequired = !freeAuthorized;
    }
    if (
      item.audienceIdentityId
      && paidContinuationRequired
      && !item.walletReservation
      && !entitlementReservation
    ) {
      entitlementReservation = await reserveGenerationConversationEntitlement({
        runId: item.runId,
        ...workLease,
        audienceIdentityId: item.audienceIdentityId,
        representativeId: setup.id,
      });
    }
    const effectiveUsage = entitlementReservation
      ? {
          ...item.usage,
          passUnlocked: true,
          deepHelpUnlocked:
            item.usage.deepHelpUnlocked
            || entitlementReservation.productCode === "plan:deep_help",
        }
      : paidContinuationRequired && !item.walletReservation
        ? {
            ...item.usage,
            freeRepliesUsed: Math.max(
              item.usage.freeRepliesUsed,
              representative.contract.freeReplyLimit,
            ),
            passUnlocked: false,
            deepHelpUnlocked: false,
          }
        : item.usage;
    const continuationAuthorized =
      !paidContinuationRequired
      || Boolean(item.walletReservation || entitlementReservation);

    if (
      parsedRequests.length
      && paidContinuationRequired
      && !item.walletReservation
      && !entitlementReservation
    ) {
      return completeTerminalDelegationFailure(
        item,
        "免费额度已用完，当前没有可预占的服务权益。请先充值或购买服务额度后再执行委托任务。",
      );
    }

    if (parsedRequests.length) {
      const computeReply = await processPublicWebComputeRequest({
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

    const recentTurns = await loadGenerationRecentTurns({
      conversationId: item.conversationId,
      beforeMessageId: item.inputMessageId,
    });
    const plan = createConversationPlan({
      text: item.userText,
      channel: "private_chat",
      representative,
      usage: effectiveUsage,
    });
    const subagent = resolveConversationSubagent(plan);
    const recalled = plan.nextStep === "answer"
      ? await recallRepresentativeContext({
          representativeSlug: item.representativeSlug,
          conversationId: item.conversationId,
          contactId: item.contactId,
          queryText: item.userText,
        })
      : { items: [], citations: [] };

    let replyText = renderReplyPreview(representative, plan);
    let runtime: { provider?: "openai" | "bailian" | "anthropic"; model?: string; inputTokens?: number; outputTokens?: number; costCents?: number } = {};
    let runtimeOutcome: GenerationRuntimeOutcome | undefined;
    let citations: typeof recalled.citations = recalled.citations;
    if (plan.nextStep === "answer") {
      const generated = await generateRepresentativeReply({
        representative,
        plan,
        subagent,
        userText: item.userText,
        recalled: recalled.items,
        recentTurns,
        collectorState: null,
      });
      leaseGuard.assertOwned();
      if (generated.ok) {
        replyText = generated.replyText;
        runtimeOutcome = { mode: "model" };
        runtime = {
          provider: generated.provider,
          model: generated.model,
          ...(generated.usage?.inputTokens !== undefined ? { inputTokens: generated.usage.inputTokens } : {}),
          ...(generated.usage?.outputTokens !== undefined ? { outputTokens: generated.usage.outputTokens } : {}),
          ...(generated.usage?.costCents !== undefined ? { costCents: generated.usage.costCents } : {}),
        };
      } else {
        const groundedFallback = renderGroundedKnowledgeFallback({
          userText: item.userText,
          recalled: recalled.items,
        });
        if (groundedFallback) {
          replyText = groundedFallback;
        }
        runtimeOutcome = {
          mode: "fallback",
          fallbackStrategy: groundedFallback
            ? "grounded_knowledge"
            : "deterministic_preview",
          modelRuntimeState: generated.state,
          fallbackReason: resolveFallbackReason(generated.state),
        };
      }
    }

    const requestHandoff =
      plan.nextStep === "handoff" || plan.nextStep === "ask_owner";
    const completed = await completeInlineGenerationRun({
      conversationId: item.conversationId,
      runId: item.runId,
      ...workLease,
      replyText,
      senderDisplayName: item.representativeName,
      intent: plan.intent,
      completeOutbox: false,
      countUsage: continuationAuthorized,
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
      ...(citations.length ? { citations } : {}),
      ...(runtimeOutcome ? { runtimeOutcome } : {}),
      ...runtime,
    });
    outputMessageId = completed.message.id;

    if (plan.nextStep === "collect_intake") {
      leaseGuard.assertOwned();
      await ensureConversationLeadAndHandoff({
        conversationId: item.conversationId,
        reason: "Qualified conversation intent",
        summary: item.userText.slice(0, 600),
        kind: plan.intent,
        priority: 50,
        source: item.channel,
        requestHandoff: false,
      });
      leaseGuard.assertOwned();
    }

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
  if (resolveDelegationConfig(input.setup).knowledgeScope !== "public_knowledge") {
    return { text: input.taskInput, authorizedKnowledge: [] };
  }

  const recalled = await recallRepresentativeContext({
    representativeSlug: input.item.representativeSlug,
    conversationId: input.item.conversationId,
    contactId: input.item.contactId,
    queryText: input.taskInput,
  });
  const publicKnowledge = recalled.items
    .slice(0, 3)
    .map((item, index) => {
      const content = item.content?.trim() || item.abstract.trim();
      return content ? `[公开资料 ${index + 1}] ${content.slice(0, 2_000)}` : "";
    })
    .filter(Boolean);

  const authorizedKnowledge = recalled.citations
    .filter((citation): citation is typeof citation & { knowledgeAssetId: string } => Boolean(citation.knowledgeAssetId))
    .slice(0, 3)
    .map((citation) => ({ assetId: citation.knowledgeAssetId, title: citation.title }));
  return {
    text: publicKnowledge.length
      ? `${input.taskInput}\n\nOwner 已授权本任务使用以下已审核公开资料：\n${publicKnowledge.join("\n")}`
      : input.taskInput,
    authorizedKnowledge,
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

async function processPublicWebComputeRequest(input: {
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
      reason: `web:${input.parsed.capability}`,
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
  text: string;
}) {
  return sendTelegramMessage(input);
}

async function sendTelegramMessage(input: {
  config: ConversationWorkerConfig;
  conversationId: string;
  chatId: string;
  connectionId?: string;
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
      async () => {
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
      },
    );
  if (!fencedDelivery.executed) {
    throw new Error(
      "Telegram channel assignment changed before outbound delivery.",
    );
  }
  return fencedDelivery.value;
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
  let externalMessageId: string | undefined;
  if (input.item.channel === "matrix") {
    if (!input.item.externalConversationId || !input.item.matrixSenderUserId) {
      throw new Error("Matrix room or representative virtual user is missing.");
    }
    externalMessageId = await sendMatrixRepresentativeMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      roomId: input.item.externalConversationId,
      senderUserId: input.item.matrixSenderUserId,
      deliveryId: input.item.runId,
      senderMode: "ai",
      generationRunId: input.item.runId,
      text: input.text,
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
      text: input.text,
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
