import {
  createLifecycleHookBus,
  type LifecycleEvent,
} from "@delegate/lifecycle-hooks";

import {
  recordHandoffPrepared,
  recordModelContextAssembly,
  recordModelReplyCompleted,
} from "./runtime-store";

export const botLifecycleHooks = createLifecycleHookBus(
  [
    {
      name: "bot-audit-hooks",
      async onEvent(event: LifecycleEvent) {
        switch (event.kind) {
          case "model_context_assembled":
            await recordModelContextAssembly({
              context: buildBotContext(event.scope),
              ...(event.subagentId ? { subagentId: event.subagentId } : {}),
              provider: event.provider,
              model: event.model,
              estimatedInputTokens: event.estimatedInputTokens,
              segments: event.segments,
              selectedKnowledgeTitles: event.selectedKnowledgeTitles,
            });
            return;
          case "model_reply_completed":
            await recordModelReplyCompleted({
              context: buildBotContext(event.scope),
              ...(event.subagentId ? { subagentId: event.subagentId } : {}),
              provider: event.provider,
              model: event.model,
              success: event.success,
              ...(event.reason ? { reason: event.reason } : {}),
              ...(event.responseId ? { responseId: event.responseId } : {}),
              ...(typeof event.inputTokens === "number" ? { inputTokens: event.inputTokens } : {}),
              ...(typeof event.outputTokens === "number" ? { outputTokens: event.outputTokens } : {}),
              ...(typeof event.totalTokens === "number" ? { totalTokens: event.totalTokens } : {}),
              ...(typeof event.estimatedInputTokens === "number"
                ? { estimatedInputTokens: event.estimatedInputTokens }
                : {}),
            });
            return;
          case "handoff_prepared":
            await recordHandoffPrepared({
              context: buildBotContext(event.scope),
              ...(event.subagentId ? { subagentId: event.subagentId } : {}),
              intent: event.intent,
              disposition: event.disposition,
              summary: event.summary,
              ownerAction: event.ownerAction,
              priority: event.priority,
            });
            return;
          default:
            return;
        }
      },
    },
  ],
  {
    onError(error, event, handler) {
      console.warn(
        `Bot lifecycle hook "${handler.name ?? "anonymous"}" failed for ${event.kind}:`,
        error,
      );
    },
  },
);

function buildBotContext(scope: {
  representativeId: string;
  representativeSlug?: string;
  contactId?: string | null;
  conversationId?: string | null;
}) {
  if (!scope.contactId || !scope.conversationId || !scope.representativeSlug) {
    throw new Error("Bot lifecycle hooks require representativeSlug, contactId, and conversationId.");
  }

  return {
    representativeId: scope.representativeId,
    representativeSlug: scope.representativeSlug,
    contactId: scope.contactId,
    conversationId: scope.conversationId,
  } as const;
}
