import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateRepresentativeReply: vi.fn(),
  planNaturalLanguageComputeRequest: vi.fn(),
  renderGroundedKnowledgeFallback: vi.fn(),
  claimNextOperatorMessageWorkItem: vi.fn(),
  claimNextGenerationWorkItem: vi.fn(),
  completeInlineGenerationRun: vi.fn(),
  createConversationPlan: vi.fn(),
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
  completeOperatorMessageDelivery: vi.fn(),
  deferOperatorMessageDelivery: vi.fn(),
  findConversationClarifyingDelegationTask: vi.fn(),
  executeAudienceTool: vi.fn(),
  finalizeComputeDelegationTask: vi.fn(),
  failGenerationRun: vi.fn(),
  renewGenerationWorkItemLease: vi.fn(),
  retryGenerationDelivery: vi.fn(),
  markDelegationTaskAwaitingApproval: vi.fn(),
  markDelegationTaskRunning: vi.fn(),
  waitGenerationRunForComputeApproval: vi.fn(),
  assertConversationChannelDeliveryAvailable: vi.fn(),
  authorizeGenerationRunFreeUsage: vi.fn(),
  reserveGenerationConversationEntitlement: vi.fn(),
  releaseConversationEntitlement: vi.fn(),
  retryOperatorMessageDelivery: vi.fn(),
}));

vi.mock("@delegate/model-runtime", () => ({
  generateRepresentativeReply: mocks.generateRepresentativeReply,
  planNaturalLanguageComputeRequest: mocks.planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallback: mocks.renderGroundedKnowledgeFallback,
}));

vi.mock("@delegate/runtime", () => ({
  buildComputeRequestsFromDelegationPlan: mocks.buildComputeRequestsFromDelegationPlan,
  createConversationPlan: mocks.createConversationPlan,
  parseComputeDirective: mocks.parseComputeDirective,
  renderReplyPreview: () => "fallback",
  readPersistedDelegationStepRequest: mocks.readPersistedDelegationStepRequest,
  resolveComputeSubagent: () => ({ id: "compute-agent" }),
  resolveConversationSubagent: () => ({ id: "public", allowedConversationSteps: ["answer"] }),
  shouldConsiderNaturalLanguageCompute: mocks.shouldConsiderNaturalLanguageCompute,
}));

vi.mock("@delegate/web-data", () => ({
  assertConversationChannelDeliveryAvailable: mocks.assertConversationChannelDeliveryAvailable,
  authorizeGenerationRunFreeUsage: mocks.authorizeGenerationRunFreeUsage,
  buildRepresentativeRuntimeProfile: mocks.buildRepresentativeRuntimeProfile,
  claimNextOperatorMessageWorkItem: mocks.claimNextOperatorMessageWorkItem,
  claimNextGenerationWorkItem: mocks.claimNextGenerationWorkItem,
  completeOperatorMessageDelivery: mocks.completeOperatorMessageDelivery,
  completeInlineGenerationRun: mocks.completeInlineGenerationRun,
  createAudienceComputeSession: mocks.createAudienceComputeSession,
  createComputeDelegationTask: mocks.createComputeDelegationTask,
  createClarifyingDelegationTask: mocks.createClarifyingDelegationTask,
  continueClarifyingDelegationTask: mocks.continueClarifyingDelegationTask,
  deferGenerationRunForHuman: vi.fn(),
  deferOperatorMessageDelivery: mocks.deferOperatorMessageDelivery,
  ensureConversationLeadAndHandoff: mocks.ensureConversationLeadAndHandoff,
  executeAudienceTool: mocks.executeAudienceTool,
  finalizeComputeDelegationTask: mocks.finalizeComputeDelegationTask,
  findConversationClarifyingDelegationTask: mocks.findConversationClarifyingDelegationTask,
  failGenerationRun: mocks.failGenerationRun,
  GENERATION_WORK_LEASE_DURATION_MS: 3_000,
  GenerationWorkLeaseLostError: class GenerationWorkLeaseLostError extends Error {
    readonly code = "generation_work_lease_lost";
  },
  getRepresentativeRuntimeSetupSnapshot: mocks.getRepresentativeRuntimeSetupSnapshot,
  loadGenerationRecentTurns: mocks.loadGenerationRecentTurns,
  markGenerationDeliveryComplete: mocks.markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval: mocks.markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning: mocks.markDelegationTaskRunning,
  recallRepresentativeContext: mocks.recallRepresentativeContext,
  releaseConversationEntitlement: mocks.releaseConversationEntitlement,
  reserveGenerationConversationEntitlement: mocks.reserveGenerationConversationEntitlement,
  renewGenerationWorkItemLease: mocks.renewGenerationWorkItemLease,
  retryGenerationDelivery: mocks.retryGenerationDelivery,
  retryOperatorMessageDelivery: mocks.retryOperatorMessageDelivery,
  isGenerationWorkLeaseLostError: (error: unknown) =>
    error instanceof Error
    && "code" in error
    && error.code === "generation_work_lease_lost",
  waitGenerationRunForComputeApproval: mocks.waitGenerationRunForComputeApproval,
}));

import { GenerationWorkLeaseLostError } from "@delegate/web-data";

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
    mocks.assertConversationChannelDeliveryAvailable.mockResolvedValue(undefined);
    mocks.authorizeGenerationRunFreeUsage.mockResolvedValue(true);
    mocks.reserveGenerationConversationEntitlement.mockResolvedValue(null);
    mocks.releaseConversationEntitlement.mockResolvedValue(undefined);
    mocks.renewGenerationWorkItemLease.mockResolvedValue(true);
    mocks.deferOperatorMessageDelivery.mockResolvedValue(true);
    mocks.retryGenerationDelivery.mockResolvedValue(undefined);
    mocks.retryOperatorMessageDelivery.mockResolvedValue(undefined);
    mocks.createComputeDelegationTask.mockResolvedValue({
      task: { id: "task-1" },
      step: { id: "task-step-1" },
    });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-1",
      leaseAttempt: 1,
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
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.createConversationPlan.mockReturnValue({
      intent: "faq",
      nextStep: "answer",
    });
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

  afterEach(() => {
    vi.useRealTimers();
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

  it("retries only persisted delivery for a completed Telegram generation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { message_id: 90210 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      runId: "run-delivery-retry",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-telegram",
      contactId: "contact-telegram",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "persisted reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramBotToken: "telegram-token-long-enough",
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.claimNextGenerationWorkItem).toHaveBeenCalledWith({
      telegramWorkerEnabled: true,
    });
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/sendMessage"),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          chat_id: "123456",
          text: "persisted reply",
        }),
      }),
    );
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-delivery-retry",
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output",
      externalMessageId: "90210",
    });
    vi.unstubAllGlobals();
  });

  it("does not claim Telegram generation ownership outside worker mode", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue(null);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "shadow",
    })).resolves.toEqual({ processed: false });

    expect(mocks.claimNextGenerationWorkItem).toHaveBeenCalledWith({
      telegramWorkerEnabled: false,
    });
    expect(mocks.claimNextOperatorMessageWorkItem).toHaveBeenCalledWith({
      telegramWorkerEnabled: false,
    });
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();
  });

  it("defers an operator message paused by channel policy without consuming retries", async () => {
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValue({
      outboxId: "operator-outbox-paused",
      messageId: "operator-message-paused",
      conversationId: "conversation-paused",
      text: "operator reply",
      operatorName: "Owner",
      channel: "telegram",
      externalConversationId: "123456",
    });
    const paused = Object.assign(
      new Error("Channel is unavailable: channel_paused."),
      {
        name: "ChannelUnavailableError",
        code: "channel_paused",
      },
    );
    mocks.assertConversationChannelDeliveryAvailable.mockRejectedValue(paused);

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramBotToken: "telegram-token-long-enough",
    })).resolves.toMatchObject({
      processed: true,
      runId: "operator-message-paused",
      status: "deferred",
    });

    expect(mocks.deferOperatorMessageDelivery).toHaveBeenCalledWith({
      outboxId: "operator-outbox-paused",
      messageId: "operator-message-paused",
      reason: "channel_paused",
    });
    expect(mocks.retryOperatorMessageDelivery).not.toHaveBeenCalled();
    expect(mocks.claimNextGenerationWorkItem).not.toHaveBeenCalled();
  });

  it("reserves and atomically consumes a shared entitlement after free replies are exhausted", async () => {
    const reservation = {
      audienceIdentityId: "audience-1",
      representativeId: "rep-1",
      productCode: "plan:pass",
      generationRunId: "run-1",
      operationKey: "generation:run-1:attempt:1",
      accountId: "entitlement-1",
      attempt: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-1",
      leaseAttempt: 1,
      runId: "run-1",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-1",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationEntitlement.mockResolvedValue(reservation);

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.reserveGenerationConversationEntitlement).toHaveBeenCalledWith({
      runId: "run-1",
      outboxId: "outbox-1",
      leaseAttempt: 1,
      audienceIdentityId: "audience-1",
      representativeId: "rep-1",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlementReservation: reservation,
      }),
    );
    expect(mocks.releaseConversationEntitlement).not.toHaveBeenCalled();
  });

  it("falls back to a paid reservation when another channel run claims the last free slot", async () => {
    const reservation = {
      audienceIdentityId: "audience-1",
      representativeId: "rep-1",
      productCode: "plan:pass",
      generationRunId: "run-1",
      operationKey: "generation:run-1:attempt:1",
      accountId: "entitlement-1",
      attempt: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-1",
      leaseAttempt: 1,
      runId: "run-1",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-1",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 3,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.authorizeGenerationRunFreeUsage.mockResolvedValue(false);
    mocks.reserveGenerationConversationEntitlement.mockResolvedValue(
      reservation,
    );

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.authorizeGenerationRunFreeUsage).toHaveBeenCalledWith({
      runId: "run-1",
      outboxId: "outbox-1",
      leaseAttempt: 1,
      freeReplyLimit: 4,
    });
    expect(mocks.reserveGenerationConversationEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        audienceIdentityId: "audience-1",
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlementReservation: reservation,
      }),
    );
  });

  it("stops before generation when fenced entitlement reservation loses its lease", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-stale-reserve",
      leaseAttempt: 1,
      runId: "run-stale-reserve",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-stale-reserve",
      contactId: "contact-stale-reserve",
      audienceIdentityId: "audience-stale-reserve",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-stale-reserve",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationEntitlement.mockRejectedValue(
      new GenerationWorkLeaseLostError("outbox-stale-reserve", 1),
    );

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-stale-reserve",
      status: "lease_lost",
    });

    expect(mocks.reserveGenerationConversationEntitlement).toHaveBeenCalledWith({
      runId: "run-stale-reserve",
      outboxId: "outbox-stale-reserve",
      leaseAttempt: 1,
      audienceIdentityId: "audience-stale-reserve",
      representativeId: "rep-1",
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("leaves a reserved entitlement for fenced terminal cleanup when generation fails", async () => {
    const reservation = {
      audienceIdentityId: "audience-terminal-1",
      representativeId: "rep-1",
      productCode: "plan:pass",
      generationRunId: "run-terminal-entitlement",
      operationKey: "generation:run-terminal-entitlement:attempt:1",
      accountId: "entitlement-terminal-1",
      attempt: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-terminal-entitlement",
      leaseAttempt: 1,
      runId: "run-terminal-entitlement",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-terminal-entitlement",
      contactId: "contact-terminal-entitlement",
      audienceIdentityId: reservation.audienceIdentityId,
      controlState: "AI_ACTIVE",
      inputMessageId: "message-terminal-entitlement",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationEntitlement.mockResolvedValue(reservation);
    mocks.generateRepresentativeReply.mockRejectedValue(new Error("model upstream unavailable"));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: reservation.generationRunId,
      status: "failed",
    });

    expect(mocks.releaseConversationEntitlement).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).toHaveBeenCalledWith({
      runId: reservation.generationRunId,
      outboxId: "outbox-terminal-entitlement",
      leaseAttempt: 1,
      errorCode: "conversation_worker_failed",
      errorMessage: "model upstream unavailable",
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
  });

  it("passes a reserved entitlement through a countUsage=false terminal reply", async () => {
    const reservation = {
      audienceIdentityId: "audience-correctable-1",
      representativeId: "rep-1",
      productCode: "plan:pass",
      generationRunId: "run-correctable-entitlement",
      operationKey: "generation:run-correctable-entitlement:attempt:1",
      accountId: "entitlement-correctable-1",
      attempt: 1,
    };
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-correctable-entitlement",
      leaseAttempt: 1,
      runId: "run-correctable-entitlement",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-correctable-entitlement",
      contactId: "contact-correctable-entitlement",
      audienceIdentityId: reservation.audienceIdentityId,
      controlState: "AI_ACTIVE",
      inputMessageId: "message-correctable-entitlement",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.reserveGenerationConversationEntitlement.mockResolvedValue(reservation);
    mocks.generateRepresentativeReply.mockRejectedValue(
      new Error("path_outside_allowed_workspace"),
    );
    mocks.completeInlineGenerationRun.mockResolvedValue({
      message: { id: "reply-correctable-entitlement" },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: reservation.generationRunId,
      status: "completed",
    });

    expect(mocks.releaseConversationEntitlement).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: reservation.generationRunId,
        countUsage: false,
        entitlementReservation: reservation,
      }),
    );
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
  });

  it("does not double-reserve unified entitlement when wallet credit already owns billing", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-wallet",
      leaseAttempt: 1,
      runId: "run-wallet",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-wallet",
      contactId: "contact-wallet",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-wallet",
      userText: "继续回答",
      channel: "web",
      walletReservation: {
        usageChargeId: "usage-charge-1",
        tokenAmount: 1,
      },
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.reserveGenerationConversationEntitlement).not.toHaveBeenCalled();
    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ passUnlocked: true }),
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.not.objectContaining({
        entitlementReservation: expect.anything(),
      }),
    );
  });

  it("does not fall back to legacy unlock flags once unified entitlements are authoritative", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-legacy",
      runId: "run-legacy",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-legacy",
      contactId: "contact-legacy",
      audienceIdentityId: "audience-1",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-legacy",
      userText: "继续回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: true,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
    });
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          freeRepliesUsed: 4,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      }),
    );
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
      replyText: expect.stringContaining("操作：写入文件：demo.txt"),
    }));
  });

  it("keeps a system-managed document path out of the public approval message", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-generated-document",
      runId: "run-generated-document",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-generated-document",
      contactId: "contact-generated-document",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-generated-document",
      userText: "生成面向管理层的季度销售报告",
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
    const naturalPlan = {
      kind: "execution" as const,
      summary: "生成季度销售报告",
      steps: [{
        capability: "write" as const,
        path: "outputs/report-abcd1234.md",
        content: "# 季度销售报告",
        summary: "生成季度销售报告",
      }],
    };
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: naturalPlan, source: "model" });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([{
      capability: "write",
      path: "outputs/report-abcd1234.md",
      content: "# 季度销售报告",
      displayTarget: "生成季度销售报告",
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
    }]);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-generated-document" } });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "pending_approval",
      approvalRequest: {
        id: "approval-generated-document",
        requestedActionSummary: 'Write to "/workspace/outputs/report-abcd1234.md".',
        riskSummary: "Workspace mutation",
      },
      artifacts: [],
    });
    mocks.waitGenerationRunForComputeApproval.mockResolvedValue({
      run: { status: "WAITING_APPROVAL" },
      message: { id: "pending-generated-document" },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "waiting_approval",
    });

    expect(mocks.waitGenerationRunForComputeApproval).toHaveBeenCalledWith(expect.objectContaining({
      replyText: expect.stringContaining("操作：生成并保存文档"),
    }));
    expect(mocks.waitGenerationRunForComputeApproval.mock.calls[0]?.[0]?.replyText).not.toContain("/workspace/");
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
      hasPaidEntitlement: true,
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
      maxSteps: 5,
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ fileName: "qa.txt", artifactId: "artifact-natural" })],
      countUsage: true,
      replyText: expect.stringContaining("已生成文件：qa.txt"),
    }));
    expect(mocks.executeAudienceTool).toHaveBeenCalledWith(
      "session-natural",
      expect.objectContaining({
        hasPaidEntitlement: false,
      }),
    );
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.replyText).not.toContain("/workspace/");
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.replyText).not.toContain("browser QA");
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "completed",
      artifacts: [expect.objectContaining({ id: "artifact-natural" })],
      actualCredits: 4,
    }));
  });

  it("marks a failed compute result as non-billable", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-compute-failed",
      runId: "run-compute-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-compute-failed",
      contactId: "contact-compute-failed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-compute-failed",
      userText: "/compute process npm test",
      channel: "web",
      usage: { freeRepliesUsed: 3, passUnlocked: true, deepHelpUnlocked: false },
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
        capability: "process",
        command: "npm test",
        displayTarget: "npm test",
        hasPaidEntitlement: true,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({
      session: { id: "session-compute-failed" },
    });
    mocks.executeAudienceTool.mockResolvedValue({
      outcome: "failed",
      artifacts: [],
      billing: { actualCredits: 4 },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.executeAudienceTool).toHaveBeenCalledWith(
      "session-compute-failed",
      expect.objectContaining({
        hasPaidEntitlement: false,
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("未能完成"),
    }));
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "failed",
    }));
  });

  it("keeps natural-language requests as ordinary chat when task triggering is disabled", async () => {
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: false,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxCostCents: 0,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).toHaveBeenCalled();
  });

  it("explains that the advanced command is unavailable when /compute is disabled", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-command-disabled",
      runId: "run-command-disabled",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-command-disabled",
      contactId: "contact-command-disabled",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-command-disabled",
      userText: "/compute",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.parseComputeDirective.mockReturnValue({ kind: "help", examples: "/compute pwd" });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: false,
        maxSteps: 5,
        maxCostCents: 0,
        knowledgeScope: "user_input_only",
      },
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      replyText: expect.stringContaining("未开放高级 /compute 命令"),
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("blocks a denied capability before creating a sandbox session", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-denied",
      runId: "run-denied",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-denied",
      contactId: "contact-denied",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-denied",
      userText: "/compute write notes/denied.txt ::: blocked",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "write",
        path: "notes/denied.txt",
        content: "blocked",
        displayTarget: "notes/denied.txt",
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxCostCents: 0,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
        capabilityModes: {
          exec: "ask",
          read: "allow",
          write: "deny",
          process: "ask",
          browser: "ask",
          mcp: "ask",
        },
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("策略禁止写入工作区文件"),
    }));
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "blocked",
      failureReason: "Representative policy denies write.",
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("adds approved public knowledge to the planner only when the owner enables that scope", async () => {
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({
      ok: true,
      source: "model",
      plan: {
        kind: "execution",
        summary: "生成公开资料摘要",
        steps: [{
          capability: "write",
          summary: "生成公开资料摘要",
          path: "outputs/public-summary.md",
          content: "# 摘要",
        }],
      },
    });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([{
      capability: "write",
      displayTarget: "生成公开资料摘要",
      path: "outputs/public-summary.md",
      content: "# 摘要",
      estimatedCostCents: 5,
    }]);
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-public-knowledge" } });
    mocks.executeAudienceTool.mockResolvedValue({ outcome: "completed", artifacts: [] });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 3,
        maxCostCents: 0,
        knowledgeScope: "public_knowledge",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.planNaturalLanguageComputeRequest).toHaveBeenCalledWith({
      userText: expect.stringContaining("Owner 已授权本任务使用以下已审核公开资料"),
      maxSteps: 3,
    });
    expect(mocks.planNaturalLanguageComputeRequest.mock.calls[0]?.[0]?.userText).toContain(
      "佩奇临时代课并带大家画恐龙",
    );
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      authorizedKnowledge: [{ assetId: "asset-1", title: "佩奇当老师" }],
    }));
  });

  it("stops a task whose estimate exceeds the representative cost limit", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-cost",
      runId: "run-cost",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-cost",
      contactId: "contact-cost",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-cost",
      userText: "/compute write notes/cost.txt ::: expensive",
      channel: "web",
      usage: { freeRepliesUsed: 0, passUnlocked: false, deepHelpUnlocked: false },
    });
    mocks.parseComputeDirective.mockReturnValue({
      kind: "request",
      request: {
        capability: "write",
        path: "notes/cost.txt",
        content: "expensive",
        displayTarget: "notes/cost.txt",
        estimatedCostCents: 12,
      },
    });
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 5,
        maxCostCents: 5,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("超过该代表设置的 5 美分上限"),
    }));
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "blocked",
      failureReason: expect.stringContaining("Estimated cost 12 cents"),
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
  });

  it("records a blocked task when the plan exceeds the representative step limit", async () => {
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);
    mocks.getRepresentativeRuntimeSetupSnapshot.mockResolvedValue({
      id: "rep-1",
      delegation: {
        enabled: true,
        naturalLanguageEnabled: true,
        explicitComputeEnabled: true,
        maxSteps: 1,
        maxCostCents: 0,
        knowledgeScope: "user_input_only",
      },
      compute: {
        enabled: true,
        baseImage: "debian:bookworm-slim",
        maxSessionMinutes: 15,
        networkMode: "no_network",
        filesystemMode: "workspace_only",
      },
    });
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({
      ok: true,
      source: "model",
      plan: {
        kind: "execution",
        summary: "生成两份文件",
        steps: [
          { capability: "write", summary: "生成第一份", path: "outputs/one.md", content: "one" },
          { capability: "write", summary: "生成第二份", path: "outputs/two.md", content: "two" },
        ],
      },
    });
    mocks.buildComputeRequestsFromDelegationPlan.mockReturnValue([
      { capability: "write", displayTarget: "生成第一份", path: "outputs/one.md", content: "one" },
      { capability: "write", displayTarget: "生成第二份", path: "outputs/two.md", content: "two" },
    ]);

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.createComputeDelegationTask).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      outcome: "blocked",
      failureReason: expect.stringContaining("Planned step count 2"),
    }));
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      countUsage: false,
      replyText: expect.stringContaining("超过该代表允许的 1 步上限"),
    }));
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
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
      leaseAttempt: 4,
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
      outboxId: "outbox-next-step",
      leaseAttempt: 4,
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

  it("returns a terminal task error instead of retrying a user-correctable sandbox path", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-invalid-path",
      runId: "run-invalid-path",
      delegationTaskId: "task-invalid-path",
      delegationTaskStepId: "step-invalid-path",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-invalid-path",
      contactId: "contact-invalid-path",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-invalid-path",
      userText: "路径 /AL，内容 佩奇爱上学",
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
        path: "/AL",
        content: "佩奇爱上学",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "写入文件",
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({ session: { id: "session-invalid-path" } });
    mocks.executeAudienceTool.mockRejectedValue(new Error("path_outside_allowed_workspace"));
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-invalid-path" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      intent: "delegation_failed",
      countUsage: false,
      replyText: expect.stringContaining("无需提供沙盒路径"),
    }));
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("never downgrades a bound delegation retry into an ordinary knowledge answer", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-delegation-retry",
      runId: "run-delegation-retry",
      delegationTaskId: "task-failed",
      delegationTaskStepId: "step-failed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-delegation-retry",
      contactId: "contact-delegation-retry",
      controlState: "FAILED",
      inputMessageId: "message-delegation-retry",
      userText: "路径 /AL，内容 佩奇爱上学",
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
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-delegation-retry" } });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      intent: "delegation_failed",
      countUsage: false,
    }));
    expect(mocks.finalizeComputeDelegationTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-failed",
      stepId: "step-failed",
      generationRunId: "run-delegation-retry",
      outcome: "failed",
    }));
    expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("stops attempt A after lease loss and lets reclaimed attempt B commit", async () => {
    vi.useFakeTimers();
    const baseItem = {
      runId: "run-reclaimed",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-reclaimed",
      contactId: "contact-reclaimed",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-reclaimed",
      userText: "请回答",
      channel: "web",
      usage: {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
    };
    mocks.claimNextGenerationWorkItem
      .mockResolvedValueOnce({
        ...baseItem,
        outboxId: "outbox-reclaimed",
        leaseAttempt: 1,
      })
      .mockResolvedValueOnce({
        ...baseItem,
        outboxId: "outbox-reclaimed",
        leaseAttempt: 2,
      });
    mocks.renewGenerationWorkItemLease
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    let releaseAttemptA!: (value: {
      ok: true;
      replyText: string;
      provider: "openai";
      model: string;
    }) => void;
    mocks.generateRepresentativeReply.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseAttemptA = resolve;
      }),
    );

    const attemptA = processNextConversationWork({ port: 4040, pollMs: 500 });
    await vi.waitFor(() => {
      expect(mocks.generateRepresentativeReply).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    releaseAttemptA({
      ok: true,
      replyText: "attempt A stale reply",
      provider: "openai",
      model: "test-model",
    });

    await expect(attemptA).resolves.toMatchObject({
      processed: true,
      runId: "run-reclaimed",
      status: "lease_lost",
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();

    mocks.generateRepresentativeReply.mockResolvedValueOnce({
      ok: true,
      replyText: "attempt B authoritative reply",
      provider: "openai",
      model: "test-model",
    });
    mocks.completeInlineGenerationRun.mockResolvedValueOnce({
      message: { id: "reply-reclaimed" },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-reclaimed",
      status: "completed",
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-reclaimed",
        outboxId: "outbox-reclaimed",
        leaseAttempt: 2,
        replyText: "attempt B authoritative reply",
      }),
    );
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-reclaimed",
      outboxId: "outbox-reclaimed",
      leaseAttempt: 2,
      outputMessageId: "reply-reclaimed",
    });
  });
});
