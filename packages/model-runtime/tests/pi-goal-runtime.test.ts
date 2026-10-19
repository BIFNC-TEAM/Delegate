import { fixtureContextAuthority } from "./context-authority-fixture";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DelegatePiAgentRuntime, GoalExecutionState, deriveEvidenceRequirements, observeBrowserPage, parseExecutionCheckpoint, type PiAgentRunInput, type PiModelBinding } from "../src/pi";

function binding(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]): PiModelBinding {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: faux.getModel().id };
}
const representative = { id: "rep", versionId: "version", name: "助手", ownerName: "Owner", role: "通用助手", capabilities: ["浏览器", "代码", "MCP"] };
const base = { contextAuthorization: fixtureContextAuthority("run"), runId: "run", sessionId: "session", representative, executionProtocol: "goal_v2" as const };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function review(verdict: string, evidenceIds: string[] = [], requiresEvidence = true) {
  return fauxAssistantMessage(JSON.stringify({ verdict, evidenceIds, requiresEvidence, missing: verdict === "complete" ? [] : ["未取得原问题所需内容"], summary: "暂未取得所需数据。", responseKind: "result", claimsSupported: verdict !== "continue" }));
}
function lastId(context: { messages: any[] }) { return context.messages.filter(m => m.role === "toolResult").at(-1)?.toolCallId; }

// These exercise the actual Pi loop; only external model/adapter transports are scripted.
describe("goal-driven Pi execution", () => {
  it.each([
    '把“今天股票市场休市”翻译成英文，只给译文。',
    '请将「查询今天杭州天气」译成英文。',
    '帮我把"使用沙盒生成result.csv文件"改写得简洁些。',
  ])("treats a quoted transformation operand as supplied text: %s", userText => {
    expect(deriveEvidenceRequirements({ ...base, userText, model: binding([]) }))
      .toMatchObject({ evidence: false, sandbox: false, browser: false, artifact: false });
  });

  it.each([
    '把“今天股票市场休市”翻译成英文，再查询今天杭州天气。',
    '翻译“今天股票市场休市”，并核实今天股票市场是否休市。',
  ])("keeps evidence for an additional lookup outside the quoted text: %s", userText => {
    expect(deriveEvidenceRequirements({ ...base, userText, model: binding([]) }).evidence).toBe(true);
  });

  it("releases the correct translation without tools or forced evidence retries", async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base,
      userText: '把“今天股票市场休市”翻译成英文，只给译文。', maxSteps: 2,
      model: binding([fauxAssistantMessage("The stock market is closed today."), review("complete", [], false)]),
    });
    expect(result.text).toBe("The stock market is closed today.");
    expect(result.status).toBe("completed"); expect(result.toolCalls).toBe(0); expect(result.modelCalls).toBe(2);
    expect(deriveEvidenceRequirements({ ...base, userText: '把“今天股票市场休市”翻译成英文。',
      evidenceRequirements: { evidence: true }, model: binding([]) }).evidence).toBe(true);
  });

  it.each(["如何在沙盒中运行脚本", "翻译：使用沙盒生成文件", "不要生成文件，直接解释", "翻译：今天的股票价格"])("does not infer execution from an explanation, quoted translation or negative request: %s", userText => {
    const requirements = deriveEvidenceRequirements({ ...base, userText, model: binding([]) });
    expect(requirements).toMatchObject({ sandbox: false, browser: false, artifact: false, evidence: false });
  });

  it("persists host-held requirements across an approval pause and rejects malformed requirements", async () => {
    const input: PiAgentRunInput = {
      ...base, userText: "执行授权任务", evidenceRequirements: { artifact: true },
      model: binding([call("execute_in_sandbox", { language: "python", code: "print('name,value')", expectedOutputs: ["result.csv"] })]),
      capabilities: { sandbox: { execute: async () => ({ status: "pending_approval", text: "pending", details: { approvalId: "requirements-approval" } }) } },
    };
    const first = await new DelegatePiAgentRuntime().run(input);
    expect(first.status).toBe("waiting_approval");
    expect(first.checkpoint?.evidenceRequirements?.artifact).toBe(true);
    expect(deriveEvidenceRequirements({ ...input, checkpoint: first.checkpoint!, evidenceRequirements: { artifact: false } }).artifact).toBe(true);
    expect(() => parseExecutionCheckpoint({ ...first.checkpoint!, evidenceRequirements: { artifact: "false" } })).toThrow("pi_checkpoint_invalid_evidence_requirements");
  });

  it.each(["查阿里今天的股票价格", "在沙盒中计算1+2", "生成 result.csv 文件并提供下载"])("does not let a permissive reviewer erase required evidence: %s", async userText => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText, maxSteps: 3, model: binding([
      fauxAssistantMessage("已完成，合成结果为123。"), review("complete", [], false), fauxAssistantMessage("仍然声称完成123。"),
    ]) });
    expect(result.status).not.toBe("completed");
    expect(result.text).not.toContain("123");
    expect(result.toolCalls).toBe(0);
  });

  it("requires the requested browser rather than accepting a different successful tool", async () => {
    let id = "";
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "使用沙盒浏览器查公开页面", maxSteps: 3, model: binding([
      call("mcp__fixture__read", {}), context => { id = lastId(context); return fauxAssistantMessage("已用沙盒浏览器完成。"); }, () => review("complete", [id], false),
    ]), capabilities: { mcp: { listTools: async () => [{ server: "fixture", name: "read", description: "Other public data", inputSchema: { type: "object" }, readOnly: true, idempotent: true }], callTool: async () => ({ status: "completed", text: "Other tool result" }) } } });
    expect(result.status).not.toBe("completed");
    expect(result.text).not.toContain("已用沙盒浏览器完成");
  });

  it("does not accept execution text as a downloadable file", async () => {
    let id = "";
    const execute = vi.fn(async () => ({ status: "completed", text: "program ran", artifacts: [] }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "生成 result.csv 文件并提供下载", maxSteps: 3, model: binding([
      call("execute_in_sandbox", { language: "python", code: "print('name,value')", expectedOutputs: ["result.csv"] }),
      context => { id = lastId(context); return fauxAssistantMessage("result.csv 已生成并可下载。"); }, () => review("complete", [id], false),
    ]), capabilities: { sandbox: { execute } } });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.status).not.toBe("completed");
    expect(result.text).not.toContain("已生成并可下载");
  });

  it("uses the queued receipt as a handoff barrier and never publishes a connected claim", async () => {
    const handoff = vi.fn(async () => ({ status: "queued", text: "queued, not connected", details: { queueId: "queue" } }));
    const execute = vi.fn(async () => ({ status: "completed", text: "must not run after handoff" }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "请转人工", model: binding([
      fauxAssistantMessage([fauxToolCall("request_human_handoff", { reason: "user", summary: "fixture" }), fauxToolCall("execute_in_sandbox", { language: "python", code: "print(1)" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("已接通真人。"), review("complete", [], false),
    ]), capabilities: { handoff: { request: handoff }, sandbox: { execute } } });
    expect(handoff).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toContain("排队");
    expect(result.text).not.toContain("已接通");
    expect(result.modelCalls).toBe(1);
  });

  it("does not forward private provider exceptions as model-visible tool results", async () => {
    const secret = "SYNTHETIC_PROVIDER_SECRET";
    const execute = vi.fn(async () => { throw new Error(`request failed with token=${secret}`); });
    let observedMessages = "";
    await new DelegatePiAgentRuntime().run({
      ...base, maxToolRetries: 0, userText: "尝试查询并说明结果", model: binding([
        call("mcp__fixture__read", {}),
        context => { observedMessages = JSON.stringify(context.messages); return fauxAssistantMessage("查询暂时失败。"); },
        review("complete", [], false),
      ]), capabilities: { mcp: {
        listTools: async () => [{ server: "fixture", name: "read", description: "Read", inputSchema: { type: "object", properties: {} }, readOnly: true, idempotent: true }],
        callTool: execute,
      } },
    });
    expect(observedMessages.length).toBeGreaterThan(0);
    expect(observedMessages).not.toContain(secret);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns a safe failure code when capability discovery throws private diagnostics", async () => {
    const secret = "SYNTHETIC_DISCOVERY_SECRET";
    const result = await new DelegatePiAgentRuntime().run({
      ...base, userText: "查询", model: binding([]),
      capabilities: { mcp: { listTools: async () => { throw new Error(`provider failed: password=${secret}`); }, callTool: vi.fn() } },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("operation_failed");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("executes original MCP arguments without retaining them in audit events", async () => {
    const secret = "SYNTHETIC_ARGUMENT_CANARY";
    const args = { note: secret, nested: [{ password: secret }], url: `https://example.invalid/?token=${secret}` };
    const execute = vi.fn(async (input: { arguments: Record<string, unknown> }) => {
      expect(input.arguments).toEqual(args);
      return { status: "completed", text: "Synthetic public result" };
    });
    const result = await new DelegatePiAgentRuntime().run({
      ...base, userText: "运行获准查询", model: binding([
        call("mcp__fixture__read", args), fauxAssistantMessage("查询已返回结果。"), review("complete", [], false),
      ]), capabilities: { mcp: {
        listTools: async () => [{ server: "fixture", name: "read", description: "Read", inputSchema: { type: "object", properties: { note: { type: "string" }, nested: { type: "array", items: {} }, url: { type: "string" } } }, readOnly: true, idempotent: true }],
        callTool: execute,
      } },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].arguments).toEqual(args);
    expect(JSON.stringify({ events: result.events, spans: result.spans })).not.toContain(secret);
    expect(args.note).toBe(secret);
  });

  it("does not offer unclassified or conflicting host MCP behavior to the model", async () => {
    const execute = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({
      ...base, userText: "有哪些可用能力", model: binding([
        context => {
          const names = context.tools?.map(tool => tool.name) ?? [];
          expect(names).toContain("mcp__fixture__read");
          expect(names).not.toContain("mcp__fixture__unknown");
          expect(names).not.toContain("mcp__fixture__conflict");
          return fauxAssistantMessage("可使用已验证的查询能力。");
        }, review("complete", [], false),
      ]), capabilities: { mcp: {
        listTools: async () => [
          { server: "fixture", name: "read", description: "Read", inputSchema: { type: "object" }, readOnly: true, idempotent: true, effectClassification: "read" },
          { server: "fixture", name: "unknown", description: "Unknown", inputSchema: { type: "object" }, readOnly: false, idempotent: false, effectClassification: "unknown" },
          { server: "fixture", name: "conflict", description: "Conflicting", inputSchema: { type: "object" }, readOnly: true, idempotent: false, effectClassification: "write" },
        ], callTool: execute,
      } },
    });
    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps stable no-tool answers valid", async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "1+2等于多少", model: binding([fauxAssistantMessage("3"), review("complete", [], false)]) });
    expect(result.status).toBe("completed"); expect(result.text).toBe("3"); expect(result.modelCalls).toBe(2);
    expect(result.spans.some(s => s.operation === "goal_assessment" && s.totalTokens !== undefined)).toBe(true);
  });

  it("rejects irrelevant real MCP evidence then permits browser without a domain router", async () => {
    let browserId = "";
    const browser = vi.fn(async () => ({ status: "completed", text: "Requested conference starts at 09:00" }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "查一下大会今天的开始时间", model: binding([
      call("mcp__weather__read", {}), fauxAssistantMessage("杭州31度。"), review("continue"),
      context => { expect(context.tools?.some(t => t.name === "browse_in_sandbox")).toBe(true); return call("browse_in_sandbox", { url: "https://example.com/event" }); },
      context => { browserId = lastId(context); return fauxAssistantMessage("大会09:00开始。"); },
      () => review("complete", [browserId]),
    ]), capabilities: {
      sandbox: { execute: vi.fn(), browse: browser },
      mcp: { listTools: async () => [{ server: "weather", name: "read", description: "Weather", inputSchema: { type: "object", properties: {} }, readOnly: true, idempotent: true }], callTool: async () => ({ status: "completed", text: "杭州31度" }) },
    } });
    expect(browser).toHaveBeenCalledTimes(1); expect(result.status).toBe("completed"); expect(result.text).not.toContain("31");
  });

  it.each([true, false])("does not accept a 429 page even when the verifier claims completion (requiresEvidence=%s)", async requiresEvidence => {
    let id = "";
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 3, userText: "读取该页面", model: binding([
      call("browse_in_sandbox", { url: "https://example.com" }),
      context => { id = lastId(context); return fauxAssistantMessage("成功获取数据。"); },
      () => review("complete", [id], requiresEvidence),
    ]), capabilities: { sandbox: { execute: vi.fn(), browse: async () => ({ status: "completed", text: "Too Many Requests", observation: { state: "blocked", httpStatus: 429 } }) } } });
    expect(result.status).toBe("partial"); expect(result.text).not.toContain("成功获取");
  });

  it("persists native tool IDs and resumes without rerunning an approved step or removing the browser", async () => {
    const browse = vi.fn(async () => ({ status: "pending_approval", text: "approval", details: { approvalId: "a1" } }));
    const firstInput: PiAgentRunInput = { ...base, contextAuthorization: { ...fixtureContextAuthority("run"), hasResultSource: (ref, tool) => ref === "browser-receipt" && tool === "browse_in_sandbox" }, userText: "依次读取两个网页", model: binding([call("browse_in_sandbox", { url: "https://example.com/one" })]), capabilities: { sandbox: { execute: vi.fn(), browse } } };
    const first = await new DelegatePiAgentRuntime().run(firstInput);
    expect(first.status).toBe("waiting_approval"); expect(first.checkpoint?.pending.approvalId).toBe("a1");
    expect(first.modelCalls).toBe(1);
    const next = vi.fn(async () => ({ status: "pending_approval", text: "approval", details: { approvalId: "a2" } }));
    const second = await new DelegatePiAgentRuntime().run({ ...firstInput, checkpoint: first.checkpoint!, approvedToolResult: { approvalId: "a1", toolName: "browse_in_sandbox", status: "completed", text: "Page one", contextSourceRef: "browser-receipt" }, model: binding([
      context => {
        expect(JSON.stringify(context.messages)).toContain("Page one");
        expect(context.tools?.some(t => t.name === "browse_in_sandbox")).toBe(true);
        return call("browse_in_sandbox", { url: "https://example.com/two" });
      },
    ]), capabilities: { sandbox: { execute: vi.fn(), browse: next } } });
    expect(next).toHaveBeenCalledTimes(1); expect(browse).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("waiting_approval"); expect(second.checkpoint?.pending.approvalId).toBe("a2");
    expect(second.checkpoint!.turnsUsed).toBeGreaterThan(first.checkpoint!.turnsUsed);
    expect(second.checkpoint!.activeMs).toBeGreaterThanOrEqual(first.checkpoint!.activeMs);
    expect(second.checkpoint!.observations[0]?.text).toBe("Page one");
    expect(second.checkpoint!.nextActionOrdinal).toBe(3);
    expect((next.mock.calls as unknown as Array<[{ context: { logicalAction: { ordinal: number } } }]>)[0]![0].context.logicalAction.ordinal).toBe(2);
    expect(() => new GoalExecutionState({ ...firstInput, userText: "不同目标", checkpoint: first.checkpoint! })).toThrow("scope_mismatch");
    expect(() => new GoalExecutionState({ ...firstInput, checkpoint: first.checkpoint!, approvedToolResult: { approvalId: "wrong", toolName: "browse_in_sandbox", status: "completed", text: "wrong" } }).restoreMessages(["browse_in_sandbox"])).toThrow("approval_mismatch");
  });

  it("fails closed when goal verification is unavailable", async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "读取网页", model: binding([fauxAssistantMessage("已完成"), fauxAssistantMessage("not JSON")]) });
    expect(result.status).toBe("partial"); expect(result.text).toContain("核验未完成");
  });

  it("classifies transport evidence and rejects malformed or oversized checkpoints", () => {
    expect(observeBrowserPage({ httpStatus: 200, textSnippet: "" }).state).toBe("empty");
    expect(observeBrowserPage({ httpStatus: 403, textSnippet: "Login" }).state).toBe("blocked");
    expect(observeBrowserPage({ httpStatus: 200, textSnippet: "real page" }).state).toBe("available");
    expect(() => parseExecutionCheckpoint({ version: 2 })).toThrow();
    expect(() => parseExecutionCheckpoint({ text: "x".repeat(1024 * 1024) })).toThrow();
  });
  it("stops after an unknown write outcome instead of replanning another write", async () => {
    const write = vi.fn(async () => { throw new Error("connection lost after dispatch"); });
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "创建订单", model: binding([call("mcp__orders__create", {})]), capabilities: {
      mcp: { listTools: async () => [{ server: "orders", name: "create", description: "Create order", inputSchema: { type: "object", properties: {} }, readOnly: false, idempotent: false }], callTool: write },
    } });
    expect(write).toHaveBeenCalledTimes(1); expect(result.status).toBe("waiting_user"); expect(result.modelCalls).toBe(1); expect(result.text).toContain("避免重复");
  });

  it("does not execute later calls in a batch after an approval barrier, and does not reset a spent budget", async () => {
    const browse = vi.fn(async () => ({ status: "pending_approval", text: "approval", details: { approvalId: "a1" } }));
    const model = binding([fauxAssistantMessage([
      fauxToolCall("browse_in_sandbox", { url: "https://example.com/one" }, { id: "one" }),
      fauxToolCall("browse_in_sandbox", { url: "https://example.com/two" }, { id: "two" }),
    ], { stopReason: "toolUse" })]);
    const input: PiAgentRunInput = { ...base, model, userText: "读取两页", capabilities: { sandbox: { execute: vi.fn(), browse } } };
    const first = await new DelegatePiAgentRuntime().run(input);
    expect(browse).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("waiting_approval");
    const restored = new GoalExecutionState({ ...input, checkpoint: first.checkpoint!, approvedToolResult: { approvalId: "a1", toolName: "browse_in_sandbox", status: "completed", text: "prior authorized page" } });
    const messages = restored.restoreMessages([]);
    expect(JSON.stringify(messages)).not.toContain("prior authorized page");
    expect(restored.observations[0]?.status).toBe("unavailable");
    const second = await new DelegatePiAgentRuntime().run({ ...input, maxSteps: first.checkpoint!.turnsUsed, checkpoint: first.checkpoint!, approvedToolResult: { approvalId: "a1", toolName: "browse_in_sandbox", status: "completed", text: "page" } });
    expect(second.modelCalls).toBe(0); expect(second.status).toBe("failed");
    expect(browse).toHaveBeenCalledTimes(1);
  });

});
