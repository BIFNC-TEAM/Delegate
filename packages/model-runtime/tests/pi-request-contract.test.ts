import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DelegatePiAgentRuntime } from "../src/pi/runtime";

function binding(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { model: faux.getModel(), streamFn: models.streamSimple.bind(models), provider: "faux", modelId: faux.getModel().id };
}
const base = { runId: "contract", sessionId: "session", representative: { id: "rep", name: "地理代表", ownerName: "测试所有者", role: "初中地理", instructions: "允许公开问答；不代表所有者作出业务承诺。", capabilities: ["公开问答", "授权知识"] }, currentTime: "2026-09-28T00:00:00Z" };

describe("active Pi request contract", () => {
  it("sends one coherent rule set and a scoped knowledge description through the actual SDK", async () => {
    let prompt = "";
    let knowledgeDescription = "";
    const result = await new DelegatePiAgentRuntime().run({ ...base, userText: "解释一个稳定的通用概念", executionProtocol: "goal_v2", model: binding([
      context => {
        prompt = context.systemPrompt ?? "";
        knowledgeDescription = context.tools?.find(tool => tool.name === "retrieve_authorized_knowledge")?.description ?? "";
        return fauxAssistantMessage("这是通用解释。");
      },
      fauxAssistantMessage(JSON.stringify({ verdict: "complete", requiresEvidence: false, evidenceIds: [], missing: [], summary: "", responseKind: "result", claimsSupported: true })),
    ]), capabilities: { knowledge: { retrieve: async () => ({ status: "found", text: "Synthetic authorized evidence" }) } } });
    expect(result.status).toBe("completed");
    expect(prompt).not.toContain("immutable goal");
    expect(prompt).not.toContain("before answering, refusing");
    expect(prompt).not.toContain("execute the original script unchanged first");
    expect(prompt).not.toContain("only for public current information");
    expect(prompt).not.toContain("fact and its actual source title");
    expect(prompt).not.toContain("unless its successful tool result appears in this run");
    expect(prompt).toContain("AUTHORIZATION BEFORE RETRIEVAL");
    expect(prompt).toContain("public current and historical information");
    expect(prompt).toContain("may modify or cancel");
    expect(prompt).toContain("users may name sources");
    expect(knowledgeDescription).not.toContain("every organization-specific/private question");
  });

  it.each(["completed", "failed"] as const)("does not turn approval into an unconditional success claim: %s", async status => {
    let prompt = "";
    await new DelegatePiAgentRuntime().run({ ...base, executionProtocol: "legacy_v1", userText: "说明上一步的状态", approvedToolResult: { approvalId: "approval", toolName: "execute_in_sandbox", status, text: "Synthetic receipt" }, model: binding([
      context => {
        prompt = context.systemPrompt + JSON.stringify(context.messages);
        return fauxAssistantMessage("以实际回执为准。");
      },
    ]) });
    expect(prompt).not.toContain("already executed successfully");
    expect(prompt).not.toContain("already completed successfully");
    expect(prompt).not.toContain("content was already read successfully");
    expect(prompt).toContain(status);
  });
});
