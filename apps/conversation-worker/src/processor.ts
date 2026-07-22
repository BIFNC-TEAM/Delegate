import {
  generateRepresentativeReply,
  planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallback,
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
  claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem,
  completeOperatorMessageDelivery,
  completeInlineGenerationRun,
  createComputeDelegationTask,
  createClarifyingDelegationTask,
  createAudienceComputeSession,
  deferGenerationRunForHuman,
  executeAudienceTool,
  ensureConversationLeadAndHandoff,
  failGenerationRun,
  getRepresentativeRuntimeSetupSnapshot,
  loadGenerationRecentTurns,
  markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning,
  finalizeComputeDelegationTask,
  findConversationClarifyingDelegationTask,
  continueClarifyingDelegationTask,
  recallRepresentativeContext,
  retryGenerationDelivery,
  retryOperatorMessageDelivery,
  waitGenerationRunForComputeApproval,
} from "@delegate/web-data";

import type { ConversationWorkerConfig } from "./config";
import { sendMatrixRepresentativeMessage } from "./matrix-outbound";

export async function processNextConversationWork(config: ConversationWorkerConfig) {
  const operatorItem = await claimNextOperatorMessageWorkItem();
  if (operatorItem) {
    try {
      let externalMessageId: string | undefined;
      if (operatorItem.channel === "matrix") {
        if (!operatorItem.matrixSenderUserId) throw new Error("Matrix Operator virtual user is missing.");
        externalMessageId = await sendMatrixRepresentativeMessage({
          config,
          roomId: operatorItem.externalConversationId,
          senderUserId: operatorItem.matrixSenderUserId,
          generationRunId: `operator-${operatorItem.messageId}`,
          text: operatorItem.text,
        });
      } else {
        externalMessageId = await sendTelegramOperatorMessage({
          config,
          chatId: operatorItem.externalConversationId,
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
      await retryOperatorMessageDelivery({
        outboxId: operatorItem.outboxId,
        messageId: operatorItem.messageId,
        errorMessage,
      });
      return { processed: true as const, runId: operatorItem.messageId, status: "failed" as const, error: errorMessage };
    }
  }

  const item = await claimNextGenerationWorkItem();
  if (!item) return { processed: false as const };

  let outputMessageId: string | undefined;
  try {
    if (item.controlState === "HUMAN_ACTIVE" || item.controlState === "NEEDS_HUMAN") {
      await deferGenerationRunForHuman(item.runId);
      return { processed: true as const, runId: item.runId, status: "waiting_human" as const };
    }

    const setup = await getRepresentativeRuntimeSetupSnapshot(
      item.representativeSlug,
      item.representativeVersionId,
    );
    if (!setup) throw new Error(`Representative ${item.representativeSlug} was not found.`);
    const delegationConfig = resolveDelegationConfig(setup);

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
        runId: item.runId,
        replyText,
        senderDisplayName: item.representativeName,
        intent: "compute_help",
        countUsage: false,
        completeOutbox: false,
      });
      outputMessageId = completed.message.id;
      await markGenerationDeliveryComplete({ runId: item.runId, outputMessageId });
      return { processed: true as const, runId: item.runId, status: "completed" as const };
    }

    let parsedRequests: ParsedComputeRequest[] = persistedRequest
      ? [persistedRequest]
      : computeDirective.kind === "request" ? [computeDirective.request] : [];
    let planSummary = parsedRequests[0]?.displayTarget || "";
    let planSteps: Array<{ summary: string; request: ParsedComputeRequest }> | undefined;
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
      const taskInput = clarifyingTask
        ? `原始任务：${clarifyingTask.objective}\n待补充：${clarifyingTask.blockingReason || "执行输入"}\n用户补充：${item.userText}`
        : item.userText;
      const plannerInput = await buildDelegationPlannerInput({
        setup,
        item,
        taskInput,
      });
      const planned = await planNaturalLanguageComputeRequest({
        userText: plannerInput,
        maxSteps: delegationConfig.maxSteps,
      });
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
              maxDurationMinutes: setup.compute.maxSessionMinutes,
              networkMode: setup.compute.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
              filesystemMode: setup.compute.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
            });
          }
          const completed = await completeInlineGenerationRun({
            runId: item.runId,
            replyText: planned.plan.question,
            senderDisplayName: item.representativeName,
            intent: "delegation_clarification",
            countUsage: false,
            completeOutbox: false,
          });
          outputMessageId = completed.message.id;
          await markGenerationDeliveryComplete({ runId: item.runId, outputMessageId });
          return { processed: true as const, runId: item.runId, status: "waiting_input" as const };
        }
        if (planned.plan.steps.length > delegationConfig.maxSteps) {
          return completeTerminalDelegationFailure(
            item,
            `这个任务需要 ${planned.plan.steps.length} 个执行步骤，超过该代表允许的 ${delegationConfig.maxSteps} 步上限。请缩小任务范围后重试。`,
          );
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
    if (parsedRequests.length) {
      const estimatedCostCents = parsedRequests.reduce(
        (total, request) => total + (request.estimatedCostCents ?? 0),
        0,
      );
      if (
        delegationConfig.maxCostCents > 0 &&
        estimatedCostCents > delegationConfig.maxCostCents
      ) {
        return completeTerminalDelegationFailure(
          item,
          `这个任务的预计执行成本为 ${estimatedCostCents} 美分，超过该代表设置的 ${delegationConfig.maxCostCents} 美分上限，系统未执行。请缩小任务范围。`,
        );
      }
      const computeReply = await processPublicWebComputeRequest({
        item,
        setup,
        parsed: parsedRequests[0]!,
        ...(planSteps ? { planSteps } : {}),
        ...(planSummary ? { planSummary } : {}),
        ...(delegationOverride ? { delegation: delegationOverride } : {}),
      });

      if (computeReply.approvalId) {
        const waiting = await waitGenerationRunForComputeApproval({
          runId: item.runId,
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
        runId: item.runId,
        replyText: computeReply.text,
        senderDisplayName: item.representativeName,
        intent: "compute",
        ...(computeReply.attachments?.length ? { attachments: computeReply.attachments } : {}),
        completeOutbox: false,
        ...(persistedRequest ? { countUsage: false } : {}),
        keepConversationQueued: computeReply.hasMoreSteps,
      });
      outputMessageId = completed.message.id;
      await markGenerationDeliveryComplete({
        runId: item.runId,
        outputMessageId,
      });
      return {
        processed: true as const,
        runId: item.runId,
        status: computeReply.hasMoreSteps ? "step_completed" as const : "completed" as const,
      };
    }

    const representative = buildRepresentativeRuntimeProfile(setup);
    const recentTurns = await loadGenerationRecentTurns({
      conversationId: item.conversationId,
      beforeMessageId: item.inputMessageId,
    });
    const plan = createConversationPlan({
      text: item.userText,
      channel: "private_chat",
      representative,
      usage: item.usage,
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
      if (generated.ok) {
        replyText = generated.replyText;
        runtime = {
          provider: generated.provider,
          model: generated.model,
          ...(generated.usage?.inputTokens !== undefined ? { inputTokens: generated.usage.inputTokens } : {}),
          ...(generated.usage?.outputTokens !== undefined ? { outputTokens: generated.usage.outputTokens } : {}),
          ...(generated.usage?.costCents !== undefined ? { costCents: generated.usage.costCents } : {}),
        };
      } else {
        replyText = renderGroundedKnowledgeFallback({
          userText: item.userText,
          recalled: recalled.items,
        }) ?? replyText;
      }
    }

    const completed = await completeInlineGenerationRun({
      runId: item.runId,
      replyText,
      senderDisplayName: item.representativeName,
      intent: plan.intent,
      completeOutbox: false,
      ...(citations.length ? { citations } : {}),
      ...runtime,
    });
    outputMessageId = completed.message.id;

    if (["collect_intake", "handoff", "ask_owner"].includes(plan.nextStep)) {
      const requestHandoff = plan.nextStep === "handoff" || plan.nextStep === "ask_owner";
      await ensureConversationLeadAndHandoff({
        conversationId: item.conversationId,
        reason: requestHandoff ? "AI requested human follow-up" : "Qualified conversation intent",
        summary: item.userText.slice(0, 600),
        kind: plan.intent,
        priority: requestHandoff ? 80 : 50,
        source: item.channel,
        requestHandoff,
      });
    }

    let externalMessageId: string | undefined;
    if (item.channel === "matrix") {
      if (!item.externalConversationId || !item.matrixSenderUserId) {
        throw new Error("Matrix room or representative virtual user is missing.");
      }
      externalMessageId = await sendMatrixRepresentativeMessage({
        config,
        roomId: item.externalConversationId,
        senderUserId: item.matrixSenderUserId,
        generationRunId: item.runId,
        text: replyText,
      });
    } else if (item.channel === "telegram") {
      throw new Error("Telegram generation delivery remains owned by the existing bot adapter.");
    }

    await markGenerationDeliveryComplete({
      runId: item.runId,
      outputMessageId,
      ...(externalMessageId ? { externalMessageId } : {}),
    });
    return { processed: true as const, runId: item.runId, status: "completed" as const };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Conversation processing failed.";
    const userFacingFailure = renderUserCorrectableDelegationFailure(errorMessage);
    if (!outputMessageId && userFacingFailure) {
      return completeTerminalDelegationFailure(item, userFacingFailure);
    }
    if (outputMessageId) {
      await retryGenerationDelivery({
        runId: item.runId,
        outputMessageId,
        errorMessage,
      });
    } else {
      await failGenerationRun({
        runId: item.runId,
        errorCode: "conversation_worker_failed",
        errorMessage,
      });
    }
    return { processed: true as const, runId: item.runId, status: "failed" as const, error: errorMessage };
  }
}

async function buildDelegationPlannerInput(input: {
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  taskInput: string;
}) {
  if (resolveDelegationConfig(input.setup).knowledgeScope !== "public_knowledge") {
    return input.taskInput;
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

  return publicKnowledge.length
    ? `${input.taskInput}\n\nOwner 已授权本任务使用以下已审核公开资料：\n${publicKnowledge.join("\n")}`
    : input.taskInput;
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

async function completeTerminalDelegationFailure(
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>,
  replyText: string,
) {
  if (item.delegationTaskId && item.delegationTaskStepId) {
    await finalizeComputeDelegationTask({
      taskId: item.delegationTaskId,
      stepId: item.delegationTaskStepId,
      generationRunId: item.runId,
      outcome: "failed",
      failureReason: replyText,
    });
  }
  const completed = await completeInlineGenerationRun({
    runId: item.runId,
    replyText,
    senderDisplayName: item.representativeName,
    intent: "delegation_failed",
    countUsage: false,
    completeOutbox: false,
  });
  await markGenerationDeliveryComplete({
    runId: item.runId,
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
  parsed: ParsedComputeRequest;
  planSummary?: string;
  planSteps?: Array<{ summary: string; request: ParsedComputeRequest }>;
  delegation?: { task: { id: string }; step: { id: string } };
}): Promise<{
  text: string;
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
  const delegationConfig = resolveDelegationConfig(input.setup);
  if (!input.setup.compute.enabled || !delegationConfig.enabled) {
    if (input.delegation) {
      await finalizeComputeDelegationTask({
        taskId: input.delegation.task.id,
        stepId: input.delegation.step.id,
        generationRunId: input.item.runId,
        outcome: "blocked",
        failureReason: "Delegated execution was disabled before this step could start.",
      });
    }
    return {
      text: input.setup.compute.enabled
        ? "这个代表当前不接受委托任务。"
        : "这个代表当前没有启用 Compute。请联系代表所有者在 Dashboard 中启用后再试。",
      hasMoreSteps: false,
    };
  }

  const capabilityMode = resolveCapabilityModes(input.setup)[input.parsed.capability];
  if (capabilityMode === "deny") {
    if (input.delegation) {
      await finalizeComputeDelegationTask({
        taskId: input.delegation.task.id,
        stepId: input.delegation.step.id,
        generationRunId: input.item.runId,
        outcome: "blocked",
        failureReason: `Representative policy denies ${input.parsed.capability}.`,
      });
    }
    return {
      text: `这个代表的能力策略禁止${renderCapabilityLabel(input.parsed.capability)}，系统未执行。`,
      hasMoreSteps: false,
    };
  }

  const subagent = resolveComputeSubagent(input.parsed.capability);
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
    networkMode: input.setup.compute.networkMode.toUpperCase() as "NO_NETWORK" | "ALLOWLIST" | "FULL",
    filesystemMode: input.setup.compute.filesystemMode.toUpperCase() as "WORKSPACE_ONLY" | "READ_ONLY_WORKSPACE" | "EPHEMERAL_FULL",
  });
  if (!delegation.step) throw new Error("Delegation task is missing its compute step.");

  let result: Awaited<ReturnType<typeof executeAudienceTool>>;
  try {
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id,
      contactId: input.item.contactId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      delegationTaskId: delegation.task.id,
      delegationTaskStepId: delegation.step.id,
      subagentId: subagent.id,
      requestedCapabilities: [input.parsed.capability],
      reason: `web:${input.parsed.capability}`,
      requestedBaseImage: input.setup.compute.baseImage,
    });
    await markDelegationTaskRunning(delegation.task.id, delegation.step.id);
    result = await executeAudienceTool(session.session.id, {
      ...input.parsed,
      subagentId: subagent.id,
      hasPaidEntitlement:
        input.parsed.hasPaidEntitlement ||
        input.item.usage.passUnlocked ||
        input.item.usage.deepHelpUnlocked,
    });
  } catch (error) {
    await finalizeComputeDelegationTask({
      taskId: delegation.task.id,
      stepId: delegation.step.id,
      generationRunId: input.item.runId,
      outcome: "failed",
      failureReason: error instanceof Error ? error.message : "Compute execution failed.",
    });
    throw error;
  }

  if (result.outcome === "pending_approval") {
    if (!result.approvalRequest) throw new Error("Compute approval response is missing.");
    await markDelegationTaskAwaitingApproval({
      taskId: delegation.task.id,
      stepId: delegation.step.id,
      approvalId: result.approvalRequest.id,
    });
    return {
      approvalId: result.approvalRequest.id,
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

  const finalization = await finalizeComputeDelegationTask({
    taskId: delegation.task.id,
    stepId: delegation.step.id,
    generationRunId: input.item.runId,
    outcome: result.outcome === "blocked"
      ? "blocked"
      : result.outcome === "failed"
        ? "failed"
        : "completed",
    artifacts: result.artifacts,
    ...(typeof billing === "number" ? { actualCredits: billing } : {}),
  });

  if (result.outcome === "blocked") {
    return { text: `委托任务被安全策略拒绝，未执行。${billingLine}`, hasMoreSteps: false };
  }
  if (result.outcome === "failed") {
    return {
      text: `委托任务已执行，但未能完成。\n\n${artifactSummary}${billingLine}`,
      hasMoreSteps: false,
      ...(attachments.length ? { attachments } : {}),
    };
  }
  return {
    text: finalization?.hasMoreSteps
      ? `委托任务当前步骤已完成，后续步骤已进入执行队列。\n\n${artifactSummary}${billingLine}`
      : `委托任务已在隔离沙盒中执行完成。\n\n${artifactSummary}${billingLine}`,
    hasMoreSteps: Boolean(finalization?.hasMoreSteps),
    ...(attachments.length ? { attachments } : {}),
  };
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
  chatId: string;
  operatorName: string;
  text: string;
}) {
  if (!input.config.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${input.config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: `${input.operatorName}: ${input.text}`,
    }),
  });
  const payload = (await response.json()) as { ok?: boolean; result?: { message_id?: number }; description?: string };
  if (!response.ok || !payload.ok || !payload.result?.message_id) {
    throw new Error(payload.description || `Telegram operator delivery failed (${response.status}).`);
  }
  return String(payload.result.message_id);
}
