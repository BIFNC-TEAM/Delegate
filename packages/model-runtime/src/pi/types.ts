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
  status?: string;
  /** Optional user-safe summary whose deterministic facts must not be rewritten by the model. */
  authoritativeSummary?: string;
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
  readOnly: boolean;
  idempotent: boolean;
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
  execute(input: {
    language: "python" | "javascript" | "shell";
    code: string;
    attachmentIds: string[];
    expectedOutputs: string[];
    timeoutMs: number;
    context: PiToolContext;
    signal: AbortSignal;
    onProgress?: (message: string) => void;
  }): Promise<PiCapabilityResult>;
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
  createObservedStreamFn?: ((observer: (event: PiModelAttemptEvent) => void) => StreamFn) | undefined;
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
  /**
   * Optional fail-closed recovery compiled from a server-trusted, immutable Skill
   * resource. It runs only after Pi ignores both bounded attachment corrections.
   */
  attachmentEvidenceRecovery?: PiAttachmentEvidenceRecovery;
  history?: PiHistoryMessage[];
  attachments?: PiAttachment[];
  /** Trusted product state for a tool that completed after owner approval. */
  approvedToolResult?: {
    approvalId: string;
    toolName: string;
    status: "completed";
    text: string;
    artifacts?: PiArtifact[];
  };
  conversationId?: string;
  userId?: string;
  timezone?: string;
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
};

export type PiToolBuildResult = {
  tools: AgentTool<any>[];
  sources: PiSource[];
  artifacts: PiArtifact[];
  getHandoff: () => PiAgentRunResult["handoff"];
  getPendingApproval: () => boolean;
  getKnowledgeAttempts: () => number;
  getMcpWriteAttempts: () => number;
  getAuthoritativeSummary: () => string | undefined;
  getSandboxAttempts: () => number;
  getSandboxEvidenceResults: () => number;
  getSandboxConclusiveResults: () => number;
  getSandboxSuccesses: () => number;
  acceptSandboxRecoveryResult: (result: PiCapabilityResult) => boolean;
};
