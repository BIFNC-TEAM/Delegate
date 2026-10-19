import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DelegateAgentV2, V2Error, createV2Capabilities, V2_SYSTEM_PROMPT, type V2RunInput, type V2Tool } from "../src/v2";
import { toolExecutionRequestSchema } from "../../compute-protocol/src";

const call = (name: string, args: Record<string, unknown> = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
type Responses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];
function input(responses: Responses, extra: Partial<V2RunInput> = {}): V2RunInput {
  const faux = fauxProvider({ tokensPerSecond: 1000000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { requestId: "request", sessionId: "session", scope: "tenant-user-v1", userText: "公司的休假规定是什么？", timezone: "Asia/Shanghai",
    currentTime: "2026-10-19T00:00:00Z", model: { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: "faux" },
    tools: [], context: { traceId: "trace", runId: "request", sessionId: "session", timezone: "Asia/Shanghai", attachments: [], idempotencyKey: "request" },
    authorize: async () => undefined, ...extra };
}
const tool = (name = "lookup", execute: V2Tool["execute"] = async () => ({ text: "result" }), effect: V2Tool["effect"] = "read"): V2Tool => ({
  name, label: name, description: "Read controlled fixture evidence.", category: "knowledge", effect,
  parameters: Type.Object({ query: Type.Optional(Type.String()) }), execute,
});
const citationAnswer: Responses[number] = context => {
  const result = context.messages.filter(m => m.role === "toolResult").at(-1)!;
  const payload = JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join(""));
  return fauxAssistantMessage(`试用期后享受 12 天年假 [S:${payload.sources[0].id}]`);
};

// These are mechanism tests with scripted model decisions, NOT evidence of model autonomy.
describe("V2 PI native execution mechanisms (scripted model)", () => {
  it("executes RAG once, maps real sources and stops without extra search/review", async () => {
    const rag = vi.fn(async () => ({ text: "12 天", sources: [{ id: "internal-doc", title: "休假制度", channel: "knowledge" as const, version: "2026", dataTime: "2026-01-01" }] }));
    const search = vi.fn(async () => ({ text: "not needed" }));
    const result = await new DelegateAgentV2().run(input([call("retrieve_authorized_knowledge", { query: "年假" }), citationAnswer], {
      tools: [tool("retrieve_authorized_knowledge", rag), tool("search_current_web", search)] }));
    expect(result.status).toBe("completed"); expect(rag).toHaveBeenCalledTimes(1); expect(search).not.toHaveBeenCalled();
    expect(result.modelCalls).toBe(2); expect(result.sources[0]).toMatchObject({ title: "休假制度", version: "2026" });
    expect(result.sourceBindings[result.sources[0]!.id]).toBe("internal-doc");
    expect(result.calls).toHaveLength(1); expect(result.calls[0]!.status).toBe("ok");
    expect(result.events.some(e => e.type === "response.review_started")).toBe(false);
  });
  it("permits direct translation without mandatory retrieval", async () => {
    const rag = vi.fn(async () => ({ text: "not needed" }));
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage("Hello")], { userText: "翻译：你好", tools: [tool("retrieve_authorized_knowledge", rag)] }));
    expect(result.modelCalls).toBe(1); expect(result.toolCalls).toBe(0); expect(result.sources).toEqual([]);
  });
  it.each([undefined, "上海"])("keeps authorized location separate from the clock timezone (%s)", async location => {
    const authorize = vi.fn(async () => undefined);
    const result = await new DelegateAgentV2().run(input([context => {
      const host = JSON.parse(context.systemPrompt!.split("Trusted host context:\n")[1]!.split("\n")[0]!);
      expect(authorize).toHaveBeenCalledWith("model", undefined, undefined);
      expect(host.timezone).toBe("Asia/Shanghai");
      expect(host.authorizedUserLocation).toBe(location ?? null);
      expect(host.completedToolResultsThisRequest).toEqual([]);
      return fauxAssistantMessage("done");
    }], { authorize, ...(location ? { authorizedUserLocation: location } : {}) }));
    expect(result.modelCalls).toBe(1);
  });
  it("gives the model actual execution facts without replaying raw arguments", async () => {
    await new DelegateAgentV2().run(input([call("lookup", { query: "sensitive-query" }), context => {
      const host = JSON.parse(context.systemPrompt!.split("Trusted host context:\n")[1]!.split("\n")[0]!);
      expect(host.completedToolResultsThisRequest).toEqual([{ tool: "lookup", status: "ok", sourceCount: 0 }]);
      expect(JSON.stringify(host)).not.toContain("sensitive-query");
      return fauxAssistantMessage("done");
    }], { tools: [tool()] }));
  });
  it("saves a clarification, resumes with new active time and cumulative limits", async () => {
    const saved = vi.fn(async () => undefined);
    const first = await new DelegateAgentV2().run(input([call("request_clarification", { question: "请提供城市。" })], { userText: "今天天气如何", saveSession: saved }));
    expect(first.status).toBe("waiting_user"); expect(first.text).toBe("请提供城市。"); expect(saved).toHaveBeenCalledOnce();
    expect(first.session!.messages.at(-1)!.role).toBe("assistant");
    const result = await new DelegateAgentV2().run(input([context => {
      expect(JSON.stringify(context.messages)).toContain("今天天气如何"); expect(context.systemPrompt).toContain("Asia/Shanghai");
      return fauxAssistantMessage("上海。");
    }], { requestId: "resume", userText: "上海", session: first.session! }));
    expect(result.taskUsage.modelTurns).toBe(2); expect(result.modelCalls).toBe(1);
    await expect(new DelegateAgentV2().run(input([], { session: first.session!, scope: "different-user" }))).rejects.toThrow("session_scope_mismatch");
  });
  it("does not execute any operation mixed with clarification", async () => {
    const execute = vi.fn(async () => ({ text: "done" }));
    const result = await new DelegateAgentV2().run(input([
      fauxAssistantMessage([fauxToolCall("request_clarification", { question: "where?" }), fauxToolCall("write", {})], { stopReason: "toolUse" }),
      call("request_clarification", { question: "where?" }),
    ], { tools: [tool("write", execute, "write")] }));
    expect(execute).not.toHaveBeenCalled(); expect(result.status).toBe("waiting_user");
  });
  it("persists a model-declared waiting status without a classification model", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage("<waiting_user>请提供地点。")], { userText: "查询实时信息" }));
    expect(result.status).toBe("waiting_user"); expect(result.modelCalls).toBe(1); expect(result.toolCalls).toBe(0);
    expect(result.session?.messages.at(-1)?.role).toBe("assistant");
    expect(result.text).toBe("请提供地点。");
  });
  it("never releases or persists native thinking content, including when clarifying", async () => {
    const request = input([fauxAssistantMessage([
      { type: "thinking", thinking: "PRIVATE_THINKING_FIXTURE" },
      { type: "text", text: "<waiting_user>请提供地点。" },
    ])]);
    request.model.model = { ...request.model.model, reasoning: true };
    const result = await new DelegateAgentV2().run(request);
    expect(result.status).toBe("waiting_user"); expect(result.modelCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_THINKING_FIXTURE");
  });
  it("honors a zero thinking budget even for a supported model", async () => {
    const request = input([fauxAssistantMessage("done")], { budget: { thinkingTokens: 0 } });
    request.model.model = { ...request.model.model, reasoning: true };
    const base = request.model.streamFn;
    request.model.streamFn = (model, context, options) => {
      expect(options?.reasoning).toBeUndefined();
      return base(model, context, options);
    };
    expect((await new DelegateAgentV2().run(request)).modelCalls).toBe(1);
  });
  it("reserves the final budget for the answer rather than native thinking", async () => {
    const request = input([call("lookup"), fauxAssistantMessage("<partial>已有部分结果")], { tools: [tool()], budget: { modelTurns: 2 } });
    request.model.model = { ...request.model.model, reasoning: true };
    const base = request.model.streamFn;
    const reasoning: Array<string | undefined> = [];
    request.model.streamFn = (model, context, options) => { reasoning.push(options?.reasoning); return base(model, context, options); };
    const result = await new DelegateAgentV2().run(request);
    expect(reasoning).toEqual(["low", undefined]); expect(result.status).toBe("partial");
  });
  it("disables native thinking when the response ceiling cannot hold its answer reserve", async () => {
    const request = input([fauxAssistantMessage("done")], { budget: { outputTokens: 512, finalReserveTokens: 128 } });
    request.model.model = { ...request.model.model, reasoning: true };
    const base = request.model.streamFn;
    request.model.streamFn = (model, context, options) => { expect(options?.reasoning).toBeUndefined(); return base(model, context, options); };
    expect((await new DelegateAgentV2().run(request)).status).toBe("completed");
  });
  it("accepts an explicit status on its own line and never persists an invalid-source clarification", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage("已有分析\n<waiting_user>请提供必要参数。") ]));
    expect(result.status).toBe("waiting_user"); expect(result.text).toBe("请提供必要参数。");
    const save = vi.fn(async () => undefined);
    const invalid = await new DelegateAgentV2().run(input([fauxAssistantMessage("<waiting_user>请核对 [S:invented]")], { saveSession: save }));
    expect(invalid.status).toBe("failed"); expect(save).not.toHaveBeenCalled();
  });
  it("gives validation errors back to the model and allows parameter correction", async () => {
    const execute = vi.fn(async () => ({ text: "ok" }));
    const result = await new DelegateAgentV2().run(input([call("lookup", { query: "" }), call("lookup", { query: "fixed" }), fauxAssistantMessage("done")], { tools: [{ ...tool("lookup", execute), parameters: Type.Object({ query: Type.String({ minLength: 2 }) }) }] }));
    expect(result.modelCalls).toBe(3); expect(execute).toHaveBeenCalledTimes(1); expect(result.calls[0]!.status).toBe("blocked");
  });
  it("permits distinct queries but detects exact no-progress repetition", async () => {
    const execute = vi.fn(async () => ({ text: "unchanged" }));
    const result = await new DelegateAgentV2().run(input([call("lookup", { query: "a" }), call("lookup", { query: "b" }), call("lookup", { query: "a" }), call("lookup", { query: "a" }), fauxAssistantMessage("<partial>资料不足")], { tools: [tool("lookup", execute)] }));
    expect(execute).toHaveBeenCalledTimes(3); expect(result.calls.at(-1)!.error).toBe("no_progress"); expect(result.status).toBe("partial");
  });
  it("retries only classified transient reads and counts infrastructure attempts", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new V2Error("transient")).mockResolvedValue({ text: "recovered" });
    const result = await new DelegateAgentV2().run(input([call("lookup"), fauxAssistantMessage("done")], { tools: [tool("lookup", execute)] }));
    expect(result.usage.attempts).toBe(result.modelCalls + 2); expect(result.calls[0]!.attempts).toBe(2);
  });
  it("never automatically retries a write or repeats its identical intent", async () => {
    const execute = vi.fn(async () => { throw new V2Error("transient"); });
    const result = await new DelegateAgentV2().run(input([call("write"), call("write"), fauxAssistantMessage("<partial>状态未知")], { tools: [tool("write", execute, "write")] }));
    expect(execute).toHaveBeenCalledTimes(1); expect(result.usage.attempts).toBe(result.modelCalls + 1); expect(result.error).toBe("unknown_effect");
  });
  it("runs independent reads concurrently within the cap", async () => {
    let active = 0; let maximum = 0;
    const ordinals: number[] = [];
    const execute: V2Tool["execute"] = async (_id, _args, _signal, context) => { ordinals.push(context.logicalAction!.ordinal); active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 15)); active--; return { text: "ok" }; };
    const result = await new DelegateAgentV2().run(input([
      fauxAssistantMessage([fauxToolCall("a", {}), fauxToolCall("b", {}), fauxToolCall("c", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done"),
    ], { tools: [tool("a", execute), tool("b", execute), tool("c", execute)], budget: { concurrency: 2 } }));
    expect(maximum).toBe(2); expect(result.calls.every(c => c.status === "ok")).toBe(true);
    expect(ordinals).toEqual([1, 2, 3]);
    for (const ordinal of ordinals) expect(() => toolExecutionRequestSchema.parse({ capability: "mcp", subagentId: "compute-agent", logicalAction: { version: 1, ordinal }, rejectApprovalWait: true })).not.toThrow();
  });
  it("lets PI serialize a batch containing an external write", async () => {
    let active = 0; let maximum = 0;
    const execute: V2Tool["execute"] = async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--; return { text: "ok" }; };
    await new DelegateAgentV2().run(input([fauxAssistantMessage([fauxToolCall("a", {}), fauxToolCall("write", {}), fauxToolCall("c", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")], { tools: [tool("a", execute), tool("write", execute, "write"), tool("c", execute)] }));
    expect(maximum).toBe(1);
  });
  it("enforces permissions before dispatch and stops alternative paths", async () => {
    const execute = vi.fn(async () => ({ text: "secret" }));
    const result = await new DelegateAgentV2().run(input([call("lookup")], { tools: [tool("lookup", execute)], authorize: async boundary => { if (boundary === "tool") throw new Error("denied secret"); } }));
    expect(execute).not.toHaveBeenCalled(); expect(result.status).toBe("failed"); expect(result.error).toBe("permission_denied");
    expect(JSON.stringify(result)).not.toContain("denied secret");
  });
  it("never releases content after authorization revocation", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage("SECRET")], { authorize: async boundary => { if (boundary === "release") throw new Error("revoked"); } }));
    expect(result.text).not.toContain("SECRET"); expect(result.status).toBe("failed");
  });
  it("does not route around a broker policy rejection returned as data", async () => {
    const alternative = vi.fn(async () => ({ text: "must not execute" }));
    const result = await new DelegateAgentV2().run(input([call("lookup"), call("alternative")], { tools: [
      tool("lookup", async () => ({ text: "policy rejected", status: "blocked" })), tool("alternative", alternative),
    ] }));
    expect(result.error).toBe("permission_denied"); expect(alternative).not.toHaveBeenCalled(); expect(result.modelCalls).toBe(1);
  });
  it("reserves the last model turn for a final answer with no tools", async () => {
    const result = await new DelegateAgentV2().run(input([call("lookup"), context => { expect(context.tools).toEqual([]); return fauxAssistantMessage("<partial>已取得部分结果"); }], { tools: [tool()], budget: { modelTurns: 2 } }));
    expect(result.modelCalls).toBe(2); expect(result.status).toBe("partial");
  });
  it("enforces tool-call budget even when model submits a batch", async () => {
    const execute = vi.fn(async () => ({ text: "ok" }));
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage([fauxToolCall("a", {}), fauxToolCall("b", {})], { stopReason: "toolUse" }), fauxAssistantMessage("<partial>预算不足")], { tools: [tool("a", execute), tool("b", execute)], budget: { toolCalls: 1 } }));
    expect(execute).toHaveBeenCalledTimes(1); expect(result.status).toBe("partial");
  });
  it("bounds an adapter that ignores abort and allows a bounded final response", async () => {
    const start = Date.now();
    const result = await new DelegateAgentV2().run(input([call("lookup"), fauxAssistantMessage("<partial>查询超时")], { tools: [tool("lookup", async () => new Promise(() => undefined))], budget: { toolTimeoutMs: 20 } }));
    expect(Date.now() - start).toBeLessThan(1000); expect(result.calls[0]!.status).toBe("timeout"); expect(result.status).toBe("partial");
  });
  it("cancels in-flight tools and cleans the session lock", async () => {
    const runtime = new DelegateAgentV2(); const controller = new AbortController();
    const running = runtime.run(input([call("lookup")], { signal: controller.signal, tools: [tool("lookup", async (_id, _args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new V2Error("cancelled")))))] }));
    setTimeout(() => controller.abort(), 20);
    const result = await running; expect(result.status).toBe("cancelled");
    expect((await runtime.run(input([fauxAssistantMessage("again")]))).status).toBe("completed");
  });
  it("enforces total active deadline and token admission", async () => {
    const result = await new DelegateAgentV2().run(input([call("lookup")], { authorize: async () => new Promise(() => undefined), budget: { activeMs: 30, finalReserveMs: 5 } }));
    expect(result.error).toBe("timeout"); expect(result.modelCalls).toBe(0);
    const tokens = await new DelegateAgentV2().run(input([fauxAssistantMessage("should not run")], { budget: { totalTokens: 1024 } }));
    expect(tokens.error).toBe("budget_exhausted"); expect(tokens.modelCalls).toBe(0);
  });
  it("does not hang or replay work when the event sink stalls", async () => {
    const start = Date.now();
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage("unused")], { onEvent: async () => new Promise(() => undefined), budget: { activeMs: 30, finalReserveMs: 5 } }));
    expect(Date.now() - start).toBeLessThan(1000); expect(result.error).toBe("timeout"); expect(result.modelCalls).toBe(0);
  });
  it("bounds whole JSON output and keeps secrets/raw data out of traces", async () => {
    const result = await new DelegateAgentV2().run(input([call("lookup", { query: "password=super-secret" }), context => {
      const last = context.messages.at(-1)!; expect(JSON.stringify(last)).toContain("truncated"); return fauxAssistantMessage("done");
    }], { tools: [tool("lookup", async () => ({ text: "sensitive-result".repeat(1000) }))], budget: { toolOutputBytes: 300 } }));
    expect(result.calls[0]!.outputBytes).toBeLessThanOrEqual(300);
    expect(JSON.stringify([result.calls, result.events, result.spans])).not.toMatch(/super-secret|sensitive-result/);
  });
  it("rejects invented source IDs without another model call", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage("未经支持的伪造结论 [S:invented]")]));
    expect(result.invalidCitations).toEqual(["invented"]); expect(result.sources).toEqual([]); expect(result.status).toBe("partial"); expect(result.modelCalls).toBe(1);
    expect(result.text).not.toContain("未经支持的伪造结论");
  });
  it("does not release artifacts from an invalid oversized result", async () => {
    const result = await new DelegateAgentV2().run(input([call("lookup"), fauxAssistantMessage("<partial>返回无效")], { budget: { toolOutputBytes: 300 },
      tools: [tool("lookup", async () => ({ text: "ok", artifacts: [{ id: "artifact", fileName: "x".repeat(2000), mimeType: "text/plain", sizeBytes: 1 }] }))] }));
    expect(result.artifacts).toEqual([]); expect(result.calls[0]!.error).toBe("invalid_result");
  });
  it("loads a large catalog on demand without another planning model", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...tool(`capability_${i}`), category: "mcp" as const }));
    const result = await new DelegateAgentV2().run(input([context => {
      expect(context.tools?.map(t => t.name)).toEqual(["request_clarification", "discover_tools"]);
      return call("discover_tools", { query: "capability_19" });
    }, context => {
      expect(context.tools?.some(t => t.name === "capability_19")).toBe(true); return call("capability_19");
    }, fauxAssistantMessage("done")], { tools: many }));
    expect(result.modelCalls).toBe(3); expect(result.calls.at(-1)!.toolName).toBe("capability_19");
  });
  it("exposes concrete MCP tools and enforces attachment ownership", async () => {
    const host = input([]).context;
    const tools = await createV2Capabilities({ mcp: { listTools: async () => [{ server: "crm", name: "read_contract", description: "Read an authorized contract", inputSchema: { type: "object", properties: {} }, effectClassification: "read", readOnly: true, idempotent: true }], callTool: async () => ({ text: "contract" }) }, sandbox: { execute: async () => ({ text: "ok" }) } }, host, new AbortController().signal);
    expect(tools[0]!.name).toContain("read_contract");
    await expect(Promise.resolve().then(() => tools.find(t => t.name === "execute_in_sandbox")!.execute("x", { attachmentIds: ["other-user-file"] }, new AbortController().signal, host))).rejects.toThrow("permission_denied");
  });
  it("contains the decision policy without importing old orchestration", () => {
    expect(V2_SYSTEM_PROMPT).toContain("RAG DEFAULT FIRST"); expect(V2_SYSTEM_PROMPT).toContain("pure translation");
    expect(V2_SYSTEM_PROMPT).toContain("untrusted data");
  });
});
