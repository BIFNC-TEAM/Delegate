const toolContext = { runId: "run-pi", sessionId: "conversation-pi", traceId: "fixture", timezone: "Asia/Shanghai", attachments: [], idempotencyKey: "fixture" };
import { buildAgentCapabilities } from "../src/agent-capabilities";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  executeTool: vi.fn(),
  capabilityPolicy: vi.fn(),
  cancelPending: vi.fn(),
  claimOperator: vi.fn(),
  claimConversationMessage: vi.fn(),
  claimGeneration: vi.fn(),
  renewLease: vi.fn(),
  getSetup: vi.fn(),
  getAuthority: vi.fn(),
  knowledgeConfigured: vi.fn(),
  loadTurns: vi.fn(),
  buildProfile: vi.fn(),
  completeInline: vi.fn(),
  failGeneration: vi.fn(),
  prepareDelivery: vi.fn(),
  markDeliveryComplete: vi.fn(),
  assertDelivery: vi.fn(),
  completeConversationMessage: vi.fn(),
  loadOperationalContext: vi.fn(),
  authorizeFreeUsage: vi.fn(),
  updatePiStream: vi.fn(),
  updatePiProgress: vi.fn(),
  recallContext: vi.fn(),
  getArtifactDetail: vi.fn(),
  publicArtifactDownload: vi.fn(),
  codePreflight: vi.fn(),
  contextAuthority: vi.fn(),
  contextCheck: vi.fn(),
  registerKnowledge: vi.fn(),
  registerToolResult: vi.fn(),
  approvedExecution: vi.fn(),
}));


vi.mock("@delegate/web-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@delegate/web-data")>()),
  createAudienceComputeSession: mocks.createSession,
  executeAudienceTool: mocks.executeTool,
  resolveServerOwnedMcpCapabilityPolicy: mocks.capabilityPolicy,
  claimNextOperatorMessageWorkItem: mocks.claimOperator,
  claimNextConversationMessageDeliveryWorkItem: mocks.claimConversationMessage,
  claimNextGenerationWorkItem: mocks.claimGeneration,
  renewGenerationWorkItemLease: mocks.renewLease,
  getRepresentativeRuntimeSetupSnapshot: mocks.getSetup,
  getRepresentativeRuntimeAuthoritySnapshot: mocks.getAuthority,
  isKnowledgeRetrievalServiceConfigured: mocks.knowledgeConfigured,
  loadGenerationRecentTurns: mocks.loadTurns,
  buildRepresentativeRuntimeProfile: mocks.buildProfile,
  completeInlineGenerationRun: mocks.completeInline,
  failGenerationRun: mocks.failGeneration,
  prepareGenerationMessageChannelDelivery: mocks.prepareDelivery,
  markGenerationDeliveryComplete: mocks.markDeliveryComplete,
  assertConversationChannelDeliveryAvailable: mocks.assertDelivery,
  completeConversationMessageDelivery: mocks.completeConversationMessage,
  loadConversationOperationalContext: mocks.loadOperationalContext,
  authorizeGenerationRunFreeUsage: mocks.authorizeFreeUsage,
  updateGenerationPiStream: mocks.updatePiStream,
  updateGenerationPiProgress: mocks.updatePiProgress,
  cancelGenerationPendingApprovals: mocks.cancelPending,
  recallRepresentativeContext: mocks.recallContext,
  getRepresentativeComputeArtifactDetail: mocks.getArtifactDetail,
  getPublicConversationArtifactDownload: mocks.publicArtifactDownload,
  getAudienceCodeExecutionPreflight: mocks.codePreflight,
  createAgentContextAuthorization: mocks.contextAuthority,
  getApprovedAgentToolExecution: mocks.approvedExecution,
}));

vi.mock("../src/matrix-outbound", () => ({
  sendMatrixRepresentativeMessage: vi.fn(),
}));

import {
  attachVerifiedMcpSource,
  normalizeExpectedSandboxOutputs,
  normalizeInlineProgramSource,
} from "../src/agent-capabilities";
import {
  resolveDeclaredAttachmentIds,
  validateDeclaredAttachmentRead,
} from "../src/attachment-inputs";

const config = {
  port: 4040,
  pollMs: 500,
  telegramConversationPlatformMode: "worker" as const,
};

function generationItem(overrides: Record<string, unknown> = {}) {
  return {
    outboxId: "outbox-pi",
    leaseAttempt: 1,
    runId: "run-pi",
    representativeVersionId: "version-pi",
    representativeSlug: "sktone",
    representativeName: "小派",
    conversationId: "conversation-pi",
    contactId: "contact-pi",
    controlState: "AI_ACTIVE",
    inputMessageId: "message-pi",
    inputAttachments: [],
    userText: "你好",
    channel: "web",
    accessMode: "FREE",
    usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    ...overrides,
  };
}
async function capabilitiesFixture() {
  return buildAgentCapabilities({ config, item: generationItem({ audienceIdentityId: "audience-pi" }) as any,
    setup: await mocks.getSetup(), authority: await mocks.getAuthority(),
    leaseGuard: { assertOwned() {}, confirmOwned: async () => undefined } as any,
    workLease: { outboxId: "outbox-pi", leaseAttempt: 1 }, computeAttachments: [],
    onMemoryUse() {}, registerKnowledgeSources: mocks.registerKnowledge, registerToolSource: mocks.registerToolResult,
    onPendingApproval() {},
  });
}

describe("governed V2 host capabilities", () => {

  beforeEach(() => {
    mocks.knowledgeConfigured.mockReturnValue(true);
    mocks.cancelPending.mockResolvedValue({ canceledCount: 0 });
    vi.clearAllMocks();
    // D05 adapter fixtures simulate an admitted test profile. Production Broker
    // currently has no verified general-code profile; denial is tested below.
    mocks.codePreflight.mockResolvedValue({ available: true, profileId: "delegate.aio.single-python.v1", reason: "code_execution_profile_verified", codeClassification: "untrusted_code" });
    mocks.contextCheck.mockResolvedValue(undefined); mocks.registerKnowledge.mockResolvedValue(undefined); mocks.registerToolResult.mockResolvedValue(undefined); mocks.approvedExecution.mockResolvedValue(null);
    mocks.contextAuthority.mockResolvedValue({ check: mocks.contextCheck, snapshot: () => ({ version: 1, runId: "run-pi", revision: "f".repeat(64) }), registerKnowledge: mocks.registerKnowledge, registerToolResult: mocks.registerToolResult, memorySources: () => ({ itemIds: [] }) });
    mocks.claimOperator.mockResolvedValue(null);
    mocks.claimConversationMessage.mockResolvedValue(null);
    mocks.claimGeneration.mockResolvedValue(null);
    mocks.renewLease.mockResolvedValue(true);
    mocks.getSetup.mockResolvedValue({
      id: "rep-1",
      ownerName: "测试 Owner",
      tagline: "测试产品助手",
      tone: "简洁",
      handoffPrompt: "需要时可转人工。",
      humanInLoop: true,
      skillPacks: [],
      knowledgePack: { identitySummary: "Test", faq: [], materials: [], policies: [] },
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
      delegation: { enabled: true, maxSteps: 5 },
    });
    mocks.getAuthority.mockResolvedValue({ mcpBindings: [] });
    mocks.capabilityPolicy.mockReturnValue(null);
    mocks.loadTurns.mockResolvedValue([]);
    mocks.buildProfile.mockReturnValue({ contract: { freeReplyLimit: 5 } });
    mocks.completeInline.mockResolvedValue({ message: { id: "reply-1", text: "你好，我是小派。" } });
    mocks.prepareDelivery.mockResolvedValue({
      allowNeedsHumanDelivery: false,
      deliveryAdmission: { state: "admitted" },
    });
    mocks.markDeliveryComplete.mockResolvedValue(true);
    mocks.assertDelivery.mockResolvedValue(undefined);
    mocks.completeConversationMessage.mockResolvedValue(true);
    mocks.authorizeFreeUsage.mockResolvedValue(true);
    mocks.updatePiStream.mockResolvedValue(undefined);
    mocks.updatePiProgress.mockResolvedValue(undefined);
    mocks.recallContext.mockResolvedValue({ items: [], citations: [] });
    mocks.getArtifactDetail.mockResolvedValue({
      contentText: "# 欢迎使用示例服务\n示例服务帮助访客整理公开资料。",
    });
  });


  it("attaches MCP provenance only to a verified successful result", () => {
    expect(attachVerifiedMcpSource({
      status: "failed",
      text: "MCP failed before execution.",
    }, {
      server: "weather",
      tool: "get_forecast",
      runId: "run-failed",
    }).sources).toEqual([]);

    expect(attachVerifiedMcpSource({
      status: "completed",
      text: "MCP returned current weather.",
    }, {
      server: "weather",
      tool: "get_forecast",
      runId: "run-success",
    }).sources).toEqual([expect.objectContaining({
      title: "weather/get_forecast",
      channel: "mcp",
    })]);
    expect(attachVerifiedMcpSource({ status: "completed", text: "Receipt retained", observation: { state: "blocked" } },
      { server: "fixture", tool: "operate", runId: "run" }).sources).toEqual([]);
  });


  async function sandboxFixture(stdout: string, fileName = "result.txt", mimeType = "text/plain; charset=utf-8") {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({ audienceIdentityId: "audience-pi", userText: "在沙盒生成结果文件" }));
    const setup = await mocks.getSetup();
    mocks.getSetup.mockResolvedValue({ ...setup, compute: { enabled: true, baseImage: "debian:bookworm-slim" } });
    mocks.createSession.mockResolvedValue({ session: { id: "sandbox-session" } });
    mocks.getArtifactDetail.mockResolvedValue({ contentText: stdout, truncated: false });
    mocks.publicArtifactDownload.mockResolvedValue({ fileName, mimeType, buffer: Buffer.from(stdout) });
    mocks.executeTool.mockImplementation(async (_session, request) => ({
      outcome: "completed", session: {}, execution: { id: "sandbox-execution", exitCode: 0 },
      artifacts: [{ id: "stdout", kind: "stdout", mimeType: "text/plain", sizeBytes: Buffer.byteLength(stdout) },
        ...(request.isolatedPython?.outputFileName ? [{ id: "file", kind: "file", mimeType, sizeBytes: Buffer.byteLength(stdout) }] : [])],
    }));

    const adapter = (await capabilitiesFixture()).sandbox!;
    return (expectedOutputs: string[]) => adapter!.execute({
      language: "python", code: "print('synthetic result')", attachmentIds: [], expectedOutputs, timeoutMs: 1000,
      context: { runId: "run-pi", sessionId: "conversation-pi", traceId: "fixture", timezone: "Asia/Shanghai", attachments: [], idempotencyKey: "sandbox-task" },
      signal: new AbortController().signal,
    });
  }


  it("does not dispatch code or produce a file when the Broker cannot verify an execution profile", async () => {
    const execute = await sandboxFixture("synthetic");
    mocks.codePreflight.mockResolvedValueOnce({ available: false, profileId: null, reason: "code_execution_profile_unverified", codeClassification: "untrusted_code" });
    const result = await execute(["result.txt"]);
    expect(result.status).toBe("unavailable");
    expect(result.observation).toMatchObject({ state: "unavailable" });
    expect(result.text).toContain("未执行脚本"); expect(result.artifacts).toEqual([]);
    expect(mocks.executeTool).not.toHaveBeenCalled(); expect(mocks.getArtifactDetail).not.toHaveBeenCalled();
  });


  it("submits a structured Python action without a raw shell command or a safety label", async () => {
    const execute = await sandboxFixture("synthetic"); await execute([]);
    const request = mocks.executeTool.mock.calls.find(call => call[1].capability === "exec")![1];
    expect(request.isolatedPython).toMatchObject({ profileId: "delegate.aio.single-python.v1", actionKey: expect.any(String), source: "print('synthetic result')", inputs: [], timeoutMs: 1000 });
    expect(request).not.toHaveProperty("compiledTask"); expect(request).not.toHaveProperty("command");
  });

  it("honors a smaller server execution deadline in the bound action", async () => {
    const execute = await sandboxFixture("synthetic");
    mocks.codePreflight.mockResolvedValueOnce({ available: true, profileId: "delegate.aio.single-python.v1", reason: "code_execution_profile_verified", maximumDurationMs: 500 });
    await execute([]);
    expect(mocks.executeTool.mock.calls[0]![1].isolatedPython.timeoutMs).toBe(500);
  });

  it("distinguishes a preflight lookup failure from an unknown submitted execution", async () => {
    const execute = await sandboxFixture("synthetic");
    mocks.codePreflight.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_PREFLIGHT_ERROR"));
    const result = await execute([]);
    expect(result).toMatchObject({ status: "unavailable", observation: { state: "unavailable", reason: "code_execution_preflight_unavailable" }, artifacts: [] });
    expect(result.text).toContain("未提交脚本"); expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_PREFLIGHT_ERROR");
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });


  it("preserves an uncertain Broker result as an unknown observation without writing or delivering a file", async () => {
    const execute = await sandboxFixture("synthetic");
    mocks.executeTool.mockResolvedValueOnce({ outcome: "failed", execution: { id: "uncertain", transportOutcome: "outcome_unknown" }, artifacts: [] });
    const result = await execute(["result.txt"]);
    expect(result).toMatchObject({ observation: { state: "unknown" }, details: { transportOutcome: "outcome_unknown" }, artifacts: [] });
    expect(mocks.executeTool).toHaveBeenCalledOnce(); expect(mocks.publicArtifactDownload).not.toHaveBeenCalled();
  });


  it.each(["output_not_supported_text", "output_csv_invalid", "output_json_invalid", "output_file_too_large"])("explains confirmed output rejection %s without claiming delivery", async reason => {
    const execute = await sandboxFixture("synthetic");
    mocks.executeTool.mockResolvedValueOnce({ outcome: "failed", session: { failureReason: reason }, execution: { id: "no-stdout", transportOutcome: "response_received" }, artifacts: [] });
    const result = await execute(["result.txt"]);
    expect(result).toMatchObject({ status: "failed", details: { reason }, recovery: { kind: "isolated_output_rejected", reason }, artifacts: [] });
    expect(result.text).toContain("标准输出"); expect(result.text).toContain("expectedOutputs");
    expect(mocks.executeTool).toHaveBeenCalledOnce(); expect(mocks.publicArtifactDownload).not.toHaveBeenCalled();
  });

  it("does not permit correction when an output error label lacks a terminal receipt", async () => {
    const execute = await sandboxFixture("synthetic");
    mocks.executeTool.mockResolvedValueOnce({ outcome: "failed", session: { failureReason: "output_csv_invalid" }, execution: { id: "unknown", transportOutcome: "outcome_unknown" }, artifacts: [] });
    const result = await execute(["result.csv"]);
    expect(result.observation?.state).toBe("unknown"); expect(result).not.toHaveProperty("recovery");
  });


  it("does not pass arbitrary broker failure details to the model", async () => {
    const execute = await sandboxFixture("synthetic");
    mocks.executeTool.mockResolvedValueOnce({ outcome: "failed", session: { failureReason: "SYNTHETIC_PRIVATE_ERROR" }, execution: { id: "failed", transportOutcome: "response_received" }, artifacts: [] });
    expect(JSON.stringify(await execute(["result.txt"]))).not.toContain("SYNTHETIC_PRIVATE_ERROR");
  });


  it.each([["result.xlsx"], ["result.pdf"], ["../result.txt"], ["a.txt", "b.txt"]])("rejects unsupported output requests before creating or executing a sandbox: %j", async (...outputs) => {
    const execute = await sandboxFixture("plain text\n");
    const result = await execute(outputs);
    expect(result.status).toBe("failed");
    expect(result.artifacts).toEqual([]);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });


  it.each([
    { name: "result.txt", mime: "text/plain; charset=utf-8", text: "真实文本\n" },
    { name: "result.md", mime: "text/markdown; charset=utf-8", text: "# Report\n" },
    { name: "result.csv", mime: "text/csv; charset=utf-8", text: "name,value\nA,1\n" },
    { name: "result.json", mime: "application/json; charset=utf-8", text: '{"ok":true}\n' },
  ])("delivers verified $name bytes only after checking current audience download access", async ({ name, mime, text }) => {
    const execute = await sandboxFixture(text, name, mime);
    const result = await execute([name]);
    expect(result).toMatchObject({ status: "completed", artifacts: [{ id: "file", fileName: name, mimeType: mime, sizeBytes: Buffer.byteLength(text) }] });
    expect(mocks.publicArtifactDownload).toHaveBeenCalledWith({ representativeSlug: "sktone", artifactId: "file", audienceIdentityId: "audience-pi" }, expect.objectContaining({ recordDownload: false, expectedOrigin: { generationRunId: "run-pi", toolExecutionId: "sandbox-execution" } }));
    expect(mocks.getArtifactDetail).not.toHaveBeenCalled();
    expect(mocks.executeTool).toHaveBeenCalledExactlyOnceWith("sandbox-session", expect.objectContaining({ capability: "exec", isolatedPython: expect.objectContaining({ outputFileName: name }) }));
  });


  it.each([
    { name: "result.json", text: '{"incomplete":' },
    { name: "result.csv", text: 'name,value\n"unclosed,1\n' },
    { name: "result.csv", text: "name,value\nA,1,extra\n" },
    { name: "result.txt", text: "x".repeat(65_537) },
    { name: "result.txt", text: "binary\u0000content" },
  ])("does not write a malformed or oversized $name output", async ({ name, text }) => {
    const execute = await sandboxFixture(text, name);
    const result = await execute([name]);
    expect(result.status).toBe("failed");
    expect(result.artifacts).toEqual([]);
    expect(mocks.executeTool.mock.calls.filter(([, request]) => request.capability === "write")).toHaveLength(0);
  });


  it.each(["truncated", "missing", "forbidden", "different", "wrong-mime", "missing-file"])("does not claim file delivery when the result is %s", async (failure) => {
    const execute = await sandboxFixture("hello\n");
    if (failure === "truncated") mocks.publicArtifactDownload.mockResolvedValue({ fileName: "result.txt", mimeType: "text/plain", buffer: Buffer.from("hell") });
    if (failure === "missing") mocks.publicArtifactDownload.mockResolvedValue(null);
    if (failure === "forbidden") mocks.publicArtifactDownload.mockRejectedValue(Object.assign(new Error("fixture forbidden"), { status: 403 }));
    if (failure === "different") mocks.publicArtifactDownload.mockResolvedValue({ fileName: "result.txt", mimeType: "text/plain", buffer: Buffer.from("changed\n") });
    if (failure === "wrong-mime") mocks.publicArtifactDownload.mockResolvedValue({ fileName: "result.txt", mimeType: "application/pdf", buffer: Buffer.from("hello\n") });
    if (failure === "missing-file") mocks.executeTool.mockImplementation(async (_session, request) => ({ outcome: "completed", session: {}, execution: { id: "exec", exitCode: 0 }, artifacts: request.capability === "exec" ? [{ id: "stdout", kind: "stdout", mimeType: "text/plain", sizeBytes: 6 }] : [] }));
    const result = await execute(["result.txt"]);
    expect(result.status).toBe("failed");
    expect(result.artifacts).toEqual([]);
  });


  it("restores model-escaped statement line breaks without changing normal source", () => {
    expect(normalizeInlineProgramSource("import os\\nprint('ok')"))
      .toBe("import os\nprint('ok')");
    expect(normalizeInlineProgramSource("print('first\\nsecond')"))
      .toBe("print('first\\nsecond')");
    expect(normalizeInlineProgramSource("print('ok')\nprint('done')"))
      .toBe("print('ok')\nprint('done')");
  });


  it.each(["completed", "pending_approval", "unclassified"])("tags search evidence from host policy only: %s", async state => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({ audienceIdentityId: "audience-pi" }));
    mocks.getSetup.mockResolvedValue({ ...(await mocks.getSetup()), compute: { enabled: true, baseImage: "synthetic" } });
    mocks.getAuthority.mockResolvedValue({ mcpBindings: [{ id: "binding", slug: "arbitrary", serverUrl: "https://example.invalid/mcp", transportKind: "streamable_http",
      allowedToolNames: ["search_pro"], approvalRequired: false, estimatedTokensPerCall: 1, toolDefinitions: [{ exactToolName: "search_pro", inputSchema: {}, toolSchemaHash: "a".repeat(64) }] }] });
    mocks.capabilityPolicy.mockReturnValue({ effect: { mutation: "none" }, idempotency: "naturally_idempotent", ...(state !== "unclassified" ? { semantics: { evidenceClasses: ["search_snippet"] } } : {}) });
    mocks.createSession.mockResolvedValue({ session: { id: "session" } });
    mocks.executeTool.mockResolvedValue(state === "pending_approval"
      ? { outcome: "pending_approval", session: {}, approvalRequest: { id: "approval-search" } }
      : { outcome: "completed", session: {}, execution: { id: "execution", semanticOutcome: "succeeded", finishedAt: "2026-10-08T00:00:00Z" }, artifacts: [{ id: "result", kind: "json", mimeType: "application/json", sizeBytes: 2 }] });
    mocks.publicArtifactDownload.mockResolvedValue({ fileName: "result.json", mimeType: "application/json", buffer: Buffer.from("{}") });

    const result = await (await capabilitiesFixture()).mcp!.callTool({ server: "arbitrary", tool: "search_pro", arguments: {}, idempotencyKey: "fixture", context: toolContext, signal: new AbortController().signal });
    expect(result.observation?.evidenceKind).toBe(state === "unclassified" ? undefined : "search_results");
    expect(result.observation?.state).toBe(state === "pending_approval" ? "unavailable" : "available");
    expect(mocks.executeTool).toHaveBeenCalledOnce();
  });


  it.each(["none", "write"])("withholds inaccessible MCP %s evidence without replaying the completed action", async mutation => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({ audienceIdentityId: "audience-pi" }));
    mocks.getSetup.mockResolvedValue({ ...(await mocks.getSetup()), compute: { enabled: true, baseImage: "synthetic" } });
    mocks.getAuthority.mockResolvedValue({ mcpBindings: [{ id: "binding", slug: "fixture", serverUrl: "https://example.invalid/mcp", transportKind: "streamable_http",
      allowedToolNames: ["read"], approvalRequired: false, estimatedTokensPerCall: 1, toolDefinitions: [{ exactToolName: "read", inputSchema: {}, toolSchemaHash: "a".repeat(64) }] }] });
    mocks.capabilityPolicy.mockReturnValue({ effect: { mutation }, idempotency: "unknown" });
    mocks.createSession.mockResolvedValue({ session: { id: "session" } });
    mocks.executeTool.mockResolvedValue({ outcome: "completed", session: {}, execution: { id: "execution", semanticOutcome: "succeeded" },
      artifacts: [{ id: "result", kind: "stdout", mimeType: "text/plain", sizeBytes: 20 }] });
    mocks.getArtifactDetail.mockResolvedValue({ contentText: "SYNTHETIC_OWNER_ONLY_CANARY" });
    mocks.publicArtifactDownload.mockResolvedValue(null);

    const result = await (await capabilitiesFixture()).mcp!.callTool({ server: "fixture", tool: "read", arguments: {}, idempotencyKey: "fixture", context: toolContext, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "completed", observation: { state: "blocked" }, artifacts: [], sources: [] });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_OWNER_ONLY_CANARY"); expect(mocks.getArtifactDetail).not.toHaveBeenCalled();
    expect(mocks.executeTool).toHaveBeenCalledOnce();
    expect(mocks.publicArtifactDownload).toHaveBeenCalledWith(expect.objectContaining({ audienceIdentityId: "audience-pi", artifactId: "result" }),
      expect.objectContaining({ expectedOrigin: { generationRunId: "run-pi", toolExecutionId: "execution" }, recordDownload: false }));
  });


  it.each(["allowed", "revoked", "malformed", "incomplete"])("uses audience-bound browser evidence when %s", async state => {
    mocks.getAuthority.mockResolvedValue({ mcpBindings: [], compute: { capabilityModes: { browser: "allow" } } });
    await sandboxFixture("placeholder");
    const page = JSON.stringify({ finalUrl: "https://example.invalid", title: "Synthetic", textSnippet: "SYNTHETIC_BROWSER_CANARY" });
    mocks.executeTool.mockResolvedValue({ outcome: "completed", session: {}, execution: { id: "browse-execution" },
      artifacts: [{ id: "page", kind: "json", mimeType: "application/json", sizeBytes: Buffer.byteLength(page) }] });
    mocks.getArtifactDetail.mockResolvedValue({ contentText: page });
    const actual = state === "malformed" ? "x".repeat(Buffer.byteLength(page)) : state === "incomplete" ? page.slice(0, -1) : page;
    mocks.publicArtifactDownload.mockResolvedValue(state === "revoked" ? null : { fileName: "page.json", mimeType: "application/json", buffer: Buffer.from(actual) });
    mocks.registerToolResult.mockResolvedValue("synthetic-source-receipt");
    const result = await (await capabilitiesFixture()).sandbox!.browse!({ url: "https://example.invalid", context: toolContext, signal: new AbortController().signal });
    expect(result.status).toBe(state === "allowed" ? "completed" : "failed");
    if (state === "allowed") { expect(result.text).toContain("SYNTHETIC_BROWSER_CANARY"); expect(result.contextSourceRef).toBe("synthetic-source-receipt"); }
    else expect(JSON.stringify(result)).not.toContain("SYNTHETIC_BROWSER_CANARY");
    expect(mocks.getArtifactDetail).not.toHaveBeenCalled(); expect(mocks.executeTool).toHaveBeenCalledOnce();
    expect(mocks.registerToolResult).toHaveBeenCalledWith("browse-execution");
    expect(mocks.registerToolResult.mock.invocationCallOrder[0]).toBeLessThan(mocks.publicArtifactDownload.mock.invocationCallOrder[0]!);
    expect(mocks.publicArtifactDownload).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "page", audienceIdentityId: "audience-pi" }),
      expect.objectContaining({ expectedOrigin: { generationRunId: "run-pi", toolExecutionId: "browse-execution" } }));
  });


  it("accepts common CSV readers only for the exact declared attachment path", () => {
    const attachment = {
      id: "attachment-csv",
      fileName: "ORDERS_A.csv",
      mimeType: "text/csv",
      uri: "/workspace/inputs/attachment-attachment-csv.csv",
    };
    expect(validateDeclaredAttachmentRead({
      code: "import pandas as pd\ndf = pd.read_csv('/workspace/inputs/attachment-attachment-csv.csv')",
      attachmentIds: [],
      attachments: [attachment],
    })).toEqual({ ok: true });
    expect(resolveDeclaredAttachmentIds({
      code: "import pandas as pd\ndf = pd.read_csv('/workspace/inputs/attachment-attachment-csv.csv')",
      attachmentIds: [],
      attachments: [attachment],
    })).toEqual([attachment.id]);
    expect(validateDeclaredAttachmentRead({
      code: "import polars as pl\nINPUT = '/workspace/inputs/attachment-attachment-csv.csv'\ndf = pl.scan_csv(source=INPUT)",
      attachmentIds: [attachment.id],
      attachments: [attachment],
    })).toEqual({ ok: true });
    expect(validateDeclaredAttachmentRead({
      code: "import pandas as pd\ndf = pd.read_csv('/workspace/inputs/other.csv')",
      attachmentIds: [attachment.id],
      attachments: [attachment],
    })).toEqual({ ok: false, reason: "sandbox_attachment_path_not_read" });
    expect(normalizeExpectedSandboxOutputs(["/dev/stdout", "stdout", "-", "ranking.csv"]))
      .toEqual(["ranking.csv"]);
  });
});
