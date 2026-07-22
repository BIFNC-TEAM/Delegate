import type { Representative } from "@delegate/domain";
import type { OpenVikingRecallItem } from "@delegate/openviking";
import type {
  ConversationPlan,
  NaturalLanguageDelegationPlan,
  ResolvedSubagentRoute,
  StructuredCollectorState,
} from "@delegate/runtime";
import type { ModelContextSegmentTrace } from "@delegate/lifecycle-hooks";

export type ModelProvider = "openai" | "bailian" | "anthropic";

export type ModelRuntimeState =
  | "ready"
  | "disabled"
  | "missing_credentials"
  | "unsupported_provider"
  | "invalid_subagent_route";

export type ModelPricingConfig = {
  inputCostUsdPerMillionTokens: number;
  outputCostUsdPerMillionTokens: number;
};

export type ModelRuntimeEnv = {
  enabled: boolean;
  provider: string;
  fallbackProvider?: string;
  state: ModelRuntimeState;
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  openai: {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    pricing: ModelPricingConfig;
  };
  bailian: {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    pricing: ModelPricingConfig;
  };
  anthropic: {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    pricing: ModelPricingConfig;
  };
};

export type ModelRuntimeRecentTurn = {
  direction: "inbound" | "outbound";
  messageText: string;
  intent?: string | null;
  summary?: string | null;
};

export type RepresentativeReplyInput = {
  representative: Representative;
  plan: ConversationPlan;
  subagent: ResolvedSubagentRoute;
  userText: string;
  recalled: OpenVikingRecallItem[];
  recentTurns: ModelRuntimeRecentTurn[];
  collectorState?: StructuredCollectorState | null;
};

export type RepresentativeReplyPrompt = {
  instructions: string;
  input: string;
};

export type RepresentativeReplyContextTrace = {
  estimatedInputTokens: number;
  segments: ModelContextSegmentTrace[];
  selectedKnowledgeTitles: string[];
  selectedRecallUris: string[];
};

export type ModelUsageSnapshot = {
  provider: ModelProvider;
  model: string;
  responseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costCents?: number;
  estimatedCostUsd?: number;
};

export type RepresentativeReplyResult =
  | {
      ok: true;
      replyText: string;
      provider: ModelProvider;
      model: string;
      contextTrace: RepresentativeReplyContextTrace;
      usage?: ModelUsageSnapshot;
    }
  | {
      ok: false;
      reason: string;
      state: ModelRuntimeState;
      contextTrace?: RepresentativeReplyContextTrace;
      provider?: string;
      model?: string;
    };

export type NaturalLanguageComputePlannerResult =
  | {
      ok: true;
      plan: NaturalLanguageDelegationPlan | null;
      source: "model" | "deterministic";
      provider?: ModelProvider;
      model?: string;
    }
  | {
      ok: false;
      reason: string;
      state: ModelRuntimeState;
    };
