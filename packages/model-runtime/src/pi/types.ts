import type {
  StreamFn
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";



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
  /** Bounded host-verified stdout or result summary; evidence data for the main model. */
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
     * Program/output recovery requires a terminal receipt from the isolated no-egress
     * Python profile, with no deliverable file published. */
    recovery?: { kind: "not_dispatched" | "isolated_output_rejected" | "isolated_program_failed"; reason: string };
  }>;
};

export type PiCapabilityAdapters = {
  knowledge?: PiKnowledgeAdapter;
  web?: PiWebAdapter;
  mcp?: PiMcpAdapter;
  skills?: PiSkillAdapter;
  sandbox?: PiSandboxAdapter;
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
