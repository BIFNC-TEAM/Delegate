import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateRepresentativeReply: vi.fn(),
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
}));

vi.mock("@delegate/model-runtime", () => ({
  generateRepresentativeReply: mocks.generateRepresentativeReply,
  renderGroundedKnowledgeFallback: mocks.renderGroundedKnowledgeFallback,
}));

vi.mock("@delegate/runtime", () => ({
  createConversationPlan: () => ({ intent: "faq", nextStep: "answer" }),
  renderReplyPreview: () => "fallback",
  resolveConversationSubagent: () => ({ id: "public", allowedConversationSteps: ["answer"] }),
}));

vi.mock("@delegate/web-data", () => ({
  buildRepresentativeRuntimeProfile: mocks.buildRepresentativeRuntimeProfile,
  claimNextOperatorMessageWorkItem: mocks.claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem: mocks.claimNextGenerationWorkItem,
  completeOperatorMessageDelivery: vi.fn(),
  completeInlineGenerationRun: mocks.completeInlineGenerationRun,
  deferGenerationRunForHuman: vi.fn(),
  ensureConversationLeadAndHandoff: mocks.ensureConversationLeadAndHandoff,
  failGenerationRun: vi.fn(),
  getRepresentativeRuntimeSetupSnapshot: mocks.getRepresentativeRuntimeSetupSnapshot,
  loadGenerationRecentTurns: mocks.loadGenerationRecentTurns,
  markGenerationDeliveryComplete: mocks.markGenerationDeliveryComplete,
  recallRepresentativeContext: mocks.recallRepresentativeContext,
  retryGenerationDelivery: vi.fn(),
  retryOperatorMessageDelivery: vi.fn(),
}));

import { processNextConversationWork } from "../src/processor";

describe("conversation worker knowledge recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValue(null);
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
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({ id: "rep-1" });
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
});
