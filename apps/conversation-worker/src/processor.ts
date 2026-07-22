import {
  generateRepresentativeReply,
  planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallback,
} from "@delegate/model-runtime";
import {
  buildComputeRequestFromNaturalLanguagePlan,
  createConversationPlan,
  parseComputeDirective,
  renderReplyPreview,
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
  createAudienceComputeSession,
  deferGenerationRunForHuman,
  executeAudienceTool,
  ensureConversationLeadAndHandoff,
  failGenerationRun,
  getRepresentativeRuntimeSetupSnapshot,
  loadGenerationRecentTurns,
  markGenerationDeliveryComplete,
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

    const computeDirective = item.channel === "web"
      ? parseComputeDirective(item.userText)
      : { kind: "none" as const };
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

    let parsedCompute = computeDirective.kind === "request" ? computeDirective.request : null;
    if (
      !parsedCompute &&
      item.channel === "web" &&
      setup.compute.enabled &&
      shouldConsiderNaturalLanguageCompute(item.userText)
    ) {
      const planned = await planNaturalLanguageComputeRequest({ userText: item.userText });
      if (planned.ok && planned.plan) {
        parsedCompute = buildComputeRequestFromNaturalLanguagePlan(planned.plan);
      }
    }
    if (parsedCompute) {
      const computeReply = await processPublicWebComputeRequest({
        item,
        setup,
        parsed: parsedCompute,
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
      });
      outputMessageId = completed.message.id;
      await markGenerationDeliveryComplete({
        runId: item.runId,
        outputMessageId,
      });
      return { processed: true as const, runId: item.runId, status: "completed" as const };
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

async function processPublicWebComputeRequest(input: {
  item: NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  parsed: ParsedComputeRequest;
}): Promise<{
  text: string;
  approvalId?: string;
  attachments?: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
}> {
  if (!input.setup.compute.enabled) {
    return {
      text: "这个代表当前没有启用 Compute。请联系代表所有者在 Dashboard 中启用后再试。",
    };
  }

  const subagent = resolveComputeSubagent(input.parsed.capability);
  const session = await createAudienceComputeSession({
    representativeId: input.setup.id,
    contactId: input.item.contactId,
    conversationId: input.item.conversationId,
    generationRunId: input.item.runId,
    subagentId: subagent.id,
    requestedCapabilities: [input.parsed.capability],
    reason: `web:${input.parsed.capability}`,
    requestedBaseImage: input.setup.compute.baseImage,
  });
  const result = await executeAudienceTool(session.session.id, {
    ...input.parsed,
    subagentId: subagent.id,
    hasPaidEntitlement:
      input.parsed.hasPaidEntitlement ||
      input.item.usage.passUnlocked ||
      input.item.usage.deepHelpUnlocked,
  });

  if (result.outcome === "pending_approval") {
    if (!result.approvalRequest) throw new Error("Compute approval response is missing.");
    return {
      approvalId: result.approvalRequest.id,
      text: [
        `Compute 请求已提交，正在等待代表所有者审批。`,
        `操作：${result.approvalRequest.requestedActionSummary}`,
        `风险：${result.approvalRequest.riskSummary}`,
        "审批通过后会在此对话中自动返回执行结果。",
      ].join("\n\n"),
    };
  }

  const artifactSummary = result.artifacts.length
    ? result.artifacts
        .map((artifact) => `${artifact.kind}: ${artifact.summary ?? artifact.objectKey}`)
        .join("\n")
    : "没有生成可展示的结果文件。";
  const billing = result.billing?.actualCredits ?? result.billing?.estimatedCredits;
  const billingLine = typeof billing === "number" ? `\n\n消耗：${billing} credits` : "";
  const attachments = result.artifacts.map((artifact) => ({
    fileName: resolvePublicArtifactFileName(artifact, input.parsed),
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    artifactId: artifact.id,
    url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
  }));

  if (result.outcome === "blocked") {
    return { text: `Compute 请求被安全策略拒绝，未执行。${billingLine}` };
  }
  if (result.outcome === "failed") {
    return {
      text: `Compute 已执行，但任务失败。\n\n${artifactSummary}${billingLine}`,
      ...(attachments.length ? { attachments } : {}),
    };
  }
  return {
    text: `Compute 已在隔离沙盒中执行完成。\n\n${artifactSummary}${billingLine}`,
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
