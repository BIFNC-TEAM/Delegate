import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  privateChannelSourceVerificationUnavailableStatement:
    "来源说明：暂时无法核验本次回答是否引用了已授权知识或记忆。为避免发送未经核验的内容，本次回答已被隐藏，请稍后重新提问。",
  generateRepresentativeReply: vi.fn(),
  hasPersistedTelegramBotConnections: vi.fn(),
  isDeterministicContactMemoryDeleteCommand: vi.fn(),
  planNaturalLanguageComputeRequest: vi.fn(),
  renderFailClosedReplyPreview: vi.fn(),
  renderGroundedKnowledgeFallbackWithTrace: vi.fn(),
  claimNextOperatorMessageWorkItem: vi.fn(),
  claimNextGenerationWorkItem: vi.fn(),
  completeInlineGenerationRun: vi.fn(),
  createConversationPlan: vi.fn(),
  readStructuredCollectorState: vi.fn(),
  shouldStartStructuredCollector: vi.fn(),
  beginStructuredCollector: vi.fn(),
  advanceStructuredCollector: vi.fn(),
  formatStructuredCollectorPrompt: vi.fn(),
  formatStructuredCollectorSummary: vi.fn(),
  getRepresentativeRuntimeSetupSnapshot: vi.fn(),
  buildRepresentativeRuntimeProfile: vi.fn(),
  loadGenerationRecentTurns: vi.fn(),
  recallRepresentativeContext: vi.fn(),
  markGenerationDeliveryComplete: vi.fn(),
  prepareGenerationMessageChannelDelivery: vi.fn(),
  ensureConversationLeadAndHandoff: vi.fn(),
  createConversationServiceRequest: vi.fn(),
  setConversationCollectorState: vi.fn(),
  clearConversationCollectorState: vi.fn(),
  parseComputeDirective: vi.fn(),
  shouldConsiderNaturalLanguageCompute: vi.fn(),
  buildComputeRequestsFromDelegationPlan: vi.fn(),
  readPersistedDelegationStepRequest: vi.fn(),
  resolveDeterministicContactMemorySharingCommand: vi.fn(),
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
  reserveGenerationConversationWalletUsage: vi.fn(),
  renderPrivateChannelGenerationDeliveryText: vi.fn(),
  releaseConversationEntitlement: vi.fn(),
  retryOperatorMessageDelivery: vi.fn(),
  resolveTelegramBotRuntimeCredential: vi.fn(),
  withActiveTelegramRepresentativeChannelFence: vi.fn(),
  withGenerationMessageProviderDeliveryFence: vi.fn(),
  sendMatrixRepresentativeMessage: vi.fn(),
}));

vi.mock("@delegate/model-runtime", () => ({
  generateRepresentativeReply: mocks.generateRepresentativeReply,
  planNaturalLanguageComputeRequest: mocks.planNaturalLanguageComputeRequest,
  renderGroundedKnowledgeFallbackWithTrace:
    mocks.renderGroundedKnowledgeFallbackWithTrace,
}));

vi.mock("@delegate/runtime", () => ({
  buildComputeRequestsFromDelegationPlan: mocks.buildComputeRequestsFromDelegationPlan,
  advanceStructuredCollector: mocks.advanceStructuredCollector,
  beginStructuredCollector: mocks.beginStructuredCollector,
  createConversationPlan: mocks.createConversationPlan,
  formatStructuredCollectorPrompt: mocks.formatStructuredCollectorPrompt,
  formatStructuredCollectorSummary: mocks.formatStructuredCollectorSummary,
  parseComputeDirective: mocks.parseComputeDirective,
  renderFailClosedReplyPreview: mocks.renderFailClosedReplyPreview,
  renderReplyPreview: () => "fallback",
  readPersistedDelegationStepRequest: mocks.readPersistedDelegationStepRequest,
  readStructuredCollectorState: mocks.readStructuredCollectorState,
  resolveComputeSubagent: () => ({ id: "compute-agent" }),
  resolveConversationSubagent: () => ({ id: "public", allowedConversationDispositions: ["answer"] }),
  shouldStartStructuredCollector: mocks.shouldStartStructuredCollector,
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
  createConversationServiceRequest: mocks.createConversationServiceRequest,
  createClarifyingDelegationTask: mocks.createClarifyingDelegationTask,
  continueClarifyingDelegationTask: mocks.continueClarifyingDelegationTask,
  deferGenerationRunForHuman: vi.fn(),
  deferOperatorMessageDelivery: mocks.deferOperatorMessageDelivery,
  ensureConversationLeadAndHandoff: mocks.ensureConversationLeadAndHandoff,
  setConversationCollectorState: mocks.setConversationCollectorState,
  clearConversationCollectorState: mocks.clearConversationCollectorState,
  executeAudienceTool: mocks.executeAudienceTool,
  finalizeComputeDelegationTask: mocks.finalizeComputeDelegationTask,
  findConversationClarifyingDelegationTask: mocks.findConversationClarifyingDelegationTask,
  failGenerationRun: mocks.failGenerationRun,
  GENERATION_WORK_LEASE_DURATION_MS: 3_000,
  GenerationMemoryDeliveryBlockedError:
    class GenerationMemoryDeliveryBlockedError extends Error {
      readonly code = "generation_memory_delivery_source_revoked";
    },
  GenerationWorkLeaseLostError: class GenerationWorkLeaseLostError extends Error {
    readonly code = "generation_work_lease_lost";
  },
  getRepresentativeRuntimeSetupSnapshot: mocks.getRepresentativeRuntimeSetupSnapshot,
  hasPersistedTelegramBotConnections:
    mocks.hasPersistedTelegramBotConnections,
  isDeterministicContactMemoryDeleteCommand:
    mocks.isDeterministicContactMemoryDeleteCommand,
  loadGenerationRecentTurns: mocks.loadGenerationRecentTurns,
  markGenerationDeliveryComplete: mocks.markGenerationDeliveryComplete,
  markDelegationTaskAwaitingApproval: mocks.markDelegationTaskAwaitingApproval,
  markDelegationTaskRunning: mocks.markDelegationTaskRunning,
  prepareGenerationMessageChannelDelivery:
    mocks.prepareGenerationMessageChannelDelivery,
  privateChannelSourceVerificationUnavailableStatement:
    mocks.privateChannelSourceVerificationUnavailableStatement,
  recallRepresentativeContext: mocks.recallRepresentativeContext,
  resolveDeterministicContactMemorySharingCommand:
    mocks.resolveDeterministicContactMemorySharingCommand,
  releaseConversationEntitlement: mocks.releaseConversationEntitlement,
  reserveGenerationConversationWalletUsage:
    mocks.reserveGenerationConversationWalletUsage,
  renderPrivateChannelGenerationDeliveryText:
    mocks.renderPrivateChannelGenerationDeliveryText,
  renewGenerationWorkItemLease: mocks.renewGenerationWorkItemLease,
  retryGenerationDelivery: mocks.retryGenerationDelivery,
  retryOperatorMessageDelivery: mocks.retryOperatorMessageDelivery,
  resolveTelegramBotRuntimeCredential:
    mocks.resolveTelegramBotRuntimeCredential,
  withActiveTelegramRepresentativeChannelFence:
    mocks.withActiveTelegramRepresentativeChannelFence,
  withGenerationMessageProviderDeliveryFence:
    mocks.withGenerationMessageProviderDeliveryFence,
  isGenerationWorkLeaseLostError: (error: unknown) =>
    error instanceof Error
    && "code" in error
    && error.code === "generation_work_lease_lost",
  isGenerationMemoryDeliveryBlockedError: (error: unknown) =>
    error instanceof Error
    && "code" in error
    && error.code === "generation_memory_delivery_source_revoked",
  waitGenerationRunForComputeApproval: mocks.waitGenerationRunForComputeApproval,
}));

vi.mock("../src/matrix-outbound", () => ({
  sendMatrixRepresentativeMessage: mocks.sendMatrixRepresentativeMessage,
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
    mocks.readStructuredCollectorState.mockReturnValue(null);
    mocks.shouldStartStructuredCollector.mockReturnValue(false);
    mocks.resolveDeterministicContactMemorySharingCommand.mockReturnValue(null);
    mocks.findConversationClarifyingDelegationTask.mockResolvedValue(null);
    mocks.planNaturalLanguageComputeRequest.mockResolvedValue({ ok: true, plan: null, source: "model" });
    mocks.finalizeComputeDelegationTask.mockResolvedValue({ hasMoreSteps: false });
    mocks.assertConversationChannelDeliveryAvailable.mockResolvedValue(undefined);
    mocks.authorizeGenerationRunFreeUsage.mockResolvedValue(true);
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(null);
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(null);
    mocks.renderPrivateChannelGenerationDeliveryText.mockImplementation(
      async ({ text }: { text: string }) => text,
    );
    mocks.releaseConversationEntitlement.mockResolvedValue(undefined);
    mocks.renewGenerationWorkItemLease.mockResolvedValue(true);
    mocks.deferOperatorMessageDelivery.mockResolvedValue(true);
    mocks.prepareGenerationMessageChannelDelivery.mockResolvedValue({
      conversationState: "WAITING_USER",
      leaseExpiresAt: new Date("2026-07-24T08:05:00.000Z"),
    });
    mocks.retryGenerationDelivery.mockResolvedValue(undefined);
    mocks.retryOperatorMessageDelivery.mockResolvedValue(undefined);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValue(null);
    mocks.withActiveTelegramRepresentativeChannelFence.mockImplementation(
      async (_input, operation) => ({
        executed: true,
        value: await operation({}),
      }),
    );
    mocks.withGenerationMessageProviderDeliveryFence.mockImplementation(
      async (_tx, _input, operation) => ({
        executed: true,
        value: await operation(),
      }),
    );
    mocks.hasPersistedTelegramBotConnections.mockResolvedValue(false);
    mocks.isDeterministicContactMemoryDeleteCommand.mockImplementation(
      (text: string | null) => [
        "/delete_memory",
        "/forget",
        "delete my memory",
        "forget my memory",
        "删除我的记忆",
      ].includes(text?.trim().toLocaleLowerCase() ?? ""),
    );
    mocks.sendMatrixRepresentativeMessage.mockResolvedValue("$matrix-event-1");
    mocks.createComputeDelegationTask.mockResolvedValue({
      task: { id: "task-1" },
      step: { id: "task-step-1" },
    });
    mocks.createConversationServiceRequest.mockResolvedValue({ task: { id: "service-request-1" }, skipped: null });
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
      goal: "get_information",
      intent: "faq",
      audienceRole: "other",
      disposition: "answer",
      actions: [{ id: "answer_public_information:faq", kind: "answer_public_information", status: "planned", sideEffect: "none" }],
      reasons: ["Public answer."],
      responseOutline: ["Answer from authorized public information."],
    });
    mocks.renderFailClosedReplyPreview.mockReturnValue("SAFE FAIL-CLOSED REPLY");
    mocks.loadGenerationRecentTurns.mockResolvedValue([]);
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [{
        uri: "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md",
        contextType: "resource",
        layer: "L2",
        score: 0.91,
        abstract: "佩奇临时代课并带大家画恐龙。",
        memoryUseItemId: "memory-use-item-1",
        internalSource: {
          sourceKind: "PUBLIC_KNOWLEDGE",
          memoryUseItemId: "memory-use-item-1",
        },
      }],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "佩奇临时代课，和同学们一起完成了一幅有想象力的恐龙画。",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: ["memory-use-item-1"],
      contextTrace: {
        selectedMemoryUseItemIds: ["memory-use-item-1"],
      },
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue({
      replyText: "根据已发布的知识资料：佩奇临时代课并带大家画恐龙。",
      selectedRecallUris: [
        "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md",
      ],
    });
    mocks.completeInlineGenerationRun.mockResolvedValue({ message: { id: "reply-1" } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      channel: "matrix" as const,
      command: "删除我的记忆",
      channelName: "Matrix",
      externalConversationId: "!memory-room:example.test",
      matrixSenderUserId: "@delegate:example.test",
    },
    {
      channel: "telegram" as const,
      command: "/forget",
      channelName: "Telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
    },
  ])(
    "confirms an exact $channel Contact Memory deletion without recall, model, or billing",
    async (fixture) => {
      const confirmation =
        `已完成：当前数字代表与当前 ${fixture.channelName} 渠道下的联系人记忆已立即停止召回，后台将异步清理对应长期记忆。代表经验和其他渠道的联系人记忆不受影响。`;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 90212 },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      if (fixture.channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "111111111",
          botId: "111111111",
          username: "bot_a",
          displayName: "Bot A",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
          credentialRevision: 1,
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-delete-${fixture.channel}`,
        leaseAttempt: 1,
        runId: `run-delete-${fixture.channel}`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-delete-${fixture.channel}`,
        contactId: `contact-delete-${fixture.channel}`,
        controlState: "AI_ACTIVE",
        inputMessageId: `message-delete-${fixture.channel}`,
        userText: fixture.command,
        channel: fixture.channel,
        externalConversationId: fixture.externalConversationId,
        ...(fixture.channel === "matrix"
          ? {
              matrixSenderUserId: fixture.matrixSenderUserId,
              matrixEndpointLifecycleRevision: 7,
            }
          : { telegramConnectionId: fixture.telegramConnectionId }),
        usage: {
          freeRepliesUsed: 99,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      });

      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramConversationPlatformMode: "worker",
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
      })).resolves.toMatchObject({
        processed: true,
        runId: `run-delete-${fixture.channel}`,
        status: "completed",
      });

      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith({
        conversationId: `conversation-delete-${fixture.channel}`,
        runId: `run-delete-${fixture.channel}`,
        outboxId: `outbox-delete-${fixture.channel}`,
        leaseAttempt: 1,
        replyText: confirmation,
        senderDisplayName: "SKTone",
        intent: "contact_memory_delete_confirmation",
        completeOutbox: false,
        countUsage: false,
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "disabled",
          fallbackReason: "policy_fallback",
        },
      });
      expect(mocks.getRepresentativeRuntimeSetupSnapshot).not.toHaveBeenCalled();
      expect(mocks.loadGenerationRecentTurns).not.toHaveBeenCalled();
      expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
      expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
      expect(mocks.authorizeGenerationRunFreeUsage).not.toHaveBeenCalled();
      expect(mocks.renderPrivateChannelGenerationDeliveryText).not.toHaveBeenCalled();

      if (fixture.channel === "matrix") {
        expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: "conversation-delete-matrix",
            roomId: fixture.externalConversationId,
            senderUserId: fixture.matrixSenderUserId,
            generationRunId: "run-delete-matrix",
            text: confirmation,
          }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
      } else {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining(
            "/bot111111111:AAAAAAAAAAAAAAAAAAAAAAAA/sendMessage",
          ),
          expect.objectContaining({
            body: JSON.stringify({
              chat_id: fixture.externalConversationId,
              text: confirmation,
            }),
          }),
        );
      }
    },
  );

  it("passes recalled knowledge to the model and persists its citation", async () => {
    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.recallRepresentativeContext).toHaveBeenCalledWith({
      representativeSlug: "sktone",
      conversationId: "conversation-1",
      contactId: "contact-1",
      sourceChannel: "web",
      generationRunId: "run-1",
      queryText: "佩奇当老师时发生了什么？",
    });
    expect(mocks.generateRepresentativeReply).toHaveBeenCalledWith(expect.objectContaining({
      recalled: [expect.objectContaining({ abstract: "佩奇临时代课并带大家画恐龙。" })],
    }));
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "completed",
        injectedItemIds: ["memory-use-item-1"],
        citedItemIds: ["memory-use-item-1"],
      },
      runtimeOutcome: {
        mode: "model",
      },
    }));
  });

  it("records only the ledger item actually injected and cited by the model", async () => {
    const firstUri = "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md";
    const secondUri = "viking://resources/delegate/reps/sktone/knowledge/asset-2.md/asset-2.md";
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [
        {
          uri: firstUri,
          contextType: "resource",
          layer: "L2",
          score: 0.95,
          abstract: "First searched candidate.",
          memoryUseItemId: "memory-use-item-1",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-1" },
        },
        {
          uri: secondUri,
          contextType: "resource",
          layer: "L2",
          score: 0.9,
          abstract: "Second injected candidate.",
          memoryUseItemId: "memory-use-item-2",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-2" },
        },
      ],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "Answer grounded in the injected source.",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: ["memory-use-item-2"],
      contextTrace: { selectedMemoryUseItemIds: ["memory-use-item-2"] },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryUse: {
          runId: "memory-use-run-1",
          outcome: "completed",
          injectedItemIds: ["memory-use-item-2"],
          citedItemIds: ["memory-use-item-2"],
        },
      }),
    );
  });

  it("drops public recall items that are not bound to a generation UseRun", async () => {
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [{
        uri: "viking://resources/delegate/reps/sktone/versions/version-1/faq/index.md",
        contextType: "resource",
        layer: "L2",
        score: 0.95,
        abstract: "Orphaned public fact that must not reach the model.",
        memoryUseItemId: "orphaned-memory-use-item",
        internalSource: {
          sourceKind: "PUBLIC_KNOWLEDGE",
          memoryUseItemId: "orphaned-memory-use-item",
        },
      }],
      citations: [],
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "Answer without orphaned knowledge.",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: [],
      contextTrace: { selectedMemoryUseItemIds: [] },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.generateRepresentativeReply).toHaveBeenCalledWith(
      expect.objectContaining({ recalled: [] }),
    );
    const completion = mocks.completeInlineGenerationRun.mock.calls[0]?.[0];
    expect(completion).not.toHaveProperty("memoryUse");
    expect(JSON.stringify(completion)).not.toContain("Orphaned public fact");
  });

  it("persists no citation when the token budget drops the recall segment", async () => {
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: true,
      replyText: "Answer without recalled context.",
      provider: "openai",
      model: "test-model",
      citedMemoryUseItemIds: [],
      contextTrace: { selectedMemoryUseItemIds: [] },
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "completed",
        injectedItemIds: [],
        citedItemIds: [],
      },
    }));
  });

  it("does not use or cite recalled knowledge when model generation fails", async () => {
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "provider timed out with secret upstream details",
      state: "ready",
      citedMemoryUseItemIds: [],
    });

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.renderGroundedKnowledgeFallbackWithTrace).not.toHaveBeenCalled();
    expect(mocks.renderFailClosedReplyPreview).toHaveBeenCalledWith(
      expect.any(Object),
      "佩奇当老师时发生了什么？",
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      replyText: "SAFE FAIL-CLOSED REPLY",
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "generation_failed",
      },
      runtimeOutcome: {
        mode: "fallback",
        fallbackStrategy: "deterministic_preview",
        modelRuntimeState: "ready",
        fallbackReason: "provider_failed",
      },
    }));
    expect(
      JSON.stringify(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]),
    ).not.toContain("secret upstream details");
    expect(
      JSON.stringify(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]),
    ).not.toContain("佩奇临时代课并带大家画恐龙");
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.memoryUse).not.toHaveProperty(
      "injectedItemIds",
    );
    expect(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]?.memoryUse).not.toHaveProperty(
      "citedItemIds",
    );
  });

  it("never attributes a fail-closed fallback to searched, injected, cited, or displayed sources", async () => {
    const firstUri = "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md";
    const secondUri = "viking://resources/delegate/reps/sktone/knowledge/asset-2.md/asset-2.md";
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [
        {
          uri: firstUri,
          contextType: "resource",
          layer: "L2",
          score: 0.91,
          abstract: "Relevant fallback fact.",
          memoryUseItemId: "memory-use-item-1",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-1" },
        },
        {
          uri: secondUri,
          contextType: "resource",
          layer: "L2",
          score: 0.99,
          abstract: "Unrelated searched fact.",
          memoryUseItemId: "memory-use-item-2",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE", memoryUseItemId: "memory-use-item-2" },
        },
      ],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "provider unavailable",
      state: "ready",
      citedMemoryUseItemIds: [],
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue({
      replyText: "Relevant fallback fact.",
      selectedRecallUris: [firstUri],
    });

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    expect(mocks.renderGroundedKnowledgeFallbackWithTrace).not.toHaveBeenCalled();
    const completion = mocks.completeInlineGenerationRun.mock.calls[0]?.[0];
    expect(completion).toEqual(expect.objectContaining({
      replyText: "SAFE FAIL-CLOSED REPLY",
      memoryUse: {
        runId: "memory-use-run-1",
        outcome: "generation_failed",
      },
    }));
    expect(completion?.memoryUse).not.toHaveProperty("injectedItemIds");
    expect(completion?.memoryUse).not.toHaveProperty("citedItemIds");
    expect(completion).not.toHaveProperty("citations");
    expect(JSON.stringify(completion)).not.toContain("Relevant fallback fact.");
    expect(JSON.stringify(completion)).not.toContain("Unrelated searched fact.");
  });

  it("never echoes or cites contact memory through provider-failure fallback", async () => {
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [{
        uri: "viking://user/memories/delegate/memory-ns/contacts/contact-1/channels/web/memories/memory-1/versions/version-1.md",
        contextType: "memory",
        layer: "L2",
        score: 0.99,
        abstract: "Private unrelated preference.",
        content: "Private unrelated preference.",
        memoryUseItemId: "memory-use-contact-1",
        internalSource: {
          sourceKind: "CONTACT_MEMORY",
          memoryVersionId: "memory-version-1",
          projectionItemId: "projection-1",
          contentHash: "sha256-memory",
          memoryUseItemId: "memory-use-contact-1",
        },
      }],
      citations: [],
      memoryUseRunId: "memory-use-run-1",
    });
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "provider unavailable",
      state: "ready",
      citedMemoryUseItemIds: [],
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue(null);

    await processNextConversationWork({ port: 4040, pollMs: 500 });

    const completion = mocks.completeInlineGenerationRun.mock.calls[0]?.[0];
    expect(completion).not.toHaveProperty("citations");
    expect(completion).toHaveProperty("memoryUse", {
      runId: "memory-use-run-1",
      outcome: "generation_failed",
    });
    expect(JSON.stringify(completion)).not.toContain("Private unrelated preference");
  });

  it("records a sanitized deterministic fallback when the model is unavailable", async () => {
    mocks.generateRepresentativeReply.mockResolvedValue({
      ok: false,
      reason: "missing key sk-do-not-persist",
      state: "missing_credentials",
    });
    mocks.renderGroundedKnowledgeFallbackWithTrace.mockReturnValue(null);

    await expect(processNextConversationWork({ port: 4040, pollMs: 500 })).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: "SAFE FAIL-CLOSED REPLY",
        runtimeOutcome: {
          mode: "fallback",
          fallbackStrategy: "deterministic_preview",
          modelRuntimeState: "missing_credentials",
          fallbackReason: "model_unavailable",
        },
      }),
    );
    expect(
      JSON.stringify(mocks.completeInlineGenerationRun.mock.calls[0]?.[0]),
    ).not.toContain("sk-do-not-persist");
  });

  it("does not send a completed memory-backed answer after deletion fences its delivery retry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const blocked = Object.assign(
      new Error("Generation delivery was canceled because an injected source is no longer authorized."),
      { code: "generation_memory_delivery_source_revoked" },
    );
    mocks.prepareGenerationMessageChannelDelivery.mockRejectedValueOnce(blocked);
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-memory-delivery-retry",
      leaseAttempt: 2,
      runId: "run-memory-delivery-retry",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-telegram-memory",
      contactId: "contact-telegram-memory",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound-memory",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output-memory",
      outputText: "persisted personalized answer that must stay hidden",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-memory-delivery-retry",
      status: "canceled",
    });

    expect(mocks.prepareGenerationMessageChannelDelivery).toHaveBeenCalledWith({
      conversationId: "conversation-telegram-memory",
      runId: "run-memory-delivery-retry",
      outboxId: "outbox-memory-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output-memory",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.renderPrivateChannelGenerationDeliveryText).not.toHaveBeenCalled();
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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
    mocks.renderPrivateChannelGenerationDeliveryText.mockResolvedValueOnce(
      "persisted reply\n\n——\n来源说明：本回答未引用已授权知识或记忆，内容由通用模型生成。",
    );
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "connection-a",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
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
      telegramConnectionId: "111111111",
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
      telegramBotToken: "222222222:BBBBBBBBBBBBBBBBBBBBBBBB",
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
    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).toHaveBeenCalledWith({ connectionId: "111111111" });
    expect(
      mocks.withActiveTelegramRepresentativeChannelFence,
    ).toHaveBeenCalledWith(
      {
        conversationId: "conversation-telegram",
        expectedConnectionId: "111111111",
      },
      expect.any(Function),
    );
    expect(
      mocks.withGenerationMessageProviderDeliveryFence,
    ).toHaveBeenCalledWith(
      expect.anything(),
      {
        conversationId: "conversation-telegram",
        runId: "run-delivery-retry",
        outboxId: "outbox-delivery-retry",
        leaseAttempt: 2,
        outputMessageId: "message-output",
      },
      expect.any(Function),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/bot111111111:AAAAAAAAAAAAAAAAAAAAAAAA/sendMessage",
      ),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          chat_id: "123456",
          text:
            "persisted reply\n\n——\n来源说明：本回答未引用已授权知识或记忆，内容由通用模型生成。",
        }),
      }),
    );
    expect(
      mocks.renderPrivateChannelGenerationDeliveryText,
    ).toHaveBeenCalledWith({
      generationRunId: "run-delivery-retry",
      outputMessageId: "message-output",
      text: "persisted reply",
    });
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-telegram",
      runId: "run-delivery-retry",
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output",
    }));
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-delivery-retry",
      outboxId: "outbox-delivery-retry",
      leaseAttempt: 2,
      outputMessageId: "message-output",
      externalMessageId: "90210",
    });
    vi.unstubAllGlobals();
  });

  it("uses the same persisted source footer boundary for Matrix delivery", async () => {
    mocks.renderPrivateChannelGenerationDeliveryText.mockResolvedValueOnce(
      "persisted Matrix reply\n\n——\n来源：代表经验",
    );
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-matrix-delivery",
      leaseAttempt: 1,
      runId: "run-matrix-delivery",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-matrix",
      contactId: "contact-matrix",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound-matrix",
      userText: "original inbound",
      channel: "matrix",
      externalConversationId: "!room:example.test",
      matrixSenderUserId: "@delegate:example.test",
      matrixEndpointLifecycleRevision: 7,
      deliveryOnly: true,
      outputMessageId: "message-output-matrix",
      outputText: "persisted Matrix reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      matrixHomeserverUrl: "https://matrix.example.test",
      matrixApplicationServiceToken: "as-token",
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-matrix-delivery",
      status: "completed",
    });

    expect(
      mocks.renderPrivateChannelGenerationDeliveryText,
    ).toHaveBeenCalledWith({
      generationRunId: "run-matrix-delivery",
      outputMessageId: "message-output-matrix",
      text: "persisted Matrix reply",
    });
    expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-matrix",
        roomId: "!room:example.test",
        generationRunId: "run-matrix-delivery",
        generationDelivery: {
          runId: "run-matrix-delivery",
          outboxId: "outbox-matrix-delivery",
          leaseAttempt: 1,
          outputMessageId: "message-output-matrix",
        },
        text: "persisted Matrix reply\n\n——\n来源：代表经验",
      }),
    );
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-matrix-delivery",
      outboxId: "outbox-matrix-delivery",
      leaseAttempt: 1,
      outputMessageId: "message-output-matrix",
      externalMessageId: "$matrix-event-1",
    });
  });

  it.each(["matrix", "telegram"] as const)(
    "sends only a fixed fail-closed notice when %s source verification throws",
    async (channel) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 90211 },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      mocks.renderPrivateChannelGenerationDeliveryText.mockRejectedValueOnce(
        new Error("source verification unavailable"),
      );
      if (channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "connection-a",
          botId: "111111111",
          username: "bot_a",
          displayName: "Bot A",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
          credentialRevision: 1,
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-${channel}-source-failure`,
        leaseAttempt: 1,
        runId: `run-${channel}-source-failure`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-${channel}-source-failure`,
        contactId: `contact-${channel}`,
        controlState: "WAITING_USER",
        inputMessageId: `message-inbound-${channel}`,
        userText: "original inbound",
        channel,
        externalConversationId: channel === "matrix"
          ? "!room:example.test"
          : "123456",
        ...(channel === "matrix"
          ? {
              matrixSenderUserId: "@delegate:example.test",
              matrixEndpointLifecycleRevision: 7,
            }
          : { telegramConnectionId: "connection-a" }),
        deliveryOnly: true,
        outputMessageId: `message-output-${channel}`,
        outputText: "UNVERIFIED ANSWER MUST NOT BE SENT",
        usage: {
          freeRepliesUsed: 4,
          passUnlocked: true,
          deepHelpUnlocked: false,
        },
      });

      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
        telegramConversationPlatformMode: "worker",
        telegramRequestTimeoutMs: 8_000,
      })).resolves.toMatchObject({
        processed: true,
        status: "completed",
      });

      if (channel === "matrix") {
        expect(mocks.sendMatrixRepresentativeMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            text: mocks.privateChannelSourceVerificationUnavailableStatement,
          }),
        );
      } else {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: JSON.stringify({
              chat_id: "123456",
              text: mocks.privateChannelSourceVerificationUnavailableStatement,
            }),
          }),
        );
      }
      expect(JSON.stringify([
        ...mocks.sendMatrixRepresentativeMessage.mock.calls,
        ...fetchMock.mock.calls,
      ])).not.toContain("UNVERIFIED ANSWER MUST NOT BE SENT");
      expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
      expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: `run-${channel}-source-failure`,
          outputMessageId: `message-output-${channel}`,
        }),
      );
      vi.unstubAllGlobals();
    },
  );

  it("does not call Telegram after the final assignment-epoch fence closes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.withActiveTelegramRepresentativeChannelFence
      .mockResolvedValueOnce({
        executed: false,
        reason: "telegram_channel_not_active",
      });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-old-telegram-epoch",
      leaseAttempt: 2,
      runId: "run-old-telegram-epoch",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-old-telegram-epoch",
      contactId: "contact-telegram",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "stale reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      status: "failed",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-old-telegram-epoch",
        outputMessageId: "message-output",
        errorMessage:
          "Telegram channel assignment changed before outbound delivery.",
      }),
    );
    expect(
      mocks.markGenerationDeliveryComplete,
    ).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not call Telegram after the provider memory fence cancels delivery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "111111111",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.withGenerationMessageProviderDeliveryFence.mockResolvedValueOnce({
      executed: false,
      reason: "memory_delivery_source_revoked",
    });
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-forgotten-telegram",
      leaseAttempt: 3,
      runId: "run-forgotten-telegram",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-forgotten-telegram",
      contactId: "contact-telegram",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "stale personalized reply",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-forgotten-telegram",
      status: "canceled",
    });

    expect(
      mocks.withGenerationMessageProviderDeliveryFence,
    ).toHaveBeenCalledWith(
      expect.anything(),
      {
        conversationId: "conversation-forgotten-telegram",
        runId: "run-forgotten-telegram",
        outboxId: "outbox-forgotten-telegram",
        leaseAttempt: 3,
        outputMessageId: "message-output",
      },
      expect.any(Function),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never falls back to the legacy token when a managed Bot credential is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.hasPersistedTelegramBotConnections.mockResolvedValueOnce(true);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce(null);
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-managed-credential-unavailable",
      leaseAttempt: 1,
      runId: "run-managed-credential-unavailable",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-managed-credential-unavailable",
      contactId: "contact-managed-credential-unavailable",
      controlState: "WAITING_USER",
      inputMessageId: "message-inbound",
      userText: "original inbound",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "111111111",
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
      telegramBotToken: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      telegramConversationPlatformMode: "worker",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-managed-credential-unavailable",
      status: "failed",
      error:
        "Telegram Bot credential is unavailable for this conversation.",
    });

    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).toHaveBeenCalledWith({ connectionId: "111111111" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).toHaveBeenCalledWith({
      runId: "run-managed-credential-unavailable",
      outboxId: "outbox-managed-credential-unavailable",
      leaseAttempt: 1,
      outputMessageId: "message-output",
      errorMessage:
        "Telegram Bot credential is unavailable for this conversation.",
    });
    vi.unstubAllGlobals();
  });

  it("recovers a terminal Telegram delegation without rerunning setup, model, or compute", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { message_id: 90211 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const attachments = [{
      fileName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 42,
      artifactId: "artifact-recovery",
      url: "/reps/sktone/chat/artifacts/artifact-recovery/download",
    }];
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-terminal-recovery",
      leaseAttempt: 2,
      runId: "run-terminal-recovery",
      delegationTaskId: "task-terminal-recovery",
      delegationTaskStepId: "step-terminal-recovery",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-terminal-recovery",
      contactId: "contact-terminal-recovery",
      controlState: "AI_QUEUED",
      inputMessageId: "message-terminal-recovery",
      userText: "生成一份报告",
      channel: "telegram",
      externalConversationId: "654321",
      telegramConnectionId: "111111111",
      delegationTerminalRecovery: {
        taskStatus: "COMPLETED",
        stepStatus: "COMPLETED",
        attachments,
      },
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.completeInlineGenerationRun.mockResolvedValueOnce({
      message: { id: "message-terminal-recovery-output" },
    });

    try {
      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramBotToken: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
        telegramConversationPlatformMode: "worker",
        telegramRequestTimeoutMs: 8_000,
      })).resolves.toMatchObject({
        processed: true,
        runId: "run-terminal-recovery",
        status: "completed",
      });

      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith({
        conversationId: "conversation-terminal-recovery",
        runId: "run-terminal-recovery",
        outboxId: "outbox-terminal-recovery",
        leaseAttempt: 2,
        replyText: expect.stringContaining("委托任务已在隔离沙盒中执行完成"),
        senderDisplayName: "SKTone",
        intent: "delegation_terminal_recovery",
        completeOutbox: false,
        countUsage: false,
        keepConversationQueued: false,
        attachments,
      });
      expect(
        mocks.prepareGenerationMessageChannelDelivery,
      ).toHaveBeenCalledWith({
        conversationId: "conversation-terminal-recovery",
        runId: "run-terminal-recovery",
        outboxId: "outbox-terminal-recovery",
        leaseAttempt: 2,
        outputMessageId: "message-terminal-recovery-output",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/sendMessage"),
        expect.objectContaining({
          body: expect.stringContaining("report.txt"),
        }),
      );
      expect(fetchMock.mock.calls[0]?.[1]?.body).toContain(
        "\"chat_id\":\"654321\"",
      );
      expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
        runId: "run-terminal-recovery",
        outboxId: "outbox-terminal-recovery",
        leaseAttempt: 2,
        outputMessageId: "message-terminal-recovery-output",
        externalMessageId: "90211",
      });
      expect(mocks.getRepresentativeRuntimeSetupSnapshot).not.toHaveBeenCalled();
      expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
      expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
      expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
      expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the conversation queued when recovering a completed step with more work", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      runId: "run-step-recovery",
      delegationTaskId: "task-step-recovery",
      delegationTaskStepId: "step-step-recovery",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-step-recovery",
      contactId: "contact-step-recovery",
      controlState: "AI_QUEUED",
      inputMessageId: "message-step-recovery",
      userText: "继续执行下一步",
      channel: "web",
      delegationTerminalRecovery: {
        taskStatus: "READY",
        stepStatus: "COMPLETED",
        attachments: [],
      },
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
    mocks.completeInlineGenerationRun.mockResolvedValueOnce({
      message: { id: "message-step-recovery-output" },
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
    })).resolves.toMatchObject({
      processed: true,
      runId: "run-step-recovery",
      status: "step_completed",
    });

    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith({
      conversationId: "conversation-step-recovery",
      runId: "run-step-recovery",
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      replyText: expect.stringContaining("后续步骤已进入执行队列"),
      senderDisplayName: "SKTone",
      intent: "delegation_terminal_recovery",
      completeOutbox: false,
      countUsage: false,
      keepConversationQueued: true,
    });
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).toHaveBeenCalledWith({
      conversationId: "conversation-step-recovery",
      runId: "run-step-recovery",
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      outputMessageId: "message-step-recovery-output",
    });
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-step-recovery",
      outboxId: "outbox-step-recovery",
      leaseAttempt: 3,
      outputMessageId: "message-step-recovery-output",
    });
    expect(mocks.getRepresentativeRuntimeSetupSnapshot).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.createAudienceComputeSession).not.toHaveBeenCalled();
    expect(mocks.executeAudienceTool).not.toHaveBeenCalled();
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
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
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).not.toHaveBeenCalled();
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
      telegramBotToken: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
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

  it("delivers an operator reply with the conversation's Telegram Bot credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { message_id: 90212 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
      connectionId: "connection-a",
      botId: "111111111",
      username: "bot_a",
      displayName: "Bot A",
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
      credentialRevision: 1,
    });
    mocks.claimNextOperatorMessageWorkItem.mockResolvedValue({
      outboxId: "operator-outbox-telegram-a",
      messageId: "operator-message-telegram-a",
      conversationId: "conversation-telegram-a",
      text: "operator reply",
      operatorName: "Owner",
      channel: "telegram",
      externalConversationId: "123456",
      telegramConnectionId: "connection-a",
    });

    await expect(processNextConversationWork({
      port: 4040,
      pollMs: 500,
      telegramConversationPlatformMode: "worker",
      telegramBotToken: "222222222:BBBBBBBBBBBBBBBBBBBBBBBB",
      telegramRequestTimeoutMs: 8_000,
    })).resolves.toMatchObject({
      processed: true,
      runId: "operator-message-telegram-a",
      status: "completed",
    });

    expect(
      mocks.resolveTelegramBotRuntimeCredential,
    ).toHaveBeenCalledWith({ connectionId: "connection-a" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/bot111111111:AAAAAAAAAAAAAAAAAAAAAAAA/sendMessage",
      ),
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123456",
          text: "Owner: operator reply",
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(
        "/bot222222222:BBBBBBBBBBBBBBBBBBBBBBBB/sendMessage",
      ),
      expect.anything(),
    );
    expect(mocks.completeOperatorMessageDelivery).toHaveBeenCalledWith({
      outboxId: "operator-outbox-telegram-a",
      messageId: "operator-message-telegram-a",
      externalMessageId: "90212",
    });
    expect(mocks.claimNextGenerationWorkItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("honors a pinned FREE run even if the mutable setup limit is exhausted", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-free-policy",
      leaseAttempt: 1,
      runId: "run-free-policy",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-free-policy",
      contactId: "contact-free-policy",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-free-policy",
      userText: "继续免费回答",
      channel: "web",
      accessMode: "FREE",
      effectiveFreeReplyLimit: null,
      usage: {
        freeRepliesUsed: 40,
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
      contract: { freeReplyLimit: 1 },
    });

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.authorizeGenerationRunFreeUsage).not.toHaveBeenCalled();
    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          freeRepliesUsed: 40,
          passUnlocked: true,
          deepHelpUnlocked: false,
        },
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({ countUsage: true }),
    );
  });

  it("uses the pinned CREDITS_ONLY policy after setup changes", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-credits-policy",
      leaseAttempt: 1,
      runId: "run-credits-policy",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-credits-policy",
      contactId: "contact-credits-policy",
      audienceIdentityId: "audience-credits-policy",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-credits-policy",
      userText: "第一条也需要额度",
      channel: "web",
      accessMode: "CREDITS_ONLY",
      effectiveFreeReplyLimit: 0,
      usage: {
        freeRepliesUsed: 0,
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
      contract: { freeReplyLimit: 100 },
    });
    mocks.createConversationPlan.mockImplementation((input: {
      representative: { contract: { freeReplyLimit: number } };
      usage: {
        freeRepliesUsed: number;
        passUnlocked: boolean;
        deepHelpUnlocked: boolean;
      };
    }) => ({
      intent: "faq",
      disposition:
        input.usage.freeRepliesUsed
          >= input.representative.contract.freeReplyLimit
        && !input.usage.passUnlocked
          ? "payment_required"
          : "answer",
    }));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.authorizeGenerationRunFreeUsage).not.toHaveBeenCalled();
    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-credits-policy",
      outboxId: "outbox-credits-policy",
      leaseAttempt: 1,
      audienceIdentityId: "audience-credits-policy",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        representative: expect.objectContaining({
          contract: { freeReplyLimit: 0 },
        }),
        usage: {
          freeRepliesUsed: 0,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({ countUsage: false }),
    );
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      channel: "matrix" as const,
      externalConversationId: "!paid-room:example.test",
      matrixSenderUserId: "@delegate:example.test",
      matrixEndpointLifecycleRevision: 4,
    },
    {
      channel: "telegram" as const,
      externalConversationId: "987654321",
      telegramConnectionId: "111111111",
    },
  ])(
    "reserves a current service-package credit for $channel",
    async (fixture) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 731 } }),
      });
      vi.stubGlobal("fetch", fetchMock);
      if (fixture.channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "111111111",
          botId: "111111111",
          username: "paid_bot",
          displayName: "Paid Bot",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
          credentialRevision: 1,
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-package-${fixture.channel}`,
        leaseAttempt: 1,
        runId: `run-package-${fixture.channel}`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-package-${fixture.channel}`,
        contactId: `contact-package-${fixture.channel}`,
        audienceIdentityId: "audience-package-1",
        controlState: "AI_ACTIVE",
        inputMessageId: `message-package-${fixture.channel}`,
        userText: "使用我购买的服务套餐继续回答",
        channel: fixture.channel,
        accessMode: "CREDITS_ONLY",
        effectiveFreeReplyLimit: 0,
        externalConversationId: fixture.externalConversationId,
        ...(fixture.channel === "matrix"
          ? {
              matrixSenderUserId: fixture.matrixSenderUserId,
              matrixEndpointLifecycleRevision:
                fixture.matrixEndpointLifecycleRevision,
            }
          : { telegramConnectionId: fixture.telegramConnectionId }),
        usage: {
          freeRepliesUsed: 0,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      });
      mocks.reserveGenerationConversationWalletUsage.mockResolvedValueOnce({
        usageChargeId: `usage-package-${fixture.channel}`,
        tokenAmount: 1,
      });

      const result = await processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramConversationPlatformMode: "worker",
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
      });
      expect(result).toEqual({
        processed: true,
        runId: `run-package-${fixture.channel}`,
        status: "completed",
      });

      expect(
        mocks.reserveGenerationConversationWalletUsage,
      ).toHaveBeenCalledWith({
        runId: `run-package-${fixture.channel}`,
        outboxId: `outbox-package-${fixture.channel}`,
        leaseAttempt: 1,
        audienceIdentityId: "audience-package-1",
        representativeId: "rep-1",
        tokenAmount: 1,
      });
      expect(mocks.createConversationPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          usage: expect.objectContaining({ passUnlocked: true }),
        }),
      );
      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
        expect.objectContaining({ countUsage: true }),
      );
    },
  );

  it.each([
    {
      channel: "matrix" as const,
      externalConversationId: "!empty-room:example.test",
      matrixSenderUserId: "@delegate:example.test",
      matrixEndpointLifecycleRevision: 5,
    },
    {
      channel: "telegram" as const,
      externalConversationId: "123123123",
      telegramConnectionId: "111111111",
    },
  ])(
    "sends a current service-package payment prompt when $channel has no balance",
    async (fixture) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 732 } }),
      }));
      if (fixture.channel === "telegram") {
        mocks.resolveTelegramBotRuntimeCredential.mockResolvedValueOnce({
          connectionId: "111111111",
          botId: "111111111",
          token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      mocks.claimNextGenerationWorkItem.mockResolvedValue({
        outboxId: `outbox-empty-${fixture.channel}`,
        leaseAttempt: 1,
        runId: `run-empty-${fixture.channel}`,
        representativeVersionId: "version-1",
        representativeSlug: "sktone",
        representativeName: "SKTone",
        conversationId: `conversation-empty-${fixture.channel}`,
        contactId: `contact-empty-${fixture.channel}`,
        audienceIdentityId: "audience-empty-1",
        controlState: "AI_ACTIVE",
        inputMessageId: `message-empty-${fixture.channel}`,
        userText: "继续回答",
        channel: fixture.channel,
        accessMode: "CREDITS_ONLY",
        effectiveFreeReplyLimit: 0,
        externalConversationId: fixture.externalConversationId,
        ...(fixture.channel === "matrix"
          ? {
              matrixSenderUserId: fixture.matrixSenderUserId,
              matrixEndpointLifecycleRevision:
                fixture.matrixEndpointLifecycleRevision,
            }
          : { telegramConnectionId: fixture.telegramConnectionId }),
        usage: {
          freeRepliesUsed: 0,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      });
      mocks.createConversationPlan.mockReturnValue({
        intent: "faq",
        disposition: "payment_required",
      });

      await expect(processNextConversationWork({
        port: 4040,
        pollMs: 500,
        telegramConversationPlatformMode: "worker",
        matrixHomeserverUrl: "https://matrix.example.test",
        matrixApplicationServiceToken: "as-token",
      })).resolves.toMatchObject({
        processed: true,
        status: "completed",
      });

      expect(
        mocks.reserveGenerationConversationWalletUsage,
      ).toHaveBeenCalledTimes(1);
      expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
      expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
        expect.objectContaining({
          replyText: expect.stringContaining("充值或购买服务套餐"),
          countUsage: false,
        }),
      );
    },
  );

  it("reserves and atomically consumes a service-package credit after free replies are exhausted", async () => {
    const reservation = {
      usageChargeId: "usage-charge-1",
      tokenAmount: 1,
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
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(reservation);

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-1",
      outboxId: "outbox-1",
      leaseAttempt: 1,
      audienceIdentityId: "audience-1",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: true,
      }),
    );
  });

  it("reserves a service-package credit when another channel run claims the last free slot", async () => {
    const reservation = {
      usageChargeId: "usage-charge-free-race",
      tokenAmount: 1,
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
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(
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
    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        audienceIdentityId: "audience-1",
        tokenAmount: 1,
      }),
    );
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: true,
      }),
    );
  });

  it("offers a paid unlock without model generation when the last free slot was claimed elsewhere", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-free-race",
      leaseAttempt: 1,
      runId: "run-free-race",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-free-race",
      contactId: "contact-free-race",
      audienceIdentityId: "audience-free-race",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-free-race",
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
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(null);
    mocks.createConversationPlan.mockImplementation((input: {
      usage: {
        freeRepliesUsed: number;
        passUnlocked: boolean;
        deepHelpUnlocked: boolean;
      };
    }) => ({
      intent: "faq",
      disposition:
        input.usage.freeRepliesUsed >= 4
        && !input.usage.passUnlocked
        && !input.usage.deepHelpUnlocked
          ? "payment_required"
          : "answer",
    }));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.createConversationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          freeRepliesUsed: 4,
          passUnlocked: false,
          deepHelpUnlocked: false,
        },
      }),
    );
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: false,
        intent: "faq",
      }),
    );
  });

  it("blocks an over-limit natural-language compute request before invoking the planner", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-over-limit-planner",
      leaseAttempt: 1,
      runId: "run-over-limit-planner",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-over-limit-planner",
      contactId: "contact-over-limit-planner",
      audienceIdentityId: "audience-over-limit-planner",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-over-limit-planner",
      userText: "帮我生成一份报告文件",
      channel: "web",
      usage: {
        freeRepliesUsed: 4,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
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
    mocks.buildRepresentativeRuntimeProfile.mockReturnValue({
      id: "rep-1",
      contract: { freeReplyLimit: 4 },
    });
    mocks.shouldConsiderNaturalLanguageCompute.mockReturnValue(true);

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });

    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-over-limit-planner",
      outboxId: "outbox-over-limit-planner",
      leaseAttempt: 1,
      audienceIdentityId: "audience-over-limit-planner",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.planNaturalLanguageComputeRequest).not.toHaveBeenCalled();
    expect(mocks.createClarifyingDelegationTask).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: false,
        intent: "delegation_payment_required",
        replyText: expect.stringContaining("免费额度已用完"),
      }),
    );
  });

  it("stops before generation when fenced service-credit reservation loses its lease", async () => {
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
    mocks.reserveGenerationConversationWalletUsage.mockRejectedValue(
      new GenerationWorkLeaseLostError("outbox-stale-reserve", 1),
    );

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-stale-reserve",
      status: "lease_lost",
    });

    expect(mocks.reserveGenerationConversationWalletUsage).toHaveBeenCalledWith({
      runId: "run-stale-reserve",
      outboxId: "outbox-stale-reserve",
      leaseAttempt: 1,
      audienceIdentityId: "audience-stale-reserve",
      representativeId: "rep-1",
      tokenAmount: 1,
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.generateRepresentativeReply).not.toHaveBeenCalled();
  });

  it("leaves a reserved service credit for fenced terminal cleanup when generation fails", async () => {
    const reservation = {
      usageChargeId: "usage-terminal-1",
      tokenAmount: 1,
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
      audienceIdentityId: "audience-terminal-1",
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
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(reservation);
    mocks.generateRepresentativeReply.mockRejectedValue(new Error("model upstream unavailable"));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-terminal-entitlement",
      status: "failed",
    });

    expect(mocks.releaseConversationEntitlement).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).toHaveBeenCalledWith({
      conversationId: "conversation-terminal-entitlement",
      runId: "run-terminal-entitlement",
      outboxId: "outbox-terminal-entitlement",
      leaseAttempt: 1,
      errorCode: "conversation_worker_failed",
      errorMessage: "model upstream unavailable",
    });
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
  });

  it("preserves a persisted service-credit reservation through a countUsage=false terminal reply", async () => {
    const reservation = {
      usageChargeId: "usage-correctable-1",
      tokenAmount: 1,
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
      audienceIdentityId: "audience-correctable-1",
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
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(reservation);
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
      runId: "run-correctable-entitlement",
      status: "completed",
    });

    expect(mocks.releaseConversationEntitlement).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-correctable-entitlement",
        countUsage: false,
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
      leaseAttempt: 1,
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
      generationWorkLease: {
        outboxId: "outbox-2",
        leaseAttempt: 1,
      },
      delegationTaskId: "task-1",
      delegationTaskStepId: "task-step-1",
    }));
    expect(mocks.executeAudienceTool).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        generationWorkLease: {
          outboxId: "outbox-2",
          leaseAttempt: 1,
        },
      }),
    );
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

  it("keeps delegation planning isolated from the unaudited recall path", async () => {
    mocks.recallRepresentativeContext.mockResolvedValue({
      items: [
        {
          uri: "viking://resources/delegate/reps/sktone/knowledge/asset-1.md/asset-1.md",
          contextType: "resource",
          layer: "L2",
          score: 0.91,
          abstract: "佩奇临时代课并带大家画恐龙。",
          internalSource: { sourceKind: "PUBLIC_KNOWLEDGE" },
        },
        {
          uri: "viking://user/memories/delegate/memory-ns/contacts/contact-1/channels/web/memories/memory-1/versions/version-1.md",
          contextType: "memory",
          layer: "L2",
          score: 0.99,
          abstract: "PRIVATE CONTACT MEMORY MUST NOT ENTER DELEGATION",
          content: "PRIVATE CONTACT MEMORY MUST NOT ENTER DELEGATION",
          internalSource: {
            sourceKind: "CONTACT_MEMORY",
            memoryVersionId: "memory-version-1",
            projectionItemId: "projection-1",
            contentHash: "sha256-memory",
          },
        },
      ],
      citations: [{
        knowledgeAssetId: "asset-1",
        title: "佩奇当老师",
        excerpt: "佩奇临时代课并带大家画恐龙。",
        score: 0.91,
      }],
    });
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
      userText: "佩奇当老师时发生了什么？",
      maxSteps: 3,
    });
    expect(mocks.planNaturalLanguageComputeRequest.mock.calls[0]?.[0]?.userText).not.toContain(
      "PRIVATE CONTACT MEMORY",
    );
    expect(mocks.recallRepresentativeContext).not.toHaveBeenCalled();
    expect(mocks.createComputeDelegationTask.mock.calls[0]?.[0]).not.toHaveProperty(
      "authorizedKnowledge",
    );
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
      audienceIdentityId: "audience-clarify",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-clarify",
      userText: "帮我生成一个报告文件",
      channel: "web",
      usage: { freeRepliesUsed: 4, passUnlocked: false, deepHelpUnlocked: false },
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
    const clarificationReservation = {
      usageChargeId: "usage-clarify",
      tokenAmount: 1,
    };
    mocks.reserveGenerationConversationWalletUsage.mockResolvedValue(
      clarificationReservation,
    );
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
    expect(mocks.completeInlineGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        countUsage: false,
      }),
    );
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

  it("leaves an already in-flight delegated execution for lease recovery", async () => {
    mocks.claimNextGenerationWorkItem.mockResolvedValue({
      outboxId: "outbox-execution-in-progress",
      leaseAttempt: 7,
      runId: "run-execution-in-progress",
      representativeVersionId: "version-1",
      representativeSlug: "sktone",
      representativeName: "SKTone",
      conversationId: "conversation-execution-in-progress",
      contactId: "contact-execution-in-progress",
      controlState: "AI_ACTIVE",
      inputMessageId: "message-execution-in-progress",
      userText: "/compute read notes/report.txt",
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
        path: "notes/report.txt",
        hasPaidEntitlement: false,
        browserMode: "deterministic",
        maxSteps: 1,
        allowMutations: false,
        displayTarget: "notes/report.txt",
      },
    });
    mocks.createAudienceComputeSession.mockResolvedValue({
      session: { id: "session-execution-in-progress" },
    });
    mocks.executeAudienceTool.mockRejectedValue(Object.assign(
      new Error("This delegated execution is still in progress."),
      { code: "generation_execution_in_progress" },
    ));

    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-execution-in-progress",
      status: "execution_in_progress",
    });

    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
    expect(mocks.completeInlineGenerationRun).not.toHaveBeenCalled();
    expect(mocks.markGenerationDeliveryComplete).not.toHaveBeenCalled();

    mocks.executeAudienceTool.mockRejectedValue(Object.assign(
      new Error("A newer recovery attempt owns this execution."),
      { code: "compute_execution_claim_lost" },
    ));
    await expect(
      processNextConversationWork({ port: 4040, pollMs: 500 }),
    ).resolves.toMatchObject({
      processed: true,
      runId: "run-execution-in-progress",
      status: "lease_lost",
    });
    expect(mocks.finalizeComputeDelegationTask).not.toHaveBeenCalled();
    expect(mocks.failGenerationRun).not.toHaveBeenCalled();
    expect(mocks.retryGenerationDelivery).not.toHaveBeenCalled();
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
      contextTrace: { selectedRecallUris: string[] };
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
      contextTrace: { selectedRecallUris: [] },
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
      contextTrace: { selectedRecallUris: [] },
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
    expect(
      mocks.prepareGenerationMessageChannelDelivery,
    ).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-reclaimed",
      outboxId: "outbox-reclaimed",
      leaseAttempt: 2,
      outputMessageId: "reply-reclaimed",
    }));
    expect(mocks.markGenerationDeliveryComplete).toHaveBeenCalledWith({
      runId: "run-reclaimed",
      outboxId: "outbox-reclaimed",
      leaseAttempt: 2,
      outputMessageId: "reply-reclaimed",
    });
  });
});
