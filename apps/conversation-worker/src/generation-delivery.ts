import {
  GenerationMemoryDeliveryBlockedError,
  GenerationPlanDeliverySupersededError,
  admitGenerationMessageProviderDelivery,
  assertConversationChannelDeliveryAvailable,
  hasPersistedTelegramBotConnections,
  isDeterministicContactMemoryDeleteCommand,
  markGenerationDeliveryComplete,
  prepareGenerationMessageChannelDelivery,
  privateChannelSourceVerificationUnavailableStatement,
  recordGenerationMessageProviderAcceptance,
  renderPrivateChannelGenerationDeliveryText,
  resolveTelegramBotRuntimeCredential,
  withActiveTelegramRepresentativeChannelFence,
  withGenerationMessageProviderDeliveryFence,
  type GenerationMessageDeliveryAdmission
} from "@delegate/web-data";

import type { ConversationWorkerConfig } from "./config";

import { sendMatrixRepresentativeMessage } from "./matrix-outbound";

import type { GenerationItem } from "./generation-lease";
export async function deliverGenerationOutput(input: {
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
  if((input.item.channel === "matrix" || input.item.channel === "telegram") && !isMemoryDeleteConfirmation) {
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
  if(input.item.channel === "matrix" || input.item.channel === "telegram") {
    await admitGenerationMessageProviderDelivery({
      conversationId: input.item.conversationId,
      ...providerDeliveryFence,
    });
  }
  if(input.item.channel === "matrix") {
    if(!input.item.externalConversationId || !input.item.matrixSenderUserId || !input.item.matrixEndpointLifecycleRevision) {
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
  } else if(input.item.channel === "telegram") {
    if(!input.item.externalConversationId) throw new Error("Telegram chat binding is missing.");
    externalMessageId = await sendTelegramMessage({
      config: input.config,
      conversationId: input.item.conversationId,
      chatId: input.item.externalConversationId,
      ...(input.item.telegramConnectionId ? { connectionId: input.item.telegramConnectionId } : {}),
      generationDelivery: providerDeliveryFence,
      text: deliveryText,
    });
  }
  if(externalMessageId) {
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
  } catch(error) {
    if(externalMessageId) throw new ProviderAcceptancePendingCommitError(error);
    throw error;
  }
  return externalMessageId;
}

export async function sendTelegramMessage(input: {
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
  if(input.config.telegramConversationPlatformMode !== "worker") {
    throw new Error("Telegram conversation worker is not the active delivery owner.");
  }
  const connectionId = input.connectionId?.trim();
  if(!connectionId) throw new Error("Telegram Bot connection is missing for this conversation.");
  const fenced = await withActiveTelegramRepresentativeChannelFence({
    conversationId: input.conversationId,
    expectedConnectionId: connectionId,
  }, async (tx) => {
    const credential = await resolveTelegramBotRuntimeCredential({ connectionId });
    const hasPersistedConnections = credential ? true : await hasPersistedTelegramBotConnections();
    const token = credential?.token || (!hasPersistedConnections ? input.config.telegramBotToken : undefined);
    if(!token) throw new Error("Telegram Bot credential is unavailable for this conversation.");
    const tokenBotId = token.match(/^([1-9]\d*):/)?.[1];
    const expectedBotId = credential?.botId || connectionId;
    if(!tokenBotId || (expectedBotId && tokenBotId !== expectedBotId)) {
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
      } catch(error) {
        throw new TelegramProviderOutcomeUnknownError(error);
      }
      let payload: { ok?: boolean; result?: { message_id?: number }; description?: string };
      try {
        payload = await response.json() as typeof payload;
      } catch(error) {
        if(response.ok) throw new TelegramProviderOutcomeUnknownError(error);
        throw new Error(`Telegram delivery failed with an unreadable provider response (${response.status}).`);
      }
      if(!response.ok || !payload.ok) {
        throw new Error(payload.description || `Telegram delivery failed (${response.status}).`);
      }
      if(!payload.result?.message_id) {
        throw new TelegramProviderOutcomeUnknownError(
          new Error("Telegram accepted the request without returning a message id."),
        );
      }
      return String(payload.result.message_id);
    };
    if(!input.generationDelivery) return { executed: true as const, value: await send() };
    return withGenerationMessageProviderDeliveryFence(tx, {
      conversationId: input.conversationId,
      ...input.generationDelivery,
    }, send);
  });
  if(!fenced.executed) throw new Error("Telegram channel assignment changed before outbound delivery.");
  const providerDelivery = fenced.value;
  if(!providerDelivery.executed) {
    if(providerDelivery.reason === "turn_plan_superseded_before_delivery") {
      throw new GenerationPlanDeliverySupersededError();
    }
    throw new GenerationMemoryDeliveryBlockedError();
  }
  return providerDelivery.value;
}

export function isRecoverableOperatorPause(error: unknown): error is Error & {
  code: "channel_paused" | "representative_paused" | "policy_disabled";
} {
  if(!error || typeof error !== "object") return false;
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

export function isProviderAcceptancePendingCommit(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "provider_acceptance_pending_commit");
}

export function buildProviderOutcomeUnknownRetry(error: unknown): Record<string, never> | {
  providerOutcomeUnknown: true;
  providerOutcomeCode: "telegram_provider_outcome_unknown" | "matrix_provider_outcome_unknown";
} {
  if(!error || typeof error !== "object" || !("code" in error)) return {};
  if(error.code !== "telegram_provider_outcome_unknown" && error.code !== "matrix_provider_outcome_unknown") return {};
  return { providerOutcomeUnknown: true, providerOutcomeCode: error.code };
}

export function isConversationHumanControlError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "CONVERSATION_HUMAN_ACTIVE");
}
