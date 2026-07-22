import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateRepresentativeReply: vi.fn(),
  planNaturalLanguageComputeRequest: vi.fn(),
  renderGroundedKnowledgeFallback: vi.fn(),
  claimNextOperatorMessageWorkItem: vi.fn(),
  claimNextGenerationWorkItem: vi.fn(),
  completeInlineGenerationRun: vi.fn(),
  getRepresentativeRuntimeSetupSnapshot: vi.fn(),
  buildRepresentativeRuntimeProfile: vi.fn(),
  loadGenerationRecentTurns: vi.fn(),
  recallRepresentativeContext: vi.fn(),
  markGenerationDeliveryComplete: vi.fn(),
  ensureConversationLeadAndHandoff: vi.fn(),
  parseComputeDirective: vi.fn(),
  shouldConsiderNaturalLanguageCompute: vi.fn(),
  buildComputeRequestFromNaturalLanguagePlan: vi.fn(),
  createAudienceComputeSession: vi.fn(),
  executeAudienceTool: vi.fn(),
  waitGenerationRunForComputeApproval: vi.fn(),
}));

vi.mock("@delegate/model-runtime", () => ({
  generateRepresentativeReply: mocks.generateRepresentativeReply,
  planNaturalLanguageComputeRequest: mocks.planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallback: mocks.renderGroundedKnowledgeFallback,
}));

vi.mock("@delegate/runtime", () => ({
  buildComputeRequestFromNaturalLanguagePlan: mocks.buildComputeRequestFromNaturalLanguagePlan,
  createConversationPlan: () => ({ intent: "faq", nextStep: "answer" }),
  parseComputeDirective: mocks.parseComputeDirective,
  renderReplyPreview: () => "fallback",
  resolveComputeSubagent: () => ({ id: "compute-agent" }),
  resolveConversationSubagent: () => ({ id: "public", allowedConversationSteps: ["answer"] }),
  shouldConsiderNaturalLanguageCompute: mocks.shouldConsiderNaturalLanguageCompute,
}));

vi.mock("@delegate/web-data", () => ({
  buildRepresentativeRuntimeProfile: mocks.buildRepresentativeRuntimeProfile,
  claimNextOperatorMessageWorkItem: mocks.claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem: mocks.claimNextGenerationWorkItem,
  completeOperatorMessageDelivery: vi.fn(),
  completeInlineGenerationRun: mocks.completeInlineGenerationRun,
  createAudienceComputeSession: mocks.createAudienceComputeSession,
  deferGenerationRunForHuman: vi.fn(),
  ensureConversationLeadAndHandoff: mocks.ensureConversationLeadAndHandoff,
  executeAudienceTool: mocks.executeAudienceTool,
  failGenerationRun: vi.fn(),
  getRepresentativeRuntimeSetupSnapshot: mocks.getRepresentativeRuntimeSetupSnapshot,
  loadGenerationRecentTurns: mocks.loadGenerationRecentTurns,
  markGenerationDeliveryComplete: mocks.markGenerationDeliveryComplete,
  recallRepresentativeContext: mocks.recallRepresentativeContext,
  retryGenerationDelivery: vi.fn(),
  retryOperatorMessageDelivery: vi.fn(),
  waitGenerationRunForComputeApproval: mocks.waitGenerationRunForComputeApproval,
}));

import { processNextConversationWork } from "../src/processor";

describe("conversation worker knowledge recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValue(null);
    mocks.parseComputeDirective.mockReturnValue({ kind: "none" });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(false);
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: null, source: "model" });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-1",
      runId: "run-1",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-1",
      userText: "佩奇当老师时发生了什么？",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({ id: "rep-1" });
    mocks.loadGenerationRecentTurns.mockResolvedValue([]);
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [{
        uri: "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md",
        contextType: "resource",
        layer: "L2",
        score: 0.91,
        abstract: "佩奇临时代课并带大家画恐龙。",
      }],
      citations: [{
        knowledgeAssetId: "asset-1",
        title: "佩奇当老师",
        excerpt: "佩奇临时代课并带大家画恐龙。",
        score: 0.91,
      }],
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "佩奇临时代课，和同学们一起完成了一幅有想象力的恐龙画。",
      provider: "openai",
      model: "test-model",
    });
    mocks.renderGroundedKnowledgeFallback.mockReturnValue("根据已发布的知识资料：佩奇临时代课并带大家画恐龙。");
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-1" } });
  });

  it("passes recalled knowledge to the model and persists its citation", async () => {
    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.recallRepresentativeContext).toHaveBeenCalledWith({
      representativeSlug: "sktone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      queryText: "佩奇当老师时发生了什么？",
    });
    expect(mocks.generateRepresentativeReply).toHaveBeenCalledWith(expect.objectContaining({
      recalled: [expect.objectContaining({ abstract: "佩奇临时代课并带大家画恐龙。" })],
    }));
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      citations: [expect.objectContaining({ title: "佩奇当老师" })],
    }));
  });

  it("uses recalled knowledge and keeps citations when model generation fails", async () => {
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "provider timed out",
      state: "ready",
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.renderGroundedKnowledgeFallback).toHaveBeenCalledWith({
      userText: "佩奇当老师时发生了什么？",
      recalled: [expect.objectContaining({ abstract: "佩奇临时代课并带大家画恐龙。" })],
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      replyText: expect.stringContaining("佩奇临时代课"),
      citations: [expect.objectContaining({ title: "佩奇当老师" })],
    }));
  });

  it("moves an explicit web compute request into the approval waiting state", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-2",
      runId: "run-2",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-2",
      contactId: "contact-2",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-2",
      userText: "/compute write notes/demo.txt ::: hello",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "write",
        path: "notes/demo.txt",
        content: "hello",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "notes/demo.txt",
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-1" } });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "pending_approval",
      approvalRequest: {
        id: "approval-1",
        requestedActionSummary: "Write notes/demo.txt",
        riskSummary: "Workspace mutation",
      },
      artifacts: [],
    });
    mocks.waitGenerationRunForComputeApproval.mockResolvedValue({
      run: { status: "WAITING_APPROVAL" },
      message: { id: "pending-message" },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "waiting_approval",
    });
    expect(mocks.createAudienceComputeSession).toHaveBeenCalledWith(expect.objectContaining({
      generationRunId: "run-2",
      conversationId: "conversation-2",
    }));
    expect(mocks.waitGenerationRunForComputeApproval).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-2",
      approvalId: "approval-1",
    }));
  });

  it("returns compute help without creating a sandbox session", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-help",
      runId: "run-help",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-help",
      contactId: "contact-help",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-help",
      userText: "/compute",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "help",
      examples: "/compute pwd",
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-help" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      intent: "compute_help",
    }));
  });

  it("routes a high-confidence natural-language task through the compute planner", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-natural",
      runId: "run-natural",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-natural",
      contactId: "contact-natural",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-natural",
      userText: "把 browser QA 保存到 notes/qa.txt",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    const naturalPlan = {
      capability: "write",
      path: "notes/qa.txt",
      content: "browser QA",
      summary: "生成 notes/qa.txt",
    };
    const request = {
      ...naturalPlan,
      displayTarget: naturalPlan.summary,
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: naturalPlan, source: "model" });
    mocks.buildComputeRequestFromNaturalLanguagePlan.mockReturnValue(request);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-natural" } });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "completed",
      artifacts: [{
        id: "artifact-natural",
        kind: "file",
        objectKey: "result/file",
        mimeType: "text/plain; charset=utf-8",
        sizeBytes: 10,
        summary: "/workspace/notes/qa.txt: browser QA",
      }],
      billing: { actualCredits: 4 },
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-natural" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.planNaturalLanguageComputeRequest).toHaveBeenCalledWith({
      userText: "把 browser QA 保存到 notes/qa.txt",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ fileName: "qa.txt", artifactId: "artifact-natural" })],
    }));
  });
});
