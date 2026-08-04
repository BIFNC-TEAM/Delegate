export type LifecycleScope = {
  representativeId: string;
  representativeSlug?: string;
  contactId?: string | null;
  conversationId?: string | null;
};

export type ModelContextSegmentTrace = {
  kind: string;
  priority: number;
  estimatedTokens: number;
  included: boolean;
  itemCount?: number;
  trimReason?: string;
};

export type ModelContextAssembledEvent = {
  kind: "model_context_assembled";
  scope: LifecycleScope;
  subagentId?: string;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  segments: ModelContextSegmentTrace[];
  selectedKnowledgeTitles: string[];
  selectedMemoryUseItemIds: string[];
};

export type ModelReplyCompletedEvent = {
  kind: "model_reply_completed";
  scope: LifecycleScope;
  subagentId?: string;
  provider: string;
  model: string;
  success: boolean;
  reason?: string;
  responseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedInputTokens?: number;
};

export type HandoffPreparedEvent = {
  kind: "handoff_prepared";
  scope: LifecycleScope;
  subagentId?: string;
  intent: string;
  nextStep: string;
  priority: number;
  summary: string;
  ownerAction: string;
};

export type ToolPreflightEvent = {
  kind: "tool_preflight";
  scope: LifecycleScope;
  sessionId: string;
  subagentId?: string;
  capability: string;
  decision: "allow" | "ask" | "deny";
  reason: string;
  requestedCommand?: string;
  requestedPath?: string;
  workingDirectory?: string;
  estimatedCredits?: number;
  transport?: string;
  bindingId?: string;
  remoteUrl?: string;
};

export type ToolCompletedEvent = {
  kind: "tool_completed";
  scope: LifecycleScope;
  sessionId: string;
  executionId: string;
  subagentId?: string;
  capability: string;
  exitCode: number;
  wallMs: number;
  artifactCount: number;
  actualCredits?: number;
  transport?: string;
  bindingId?: string;
  remoteUrl?: string;
};

export type SessionEndedEvent = {
  kind: "session_ended";
  scope: LifecycleScope;
  sessionId: string;
  finalStatus: string;
  reason: string;
};

export type LifecycleEvent =
  | ModelContextAssembledEvent
  | ModelReplyCompletedEvent
  | HandoffPreparedEvent
  | ToolPreflightEvent
  | ToolCompletedEvent
  | SessionEndedEvent;

export type LifecycleHookHandler = {
  name?: string;
  onEvent(event: LifecycleEvent): Promise<void> | void;
};

export type LifecycleHookBus = {
  emit(event: LifecycleEvent): Promise<void>;
};

export function createLifecycleHookBus(
  handlers: LifecycleHookHandler[],
  options?: {
    onError?: (error: unknown, event: LifecycleEvent, handler: LifecycleHookHandler) => void;
  },
): LifecycleHookBus {
  return {
    async emit(event) {
      for (const handler of handlers) {
        try {
          await handler.onEvent(event);
        } catch (error) {
          options?.onError?.(error, event, handler);
        }
      }
    },
  };
}
