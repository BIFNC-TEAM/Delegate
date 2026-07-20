import {
  generateRepresentativeReply,
  renderGroundedKnowledgeFallback,
} from "@delegate/model-runtime";
import {
  createConversationPlan,
  renderReplyPreview,
  resolveConversationSubagent,
} from "@delegate/runtime";
import {
  buildRepresentativeRuntimeProfile,
  claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem,
  completeOperatorMessageDelivery,
  completeInlineGenerationRun,
  deferGenerationRunForHuman,
  ensureConversationLeadAndHandoff,
  failGenerationRun,
  getRepresentativeRuntimeSetupSnapshot,
  loadGenerationRecentTurns,
  markGenerationDeliveryComplete,
  recallRepresentativeContext,
  retryGenerationDelivery,
  retryOperatorMessageDelivery,
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
