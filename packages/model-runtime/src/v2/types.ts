import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { PiArtifact, PiCapabilityResult, PiModelBinding, PiRuntimeEvent, PiSource, PiSpan, PiToolContext } from "../pi/types";
import type { V2Budget } from "./config";

export type V2Tool = Omit<AgentTool<any>, "execute"> & {
  category: "knowledge" | "web" | "mcp" | "skill" | "sandbox" | "control";
  effect: "read" | "write" | "unknown";
  approvalRequired?: boolean;
  execute(callId: string, args: any, signal: AbortSignal, context: PiToolContext): Promise<PiCapabilityResult>;
};
export type V2Usage = { modelTurns: number; toolCalls: number; attempts: number; tokens: number; inputTokens: number; outputTokens: number; costUsd: number; activeMs: number };
export const emptyV2Usage = (): V2Usage => ({ modelTurns: 0, toolCalls: 0, attempts: 0, tokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, activeMs: 0 });
export type V2Session = {
  version: 1;
  scope: string;
  taskId: string;
  status: "waiting_user";
  /** Only user messages + the clarification, never tool bodies or hidden reasoning. */
  messages: AgentMessage[];
  usage: V2Usage;
  /** No result content. Prevents accidental repeat effects across a clarification. */
  attemptedWrites: string[];
};
export type V2TraceCall = {
  requestId: string; traceId: string; toolCallId: string; toolName: string; category: string;
  argumentCount: number; startedAt: string; durationMs: number; attempts: number;
  status: "ok" | "error" | "cancelled" | "timeout" | "blocked"; error?: string;
  sourceIds: string[]; outputBytes: number;
};
export type V2RunInput = {
  requestId: string; sessionId: string; scope: string; userText: string; timezone: string;
  currentTime?: string; instructions?: string; model: PiModelBinding; tools: V2Tool[];
  context: PiToolContext; budget?: Partial<V2Budget>; session?: V2Session;
  history?: AgentMessage[]; signal?: AbortSignal;
  /** Required host gate; rechecked before each model/tool/result/release boundary. */
  authorize(boundary: "model" | "tool" | "tool_result" | "release", tool?: V2Tool, args?: unknown): Promise<void>;
  /** Host-supplied task store. Save must succeed before exposing a clarification. */
  saveSession?(session: V2Session): Promise<void>;
  onEvent?(event: PiRuntimeEvent): Promise<void> | void;
};
export type V2RunResult = {
  runtime: "delegate-agent-v2"; requestId: string; traceId: string;
  status: "completed" | "partial" | "waiting_user" | "failed" | "cancelled";
  text: string; sources: PiSource[]; artifacts: PiArtifact[]; invalidCitations: string[];
  /** Host-only ledger mapping; omit from public API/telemetry. */
  sourceBindings: Record<string, string>;
  modelCalls: number; toolCalls: number; totalDurationMs: number; firstTextMs?: number;
  usage: V2Usage; taskUsage: V2Usage; session?: V2Session;
  /** Costs use configured provider prices; false means zero is not a price claim. */
  costAvailable: boolean;
  events: PiRuntimeEvent[]; spans: PiSpan[]; calls: V2TraceCall[]; error?: string;
};
export class V2Error extends Error {
  constructor(readonly code: "permission_denied" | "unavailable" | "invalid_result" | "empty_result" | "transient" | "timeout" | "cancelled" | "budget_exhausted" | "no_progress" | "unknown_effect" | "context_limit" | "session_scope_mismatch") { super(code); }
}
