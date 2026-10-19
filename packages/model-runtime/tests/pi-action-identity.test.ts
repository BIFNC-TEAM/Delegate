import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentActionIdentityError } from "@delegate/runtime";
import { DelegatePiAgentRuntime } from "../src/pi";
function model(messages: ReturnType<typeof fauxAssistantMessage>[]) {
  const provider = fauxProvider({ tokensPerSecond: 100000 }); provider.setResponses(messages); const models = createModels(); models.setProvider(provider.provider);
  return { model: provider.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: provider.getModel().id };
}
const base = { runId: "same-origin-run", sessionId: "conversation", userText: "请独立执行两次相同的提交", maxSteps: 2,
  representative: { id: "rep", versionId: "version", name: "Synthetic", role: "Assistant" } };
const descriptor = { server: "fixture", name: "create", description: "Submit an authorized synthetic record", inputSchema: { type: "object", properties: { amount: { type: "number" } } }, readOnly: false, idempotent: false };
const call = (id: string) => fauxAssistantMessage(fauxToolCall("mcp__fixture__create", { amount: 1 }, { id }), { stopReason: "toolUse" });
describe("host logical action identity", () => {
  it("does not claim completion or submit another action when the provider reports processing", async () => {
    const submit = vi.fn(async () => ({ status: "failed", text: "The provider is still processing.", details: { semanticOutcome: "unknown", transportOutcome: "response_received" }, observation: { state: "unknown" as const } }));
    const result = await new DelegatePiAgentRuntime().run({ ...base,
      model: model([fauxAssistantMessage([fauxToolCall("mcp__fixture__create", { amount: 1 }, { id: "first" }), fauxToolCall("mcp__fixture__create", { amount: 2 }, { id: "second" })], { stopReason: "toolUse" })]),
      capabilities: { mcp: { listTools: async () => [descriptor], callTool: submit } } });
    expect(submit).toHaveBeenCalledOnce(); expect(result.status).toBe("waiting_user"); expect(result.text).not.toContain("已完成");
  });
  it("P05: two explicitly requested identical effects receive distinct logical actions", async () => {
    const submit = vi.fn(async () => ({ status: "completed", text: "Synthetic receipt" }));
    await new DelegatePiAgentRuntime().run({ ...base, model: model([call("first-call"), call("second-call")]),
      capabilities: { mcp: { listTools: async () => [descriptor], callTool: submit } } });
    expect(submit).toHaveBeenCalledTimes(2);
    const calls = submit.mock.calls as unknown as Array<[{ context: { logicalAction: { ordinal: number } }; arguments: unknown; idempotencyKey: string }]>;
    expect(calls.map(([input]) => input.context.logicalAction.ordinal)).toEqual([1, 2]);
    expect(calls[0]![0].arguments).toEqual(calls[1]![0].arguments); expect(calls[0]![0].idempotencyKey).not.toBe(calls[1]![0].idempotencyKey);
  });
  it("keeps the first logical action stable across a worker restart with a different model tool-call ID", async () => {
    const submit = vi.fn(async () => ({ status: "completed", text: "Synthetic receipt" }));
    for (const id of ["before-restart", "after-restart"]) await new DelegatePiAgentRuntime().run({ ...base, maxSteps: 1, model: model([call(id)]),
      capabilities: { mcp: { listTools: async () => [descriptor], callTool: submit } } });
    const calls = submit.mock.calls as unknown as Array<[{ idempotencyKey: string }]>;
    expect(calls).toHaveLength(2); expect(calls[0]![0].idempotencyKey).toBe(calls[1]![0].idempotencyKey);
  });
  it("does not retry or switch tools when the Broker rejects a conflicting or unresolved action", async () => {
    const submit = vi.fn(async () => { throw new AgentActionIdentityError("logical_action_previous_unresolved"); }); const compute = vi.fn();
    const result = await new DelegatePiAgentRuntime().run({ ...base, maxToolRetries: 3,
      model: model([fauxAssistantMessage([fauxToolCall("mcp__fixture__create", { amount: 1 }, { id: "one" }),
        fauxToolCall("execute_in_sandbox", { language: "python", code: "print(1)" }, { id: "two" })], { stopReason: "toolUse" })]),
      capabilities: { mcp: { listTools: async () => [{ ...descriptor, idempotent: true }], callTool: submit }, sandbox: { execute: compute } } });
    expect(submit).toHaveBeenCalledOnce(); expect(compute).not.toHaveBeenCalled(); expect(result.status).toBe("waiting_user"); expect(result.text).toContain("核对原操作");
  });
});
