import { localTraceEvent } from "@delegate/runtime/local-trace";
import { setMaxListeners } from "node:events";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";

const MIN_OUTPUT_TOKENS = 1024;
import { auditReference, summarizeAuditArguments } from "@delegate/runtime";
import { PiTelemetry } from "../pi/telemetry";
import type { PiArtifact, PiCapabilityResult, PiSource } from "../pi/types";
import { PI_THINKING_ANSWER_RESERVE_TOKENS, v2BudgetSchema } from "./config";
import { bounded, byteLength, fingerprint, safeError, Semaphore, truncateUtf8 } from "./guards";
import { V2_REFERENCE_SYSTEM_PROMPT, V2_SYSTEM_PROMPT } from "./prompt";
import { CITATION_FAILURE_TEXT, parseReferences, readCitationAnswer, type CitationDiagnostics, type CitationParseResult } from "./citations";
import { emptyV2Usage, V2Error, V2RecoverableToolError, type V2RunInput, type V2RunResult, type V2Session, type V2Tool, type V2TraceCall } from "./types";

export class DelegateAgentV2 {
  private readonly active = new Map<string, AbortController>();
  cancel(sessionId: string): boolean { const active = this.active.get(sessionId); active?.abort(new V2Error("cancelled")); return !!active; }

  async run(input: V2RunInput): Promise<V2RunResult> {
    if (this.active.has(input.sessionId)) throw new Error("v2_session_busy");
    if (!input.userText.trim()) throw new Error("v2_empty_input");
    if (input.session && (input.session.version !== 1 || input.session.scope !== input.scope)) throw new V2Error("session_scope_mismatch");
    if (input.session && (Object.keys(emptyV2Usage()).some(key => {
      const value = input.session!.usage[key as keyof typeof input.session.usage];
      return !Number.isFinite(value) || value < 0;
    }) || input.session.messages.length > 64 || input.session.attemptedWrites.length > 100
      || input.session.attemptedWrites.some(value => !/^[a-f0-9]{64}$/.test(value)))) throw new Error("v2_invalid_session");
    const budget = v2BudgetSchema.parse(input.budget ?? {});
    localTraceEvent("runtime.started", { requestId: input.requestId, userText: input.userText, history: input.history, session: input.session, budget });
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(); // Fail closed on invalid timezones.
    const now = input.currentTime ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(now))) throw new Error("v2_invalid_time");
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    setMaxListeners(0, signal);
    this.active.set(input.sessionId, controller);
    const timer = setTimeout(() => controller.abort(new V2Error("timeout")), budget.activeMs);
    const usage = emptyV2Usage();
    const prior = input.session?.usage ?? emptyV2Usage();
    const totals = () => Object.fromEntries(Object.keys(usage).map(k => [k, usage[k as keyof typeof usage] + prior[k as keyof typeof usage]])) as typeof usage;
    const startedAt = performance.now();
    const telemetry = new PiTelemetry({ runId: input.requestId, ...(input.onEvent ? { onEvent: async event => {
      if (signal.aborted) return;
      const eventSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(budget.activeMs - (performance.now() - startedAt))))]);
      // Presentation/log transport failures must not restart a business effect.
      await bounded(() => Promise.resolve(input.onEvent!(event)), eventSignal).catch(() => undefined);
    } } : {}) });
    const sources = new Map<string, PiSource>();
    const sourceBindings: Record<string, string> = {};
    const artifacts = new Map<string, PiArtifact>();
    const calls: V2TraceCall[] = [];
    const callRecords = new Map<string, { trace: V2TraceCall; span: string; start: number }>();
    const attempts = new Map<string, number>();
    const ordinals = new Map<string, number>();
    const repeated = new Map<string, { output: string; count: number }>();
    const writes = new Set(input.session?.attemptedWrites ?? []);
    const semaphore = new Semaphore(budget.concurrency);
    const registry = new Map<string, V2Tool>();
    const exposed = new Set<string>();
    let clarification: string | undefined;
    let stopped: string | undefined;
    let modelSpan: string | undefined;
    let modelInputCeiling = 0;
    let finalMode = false;
    let emptyTruncationFinalization = false;
    let hostFeedbackUsed = false;
    const referenceProtocol = !!input.citationSourceNumber;
    let citationRecoveryUsed = false;
    let recoveringClarification = false;
    let recoveryToolAttempted = false;
    let citationResult: CitationParseResult | undefined;
    const citationDiagnostics: CitationDiagnostics = { status: "not_cited", recoveryCount: 0, firstErrors: [], finalErrors: [], recovery: "not_needed" };
    let declaredCitationState: "completed" | "partial" | "waiting_user" = "completed";
    const inspectCitationDraft = (raw: string) => { const parsed = parseReferences(readCitationAnswer(raw).text, new Set(sources.keys())); localTraceEvent("citation.inspected", { parsed, legalSources: [...sources.keys()] }); return parsed; };
    let firstTextMs: number | undefined;
    let answer = "";
    let finishReason: string | undefined;
    let session: V2Session | undefined;
    let status: V2RunResult["status"] = "failed";
    let settled = false;
    const remainingMs = () => Math.max(0, budget.activeMs - telemetry.offset());
    const budgetSummary = () => ({ activeMs: Math.round(remainingMs()), modelTurns: budget.modelTurns - totals().modelTurns,
      toolCalls: budget.toolCalls - totals().toolCalls, attempts: budget.attempts - totals().attempts,
      tokens: budget.totalTokens - totals().tokens, finalAnswerOnly: finalMode || citationRecoveryUsed });
    const hostPrompt = () => `${referenceProtocol ? V2_REFERENCE_SYSTEM_PROMPT : V2_SYSTEM_PROMPT}\n\nTrusted host context:\n${JSON.stringify({ currentTime: now, timezone: input.timezone,
      timezonePurpose: "date_interpretation_only_not_user_location",
      authorizedUserLocation: input.authorizedUserLocation ?? null,
      activeTask: input.session ? { status: "waiting_user" } : null,
      completedToolResultsThisRequest: calls.filter(call => call.attempts > 0).map(call => ({ tool: call.toolName, status: call.status, sourceCount: call.sourceIds.length })),
      attachments: input.context.attachments, remainingBudget: budgetSummary() })}\n${input.instructions ?? ""}`;
    const authorize = async (boundary: Parameters<V2RunInput["authorize"]>[0], tool?: V2Tool, args?: unknown) => {
      try { localTraceEvent("authorization.started", { boundary, tool: tool?.name }); await bounded(() => input.authorize(boundary, tool, args), signal); localTraceEvent("authorization.passed", { boundary, tool: tool?.name }); }
      catch (error) { localTraceEvent("authorization.failed", { boundary, tool: tool?.name, error }); if (signal.aborted) throw error; stopped = "permission_denied"; throw new V2Error("permission_denied"); }
    };
    const wrap = (tool: V2Tool): AgentTool<any> => ({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      executionMode: tool.effect === "read" ? "parallel" : "sequential",
      replay: tool.effect === "read" ? "safe" : "never",
      execute: async (callId, args) => semaphore.run(signal, async () => {
        if (clarification || stopped || citationRecoveryUsed) throw new V2Error(stopped === "permission_denied" ? "permission_denied" : "budget_exhausted");
        if (tool.effect === "unknown") throw new V2Error("permission_denied");
        const key = fingerprint([tool.name, args]);
        if (tool.effect === "write" && writes.has(key)) throw new V2Error("unknown_effect");
        if ((repeated.get(key)?.count ?? 0) >= 2) throw new V2Error("no_progress");
        await authorize("tool", tool, args);
        const deadline = Math.min(budget.toolTimeoutMs, remainingMs() - budget.finalReserveMs);
        if (deadline <= 0 || finalMode) throw new V2Error("budget_exhausted");
        const local = new AbortController();
        const active = AbortSignal.any([signal, local.signal]);
        const timeout = setTimeout(() => local.abort(new V2Error("timeout")), deadline);
        // Stable for infrastructure retries; writes are never retried here.
        const context = { ...input.context, traceId: telemetry.traceId,
          idempotencyKey: fingerprint([input.scope, input.session?.taskId ?? input.requestId, ordinals.get(callId)]),
          logicalAction: { version: 1 as const, ordinal: ordinals.get(callId)! } };
        try {
          for (let attempt = 0; ; attempt++) {
            active.throwIfAborted();
            if (totals().attempts >= budget.attempts - 1) throw new V2Error("budget_exhausted");
            usage.attempts++;
            attempts.set(callId, (attempts.get(callId) ?? 0) + 1);
            if (tool.effect === "write") writes.add(key);
            try {
              localTraceEvent("tool.attempt_started", { callId, name: tool.name, args, attempt: attempt + 1, usage: totals(), remaining: budgetSummary() });
              const result = await bounded(() => tool.execute(callId, args, active, context), active);
              localTraceEvent("tool.raw_result", { callId, name: tool.name, attempt: attempt + 1, result });
              active.throwIfAborted();
              await authorize("tool_result", tool, args);
              if (tool.category === "knowledge" && result.status === "found" && !result.sources?.length) throw new V2Error("invalid_result");
              const normalized = await bounded(() => normalizeResult(result, budget.toolOutputBytes, input.scope, sources, artifacts, sourceBindings, tool.effect, active, input.citationSourceNumber), active);
              localTraceEvent("tool.normalized_result", { callId, name: tool.name, normalized });
              const outputHash = fingerprint(normalized);
              const previous = repeated.get(key);
              repeated.set(key, { output: outputHash, count: previous?.output === outputHash ? previous.count + 1 : 1 });
              if (tool.category === "knowledge") await telemetry.event({ type: "retrieval.completed", module: "knowledge", status: result.status ?? "completed", data: { sourceCount: normalized.sources.length } });
              const record = callRecords.get(callId)?.trace;
              if (record) { record.sourceIds = normalized.sources.map(s => auditReference(s.id)); record.outputBytes = byteLength(normalized); }
              return { content: [{ type: "text" as const, text: JSON.stringify(normalized) }], details: { sourceCount: normalized.sources.length } };
            } catch (error) {
              localTraceEvent("tool.attempt_failed", { callId, name: tool.name, attempt: attempt + 1, error });
              if (tool.effect === "write") {
                if (error instanceof V2RecoverableToolError && error.disposition !== "read_failed") writes.delete(key);
                else stopped = "unknown_effect";
              }
              if (tool.effect !== "read" || !(error instanceof V2Error) || error.code !== "transient" || attempt >= budget.readRetries) throw error;
              // Retry only a host-classified transient failure. All attempts share the deadline/budget.
            }
          }
        } finally { clearTimeout(timeout); }
      }).catch(error => {
        localTraceEvent("tool.rejected", { callId, name: tool.name, error });
        const code = signal.aborted ? signal.reason instanceof V2Error ? signal.reason.code : "cancelled" : error instanceof V2Error ? error.code : "unavailable";
        if (code === "permission_denied") stopped = code;
        if (code !== "no_progress") {
          const key = fingerprint([tool.name, args]);
          const previous = repeated.get(key);
          const output = `error:${code}`;
          repeated.set(key, { output, count: previous?.output === output ? previous.count + 1 : 1 });
        }
        if (error instanceof V2RecoverableToolError && !signal.aborted
          && (error.disposition !== "read_failed" || tool.effect === "read")) {
          const feedback = JSON.stringify({ status: "failed", error: code, reason: error.reason,
            executionState: error.disposition, correctionAllowed: true,
            message: truncateUtf8(error.feedback, Math.max(0, budget.toolOutputBytes - 256)) });
          const record = callRecords.get(callId)?.trace;
          if (record) { record.error = error.reason; record.outputBytes = byteLength(feedback); }
          // PI turns thrown errors into real error tool results for the next
          // normal model step. No automatic write retry or verifier is added.
          throw new Error(feedback);
        }
        throw new V2Error(code);
      }),
    });
    const control: V2Tool = {
      name: "request_clarification", label: "补充信息", category: "control", effect: "read",
      description: "Pause only for essential missing parameters that an existing authorized capability can actually use. Do not request personal identifiers or credentials for unavailable systems or merely because document retrieval missed; explain that evidence/capability limit with <partial> instead. Ask necessary questions together. No external side effects. Returns waiting_user; the user's next message resumes this task with its cumulative budget. Call alone; do not combine with business execution.",
      parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 2000 }) }),
      execute: async (_id, args) => { clarification = args.question; return { text: "waiting_user", status: "waiting_user" }; },
    };
    const all = [...input.tools, control];
    if (input.tools.some(t => t.name === "discover_tools")) {
      clearTimeout(timer); this.active.delete(input.sessionId); throw new Error("v2_reserved_tool_name");
    }
    for (const tool of all) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || registry.has(tool.name)) {
        clearTimeout(timer); this.active.delete(input.sessionId); throw new Error("v2_invalid_tool_registry");
      }
      registry.set(tool.name, tool);
    }
    if (input.tools.length <= budget.directTools) all.forEach(t => exposed.add(t.name));
    else {
      all.filter(t => t.category === "knowledge" || t.category === "control").forEach(t => exposed.add(t.name));
      registry.set("discover_tools", {
        name: "discover_tools", label: "发现工具", category: "control", effect: "read",
        description: "Find authorized tools by a short capability query. Returns enabled concrete names and pagination; their complete definitions become available next turn. Discovery is metadata, not evidence or execution. Use offset to inspect another page.",
        parameters: Type.Object({ query: Type.String({ maxLength: 500 }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 512 })) }),
        execute: async (_id, args) => {
          const terms = String(args.query).toLowerCase().split(/\s+/u).filter(Boolean);
          const ranked = input.tools.map(tool => ({ tool, score: terms.filter(q => `${tool.name} ${tool.description}`.toLowerCase().includes(q)).length })).sort((a, b) => b.score - a.score);
          const selected = ranked.slice(args.offset ?? 0, (args.offset ?? 0) + 4);
          // Keep only the current discovery page plus core knowledge/control tools.
          for (const name of exposed) if (!["knowledge", "control"].includes(registry.get(name)!.category)) exposed.delete(name);
          for (const { tool } of selected) exposed.add(tool.name);
          return { text: JSON.stringify({ enabledToolNames: selected.map(({ tool }) => tool.name), total: ranked.length,
            nextOffset: (args.offset ?? 0) + selected.length < ranked.length ? (args.offset ?? 0) + selected.length : null }) };
        },
      }); exposed.add("discover_tools");
    }
    const selectedTools = () => [...exposed].map(name => wrap(registry.get(name)!));
    const history = input.session?.messages ?? input.history ?? [];
    let agent: Agent | undefined;
    const abort = () => agent?.abort();
    try {
      await telemetry.event({ type: "request.accepted", module: "request" });
      const baseStream = input.model.streamFn;
      agent = new Agent({
        initialState: { systemPrompt: hostPrompt(), model: input.model.model, tools: selectedTools(), messages: history,
          thinkingLevel: input.model.model.reasoning && budget.thinkingTokens > 0 ? "low" : "off" },
        thinkingBudgets: { low: budget.thinkingTokens },
        sessionId: fingerprint([input.scope, input.sessionId]), toolExecution: "parallel",
        prepareNextTurnWithContext: ({ context }) => ({ context: { ...context, tools: citationRecoveryUsed ? [] : selectedTools(), systemPrompt: hostPrompt() } }),
        streamFn: async (model, context, options) => {
          localTraceEvent("model.preflight", { nextTurn: totals().modelTurns + 1, usage: totals(), remaining: budgetSummary(), citationRecoveryUsed });
          try {
            await authorize("model");
            if (totals().modelTurns >= budget.modelTurns) throw new V2Error("budget_exhausted");
            finalMode = emptyTruncationFinalization || totals().modelTurns >= budget.modelTurns - 1 || totals().toolCalls >= budget.toolCalls
              || totals().attempts >= budget.attempts - 1 || remainingMs() <= budget.finalReserveMs;
            if (totals().attempts >= budget.attempts) throw new V2Error("budget_exhausted");
            const projected = { ...context, systemPrompt: hostPrompt(), tools: finalMode || citationRecoveryUsed ? [] : context.tools ?? [] };
            modelInputCeiling = byteLength(projected) + 128; // Conservative UTF-8 ceiling, including protocol allowance.
            if (modelInputCeiling > budget.contextBytes) throw new V2Error("context_limit");
            const tokensLeft = budget.totalTokens - totals().tokens - modelInputCeiling;
            const requestedMaxTokens = Math.min(budget.outputTokens, tokensLeft - (finalMode ? 0 : budget.finalReserveTokens));
            if (requestedMaxTokens < MIN_OUTPUT_TOKENS) throw new V2Error("budget_exhausted");
            const maxTokens = clampMaxTokensToContext(model, projected, requestedMaxTokens);
            localTraceEvent("model.context_admission", { requestedMaxTokens, maxTokens, minimumOutputTokens: MIN_OUTPUT_TOKENS,
              contextWindow: model.contextWindow, finalAnswerOnly: finalMode || citationRecoveryUsed });
            if (maxTokens < MIN_OUTPUT_TOKENS) throw new V2Error("context_limit");
            if (budget.costUsd !== undefined) {
              const price = model.cost;
              if (!(price.input > 0 && price.output > 0)) throw new Error("v2_cost_pricing_unavailable");
              if (totals().costUsd + (modelInputCeiling * price.input + maxTokens * price.output) / 1e6 > budget.costUsd) throw new V2Error("budget_exhausted");
            }
            if (citationRecoveryUsed) citationDiagnostics.recoveryCount = 1;
            usage.modelTurns++;
            usage.attempts++;
            modelSpan = telemetry.start({ module: "model", operation: "generate", provider: input.model.provider, model: input.model.modelId });
            await telemetry.event({ type: "model.started", module: "model", spanId: modelSpan });
            const { reasoning, ...streamOptions } = options ?? {};
            const canThink = !finalMode && !citationRecoveryUsed && maxTokens > PI_THINKING_ANSWER_RESERVE_TOKENS;
            localTraceEvent("model.input", { turn: totals().modelTurns, provider: input.model.provider, model: input.model.modelId, context: projected, options: { maxTokens, maxRetries: 0, temperature: budget.temperature, thinkingEnabled: canThink && !!reasoning }, usage: totals(), remaining: budgetSummary() });
            return await baseStream(model, projected, { ...streamOptions,
              ...(canThink && reasoning ? { reasoning } : {}), signal, maxTokens, maxRetries: 0, temperature: budget.temperature });
          } catch (error) { localTraceEvent("model.failed", { error }); stopped = safeError(error); throw error; }
        },
        beforeToolCall: async ({ toolCall, args, assistantMessage }) => {
          localTraceEvent("tool.proposed", { toolCall, args, finalMode, citationRecoveryUsed, remaining: budgetSummary() });
          if (citationRecoveryUsed) { recoveryToolAttempted = true; return { block: true, reason: "Citation recovery is answer-only. No tools are permitted." }; }
          if (assistantMessage.content.some(c => c.type === "toolCall" && c.name === "request_clarification") && assistantMessage.content.filter(c => c.type === "toolCall").length > 1) return { block: true, reason: "Call request_clarification alone, without business tools." };
          if (stopped || clarification || finalMode || totals().toolCalls > budget.toolCalls || remainingMs() <= budget.finalReserveMs) return { block: true, reason: "Execution budget exhausted. Provide a partial answer using available evidence." };
          if (!exposed.has(toolCall.name)) return { block: true, reason: "Discover this tool before calling it." };
          await authorize("tool", registry.get(toolCall.name), args);
          return undefined;
        },
        afterToolCall: async ({ isError, result }) => isError ? {
          content: [{ type: "text", text: result.content.filter(c => c.type === "text").map(c => c.text).join(" ") }],
          details: {}, isError: true,
        } : clarification ? { terminate: true } : undefined,
        shouldStopAfterTurn: ({ message }) => {
          if (!hostFeedbackUsed && !citationRecoveryUsed && !clarification && !stopped && !signal.aborted
            && !message.content.some(c => c.type === "toolCall") && totals().modelTurns < budget.modelTurns
            && totals().attempts < budget.attempts - 1 && remainingMs() > budget.finalReserveMs
            && budget.totalTokens - totals().tokens > budget.finalReserveTokens) {
            const feedback = input.finalFeedback?.(message.content.filter(c => c.type === "text").map(c => c.text).join(""));
            if (feedback) {
              hostFeedbackUsed = true;
              agent!.followUp({ role: "user", timestamp: Date.now(), content: `Trusted host validation feedback (not a new user task or evidence): ${feedback}` });
              return false;
            }
          }
          if (referenceProtocol && !stopped && !signal.aborted) {
            const hasToolCall = message.content.some(c => c.type === "toolCall");
            if (citationRecoveryUsed && hasToolCall) { recoveryToolAttempted = true; return true; }
            if (recoveryToolAttempted) return true;
            if (clarification || !hasToolCall) {
              const draft = clarification ?? message.content.filter(c => c.type === "text").map(c => c.text).join("");
              const parsed = inspectCitationDraft(draft);
              const isClarification = !!clarification || readCitationAnswer(draft).state === "waiting_user";
              const needsSelfCheck = !isClarification && sources.size > 0 && !parsed.ranges.length && !!parsed.text.trim();
              if (!citationRecoveryUsed && (parsed.errors.length || needsSelfCheck)) {
                citationDiagnostics.firstErrors = parsed.errors;
                if (!emptyTruncationFinalization && totals().modelTurns < budget.modelTurns
                  && totals().attempts < budget.attempts && remainingMs() > budget.finalReserveMs
                  && budget.totalTokens - totals().tokens > budget.finalReserveTokens) {
                  citationRecoveryUsed = true;
                  recoveringClarification = isClarification;
                  citationDiagnostics.recovery = "used";
                  clarification = undefined;
                  agent!.followUp({ role: "user", timestamp: Date.now(), content:
                    `服务端引用校验反馈（不是新用户任务或证据）：${JSON.stringify({ errors: parsed.errors, legalSourceNumbers: [...sources.keys()], selfCheck: !parsed.errors.length })}。${recoveringClarification ? "请保留原澄清意图，仅修正澄清问题，以<waiting_user>输出，不直接作答" : "请仅为原问题重新给出完整回答"}，不调用工具。合法集合为空时移除引用，不编造来源。若未采用资料的通用回答无需强行引用。` });
                  return false;
                }
                citationDiagnostics.recovery = "budget_exhausted";
              }
              if (citationRecoveryUsed || parsed.errors.length) return true;
            }
          }
          if (clarification || stopped || signal.aborted || totals().modelTurns >= budget.modelTurns) return true;
          if (emptyTruncationFinalization) return true;
          // PI ends a truncated text-only turn without asking for another
          // response. Queue at most one native follow-up when no answer or
          // tool call exists. This is an output-format failure, not a semantic
          // review, and never replays an action or increases execution limits.
          if (message.stopReason === "length"
            && !message.content.some(c => c.type === "toolCall" || (c.type === "text" && c.text.trim()))
            && totals().attempts < budget.attempts
            && budget.totalTokens - totals().tokens > budget.finalReserveTokens
            && remainingMs() > budget.finalReserveMs) {
            emptyTruncationFinalization = true;
            agent!.followUp({ role: "user", timestamp: Date.now(), content:
              "服务端执行反馈（不是新用户任务）：上一响应达到输出长度上限，但未输出答案或工具调用。请直接为原始用户请求给出简短收尾，不再调用工具。若缺少用户必须补充的参数，按系统协议用 <waiting_user> 提问；若缺少证据则用 <partial> 说明限制，不编造结果。" });
          }
          return false;
        },
      });
      agent.subscribe(async event => {
        if (settled) return;
        if (event.type !== "message_update") localTraceEvent("agent." + event.type, event);
        if (event.type === "tool_execution_start") {
          ordinals.set(event.toolCallId, totals().toolCalls + 1);
          usage.toolCalls++;
          const tool = registry.get(event.toolName);
          const name = tool?.name ?? "unknown_tool";
          const span = telemetry.start({ module: tool?.category === "control" ? "orchestration" : tool?.category ?? "orchestration", operation: "tool", logicalCallId: auditReference(event.toolCallId), toolName: name });
          const trace: V2TraceCall = { requestId: input.requestId, traceId: telemetry.traceId, toolCallId: auditReference(event.toolCallId), toolName: name,
            category: tool?.category ?? "unknown", argumentCount: summarizeAuditArguments(event.args).argumentCount ?? 0,
            startedAt: new Date().toISOString(), durationMs: 0, attempts: 0, status: "blocked", sourceIds: [], outputBytes: 0 };
          calls.push(trace); callRecords.set(event.toolCallId, { trace, span, start: telemetry.offset() });
          await telemetry.event({ type: "tool.started", module: tool?.category === "control" ? "orchestration" : tool?.category ?? "orchestration", toolName: name, spanId: span, data: { toolCallId: event.toolCallId, arguments: event.args } });
        }
        if (event.type === "tool_execution_end") {
          const record = callRecords.get(event.toolCallId);
          if (record) {
            const raw = (event.result.content as Array<{ text?: string }>).map(c => c.text ?? "").join(" ");
            const code = ["permission_denied", "unavailable", "invalid_result", "empty_result", "transient", "timeout", "cancelled", "budget_exhausted", "no_progress", "unknown_effect"].find(c => raw === c);
            record.trace.durationMs = telemetry.offset() - record.start;
            record.trace.attempts = attempts.get(event.toolCallId) ?? 0;
            record.trace.status = event.isError ? code === "timeout" ? "timeout" : code === "cancelled" ? "cancelled" : record.trace.attempts ? "error" : "blocked" : "ok";
            if (event.isError) record.trace.error ??= code ?? "invalid_arguments_or_tool";
            telemetry.end(record.span, { status: event.isError ? "error" : "ok" });
            await telemetry.event({ type: event.isError ? "tool.failed" : "tool.completed", toolName: record.trace.toolName, spanId: record.span, status: event.isError ? "failed" : "completed", data: { toolCallId: event.toolCallId, sourceCount: record.trace.sourceIds.length } });
          }
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const message = event.message;
          if (modelSpan) {
            usage.inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
            usage.outputTokens += message.usage.output;
            usage.tokens += message.usage.totalTokens > 0 ? message.usage.totalTokens : modelInputCeiling + budget.outputTokens;
            usage.costUsd += message.usage.cost.total;
            if (modelSpan) telemetry.end(modelSpan, { status: message.stopReason === "error" ? "error" : "ok", inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, outputTokens: message.usage.output, totalTokens: message.usage.totalTokens });
            modelSpan = undefined;
          }
          finishReason = message.stopReason;
          if (!message.content.some(c => c.type === "toolCall")) answer = message.content.filter(c => c.type === "text").map(c => c.text).join("");
        }
      });
      signal.addEventListener("abort", abort, { once: true });
      await bounded(() => agent!.prompt(input.userText), signal);
      if (signal.aborted) throw signal.reason;
      if (stopped) throw stopped === "operation_failed" ? new Error(stopped) : new V2Error(stopped as V2Error["code"]);
      if (referenceProtocol) {
        declaredCitationState = clarification || recoveringClarification ? "waiting_user" : readCitationAnswer(answer).state;
        citationResult = inspectCitationDraft(clarification ?? answer);
        if (recoveryToolAttempted) citationResult.errors.push({ code: "tool_call_during_recovery", offset: 0, offsetSpace: "draft" });
        citationDiagnostics.finalErrors = citationResult.errors;
        if (!citationDiagnostics.firstErrors.length && !citationRecoveryUsed) citationDiagnostics.firstErrors = citationResult.errors;
        citationDiagnostics.status = citationResult.errors.length ? "invalid" : citationResult.ranges.length ? "valid" : "not_cited";
        if (citationResult.errors.length) {
          answer = `<partial>${CITATION_FAILURE_TEXT}`;
          clarification = undefined;
          declaredCitationState = "partial";
          citationResult.ranges = [];
        } else if (clarification) clarification = citationResult.text;
      }
      await authorize("release");
      // Parse a model-declared protocol state, never infer intent from business keywords.
      const waiting = answer.match(/(?:^|\n)<waiting_user>([\s\S]*)$/u);
      if (referenceProtocol) {
        if (declaredCitationState === "waiting_user") clarification = citationResult!.text;
      } else if (waiting) clarification = waiting[1]!.trim();
      if (!referenceProtocol && /(?:^|\n)<partial>/u.test(answer) && !answer.startsWith("<partial>")) answer = `<partial>${answer.replace(/\n<partial>/u, "\n")}`;
      if (clarification) {
        if (!referenceProtocol && [...clarification.matchAll(/\[S:([^\]\s]+)\]/g)].some(match => !sources.has(match[1]!))) throw new V2Error("invalid_result");
        answer = clarification;
        usage.activeMs = telemetry.offset();
        session = { version: 1, scope: input.scope, taskId: input.session?.taskId ?? input.requestId, status: "waiting_user",
          messages: [...history.filter(m => m.role === "user"), { role: "user", content: input.userText, timestamp: Date.now() },
            { role: "assistant", content: [{ type: "text", text: clarification }], api: input.model.model.api,
              provider: input.model.provider, model: input.model.modelId, stopReason: "stop", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }],
          usage: totals(), attemptedWrites: [...writes] };
        if (input.saveSession) await bounded(() => input.saveSession!(session!), signal);
        status = "waiting_user";
      } else status = !answer || finishReason === "error" || finishReason === "aborted" ? "failed"
        : (referenceProtocol ? declaredCitationState === "partial" : answer.startsWith("<partial>")) || finishReason === "length" || finalMode ? "partial" : "completed";
      if (referenceProtocol) answer = citationDiagnostics.status === "invalid" ? CITATION_FAILURE_TEXT : citationResult!.text;
      if (status === "failed") stopped = "model_failed";
    } catch (error) {
      localTraceEvent("runtime.failed", { error, usage: totals(), citationDiagnostics });
      stopped = signal.aborted ? signal.reason instanceof V2Error ? signal.reason.code : "cancelled" : safeError(error);
      status = stopped === "cancelled" ? "cancelled" : ["budget_exhausted", "timeout", "context_limit", "unknown_effect"].includes(stopped) ? "partial" : "failed";
      if (referenceProtocol) { citationResult = undefined; session = undefined; }
      answer = ""; // A draft or revoked result is never released on a failed boundary.
      if (referenceProtocol && citationRecoveryUsed && ["budget_exhausted", "timeout", "context_limit"].includes(stopped)) {
        citationDiagnostics.recovery = "budget_exhausted";
        citationDiagnostics.finalErrors = citationDiagnostics.firstErrors;
        citationDiagnostics.status = citationDiagnostics.firstErrors.length ? "invalid" : "not_cited";
        if (citationDiagnostics.status === "invalid") answer = CITATION_FAILURE_TEXT;
      }
      if (stopped === "permission_denied") { sources.clear(); artifacts.clear(); }
    } finally {
      settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort); agent?.abort(); this.active.delete(input.sessionId);
      usage.activeMs = telemetry.offset();
      telemetry.closeOpen(signal.aborted ? "cancelled" : "error");
    }
    const invalidCitations: string[] = [];
    const cited = new Set<string>();
    if (referenceProtocol) {
      if (citationResult && citationDiagnostics.status === "valid") for (const range of citationResult.ranges) for (const id of range.sourceIds) cited.add(id);
    } else {
      answer = answer.replace(/^<(?:answer|partial)>\s*/u, "").replace(/\[S:([^\]\s]+)\]/g, (match, id: string) => {
        if (sources.has(id)) { cited.add(id); return match; }
        invalidCitations.push(id); return "[来源不可用]";
      });
      if (invalidCitations.length) {
        status = "partial";
        answer = "回答包含未登记的来源引用，因此本次没有交付该回答。需要取得可追溯的获授权资料后继续。";
        cited.clear();
      }
      // Missing citation fields are a format failure, not a semantic judgment or
      // a trigger for another model call. Never label unbound evidence as verified.
      if (sources.size > 0 && cited.size === 0 && status === "completed") {
        status = "partial";
        answer += "\n\n本次回答未提供可解析的来源引用。";
      }
    }
    if (!answer) answer = status === "cancelled" ? "任务已取消。已发生的操作不会自动撤销。"
      : stopped === "context_limit" ? "本次上下文空间不足，无法保留至少1024 token的回答空间，已停止生成。请缩小问题范围后再试。"
      : stopped === "unknown_effect" ? "操作的最终状态尚未确认；请先核查实际回执。本次没有自动重试或宣称完成。"
      : "本次未能完成请求；没有足够的已确认结果可以交付。";
    // Release only final text, never speculative pre-tool drafts or hidden reasoning.
    if (status !== "failed" && status !== "cancelled") {
      firstTextMs = telemetry.offset();
      await telemetry.event({ type: "response.delta", module: "response", delta: answer, status });
    }
    await telemetry.event({ type: status === "failed" ? "run.failed" : status === "cancelled" ? "run.cancelled" : "run.completed", module: "request", status });
    localTraceEvent("runtime.final", { status, error: stopped, text: answer, sources: [...sources.values()], sourceBindings, citationRanges: citationResult?.ranges ?? [], citationDiagnostics, usage, taskUsage: totals() });
    return { runtime: "delegate-agent-v2", requestId: input.requestId, traceId: telemetry.traceId, status, text: answer,
      ...(referenceProtocol ? { citationRanges: citationResult?.ranges ?? [], citationStatus: citationDiagnostics.status, citationDiagnostics } : {}),
      sources: [...cited].map(id => sources.get(id)!), sourceBindings, artifacts: [...artifacts.values()], invalidCitations,
      modelCalls: usage.modelTurns, toolCalls: usage.toolCalls, totalDurationMs: telemetry.offset(),
      costAvailable: input.model.model.cost.input > 0 && input.model.model.cost.output > 0,
      ...(firstTextMs !== undefined ? { firstTextMs } : {}), usage, taskUsage: totals(), ...(session ? { session } : {}),
      events: telemetry.events, spans: telemetry.spans, calls, ...(stopped ? { error: stopped } : {}) };
  }
}

async function normalizeResult(result: PiCapabilityResult, limit: number, scope: string, sources: Map<string, PiSource>, artifacts: Map<string, PiArtifact>, sourceBindings: Record<string, string>, effect: V2Tool["effect"], signal: AbortSignal, sourceNumber?: V2RunInput["citationSourceNumber"]) {
  if (!result || typeof result.text !== "string") throw new V2Error("invalid_result");
  if (!result.text.trim()) throw new V2Error("empty_result");
  const status = result.status ?? "completed";
  if (result.observation?.state === "unknown") throw new V2Error("unknown_effect");
  if (result.observation?.state === "blocked" || status === "denied" || status === "blocked") throw new V2Error("permission_denied");
  const httpStatus = result.observation?.httpStatus;
  if (httpStatus === 401 || httpStatus === 403) throw new V2Error("permission_denied");
  // A confirmed read HTTP error is not a permission grant or a write receipt.
  // Give the next normal model turn a safe status code, never the remote error
  // body's instructions. Do not retry it automatically or retain its sources.
  if (effect === "read" && typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) {
    throw new V2RecoverableToolError("read_failed", `http_${httpStatus}`,
      `只读请求返回 HTTP ${httpStatus}，未取得目标正文。核对用户提供的完整地址或调整合法参数；不能据错误页编造内容。系统没有自动重试，后续调用仍受权限和剩余预算限制。`);
  }
  if (["failed", "error", "unavailable", "pending_approval", "confirmation_required"].includes(status)) throw new V2Error("unavailable");
  let text = result.text;
  const records = await Promise.all((sourceNumber ? result.sources ?? [] : (result.sources ?? []).slice(0, 12)).map(async source => {
    if (!source.id || !source.title || !["knowledge", "web", "mcp"].includes(source.channel)) throw new V2Error("invalid_result");
    const safe: PiSource = { id: source.id, title: truncateUtf8(source.title, 256), channel: source.channel,
      ...(source.provider && /^[\p{L}\p{N} ._-]{1,80}$/u.test(source.provider) ? { provider: source.provider } : {}),
      ...(source.version ? { version: truncateUtf8(source.version, 128) } : {}),
      ...(source.dataTime ? { dataTime: source.dataTime } : {}), ...(source.observedAt ? { observedAt: source.observedAt } : {}),
      ...(source.url && safeUrl(source.url) ? { url: source.url } : {}) };
    const id = sourceNumber ? await sourceNumber(safe, { ...(result.contextSourceRef ? { contextSourceRef: result.contextSourceRef } : {}), ...(result.resultRef ? { resultRef: result.resultRef } : {}) }) : fingerprint([scope, source.channel, source.id, source.version ?? "", source.url ?? ""]).slice(0, 24);
    if (sourceNumber && !/^[1-9]\d*$/.test(id)) throw new V2Error("invalid_result");
    safe.id = id;
    return { source: safe, originalSourceId: source.id };
  }));
  // Promise.all preserves input order; keep the binding in that same record,
  // rather than pairing it with a separate array ordered by completion time.
  const mapped = records.map(record => record.source);
  for (const { source, originalSourceId } of records) {
    text = text.replaceAll(`[S:${originalSourceId}]`, sourceNumber ? `〔来源编号：${source.id}〕` : `[S:${source.id}]`);
  }
  const visibleArtifacts = (result.artifacts ?? []).slice(0, 10).map(a => {
    if (typeof a.id !== "string" || !a.id || typeof a.fileName !== "string" || !a.fileName || typeof a.mimeType !== "string" || !Number.isSafeInteger(a.sizeBytes) || a.sizeBytes < 0) throw new V2Error("invalid_result");
    return { id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, ...(a.url && safeUrl(a.url) ? { url: a.url } : {}) };
  });
  const envelope = { status, text: "", sources: mapped, artifacts: visibleArtifacts, truncated: false,
    ...(result.details?.searchIncomplete === true ? { searchIncomplete: true } : {}) };
  if (sourceNumber && result.sourceContents?.length) {
    if (result.sourceContents.length !== mapped.length || new Set(result.sourceContents.map(item => item.sourceId)).size !== mapped.length) throw new V2Error("invalid_result");
    envelope.sources = [];
    for (const { source, originalSourceId } of records) {
      const body = result.sourceContents.find(item => item.sourceId === originalSourceId);
      if (!body || typeof body.text !== "string" || !body.text.trim()) throw new V2Error("invalid_result");
      const prefix = `${envelope.text ? "\n\n" : ""}〔来源编号：${source.id}〕 ${source.title}\n`;
      const candidate = { ...envelope, sources: [...envelope.sources, source], text: envelope.text + prefix + body.text };
      if (byteLength(candidate) <= limit) {
        envelope.sources.push(source); envelope.text = candidate.text;
      } else {
        // Retain a bounded prefix of the last source, or omit that source and
        // body together. Earlier source bodies are never left without IDs.
        let tail = body.text;
        while (tail && byteLength({ ...candidate, truncated: true, text: envelope.text + prefix + tail }) > limit) {
          tail = truncateUtf8(tail, Math.floor(byteLength(tail) * 0.8));
        }
        if (tail.trim()) { envelope.sources.push(source); envelope.text += prefix + tail; }
        envelope.truncated = true;
        break;
      }
    }
    if (mapped.length && !envelope.sources.length) throw new V2Error("invalid_result");
    if (envelope.sources.length !== mapped.length) envelope.truncated = true;
  } else {
    const available = limit - byteLength(envelope) - 128;
    if (available < 64) throw new V2Error("invalid_result");
    // JSON escaping can expand text; shrink until the complete envelope fits.
    envelope.text = truncateUtf8(text, available); envelope.truncated = envelope.text !== text;
    while (byteLength(envelope) > limit) { envelope.text = truncateUtf8(envelope.text, Math.floor(byteLength(envelope.text) * 0.8)); envelope.truncated = true; }
  }
  signal.throwIfAborted();
  for (const source of envelope.sources) sources.set(source.id, source);
  for (const { source, originalSourceId } of records) if (envelope.sources.some(visible => visible.id === source.id)) sourceBindings[source.id] = originalSourceId;
  for (const artifact of visibleArtifacts) artifacts.set(artifact.id, artifact);
  return envelope;
}
function safeUrl(value: string): boolean {
  if (value.startsWith("/reps/") && !value.includes("\\")) {
    const url = new URL(value, "https://delegate.invalid");
    return url.pathname === value && /^\/reps\/[^/]+\/chat\/artifacts\/[a-zA-Z0-9_-]+\/download$/.test(value);
  }
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
export const delegateAgentV2 = new DelegateAgentV2();
