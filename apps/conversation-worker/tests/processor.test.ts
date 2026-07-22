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
  buildComputeRequestsFromDelegationPlan: vi.fn(),
  readPersistedDelegationStepRequest: vi.fn(),
  createAudienceComputeSession: vi.fn(),
  createComputeDelegationTask: vi.fn(),
  createClarifyingDelegationTask: vi.fn(),
  continueClarifyingDelegationTask: vi.fn(),
  findConversationClarifyingDelegationTask: vi.fn(),
  executeAudienceTool: vi.fn(),
  finalizeComputeDelegationTask: vi.fn(),
  markDelegationTaskAwaitingApproval: vi.fn(),
  markDelegationTaskRunning: vi.fn(),
  waitGenerationRunForComputeApproval: vi.fn(),
}));

vi.mock("@delegate/model-runtime", () => ({
  generateRepresentativeReply: mocks.generateRepresentativeReply,
  planNaturalLanguageComputeRequest: mocks.planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallback: mocks.renderGroundedKnowledgeFallback,
}));

vi.mock("@delegate/runtime", () => ({
  buildComputeRequestsFromDelegationPlan: mocks.buildComputeRequestsFromDelegationPlan,
  createConversationPlan: () => ({ intent: "faq", nextStep: "answer" }),
  parseComputeDirective: mocks.parseComputeDirective,
  renderReplyPreview: () => "fallback",
  readPersistedDelegationStepRequest: mocks.readPersistedDelegationStepRequest,
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
  createComputeDelegationTask: mocks.createComputeDelegationTask,
  createClarifyingDelegationTask: mocks.createClarifyingDelegationTask,
  continueClarifyingDelegationTask: mocks.continueClarifyingDelegationTask,
  deferGenerationRunForHuman: vi.fn(),
  ensureConversationLeadAndHandoff: mocks.ensureConversationLeadAndHandoff,
  executeAudienceTool: mocks.executeAudienceTool,
  finalizeComputeDelegationTask: mocks.finalizeComputeDelegationTask,
  findConversationClarifyingDelegationTask: mocks.findConversationClarifyingDelegationTask,
  failGenerationRun: vi.fn(),
  getRepresentativeRuntimeSetupSnapshot: mocks.getRepresentativeRuntimeSetupSnapshot,
  loadGenerationRecentTurns: mocks.loadGenerationRecentTurns,
  markGenerationDeliveryComplete: mocks.markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval: mocks.markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning: mocks.markDelegationTaskRunning,
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
    mocks.readPersistedDelegationStepRequest.mockReturnValue(null);
    mocks.findConversationClarifyingDelegationTask.mockResolvedValue(null);
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: null, source: "model" });
    mocks.finalizeComputeDelegationTask.mockResolvedValue({ hasMoreSteps: false });
    mocks.createComputeDelegationTask.mockResolvedValue({
      task: { id: "task-1" },
      step: { id: "task-step-1" },
    });
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
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
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
      delegationTaskId: "task-1",
      delegationTaskStepId: "task-step-1",
    }));
    expect(mocks.markDelegationTaskRunning).toHaveBeenCalledWith("task-1", "task-step-1");
    expect(mocks.markDelegationTaskAwaitingApproval).toHaveBeenCalledWith({
      taskId: "task-1",
      stepId: "task-step-1",
      approvalId: "approval-1",
    });
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
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
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
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
    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
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
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    const naturalStep = {
      capability: "write" as const,
      path: "notes/qa.txt",
      content: "browser QA",
      summary: "生成 notes/qa.txt",
    };
    const request = {
      ...naturalStep,
      displayTarget: naturalStep.summary,
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    const naturalPlan = { kind: "execution" as const, summary: "生成并保存文件", steps: [naturalStep] };
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: naturalPlan, source: "model" });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([request]);
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
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "completed",
      artifacts: [expect.objectContaining({ id: "artifact-natural" })],
      actualCredits: 4,
    }));
  });

  it("creates a clarifying task instead of inventing missing execution inputs", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-clarify",
      runId: "run-clarify",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-clarify",
      contactId: "contact-clarify",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-clarify",
      userText: "帮我生成一个报告文件",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({
      ok: true,
      source: "deterministic",
      plan: {
        kind: "clarification",
        summary: "生成报告文件",
        question: "请补充目标路径和完整内容。",
        missingFields: ["path", "content"],
      },
    });
    mocks.createClarifyingDelegationTask.mockResolvedValue({ task: { id: "task-clarify" }, step: { id: "step-clarify" } });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-clarify" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "waiting_input",
    });
    expect(mocks.createClarifyingDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      objective: "帮我生成一个报告文件",
      missingFields: ["path", "content"],
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("keeps the conversation queued while a multi-step task schedules its next step", async () => {
    const request = {
      capability: "write",
      path: "notes/p1.txt",
      content: "P1",
      displayTarget: "写入 notes/p1.txt",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-multi",
      runId: "run-multi",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-multi",
      contactId: "contact-multi",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-multi",
      userText: "/compute write notes/p1.txt ::: P1",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: true, baseImage: "debian:bookworm-slim", maxSessionMinutes: 15, networkMode: "no_network", filesystemMode: "workspace_only" },
    });
    mocks.parseComputeDirective.mockReturnValue({ kind: "request", request });
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-multi" } });
    mocks.executeAudienceTool.mockResolvedValue({ outcome: "completed", artifacts: [] });
    mocks.finalizeComputeDelegationTask.mockResolvedValue({ hasMoreSteps: true });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-multi" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "step_completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      keepConversationQueued: true,
    }));
  });

  it("executes a persisted next step on the existing task instead of creating another task", async () => {
    const request = {
      capability: "read",
      path: "notes/p1.txt",
      displayTarget: "读取 notes/p1.txt",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-next-step",
      runId: "run-next-step",
      delegationTaskId: "task-existing",
      delegationTaskStepId: "step-existing-2",
      contextSnapshot: { source: "delegation_plan_step", request },
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-next-step",
      contactId: "contact-next-step",
      controlState: "AI_QUEUED",
      inputMessageId: "message-original",
      userText: "生成并检查报告",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: true, baseImage: "debian:bookworm-slim", maxSessionMinutes: 15, networkMode: "no_network", filesystemMode: "workspace_only" },
    });
    mocks.readPersistedDelegationStepRequest.mockReturnValue(request);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-next-step" } });
    mocks.executeAudienceTool.mockResolvedValue({ outcome: "completed", artifacts: [] });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-next-step" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.createAudienceComputeSession).toHaveBeenCalledWith(expect.objectContaining({
      delegationTaskId: "task-existing",
      delegationTaskStepId: "step-existing-2",
    }));
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-existing",
      stepId: "step-existing-2",
      generationRunId: "run-next-step",
    }));
  });

  it("blocks the existing delegated step if Compute is disabled before it starts", async () => {
    const request = {
      capability: "read",
      path: "notes/p1.txt",
      displayTarget: "读取 notes/p1.txt",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-disabled-step",
      runId: "run-disabled-step",
      delegationTaskId: "task-disabled",
      delegationTaskStepId: "step-disabled-2",
      contextSnapshot: { request },
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-disabled-step",
      contactId: "contact-disabled-step",
      controlState: "AI_QUEUED",
      inputMessageId: "message-original",
      userText: "生成并检查报告",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.readPersistedDelegationStepRequest.mockReturnValue(request);
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-disabled-step" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-disabled",
      stepId: "step-disabled-2",
      generationRunId: "run-disabled-step",
      outcome: "blocked",
    }));
  });

  it("marks a delegated task failed when the compute session cannot be created", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-failed",
      runId: "run-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-failed",
      contactId: "contact-failed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-failed",
      userText: "/compute read notes/missing.txt",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "read",
        path: "notes/missing.txt",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "notes/missing.txt",
      },
    });
    mocks.createAudienceComputeSession.mockRejectedValue(new Error("broker unavailable"));

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "failed",
      error: "broker unavailable",
    });
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith({
      taskId: "task-1",
      stepId: "task-step-1",
      generationRunId: "run-failed",
      outcome: "failed",
      failureReason: "broker unavailable",
    });
  });
});
