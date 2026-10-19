import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DelegatePiAgentRuntime, executionScopeHash, type PiAgentRunInput } from "../src/pi";
import { fixtureContextAuthority } from "./context-authority-fixture";
import { AgentContextAuthorizationError } from "@delegate/runtime";
import { createObservedProviderFetch } from "../src/pi/provider";
function binding(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const f = fauxProvider({ tokensPerSecond: 100000 }); f.setResponses(responses); const models = createModels(); models.setProvider(f.provider);
  return { model: f.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: f.getModel().id };
}
const canary = "SYNTHETIC_REVOKED_CONTEXT_CANARY";
const base = { runId: "context-run", sessionId: "session", conversationId: "conversation", userId: "audience", executionProtocol: "goal_v2" as const,
  representative: { id: "representative", versionId: "v1", name: "Representative", role: "Assistant" }, userText: "依据资料继续任务" };
function checkpoint() {
  const input = { ...base, model: binding([]) };
  return { version: 2 as const, replaySourcesTracked: true, runId: base.runId, sessionId: base.sessionId, scopeHash: executionScopeHash(input), goal: base.userText, turnsUsed: 0, activeMs: 0,
    pending: { approvalId: "approval", callId: "pending", toolName: "execute_in_sandbox" }, observations: [
      { callId: "knowledge", toolName: "retrieve_authorized_knowledge", status: "found", text: canary, sources: [], artifacts: [] },
      { callId: "pending", toolName: "execute_in_sandbox", status: "pending_approval", text: canary, sources: [], artifacts: [] }],
    messages: [{ role: "user" as const, content: base.userText, timestamp: 1 },
      fauxAssistantMessage(fauxToolCall("execute_in_sandbox", { language: "python", code: `print('${canary}')` }, { id: "pending" }), { stopReason: "toolUse" }),
      { role: "toolResult" as const, toolName: "execute_in_sandbox", toolCallId: "pending", content: [{ type: "text" as const, text: "pending" }], isError: false, timestamp: 1 }] };
}
describe("context authorization boundaries", () => {
  it.each([undefined, "forged-receipt", "wrong-tool"])("does not accept a replayable flag with an unregistered remote reference %s", async reference => {
    const guard = { ...fixtureContextAuthority(base.runId), hasResultSource: (ref: string, tool: string) => ref === "valid" && tool === "browse_in_sandbox" };
    const saved = checkpoint();
    saved.observations.push({ callId: "remote", toolName: reference === "wrong-tool" ? "mcp__fixture__read" : "browse_in_sandbox", status: "completed", text: canary, sources: [], artifacts: [],
      ...(reference ? { contextSourceRef: reference === "wrong-tool" ? "valid" : reference } : {}) } as never);
    const stream = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, contextAuthorization: guard,
      checkpoint: { ...saved, contextAuthorization: guard.snapshot(), replaySourcesTracked: true },
      approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status: "completed", text: "receipt" }, model: { ...binding([]), streamFn: stream } });
    expect(result.contextAuthorizationBlocked).toBe(true); expect(stream).not.toHaveBeenCalled();
  });
  it("P02: never sends unproven old checkpoint copies to a model or another tool", async () => {
    const contexts: unknown[] = []; const execute = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, checkpoint: checkpoint(), approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status: "completed", text: "receipt" },
      model: binding([context => { contexts.push(context); return fauxAssistantMessage("continue"); }]), capabilities: { sandbox: { execute } }, maxSteps: 1 });
    expect(JSON.stringify(contexts)).not.toContain(canary); expect(contexts).toHaveLength(0); expect(execute).not.toHaveBeenCalled();
    expect(result.artifacts).toEqual([]);
  });
  it("reuses a proved and currently authorized checkpoint without repeating the approved action", async () => {
    const guard = fixtureContextAuthority(base.runId); const contexts: unknown[] = []; const execute = vi.fn();
    await new DelegatePiAgentRuntime().run({ ...base, contextAuthorization: guard, checkpoint: { ...checkpoint(), contextAuthorization: guard.snapshot() },
      approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status: "completed", text: "verified receipt" },
      model: binding([context => { contexts.push(context); return fauxAssistantMessage("verified receipt"); }]), maxSteps: 1, capabilities: { sandbox: { execute } } });
    expect(contexts).toHaveLength(1); expect(JSON.stringify(contexts)).toContain(canary); expect(execute).not.toHaveBeenCalled();
  });
  it("blocks a once-valid proof after revocation, before either the main model or reviewer", async () => {
    const guard = fixtureContextAuthority(base.runId); const contexts: unknown[] = []; const execute = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, contextAuthorization: { ...guard, check: async () => { throw new AgentContextAuthorizationError(); } },
      checkpoint: { ...checkpoint(), contextAuthorization: guard.snapshot() },
      approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status: "completed", text: canary, artifacts: [{ id: "file", fileName: canary, mimeType: "text/plain", sizeBytes: 8 }] },
      model: binding([context => { contexts.push(context); return fauxAssistantMessage(canary); }]), capabilities: { sandbox: { execute } } });
    expect(contexts).toEqual([]); expect(execute).not.toHaveBeenCalled(); expect(result.contextAuthorizationBlocked).toBe(true);
    expect(JSON.stringify({ text: result.text, artifacts: result.artifacts, sources: result.sources, messages: result.messages })).not.toContain(canary);
  });
  it("does not treat a scope proof as reauthorization of opaque prior remote results", async () => {
    const guard = fixtureContextAuthority(base.runId); const stream = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, contextAuthorization: guard, checkpoint: { ...checkpoint(), contextAuthorization: guard.snapshot(), replaySourcesTracked: false },
      approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status: "completed", text: canary },
      model: { ...binding([]), streamFn: stream } });
    expect(stream).not.toHaveBeenCalled(); expect(result.contextAuthorizationBlocked).toBe(true);
  });
  it("stops a tool argument derived from recalled text if access changes during model generation", async () => {
    let valid = true; let calls = 0; const external = vi.fn(); const guard = fixtureContextAuthority(base.runId);
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "读取资料并登记", contextAuthorization: { ...guard, check: async () => { if (!valid) throw new AgentContextAuthorizationError(); } },
      model: binding([
        () => { calls++; return fauxAssistantMessage(fauxToolCall("retrieve_authorized_knowledge", { query: "policy" }), { stopReason: "toolUse" }); },
        context => { calls++; expect(JSON.stringify(context.messages)).toContain(canary); valid = false; return fauxAssistantMessage(fauxToolCall("mcp__records__create", { note: canary }), { stopReason: "toolUse" }); },
      ]), capabilities: { knowledge: { retrieve: async () => ({ status: "found", text: canary }) },
        mcp: { listTools: async () => [{ server: "records", name: "create", description: "Synthetic record", inputSchema: { type: "object" }, readOnly: false, idempotent: false }], callTool: external } } });
    expect(calls).toBe(2); expect(external).not.toHaveBeenCalled(); expect(result.contextAuthorizationBlocked).toBe(true); expect(result.text).not.toContain(canary);
  });
  it("withholds a generated candidate if authorization is lost before review/release", async () => {
    let valid = true; let calls = 0; const guard = fixtureContextAuthority(base.runId);
    const result = await new DelegatePiAgentRuntime().run({ ...base, contextAuthorization: { ...guard, check: async () => { if (!valid) throw new AgentContextAuthorizationError(); } },
      model: binding([() => { calls++; valid = false; return fauxAssistantMessage(canary); }]) });
    expect(calls).toBe(1); expect(result.text).not.toContain(canary); expect(result.contextAuthorizationBlocked).toBe(true);
  });
  it("rechecks before a provider retry and never sends the stale body again", async () => {
    let valid = true; const fetch = vi.fn(async () => { valid = false; return new Response("busy", { status: 429 }); });
    const guarded = createObservedProviderFetch({ fetch, beforeRequest: async () => { if (!valid) throw new AgentContextAuthorizationError(); }, maximumRetries: 1, maximumRetryDelayMs: 2000 });
    await guarded("https://synthetic.invalid", { method: "POST", body: canary });
    await expect(guarded("https://synthetic.invalid", { method: "POST", body: canary })).rejects.toThrow("authorization_failed"); expect(fetch).toHaveBeenCalledOnce();
  });
});
