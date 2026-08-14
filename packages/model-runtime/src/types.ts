import type { Representative } from "@delegate/domain";
import type { OpenVikingRecallItem } from "@delegate/openviking";
import type {
  ConversationPlan,
  NaturalLanguageDelegationPlan,
  ResolvedSubagentRoute,
  StructuredCollectorState,
} from "@delegate/runtime";
import type { ModelContextSegmentTrace } from "@delegate/lifecycle-hooks";

/**
 * Recall input accepted by the model runtime.
 *
 * `memoryUseItemId` is an opaque Postgres identifier used to correlate the
 * final prompt selection with the governed memory-use ledger. The identifier
 * is required at the type boundary and is never rendered into the model
 * prompt. Runtime validation still filters empty IDs fail closed.
 */
export type RepresentativeRecallItem = OpenVikingRecallItem & {
  memoryUseItemId: string;
  /** Server-classified source family used for subagent scope enforcement. */
  internalSource: {
    sourceKind:
      | "PUBLIC_KNOWLEDGE"
      | "CONTACT_MEMORY"
      | "REPRESENTATIVE_EXPERIENCE";
  };
};

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

export type RepresentativeReplyInput = {
  representative: Representative;
  plan: ConversationPlan;
  subagent: ResolvedSubagentRoute;
  userText: string;
  recalled: RepresentativeRecallItem[];
  recentTurns: ModelRuntimeRecentTurn[];
  collectorState?: StructuredCollectorState | null;
  operationalContext?: ConversationOperationalContext | null;
};

export type RepresentativeReplyPrompt = {
  instructions: string;
  input: string;
  responseFormat?: "json_object";
};

export type RepresentativeReplyContextTrace = {
  estimatedInputTokens: number;
  segments: ModelContextSegmentTrace[];
  selectedKnowledgeTitles: string[];
  /** Opaque ledger identifiers for only the sources included in the prompt. */
  selectedMemoryUseItemIds: string[];
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
      /** Opaque ledger IDs for sources the model explicitly cited in its reply. */
      citedMemoryUseItemIds: string[];
      provider: ModelProvider;
      model: string;
      contextTrace: RepresentativeReplyContextTrace;
      usage?: ModelUsageSnapshot;
    }
  | {
      ok: false;
      reason: string;
      state: ModelRuntimeState;
      /** Always empty when generation or citation parsing did not succeed. */
      citedMemoryUseItemIds: string[];
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
