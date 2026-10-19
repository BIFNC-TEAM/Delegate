import type {
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export const PI_RUNTIME_VERSION = "delegate-pi-runtime.1" as const;

export type PiRunStatus =
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "waiting_approval"
  | "waiting_user";

export type PiSpanStatus = "ok" | "error" | "timeout" | "cancelled";

export type PiModule =
  | "request"
  | "context"
  | "orchestration"
  | "model"
  | "knowledge"
  | "web"
  | "mcp"
  | "skill"
  | "sandbox"
  | "artifact"
  | "handoff"
  | "response"
  | "wait";

export type PiSpan = {
  traceId: string;
  runId: string;
  caseId?: string;
  spanId: string;
  parentSpanId?: string;
  module: PiModule;
  operation: string;
  purpose?: string;
  logicalCallId?: string;
  attempt: number;
  startOffsetMs: number;
  durationMs: number;
  selfDurationMs?: number;
  status: PiSpanStatus;
  queueMs?: number;
  retryBackoffMs?: number;
  provider?: string;
  model?: string;
  toolName?: string;
  skillId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHit?: boolean;
  coldStart?: boolean;
  resultRef?: string;
  error?: string;
};

export type PiRuntimeEvent = {
  type:
    | "request.accepted"
    | "model.started"
    | "model.first_event"
    | "response.delta"
    | "response.review_started"
    | "response.review_rejected"
    | "retrieval.completed"
    | "skill.discovered"
    | "skill.loaded"
    | "tool.started"
    | "tool.completed"
    | "tool.failed"
    | "sandbox.started"
    | "sandbox.completed"
    | "artifact.created"
    | "handoff.updated"
    | "run.completed"
    | "run.failed"
    | "run.cancelled";
  traceId: string;
  runId: string;
  atOffsetMs: number;
  spanId?: string;
  parentSpanId?: string;
  module?: PiModule;
  toolName?: string;
  status?: string;
  delta?: string;
  data?: Record<string, unknown>;
};

export type PiHistoryMessage = {
  messageId?: string;
  taskAnchor?: boolean;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
};

export type PiAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uri?: string;
};

export type PiSource = {
  id: string;
  title: string;
  channel: "knowledge" | "web" | "mcp";
  provider?: string;
  url?: string;
  dataTime?: string;
  observedAt?: string;
  version?: string;
};

export type PiArtifact = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url?: string;
  checksum?: string;
  /** Bounded, verified preview for text artifacts; never populated for binary files. */
  preview?: string;
  summary?: string;
};

export type PiCapabilityResult = {
  text: string;
  details?: Record<string, unknown>;
  sources?: PiSource[];
  artifacts?: PiArtifact[];
  resultRef?: string;
  contextSourceRef?: string;
  status?: string;
  /** Optional user-safe summary whose deterministic facts must not be rewritten by the model. */
  authoritativeSummary?: string;
  observation?: {
    state: "available" | "empty" | "blocked" | "unavailable" | "unknown";
    /** Host-classified result kind; not inferred from text, URLs or a model-selected tool name. */
    evidenceKind?: "search_results";
    reason?: string;
    httpStatus?: number;
    observedAt?: string;
    sourceTime?: string;
    retryAfterMs?: number;
  };
};

export type PiToolObservation = {
  callId: string;
  toolName: string;
  status: string;
  text: string;
  argumentsHash?: string;
  contextSourceRef?: string;
  actionOrdinal?: number;
  sources: PiSource[];
  artifacts: PiArtifact[];
  observation?: PiCapabilityResult["observation"];
};

/** Product/task requirements; a model's assessment cannot clear these. */
export type PiEvidenceRequirements = {
  evidence?: boolean;
  sandbox?: boolean;
  browser?: boolean;
  artifact?: boolean;
  /** Unambiguous requested output targets, held by the host, not the reviewer. */
  outputFiles?: Array<{ format: string; fileName?: string }>;
};

export type PiExecutionCheckpoint = {
  version: 2;
  runId: string;
  sessionId: string;
  scopeHash: string;
  goal: string;
  messages: AgentMessage[];
  observations: PiToolObservation[];
  turnsUsed: number;
  activeMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  evidenceRequirements?: PiEvidenceRequirements;
  contextAuthorization?: import("@delegate/runtime").AgentContextProof;
  replaySourcesTracked?: boolean;
  actionIdentityVersion?: 1;
  nextActionOrdinal?: number;
  pending: { approvalId: string; callId: string; toolName: string };
};

export type PiToolContext = {
  traceId: string;
  runId: string;
  sessionId: string;
  representativeId?: string;
  representativeVersionId?: string;
  conversationId?: string;
  userId?: string;
  timezone: string;
  attachments: PiAttachment[];
  idempotencyKey: string;
  logicalAction?: { version: 1; ordinal: number };
};

export type PiKnowledgeAdapter = {
  retrieve(input: {
    query: string;
    maximumResults: number;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
};

export type PiWebAdapter = {
  /** Trusted host description of actual provider coverage/freshness, if known. */
  description?: string;
  search(input: {
    query: string;
    localDate?: string;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
};

export type PiMcpToolDescriptor = {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Trusted host classification; legacy adapters may omit it. */
  effectClassification?: "read" | "write" | "unknown";
  readOnly: boolean;
  idempotent: boolean;
  /** Host-verified permission metadata; absence is not permission to parallelize. */
  approvalRequired?: boolean;
};

export type PiMcpAdapter = {
  listTools(input: {
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiMcpToolDescriptor[]>;
  callTool(input: {
    server: string;
    tool: string;
    arguments: Record<string, unknown>;
    idempotencyKey: string;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
};

export type PiSkillDescriptor = {
  id: string;
  version: string;
  name: string;
  description: string;
};

export type PiSkillAdapter = {
  discover(input: {
    query: string;
    maximumResults: number;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiSkillDescriptor[]>;
  load(input: {
    id: string;
    version?: string;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<{
    descriptor: PiSkillDescriptor;
    instructions: string;
    instructionsDigest?: string;
    resources?: string[];
  }>;
};

export type PiSandboxAdapter = {
  /** Trusted host description of the actual execution/output contract. */
  executionDescription?: string;
  /** Uses the broker's managed browser, including its runtime launch settings. */
  browse?(input: {
    url: string;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
  execute(input: {
    language: "python" | "javascript" | "shell";
    code: string;
    attachmentIds: string[];
    expectedOutputs: string[];
    timeoutMs: number;
    context: PiToolContext;
    signal: AbortSignal;
    onProgress?: (message: string) => void;
  }): Promise<PiCapabilityResult & {
    /** Host-verified only: never infer from stdout or accept from remote MCP data.
     * output_rejected requires a terminal receipt from the isolated no-egress
     * Python profile, with no deliverable file published. */
    recovery?: { kind: "not_dispatched" | "isolated_output_rejected"; reason: string };
  }>;
};

export type PiArtifactAdapter = {
  register(input: {
    sandboxResultRef: string;
    paths: string[];
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
};

export type PiHandoffAdapter = {
  request(input: {
    reason: string;
    summary: string;
    priority?: number;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
  cancel?(input: {
    transferId?: string;
    queueId?: string;
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
};

export type PiCapabilityAdapters = {
  knowledge?: PiKnowledgeAdapter;
  web?: PiWebAdapter;
  mcp?: PiMcpAdapter;
  skills?: PiSkillAdapter;
  sandbox?: PiSandboxAdapter;
  artifacts?: PiArtifactAdapter;
  handoff?: PiHandoffAdapter;
};

export type PiAttachmentEvidenceRecovery = {
  skill: {
    id: string;
    version: string;
    instructionsDigest: string;
    resource: string;
  };
  execute(input: {
    context: PiToolContext;
    signal: AbortSignal;
  }): Promise<PiCapabilityResult>;
};

export type PiModelBinding = {
  model: Model<any>;
  streamFn: StreamFn;
  createObservedStreamFn?: ((observer: (event: PiModelAttemptEvent) => void, beforeRequest?: () => Promise<void>) => StreamFn) | undefined;
  provider: string;
  modelId: string;
};

export type PiModelAttemptEvent = {
  type: "start" | "end";
  logicalCallId: string;
  attempt: number;
  status?: "ok" | "error" | "cancelled";
  httpStatus?: number;
  error?: string;
  willRetry?: boolean;
};

export type PiAgentRunInput = {
  runId: string;
  sessionId: string;
  userText: string;
  representative: {
    id?: string;
    versionId?: string;
    name: string;
    /** The person or organization that authorized this public representative. */
    ownerName?: string;
    role: string;
    agentBehavior?: import("@delegate/domain").AgentBehavior;
    instructions?: string;
    capabilities?: string[];
  };
  audience?: {
    kind: "external_visitor" | "authenticated_visitor" | "owner" | "operator";
    displayName?: string;
    /** Relationship to the representative owner is unverified unless supplied by trusted product state. */
    relationshipToOwner?: "unverified" | "customer" | "partner" | "employee" | "owner" | "operator";
  };
  model: PiModelBinding;
  capabilities?: PiCapabilityAdapters;
  /** v1 only drains already-pending requests; new production requests use v2. */
  executionProtocol?: "legacy_v1" | "goal_v2";
  /** Host-selected review policy. bounded_v1 skips ordinary review and caps required review at one; earlier modes remain for compatibility. */
  reviewMode?: "always" | "simple_text_v1" | "selective_text_v2" | "bounded_v1";
  /** Trusted host requirement. Neither visitor text nor the generating model can clear it. */
  semanticReviewRequired?: boolean;
  /** Host prefetch through the normal authorized knowledge tool before first generation. */
  knowledgePrefetch?: "ordinary_questions_v1";
  checkpoint?: PiExecutionCheckpoint;
  contextAuthorization?: import("@delegate/runtime").AgentContextAuthorization;
  evidenceRequirements?: PiEvidenceRequirements;
  /**
   * Optional fail-closed recovery compiled from a server-trusted, immutable Skill
   * resource. It runs only after Pi ignores both bounded attachment corrections.
   */
  attachmentEvidenceRecovery?: PiAttachmentEvidenceRecovery;
  history?: PiHistoryMessage[];
  /** Authorized user context only, with a server-resolved conversational focus. */
  conversationContextMode?: "focused_v1";
  attachments?: PiAttachment[];
  /** Trusted product state for a tool that completed after owner approval. */
  approvedToolResult?: {
    approvalId: string;
    toolName: string;
    status: "completed" | "failed";
    text: string;
    contextSourceRef?: string;
    artifacts?: PiArtifact[];
    sources?: PiSource[];
    observation?: PiCapabilityResult["observation"];
  };
  conversationId?: string;
  userId?: string;
  timezone?: string;
  /** Server language fallback for identifiers with no linguistic signal/history. */
  responseLanguage?: string;
  /** Deterministic clock for regression/control tests; production omits it. */
  currentTime?: string;
  caseId?: string;
  maxSteps?: number;
  timeoutMs?: number;
  maxToolRetries?: number;
  signal?: AbortSignal;
  onEvent?: (event: PiRuntimeEvent) => void | Promise<void>;
};

export type PiAgentRunResult = {
  /** 0=current visitor request, n=history[n-1]. Never a permission grant. */
  conversationFocusIndex?: number;
  conversationTargetIndex?: number;
  runtime: typeof PI_RUNTIME_VERSION;
  traceId: string;
  runId: string;
  sessionId: string;
  status: PiRunStatus;
  text: string;
  messages: AgentMessage[];
  events: PiRuntimeEvent[];
  spans: PiSpan[];
  sources: PiSource[];
  artifacts: PiArtifact[];
  handoff?: { status: string; transferId?: string; queueId?: string };
  firstModelEventMs?: number;
  firstTextMs?: number;
  totalDurationMs: number;
  modelCalls: number;
  toolCalls: number;
  error?: string;
  checkpoint?: PiExecutionCheckpoint;
  contextAuthorizationBlocked?: true;
};

export type PiToolBuildResult = {
  tools: AgentTool<any>[];
  sources: PiSource[];
  artifacts: PiArtifact[];
  getHandoff: () => PiAgentRunResult["handoff"];
  getPendingApproval: () => boolean;
  getKnowledgeAttempts: () => number;
  getKnowledgeOutcome: () => "not_attempted" | "found" | "missing" | "unavailable";
  getCurrentInformationAttempts: () => number;
  getMcpWriteAttempts: () => number;
  getAuthoritativeSummary: () => string | undefined;
  getSandboxAttempts: () => number;
  getSandboxEvidenceResults: () => number;
  getSandboxConclusiveResults: () => number;
  getSandboxSuccesses: () => number;
  acceptSandboxRecoveryResult: (result: PiCapabilityResult) => boolean;
};
