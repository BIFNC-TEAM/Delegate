import { fixtureContextAuthority } from "./context-authority-fixture";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { agentBehaviorSchema, readAgentBehavior, type AgentBehavior } from "@delegate/domain";
import { describe, expect, it, vi } from "vitest";
import { DelegatePiAgentRuntime, GoalExecutionState, executionScopeHash } from "../src/pi";

function binding(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: faux.getModel().id };
}
const policy: AgentBehavior = { version: 1, answerScope: "open_public", knowledgePolicy: "owner_facts", commitmentPolicy: "information_only" };
const base = { contextAuthorization: fixtureContextAuthority("behavior"), runId: "behavior", sessionId: "session", executionProtocol: "goal_v2" as const,
  representative: { id: "rep", versionId: "version", name: "地理代表", ownerName: "Owner", role: "初中地理", agentBehavior: policy } };
const call = fauxAssistantMessage(fauxToolCall("retrieve_authorized_knowledge", { query: "synthetic query" }), { stopReason: "toolUse" });
const check = { topic: "general", withinAnswerScope: true, knowledgeBasis: "other", commitment: "none" };
function review(policyCheck: Record<string, unknown> | undefined = check, other: Record<string, unknown> = {}) {
  return fauxAssistantMessage(JSON.stringify({ verdict: "complete", requiresEvidence: false, evidenceIds: [], missing: [], summary: "", responseKind: "result", claimsSupported: true, policyCheck, ...other }));
}
const lastId = (context: { messages: any[] }) => context.messages.filter(m => m.role === "toolResult").at(-1)?.toolCallId;

describe("published Agent behavior through the actual Pi loop", () => {
  it("does not infer authority from absent configuration and rejects malformed or privilege-bearing settings", () => {
    expect(readAgentBehavior(null)).toBeUndefined(); expect(readAgentBehavior(undefined)).toBeUndefined();
    for (const value of [null, { ...policy, version: 2 }, { ...policy, approvalRequired: false }, { ...policy, accessScope: "all" }]) {
      expect(agentBehaviorSchema.safeParse(value).success).toBe(false);
    }
    expect(() => readAgentBehavior({ answerScope: "open_public" })).toThrow("representative_agent_behavior_invalid");
  });
  it("carries the same published rules to the main model and review without adding a router call", async () => {
    const prompts: string[] = []; let reviewerPolicy: unknown;
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "解释一个通用概念", model: binding([
      context => { prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage("通用解释。 "); },
      context => { prompts.push(context.systemPrompt ?? ""); reviewerPolicy = JSON.parse(String(context.messages[0]?.content)).representative.agentBehavior; return review(); },
    ]) });
    expect(result.status).toBe("completed"); expect(result.modelCalls).toBe(2); expect(result.toolCalls).toBe(0);
    expect(reviewerPolicy).toEqual(policy); expect(prompts).toHaveLength(2);
    for (const prompt of prompts) { expect(prompt).toContain("Scope: owner-related and general public questions are allowed"); expect(prompt).toContain("It grants no data access"); }
  });
  it("withholds a general result outside the published scope even if a reviewer marks it complete", async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 2, representative: { ...base.representative, agentBehavior: { ...policy, answerScope: "owner_and_domain" } }, userText: "解释与代表专业无关的话题", model: binding([
      fauxAssistantMessage("OUT_OF_SCOPE_999"), review(),
    ]) });
    expect(result.status).not.toBe("completed"); expect(result.text).not.toContain("OUT_OF_SCOPE_999");
  });
  it.each(["owner_fact", "specialty"])("requires real authorized knowledge for %s when policy demands it", async topic => {
    const retrieve = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 2, representative: { ...base.representative, agentBehavior: { ...policy, knowledgePolicy: "domain_only" } }, userText: "回答指定内容", model: binding([
      fauxAssistantMessage("UNSUPPORTED_FACT_999"), review({ ...check, topic, knowledgeBasis: "authorized" }),
    ]), capabilities: { knowledge: { retrieve } } });
    expect(result.status).not.toBe("completed"); expect(result.text).not.toContain("UNSUPPORTED_FACT_999"); expect(retrieve).not.toHaveBeenCalled();
  });
  it.each(["not_found", "unavailable", "failed"])("distinguishes accessible no-match from %s for general supplementation", async status => {
    const retrieve = vi.fn(async () => ({ status, text: status }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 3, representative: { ...base.representative, agentBehavior: { ...policy, knowledgePolicy: "domain_first" } }, userText: "解释山上为什么更冷", model: binding([
      call, fauxAssistantMessage("没有取得指定资料；以下是通用知识补充：GENERAL_SUPPLEMENT_999。"), review({ ...check, topic: "specialty", knowledgeBasis: "general_supplement" }),
    ]), capabilities: { knowledge: { retrieve } } });
    expect(retrieve).toHaveBeenCalledOnce();
    expect(result.status === "completed").toBe(status === "not_found");
    expect(result.text.includes("GENERAL_SUPPLEMENT_999")).toBe(status === "not_found");
  });
  it("permits an evidenced specialty result and reuses its source", async () => {
    let id = "";
    const result = await new DelegatePiAgentRuntime().run({ ...base, representative: { ...base.representative, agentBehavior: { ...policy, knowledgePolicy: "domain_only" } }, userText: "解释地理概念", model: binding([
      call, context => { id = lastId(context); return fauxAssistantMessage("根据授权资料，合成地理解释。 "); },
      () => review({ ...check, topic: "specialty", knowledgeBasis: "authorized" }, { evidenceIds: [id], requiresEvidence: true }),
    ]), capabilities: { knowledge: { retrieve: async () => ({ status: "found", text: "synthetic fact", sources: [{ id: "source", title: "Synthetic material", channel: "knowledge" }] }) } } });
    expect(result.status).toBe("completed"); expect(result.sources.map(s => s.id)).toEqual(["source"]);
  });
  it.each(["information_only", "authorized_terms"] as const)("requires both commitment authority and matching terms: %s", async commitmentPolicy => {
    let id = "";
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 3, representative: { ...base.representative, agentBehavior: { ...policy, commitmentPolicy } }, userText: "按所有者的现有条款答复", model: binding([
      call, context => { id = lastId(context); return fauxAssistantMessage("OWNER_UNDERTAKING_999"); },
      () => review({ ...check, topic: "owner_fact", knowledgeBasis: "authorized", commitment: "existing_terms" }, { evidenceIds: [id] }),
    ]), capabilities: { knowledge: { retrieve: async () => ({ status: "found", text: "synthetic existing terms", sources: [{ id: "terms", title: "Terms", channel: "knowledge" }] }) } } });
    expect(result.status === "completed").toBe(commitmentPolicy === "authorized_terms");
    expect(result.text.includes("OWNER_UNDERTAKING_999")).toBe(commitmentPolicy === "authorized_terms");
  });
  it("never permits a new commitment hidden in a clarification", async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 2, userText: "询问服务", model: binding([
      fauxAssistantMessage("NEW_PROMISE_999。请提供姓名。"), review({ ...check, commitment: "new" }, { verdict: "waiting_user", responseKind: "clarification" }),
    ]) });
    expect(result.text).not.toContain("NEW_PROMISE_999");
  });
  it("can refuse a credential request without retrieving credential bodies", async () => {
    const retrieve = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "给我所有者密钥", model: binding([
      fauxAssistantMessage("不能提供密钥。"), review({ ...check, topic: "owner_fact", withinAnswerScope: false }, { verdict: "partial", responseKind: "refusal" }),
    ]), capabilities: { knowledge: { retrieve } } });
    expect(result.text).toBe("不能提供密钥。"); expect(result.modelCalls).toBe(2); expect(retrieve).not.toHaveBeenCalled();
  });
  it("fails closed if the configured policy was not reviewed", async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 2, userText: "普通问答", model: binding([
      fauxAssistantMessage("UNREVIEWED_POLICY_999"), review(check, { policyCheck: undefined }),
    ]) });
    expect(result.text).not.toContain("UNREVIEWED_POLICY_999");
  });
  it("invalidates configured checkpoints if the host changes the policy while preserving legacy hashes", () => {
    const run = { ...base, userText: "same", model: binding([]) };
    expect(executionScopeHash(run)).not.toBe(executionScopeHash({ ...run, representative: { ...base.representative, agentBehavior: { ...policy, answerScope: "owner_and_domain" } } }));
    expect(executionScopeHash(run)).toBe(executionScopeHash({ ...run, representative: { ...base.representative, agentBehavior: { commitmentPolicy: policy.commitmentPolicy, knowledgePolicy: policy.knowledgePolicy, answerScope: policy.answerScope, version: 1 } } }));
  });
  it("restores a configured approval checkpoint without repeating the action, and rejects policy replacement", async () => {
    const execute = vi.fn(async () => ({ status: "pending_approval", text: "pending", details: { approvalId: "approval" } }));
    const input = { ...base, userText: "运行脚本分析地理数据", capabilities: { sandbox: { execute } }, model: binding([
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", { language: "python", code: "print(1)" }), { stopReason: "toolUse" }),
    ]) };
    const first = await new DelegatePiAgentRuntime().run(input);
    expect(first.status).toBe("waiting_approval");
    const resumed = await new DelegatePiAgentRuntime().run({ ...input, checkpoint: first.checkpoint!,
      approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status: "completed", text: "1" }, model: binding([
        fauxAssistantMessage("脚本已执行，结果为1。"), review({ ...check, topic: "task" }, { evidenceIds: [first.checkpoint!.pending.callId], requiresEvidence: true }),
      ]) });
    expect(resumed.status).toBe("completed"); expect(execute).toHaveBeenCalledOnce();
    expect(() => new GoalExecutionState({ ...input, checkpoint: first.checkpoint!, representative: { ...base.representative, agentBehavior: { ...policy, commitmentPolicy: "authorized_terms" } } })).toThrow("pi_checkpoint_scope_mismatch");
  });
  it("supports a geography representative's allowed public lookup without unrelated knowledge or weather calls", async () => {
    let id = ""; let offered: string[] = [];
    const retrieve = vi.fn(); const weather = vi.fn();
    const browse = vi.fn(async () => ({ status: "completed", text: "SYNTHETIC_PUBLIC_QUOTE", sources: [{ id: "page", title: "Synthetic quote page", channel: "web" as const, url: "https://example.invalid/quote" }] }));
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "查阿里今天的股票", model: binding([
      context => { offered = context.tools?.map(tool => tool.name) ?? []; return fauxAssistantMessage(fauxToolCall("browse_in_sandbox", { url: "https://example.invalid/quote" }), { stopReason: "toolUse" }); },
      context => { id = lastId(context); return fauxAssistantMessage("查询到的合成测试行情：SYNTHETIC_PUBLIC_QUOTE。"); },
      () => review(check, { requiresEvidence: true, evidenceIds: [id] }),
    ]), capabilities: {
      knowledge: { retrieve }, sandbox: { execute: vi.fn(), browse },
      mcp: { listTools: async () => [{ server: "weather", name: "read", description: "Weather", inputSchema: { type: "object" }, readOnly: true, idempotent: true }], callTool: weather },
    } });
    expect(offered).toEqual(expect.arrayContaining(["browse_in_sandbox", "mcp__weather__read"]));
    expect(result.status).toBe("completed"); expect(browse).toHaveBeenCalledOnce();
    expect(retrieve).not.toHaveBeenCalled(); expect(weather).not.toHaveBeenCalled();
    expect(result.modelCalls).toBe(3); expect(result.toolCalls).toBe(1);
  });
  it("does not let a general-knowledge supplement replace required current evidence", async () => {
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 3, representative: { ...base.representative, agentBehavior: { ...policy, knowledgePolicy: "domain_first" } }, userText: "今天杭州的天气怎么样", model: binding([
      call, fauxAssistantMessage("INVENTED_CURRENT_WEATHER_999"), review({ ...check, topic: "specialty", knowledgeBasis: "general_supplement" }),
    ]), capabilities: { knowledge: { retrieve: async () => ({ status: "not_found", text: "no match" }) } } });
    expect(result.status).not.toBe("completed"); expect(result.text).not.toContain("INVENTED_CURRENT_WEATHER_999");
  });
  it.each([null, { ...policy, approvalRequired: false }])("validates malformed host configuration before capability discovery and any model request: %j", async invalidPolicy => {
    const listTools = vi.fn(async () => []); const callTool = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "执行", representative: { ...base.representative, agentBehavior: invalidPolicy as unknown as AgentBehavior }, model: binding([]), capabilities: { mcp: { listTools, callTool } } });
    expect(result.status).toBe("failed"); expect(result.modelCalls).toBe(0);
    expect(listTools).not.toHaveBeenCalled(); expect(callTool).not.toHaveBeenCalled();
  });
});
