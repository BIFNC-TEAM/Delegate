import { fixtureContextAuthority } from "./context-authority-fixture";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { compactContext, DelegatePiAgentRuntime } from "../src/pi/runtime";
import { executionScopeHash } from "../src/pi/execution-state";
import type { PiAgentRunInput, PiExecutionCheckpoint } from "../src/pi/types";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const call = (...ids: string[]) => fauxAssistantMessage(ids.map(id =>
  fauxToolCall("execute_in_sandbox", { language: "python", code: "print(1)" }, { id })), { stopReason: "toolUse" });
const result = (id: string): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: "execute_in_sandbox", content: [{ type: "text", text: "synthetic result" }], isError: false, timestamp: 1 });
const history = (n: number) => Array.from({ length: n }, (_, i) => user(`prior user request ${i}`));

function ids(messages: AgentMessage[]) {
  return {
    calls: messages.flatMap(message => message.role === "assistant" ? message.content.flatMap(item => item.type === "toolCall" ? [item.id] : []) : []),
    results: messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []),
  };
}

describe("Pi context compaction", () => {
  it("preserves short complete interactions without changing the source", async () => {
    const messages = [user("task"), call("a", "b"), result("a"), result("b")];
    const snapshot = structuredClone(messages);
    expect(await compactContext(messages)).toEqual(snapshot);
    expect(messages).toEqual(snapshot);
  });

  it.each([1, 3])("keeps a complete recent batch of %i calls and never splits the old head", async (size) => {
    const recent = Array.from({ length: size }, (_, i) => `recent-${i}`);
    const messages = [user("original task"), call("old"), result("old"), ...history(36), call(...recent), ...recent.map(result)];
    const compacted = await compactContext(messages);
    const paired = ids(compacted);
    expect(paired.calls).toEqual(paired.results);
    expect(paired.calls).toEqual(expect.arrayContaining(recent));
    expect(compacted[0]).toEqual(user("original task"));
    expect(compacted.length).toBeLessThanOrEqual(32);
  });

  it("keeps an oversized latest batch intact rather than truncating its results", async () => {
    const batch = Array.from({ length: 40 }, (_, i) => `batch-${i}`);
    const compacted = await compactContext([user("task"), ...history(36), call(...batch), ...batch.map(result)]);
    expect(ids(compacted)).toEqual({ calls: batch, results: batch });
    expect(compacted.length).toBeGreaterThan(32);
  });

  it("preserves the entire unresolved batch without inventing successful results", async () => {
    const compacted = await compactContext([user("task"), ...history(36), call("done", "pending"), result("done")]);
    expect(ids(compacted)).toEqual({ calls: ["done", "pending"], results: ["done"] });
    expect(compacted.at(-1)).toEqual(result("done"));
  });

  it.each([
    [user("task"), result("orphan")],
    [user("task"), call("expected"), result("wrong")],
    [user("task"), call("one"), result("one"), result("one")],
  ])("rejects a malformed transcript instead of forwarding unrelated tool results", async (...messages) => {
    await expect(compactContext(messages)).rejects.toThrow("pi_context_tool_result_orphaned");
  });

  it("sends paired messages to the actual Pi model after approval checkpoint recovery", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels(); models.setProvider(faux.provider);
    const input: PiAgentRunInput = {
      contextAuthorization: fixtureContextAuthority("context-run"), runId: "context-run", sessionId: "context-session", executionProtocol: "goal_v2", userText: "继续原任务", maxSteps: 1,
      representative: { id: "rep", versionId: "v1", name: "Fixture", ownerName: "Owner", role: "Assistant", capabilities: ["代码"] },
      model: { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: faux.getModel().id },
      capabilities: { sandbox: { execute: vi.fn() } },
    };
    const checkpoint: PiExecutionCheckpoint = {
      version: 2, replaySourcesTracked: true, contextAuthorization: input.contextAuthorization!.snapshot(), runId: input.runId, sessionId: input.sessionId, scopeHash: executionScopeHash(input), goal: input.userText, turnsUsed: 0, activeMs: 0,
      pending: { approvalId: "approval", callId: "pending", toolName: "execute_in_sandbox" },
      observations: ["old", "pending"].map(id => ({ callId: id, toolName: "execute_in_sandbox", status: id === "old" ? "completed" : "pending_approval", text: "synthetic result", sources: [], artifacts: [] })),
      messages: [user("original task"), call("old"), result("old"), ...history(36), call("pending"), result("pending")],
    };
    let sent: AgentMessage[] | undefined;
    faux.setResponses([context => { sent = context.messages; return fauxAssistantMessage("已取得执行结果。"); }]);
    await new DelegatePiAgentRuntime().run({ ...input, checkpoint, approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status: "completed", text: "Synthetic approved output" } });
    expect(sent).toBeDefined();
    const paired = ids(sent!);
    expect(paired.calls).toEqual(paired.results);
    expect(paired.calls).toContain("pending");
  });
});
