
export type ModelProvider = "agicto" | "openai" | "bailian" | "anthropic";

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
  documentTimeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  documentMaxOutputTokens: number;
  documentMaxParts: number;
  agicto: {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    pricing: ModelPricingConfig;
  };
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

export type ModelTextCompletion = {
  status: "complete" | "incomplete";
  reason?: string;
};

export type ModelRuntimeRecentTurn = {
  direction: "inbound" | "outbound";
  messageText: string;
  intent?: string | null;
  summary?: string | null;
};

/**
 * Minimal, audience-safe operational state available to the reply model.
 * Identifiers, private notes, raw approval payloads, and tool arguments are
 * deliberately excluded from this boundary.
 */
export type ConversationOperationalContext = {
  conversationState: string;
  activeCollector?: {
    kind: string;
    intent: string;
    stepIndex: number;
  };
  latestTask?: {
    kind: string;
    status: string;
    nextActionBy: string;
  };
  pendingApproval?: {
    requestedActionSummary: string;
    expiresAt?: string;
  };
  activeHandoff?: {
    status: string;
  };
  serviceEntitlement?: {
    available: boolean;
    remainingUnits: number;
  };
};

export type RepresentativeReplyPrompt = {
  instructions: string;
  input: string;
  responseFormat?: "json_object";
  strictJsonSchema?: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
  };
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
