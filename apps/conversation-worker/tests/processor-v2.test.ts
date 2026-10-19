import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), adapters: vi.fn(), complete: vi.fn(), deliver: vi.fn(), gate: vi.fn(), authorizeUsage: vi.fn(), prior: vi.fn(), stream: vi.fn() }));
vi.mock("../src/processor-pi", () => ({ buildPiAdapters: mocks.adapters, deliverGenerationOutput: mocks.deliver }));
vi.mock("@delegate/model-runtime/v2", async original => ({ ...await original<typeof import("@delegate/model-runtime/v2")>(),
  createV2ModelBindingFromEnv: () => ({ ok: true, binding: { provider: "faux", modelId: "faux" } }), delegateAgentV2: { run: mocks.run } }));
vi.mock("@delegate/web-data", () => ({
  buildRepresentativeRuntimeProfile: () => ({ contract: { freeReplyLimit: 2 } }), buildSandboxAttachmentPath: () => "/attachments/a",
  createAgentContextAuthorization: async () => ({ check: mocks.gate, registerKnowledge: vi.fn(), registerToolResult: vi.fn() }),
  authorizeGenerationRunFreeUsage: mocks.authorizeUsage, reserveGenerationConversationWalletUsage: async () => false,
  completeInlineGenerationRun: mocks.complete, getRepresentativeRuntimeAuthoritySnapshot: async () => ({ compute: { capabilityModes: { exec: "ask", write: "ask", browser: "allow" } } }),
  loadGenerationRecentTurns: async () => [], loadGenerationV2Task: mocks.prior,
  projectPublicAnswerSources: (sources: unknown) => sources, readPublicExecution: () => [], updateGenerationPiProgress: async () => undefined, updateGenerationPiStream: mocks.stream,
}));
import { processV2ConversationTurn, shouldUseAgentV2 } from "../src/processor-v2";
const makeHost = () => ({ config: {}, item: { runId: "run", conversationId: "conv", inputMessageId: "message", representativeSlug: "test", representativeName: "Test", representativeVersionId: "version", contactId: "contact", audienceIdentityId: "audience", channel: "web", userText: "test", accessMode: "FREE", inputAttachments: [] },
  setup: { id: "rep", ownerName: "Owner", tagline: "Assistant", tone: "concise" }, leaseGuard: { confirmOwned: vi.fn(async () => undefined) }, workLease: { outboxId: "outbox", leaseAttempt: 1 } });
const usage = { modelTurns: 1, toolCalls: 0, attempts: 0, tokens: 10, inputTokens: 8, outputTokens: 2, costUsd: 0, activeMs: 5 };
beforeEach(() => {
  vi.clearAllMocks(); mocks.adapters.mockReturnValue({}); mocks.prior.mockResolvedValue(null); mocks.authorizeUsage.mockResolvedValue(false);
  mocks.complete.mockResolvedValue({ message: { id: "reply", text: "answer" } });
  mocks.run.mockResolvedValue({ runtime: "delegate-agent-v2", traceId: "trace", status: "completed", text: "answer", sources: [], artifacts: [], sourceBindings: {},
    events: [], spans: [], calls: [], modelCalls: 1, toolCalls: 0, totalDurationMs: 5, usage, taskUsage: usage });
});
describe("V2 worker integration", () => {
  it("requires explicit version and an exact representative allowlist", () => {
    expect(shouldUseAgentV2("test", {})).toBe(false);
    expect(shouldUseAgentV2("test", { DELEGATE_AGENT_VERSION: "v2" })).toBe(false);
    expect(shouldUseAgentV2("test", { DELEGATE_AGENT_VERSION: "v2", DELEGATE_AGENT_V2_REPRESENTATIVES: "test-other" })).toBe(false);
    expect(shouldUseAgentV2("test", { DELEGATE_AGENT_VERSION: "v2", DELEGATE_AGENT_V2_REPRESENTATIVES: "a, test" })).toBe(true);
  });
  it("reuses delivery and preserves task counters without invoking the old runtime", async () => {
    await processV2ConversationTurn(makeHost() as any);
    expect(mocks.adapters).toHaveBeenCalledWith(expect.objectContaining({ orchestration: "model_v2" }));
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ intent: "agent_v2", agentTrace: expect.objectContaining({ runtime: "delegate-agent-v2", v2Task: expect.objectContaining({ inputMessageIds: ["message"], usage }) }) }));
    expect(mocks.deliver).toHaveBeenCalledOnce();
  });
  it("blocks unclassified or approval-required operations at the host gate", async () => {
    await processV2ConversationTurn(makeHost() as any);
    const authorize = mocks.run.mock.calls[0]![0].authorize;
    await expect(authorize("tool", { name: "mcp_write", effect: "write", approvalRequired: true })).rejects.toThrow("permission_denied");
    await expect(authorize("tool", { name: "execute_in_sandbox", effect: "write" })).rejects.toThrow("permission_denied");
    await expect(authorize("tool", { name: "browse_in_sandbox", effect: "read" })).resolves.toBeUndefined();
    expect(mocks.gate).toHaveBeenCalledWith("tool");
  });
  it("does not call a model or tools without service admission", async () => {
    const host = makeHost(); host.item.accessMode = "PAID";
    await processV2ConversationTurn(host as any);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.adapters).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ countUsage: false }));
  });
  it("does not silently drop a published mandatory semantic review boundary", async () => {
    const host = makeHost() as any;
    host.setup.agentBehavior = { version: 1, answerScope: "open_public", knowledgePolicy: "domain_only", commitmentPolicy: "information_only" };
    await processV2ConversationTurn(host);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ countUsage: false, replyText: expect.stringContaining("专项语义审核") }));
  });
  it("keeps V2 runtime imports independent of legacy decisions", () => {
    const root = new URL("../../../packages/model-runtime/src/v2/", import.meta.url);
    const files = readdirSync(root).filter(f => f.endsWith(".ts") && f !== "evaluate.ts");
    for (const file of files) expect(readFileSync(new URL(file, root), "utf8")).not.toMatch(/from ["']\.\.\/pi\/(runtime|tools|execution-state|simple-text|selective-text|knowledge-prefetch|behavior-policy)["']/);
  });
});
