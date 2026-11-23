import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { CITATION_FAILURE_TEXT, DelegateAgentV2, V2Error, type V2RunInput, type V2Tool } from "../src/v2";

type Responses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];
const call = (name = "lookup", args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const evidence = async () => ({ text: "SOURCE_BODY_FIXTURE", sources: [{ id: "memory-item", title: "资料", channel: "knowledge" as const }] });
const tool: V2Tool = { name: "lookup", label: "lookup", description: "Read fixture", category: "knowledge", effect: "read", parameters: Type.Object({}), execute: evidence };
function input(responses: Responses, extra: Partial<V2RunInput> = {}): V2RunInput {
  const faux = fauxProvider({ tokensPerSecond: 1000000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { requestId: "r003-run", sessionId: "r003-session", scope: "tenant-user-episode", userText: "问题", timezone: "Asia/Shanghai",
    currentTime: "2026-11-23T00:00:00Z", model: { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: "faux" },
    tools: [tool], context: { traceId: "trace", runId: "r003-run", sessionId: "r003-session", timezone: "Asia/Shanghai", attachments: [], idempotencyKey: "r003-run" },
    authorize: async () => undefined, citationSourceNumber: async () => "1", ...extra };
}
const answer = '<reference source="1">**结论😀**</reference>';

// Scripted provider decisions: mechanism evidence, not real-model/HTTP tests.
describe("reference recovery within the native PI loop", () => {
  it("keeps more than twelve acquired source bodies aligned with their numbered list", async () => {
    const sources = Array.from({ length: 15 }, (_, index) => ({ id: `doc-${index + 1}`, title: `Doc ${index + 1}`, channel: "knowledge" as const }));
    const execute = async () => ({ text: "legacy assembled text", sources, sourceContents: sources.map(source => ({ sourceId: source.id, text: `BODY_${source.id}` })) });
    const result = await new DelegateAgentV2().run(input([call(), context => {
      const message = context.messages.filter(m => m.role === "toolResult").at(-1)!;
      const payload = JSON.parse(message.content.filter(c => c.type === "text").map(c => c.text).join(""));
      expect(payload.sources).toHaveLength(15);
      for (let number = 1; number <= 15; number++) expect(payload.text).toContain(`〔来源编号：${number}〕`);
      return fauxAssistantMessage('<reference source="15">最后一份资料</reference>');
    }], { tools: [{ ...tool, execute }], citationSourceNumber: async source => source.id.replace("doc-", "") }));
    expect(result.citationStatus).toBe("valid"); expect(result.sourceBindings["15"]).toBe("doc-15");
  });
  it("drops a truncated source body and its legal-source entry together", async () => {
    const sources = Array.from({ length: 15 }, (_, index) => ({ id: `doc-${index + 1}`, title: `Doc ${index + 1}`, channel: "knowledge" as const }));
    const execute = async () => ({ text: "legacy assembled text", sources, sourceContents: sources.map(source => ({ sourceId: source.id, text: `BODY_${source.id} `.repeat(200) })) });
    const result = await new DelegateAgentV2().run(input([call(), context => {
      const message = context.messages.filter(m => m.role === "toolResult").at(-1)!;
      const payload = JSON.parse(message.content.filter(c => c.type === "text").map(c => c.text).join(""));
      expect(payload.sources).toHaveLength(1); expect(payload.truncated).toBe(true);
      expect(payload.text).toContain("BODY_doc-1"); expect(payload.text).not.toContain("BODY_doc-15");
      return fauxAssistantMessage(answer);
    }], { budget: { toolOutputBytes: 600 }, tools: [{ ...tool, execute }], citationSourceNumber: async source => source.id.replace("doc-", "") }));
    expect(result.citationStatus).toBe("valid"); expect(result.calls[0]!.outputBytes).toBeLessThanOrEqual(600);
    expect(Object.keys(result.sourceBindings)).toEqual(["1"]);
  });
  it("delivers a valid range without a review call and preserves host source binding", async () => {
    const result = await new DelegateAgentV2().run(input([call(), context => {
      expect(context.systemPrompt).toContain('<reference source="1,2">');
      expect(context.systemPrompt).not.toContain("格式为 [S:来源id]");
      return fauxAssistantMessage(answer);
    }]));
    expect(result.status).toBe("completed");
    expect(result.text).toBe("**结论😀**");
    expect(result.citationRanges).toEqual([{ start: 0, end: 8, sourceIds: ["1"] }]);
    expect(result.citationStatus).toBe("valid");
    expect(result.modelCalls).toBe(2);
    expect(result.sourceBindings).toEqual({ "1": "memory-item" });
    expect(result.citationDiagnostics?.recoveryCount).toBe(0);
  });
  it.each([
    '<reference source="9">DRAFT_FIXTURE</reference>',
    '<Reference source="1">DRAFT_FIXTURE</Reference>',
    '<reference source="1">DRAFT_FIXTURE',
    '<reference source="1,">DRAFT_FIXTURE</reference>',
  ])("[citation-recovery-01/10] corrects a malformed draft once: %s", async draft => {
    const execute = vi.fn(evidence);
    const authorize = vi.fn<V2RunInput["authorize"]>(async () => undefined);
    const result = await new DelegateAgentV2().run(input([call(), fauxAssistantMessage(draft), context => {
      expect(context.tools ?? []).toHaveLength(0);
      expect(JSON.stringify(context.messages)).toContain("DRAFT_FIXTURE");
      expect(JSON.stringify(context.messages.at(-1))).toContain('legalSourceNumbers');
      expect(JSON.stringify(context.messages.at(-1))).toContain("不调用工具");
      return fauxAssistantMessage(answer);
    }], { tools: [{ ...tool, execute }], authorize }));
    expect(result.text).toBe("**结论😀**");
    expect(result.citationStatus).toBe("valid"); expect(result.modelCalls).toBe(3);
    expect(result.citationDiagnostics?.recoveryCount).toBe(1);
    expect(result.citationDiagnostics?.firstErrors.length).toBeGreaterThan(0);
    expect(result.citationDiagnostics?.finalErrors).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.taskUsage).toEqual(result.usage);
    expect(authorize.mock.calls.at(-1)?.[0]).toBe("release");
    expect(JSON.stringify([result.events, result.spans, result.calls, result.citationDiagnostics])).not.toContain("SOURCE_BODY_FIXTURE");
  });
  it("[citation-recovery-04] allows empty-set correction and passes the empty legal set explicitly", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage(answer), context => {
      expect(JSON.stringify(context.messages.at(-1))).toContain('legalSourceNumbers\\\":[]');
      return fauxAssistantMessage("通用回答");
    }]));
    expect(result.modelCalls).toBe(2); expect(result.text).toBe("通用回答");
    expect(result.citationStatus).toBe("not_cited");
  });
  it("[citation-recovery-07] shares one chance between missing-citation self-check and unknown-source recovery", async () => {
    const result = await new DelegateAgentV2().run(input([call(), fauxAssistantMessage("独立通用解释"), fauxAssistantMessage('<reference source="9">仍错误</reference>'), fauxAssistantMessage("must not run")]));
    expect(result.modelCalls).toBe(3); expect(result.text).toBe(CITATION_FAILURE_TEXT);
    expect(result.citationStatus).toBe("invalid"); expect(result.citationRanges).toEqual([]);
    expect(result.sources).toEqual([]);
  });
  it("[citation-recovery-06/09] does not require a citation after a conditional self-check", async () => {
    const result = await new DelegateAgentV2().run(input([call(), fauxAssistantMessage("通用解释"), fauxAssistantMessage("仍为通用解释")]));
    expect(result.modelCalls).toBe(3); expect(result.text).toBe("仍为通用解释");
    expect(result.status).toBe("completed"); expect(result.citationStatus).toBe("not_cited");
  });
  it("does not self-check code samples or source-free general answers", async () => {
    for (const text of ["通用解释", '`<reference source="1">代码示例</reference>`']) {
      const result = await new DelegateAgentV2().run(input([fauxAssistantMessage(text)]));
      expect(result.modelCalls).toBe(1); expect(result.text).toBe(text);
    }
  });
  it("[citation-recovery-05] returns the fixed failure after one unsuccessful recovery, never the draft", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage(answer), fauxAssistantMessage(answer), fauxAssistantMessage("must not run")]));
    expect(result.text).toBe(CITATION_FAILURE_TEXT); expect(result.status).toBe("partial");
    expect(result.modelCalls).toBe(2); expect(result.citationStatus).toBe("invalid");
    expect(result.events.filter(e => e.type === "response.delta")).toHaveLength(1);
    expect(JSON.stringify(result.events)).not.toContain("<reference");
  });
  it("blocks tools during recovery even if the provider ignores the empty tool list", async () => {
    const execute = vi.fn(evidence);
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage(answer), call(), fauxAssistantMessage("must not run")], { tools: [{ ...tool, execute }] }));
    expect(execute).not.toHaveBeenCalled(); expect(result.modelCalls).toBe(2);
    expect(result.text).toBe(CITATION_FAILURE_TEXT);
  });
  it("does not save an invalid clarification, including the control-tool path", async () => {
    for (const first of [fauxAssistantMessage(`<waiting_user>${answer}`), call("request_clarification", { question: answer })]) {
      const saveSession = vi.fn(async () => undefined);
      const result = await new DelegateAgentV2().run(input([first, fauxAssistantMessage(answer)], { saveSession }));
      expect(saveSession).not.toHaveBeenCalled(); expect(result.session).toBeUndefined();
      expect(result.modelCalls).toBe(2); expect(result.text).toBe(CITATION_FAILURE_TEXT);
    }
  });
  it("saves only the corrected clarification", async () => {
    const saveSession = vi.fn(async () => undefined);
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage(`<waiting_user>${answer}`), fauxAssistantMessage("<waiting_user>请提供城市。")], { saveSession }));
    expect(result.status).toBe("waiting_user"); expect(result.text).toBe("请提供城市。");
    expect(saveSession).toHaveBeenCalledOnce(); expect(JSON.stringify(result.session)).not.toContain("<reference");
  });
  it("[citation-recovery-02] does not extend an exhausted attempt budget", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage(answer), fauxAssistantMessage("must not run")], { budget: { attempts: 1 } }));
    expect(result.modelCalls).toBe(1); expect(result.text).toBe(CITATION_FAILURE_TEXT);
    expect(result.citationDiagnostics?.recovery).toBe("budget_exhausted");
  });
  it("does not schedule a third turn when the original turn budget is exhausted", async () => {
    const result = await new DelegateAgentV2().run(input([call(), fauxAssistantMessage('<reference source="9">错误</reference>'), fauxAssistantMessage("must not run")], { budget: { modelTurns: 2 } }));
    expect(result.modelCalls).toBe(2); expect(result.citationDiagnostics?.recoveryCount).toBe(0);
    expect(result.text).toBe(CITATION_FAILURE_TEXT);
  });
  it("does not stack citation recovery onto empty-truncation finalization", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage([], { stopReason: "length" }), fauxAssistantMessage(answer), fauxAssistantMessage("must not run")]));
    expect(result.modelCalls).toBe(2); expect(result.text).toBe(CITATION_FAILURE_TEXT);
    expect(result.citationDiagnostics?.recoveryCount).toBe(0);
  });
  it("does not invoke a correction provider when its projected input exhausts tokens", async () => {
    const request = input([fauxAssistantMessage(answer), fauxAssistantMessage("must not run")]);
    let modelCalls = 0;
    const stream = request.model.streamFn;
    request.model.streamFn = (model, context, options) => {
      modelCalls++;
      // Keep enough for the first admitted call, not a second complete context.
      return stream(model, context, options);
    };
    request.budget = { totalTokens: 16_500, outputTokens: 1024, finalReserveTokens: 64 };
    const result = await new DelegateAgentV2().run(request);
    expect(modelCalls).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(result.error).toBe("budget_exhausted");
    expect(result.citationDiagnostics?.recoveryCount).toBe(0);
    expect(result.text).toBe(CITATION_FAILURE_TEXT);
  });
  it("uses the original active deadline while authorizing a correction", async () => {
    let models = 0;
    const authorize: V2RunInput["authorize"] = async boundary => {
      if (boundary === "model" && ++models === 2) await new Promise(() => undefined);
    };
    const runtime = new DelegateAgentV2();
    const result = await runtime.run(input([fauxAssistantMessage(answer), fauxAssistantMessage("must not run")], { authorize, budget: { activeMs: 100, finalReserveMs: 1 } }));
    expect(result.error).toBe("timeout"); expect(result.modelCalls).toBe(1);
    expect(result.text).toBe(CITATION_FAILURE_TEXT);
    expect((await runtime.run(input([fauxAssistantMessage("next")]))).text).toBe("next");
  });
  it("does not increase the original cost allowance for a correction", async () => {
    const request = input([fauxAssistantMessage(answer), fauxAssistantMessage("must not run")]);
    request.model.model = { ...request.model.model, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
    request.model.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage(answer);
      message.usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0.009, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    };
    // The first admission fits, then its reported usage leaves too little cost.
    request.budget = { costUsd: 0.02, outputTokens: 2048 };
    const result = await new DelegateAgentV2().run(request);
    expect(result.modelCalls).toBe(1); expect(result.error).toBe("budget_exhausted");
    expect(result.citationDiagnostics?.recoveryCount).toBe(0);
    expect(result.text).toBe(CITATION_FAILURE_TEXT);
  });
  it("retains release authorization after a successful correction", async () => {
    const authorize: V2RunInput["authorize"] = async boundary => { if (boundary === "release") throw new V2Error("permission_denied"); };
    const result = await new DelegateAgentV2().run(input([call(), fauxAssistantMessage('<reference source="9">错误</reference>'), fauxAssistantMessage(answer)], { authorize }));
    expect(result.modelCalls).toBe(3); expect(result.status).toBe("failed");
    expect(result.citationRanges).toEqual([]); expect(result.sources).toEqual([]);
    expect(result.text).not.toContain("结论");
  });
  it("[citation-recovery-08] validates partial text as well as complete text", async () => {
    const result = await new DelegateAgentV2().run(input([fauxAssistantMessage(`<partial>${answer}`), fauxAssistantMessage(`<partial>${answer}`)]));
    expect(result.text).toBe(CITATION_FAILURE_TEXT); expect(result.modelCalls).toBe(2);
  });
  it("[citation-recovery-03] rechecks model/release permissions and never releases a revoked result", async () => {
    let models = 0;
    const authorize: V2RunInput["authorize"] = async boundary => { if (boundary === "model" && ++models === 3) throw new V2Error("permission_denied"); };
    const result = await new DelegateAgentV2().run(input([call(), fauxAssistantMessage('<reference source="9">错误</reference>'), fauxAssistantMessage(answer)], { authorize }));
    expect(result.status).toBe("failed"); expect(result.error).toBe("permission_denied");
    expect(result.citationRanges).toEqual([]); expect(result.sources).toEqual([]);
    expect(result.events.some(e => e.type === "response.delta")).toBe(false);
  });
  it("[citation-recovery-03] cleans up the active-session lock on cancellation during recovery", async () => {
    const controller = new AbortController();
    const runtime = new DelegateAgentV2();
    const result = await runtime.run(input([fauxAssistantMessage(answer), () => { controller.abort(); return fauxAssistantMessage("must not deliver"); }], { signal: controller.signal }));
    expect(result.status).toBe("cancelled"); expect(result.session).toBeUndefined();
    expect((await runtime.run(input([fauxAssistantMessage("新请求")]))).text).toBe("新请求");
  });
});
