import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  builtinSpreadsheetAnalysisSkill,
  spreadsheetAnalysisSkillInstructions,
} from "@delegate/domain";

const mocks = vi.hoisted(() => ({
  piRun: vi.fn(),
  cancelSession: vi.fn(),
  claimOperator: vi.fn(),
  claimConversationMessage: vi.fn(),
  claimGeneration: vi.fn(),
  renewLease: vi.fn(),
  getSetup: vi.fn(),
  getAuthority: vi.fn(),
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
  probeKnowledgeMetadata: vi.fn(),
  recallContext: vi.fn(),
  getArtifactDetail: vi.fn(),
}));

vi.mock("@delegate/model-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@delegate/model-runtime")>()),
  createPiModelBindingFromEnv: () => ({
    ok: true as const,
    binding: { provider: "agicto", modelId: "test-model", model: {}, streamFn: vi.fn() },
  }),
  delegatePiAgentRuntime: {
    run: mocks.piRun,
    cancelSession: mocks.cancelSession,
  },
}));

vi.mock("@delegate/web-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@delegate/web-data")>()),
  claimNextOperatorMessageWorkItem: mocks.claimOperator,
  claimNextConversationMessageDeliveryWorkItem: mocks.claimConversationMessage,
  claimNextGenerationWorkItem: mocks.claimGeneration,
  renewGenerationWorkItemLease: mocks.renewLease,
  getRepresentativeRuntimeSetupSnapshot: mocks.getSetup,
  getRepresentativeRuntimeAuthoritySnapshot: mocks.getAuthority,
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
  probeRepresentativeKnowledgeMetadata: mocks.probeKnowledgeMetadata,
  recallRepresentativeContext: mocks.recallContext,
  getRepresentativeComputeArtifactDetail: mocks.getArtifactDetail,
}));

vi.mock("../src/matrix-outbound", () => ({
  sendMatrixRepresentativeMessage: vi.fn(),
}));

import {
  attachVerifiedMcpSource,
  buildInlineSandboxCommand,
  normalizeInlineProgramSource,
  normalizeExpectedSandboxOutputs,
  processNextPiConversationWork,
  resolveKnowledgeRetrievalQuery,
} from "../src/processor-pi";
import {
  resolveDeclaredAttachmentIds,
  validateDeclaredAttachmentRead,
} from "../src/spreadsheet-skill-recovery";

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

describe("production Pi conversation processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.probeKnowledgeMetadata.mockResolvedValue({
      status: "miss",
      candidateCount: 0,
      matchedTopics: [],
      probeRevision: "probe-test",
    });
    mocks.recallContext.mockResolvedValue({ items: [], citations: [] });
    mocks.getArtifactDetail.mockResolvedValue({
      contentText: "# 欢迎使用示例服务\n示例服务帮助访客整理公开资料。",
    });
    mocks.piRun.mockResolvedValue({
      runtime: "delegate-pi-runtime.1",
      traceId: "pi-trace-production",
      runId: "run-pi",
      sessionId: "conversation-pi",
      status: "completed",
      text: "你好，我是小派。",
      messages: [],
      events: [{ type: "run.completed", traceId: "pi-trace-production", runId: "run-pi", atOffsetMs: 12 }],
      spans: [{
        traceId: "pi-trace-production",
        runId: "run-pi",
        spanId: "model-production",
        module: "model",
        operation: "generate",
        attempt: 1,
        startOffsetMs: 0,
        durationMs: 12,
        status: "ok",
        inputTokens: 11,
        outputTokens: 6,
      }],
      sources: [],
      artifacts: [],
      firstModelEventMs: 2,
      firstTextMs: 4,
      totalDurationMs: 12,
      modelCalls: 1,
      toolCalls: 0,
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
  });

  it("executes sandbox programs inline without a separately approved script artifact", () => {
    const code = "print(open('/workspace/inputs/attachment-safe.md').read())";
    const command = buildInlineSandboxCommand("python", code);
    expect(command).toContain("python -c");
    expect(command).toContain(Buffer.from(code, "utf8").toString("base64"));
    expect(command).not.toContain("pi-agent-");
    expect(command).not.toContain("/workspace/inputs/");
  });

  it("restores model-escaped statement line breaks without changing normal source", () => {
    expect(normalizeInlineProgramSource("import os\\nprint('ok')"))
      .toBe("import os\nprint('ok')");
    expect(normalizeInlineProgramSource("print('first\\nsecond')"))
      .toBe("print('first\\nsecond')");
    expect(normalizeInlineProgramSource("print('ok')\nprint('done')"))
      .toBe("print('ok')\nprint('done')");
  });

  it("keeps successful read-only MCP evidence out of user deliverable attachments", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/processor-pi.ts"),
      "utf8",
    );
    expect(source).toContain("artifacts: request.readOnly ? []");
    expect(source).toContain("!request.readOnly && authoritativeSummary");
  });

  it("runs the production Pi path and persists timing evidence", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem());

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      runId: "run-pi",
      status: "completed",
    });

    expect(mocks.piRun).toHaveBeenCalledOnce();
    expect(mocks.piRun).toHaveBeenCalledWith(expect.objectContaining({
      representative: expect.objectContaining({
        ownerName: "测试 Owner",
        instructions: expect.not.stringContaining("需要时可转人工"),
      }),
      audience: {
        kind: "external_visitor",
        relationshipToOwner: "unverified",
      },
    }));
    expect(mocks.completeInline).toHaveBeenCalledWith(expect.objectContaining({
      intent: "pi_agent",
      agentTrace: expect.objectContaining({
        runtime: "delegate-pi-runtime.1",
        traceId: "pi-trace-production",
        firstTextMs: 4,
        modelCalls: 1,
      }),
    }));
    expect(mocks.markDeliveryComplete).toHaveBeenCalledOnce();
  });

  it("keeps handoff semantically available but blocks an unrelated file request", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "生成摘要",
      inputAttachments: [{
        id: "attachment-unicode",
        fileName: "欢迎.md",
        mimeType: "text/markdown",
        sizeBytes: 221,
      }],
    }));

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    const runInput = mocks.piRun.mock.calls[0]![0];
    expect(runInput.capabilities.handoff).toBeDefined();
    await expect(runInput.capabilities.handoff.request({
      reason: "model misroute",
      summary: "unrelated file request",
      context: {},
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: "confirmation_required",
    });
    expect(runInput.attachments).toEqual([expect.objectContaining({
      fileName: "欢迎.md",
      uri: "/workspace/inputs/attachment-attachment-unicode.md",
    })]);
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

  it("loads the formally configured spreadsheet Skill ahead of unrelated representative Skills", async () => {
    mocks.getSetup.mockResolvedValueOnce({
      id: "rep-1",
      ownerName: "测试 Owner",
      tagline: "测试产品助手",
      tone: "简洁",
      handoffPrompt: "需要时可转人工。",
      humanInLoop: true,
      skillPacks: [{
        slug: "founder-core",
        version: "1.0.0",
        enabled: true,
        displayName: "Founder Core",
        summary: "基础 FAQ 和转接规则",
        capabilityTags: ["faq"],
        executesCode: false,
        resources: [],
      }, {
        ...builtinSpreadsheetAnalysisSkill,
        instructions: spreadsheetAnalysisSkillInstructions,
      }],
      knowledgePack: { identitySummary: "Test", faq: [], materials: [], policies: [] },
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
      delegation: { enabled: true, maxSteps: 5 },
    });
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "分析附件，做销售排名",
      inputAttachments: [{
        id: "attachment-csv",
        fileName: "ORDERS_A.csv",
        mimeType: "text/csv",
        sizeBytes: 162,
      }],
    }));

    await processNextPiConversationWork(config);
    const runInput = mocks.piRun.mock.calls[0]![0];
    expect(runInput.representative.capabilities).toContain("Skill");
    const skills = runInput.capabilities.skills;
    const context = {
      traceId: "trace",
      runId: "run-pi",
      sessionId: "conversation-pi",
      timezone: "Asia/Shanghai",
      attachments: runInput.attachments,
      idempotencyKey: "test",
    };
    const discovered = await skills.discover({
      query: "销售排名 CSV 分析",
      maximumResults: 3,
      context,
      signal: new AbortController().signal,
    });
    expect(discovered[0]?.id).toBe(builtinSpreadsheetAnalysisSkill.slug);
    const loaded = await skills.load({
      id: builtinSpreadsheetAnalysisSkill.slug,
      version: builtinSpreadsheetAnalysisSkill.version,
      context,
      signal: new AbortController().signal,
    });
    expect(loaded.instructions).toContain(spreadsheetAnalysisSkillInstructions);
    expect(loaded.instructions).toContain("Python 标准库 csv");
    await expect(skills.load({
      id: "founder-core",
      version: "1.0.0",
      context,
      signal: new AbortController().signal,
    })).rejects.toThrow("not applicable to structured-data");
  });

  it("feeds an approved sandbox result back to Pi without exposing sandbox again", async () => {
    mocks.getSetup.mockResolvedValueOnce({
      id: "rep-1",
      ownerName: "测试 Owner",
      tagline: "测试产品助手",
      tone: "简洁",
      handoffPrompt: "需要时可转人工。",
      humanInLoop: true,
      skillPacks: [],
      knowledgePack: { identitySummary: "Test", faq: [], materials: [], policies: [] },
      compute: { enabled: true, baseImage: "debian:bookworm-slim" },
      delegation: { enabled: true, maxSteps: 5 },
    });
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "生成摘要",
      contextSnapshot: {
        piApprovalContinuation: {
          version: 1,
          approvalId: "approval-1",
          status: "completed",
          completedAt: "2026-09-11T08:00:00.000Z",
          artifacts: [{
            id: "artifact-stdout",
            kind: "stdout",
            mimeType: "text/plain",
            sizeBytes: 88,
          }],
        },
      },
      inputAttachments: [{
        id: "attachment-unicode",
        fileName: "欢迎.md",
        mimeType: "text/markdown",
        sizeBytes: 221,
      }],
    }));

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    const runInput = mocks.piRun.mock.calls[0]![0];
    expect(runInput.approvedToolResult).toMatchObject({
      approvalId: "approval-1",
      toolName: "execute_in_sandbox",
      status: "completed",
      text: expect.stringContaining("示例服务帮助访客整理公开资料"),
    });
    expect(runInput.capabilities.sandbox).toBeUndefined();
  });

  it("exposes human handoff when the current user explicitly requests it", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "真人转接",
    }));
    const baseResult = await mocks.piRun.getMockImplementation()!();
    mocks.piRun.mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        type: "model.started",
        module: "model",
        traceId: "handoff-stream",
        runId: "run-pi",
        atOffsetMs: 1,
      });
      await input.onEvent?.({
        type: "response.delta",
        module: "response",
        delta: "稍后一定会有老师连线。",
        traceId: "handoff-stream",
        runId: "run-pi",
        atOffsetMs: 2,
      });
      return baseResult;
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    const capabilities = mocks.piRun.mock.calls[0]![0].capabilities;
    expect(capabilities.handoff).toBeDefined();
    expect(Object.keys(capabilities)).toEqual(["handoff"]);
    expect(mocks.updatePiStream).not.toHaveBeenCalled();
  });

  it("answers a human handoff status query without model or unrelated tools", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "真人排队还要多久？",
    }));
    mocks.loadOperationalContext.mockResolvedValue({
      conversationState: "WAITING_APPROVAL",
      activeCollector: null,
      latestTask: null,
      pendingApproval: null,
      activeHandoff: { status: "OPEN" },
      serviceEntitlement: null,
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      status: "completed",
    });
    expect(mocks.completeInline).toHaveBeenCalledWith(expect.objectContaining({
      intent: "conversation_status",
      countUsage: false,
    }));
    expect(mocks.piRun).not.toHaveBeenCalled();
  });

  it("tells the first Pi turn when published knowledge metadata matches", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "世界上面积最大的大洲是什么？",
    }));
    mocks.probeKnowledgeMetadata.mockResolvedValue({
      status: "hit",
      candidateCount: 1,
      matchedTopics: ["世界上", "面积最大", "大洲"],
      probeRevision: "probe-hit",
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.piRun).toHaveBeenCalledWith(expect.objectContaining({
      representative: expect.objectContaining({
        instructions: expect.stringContaining(
          "在起草答案前必须先调用 retrieve_authorized_knowledge",
        ),
      }),
    }));
  });

  it("streams a representative capability answer without waiting for knowledge", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "我能让你做些什么？",
    }));
    mocks.getSetup.mockResolvedValueOnce({
      id: "rep-1",
      ownerName: "测试 Owner",
      tagline: "负责初中地理课程，讲解地图、气候和世界地理。",
      tone: "简洁",
      handoffPrompt: "需要时可转人工。",
      humanInLoop: true,
      skillPacks: [],
      knowledgePack: { identitySummary: "Test", faq: [], materials: [], policies: [] },
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
      delegation: { enabled: true, maxSteps: 5 },
    });
    const baseResult = await mocks.piRun.getMockImplementation()!();
    mocks.piRun.mockImplementationOnce(async (input) => {
      const emit = async (delta: string) => input.onEvent?.({
        type: "response.delta",
        module: "response",
        delta,
        traceId: "trace-capability-stream",
        runId: "run-pi",
        atOffsetMs: 1,
      });
      await input.onEvent?.({
        type: "model.started",
        module: "model",
        traceId: "trace-capability-stream",
        runId: "run-pi",
        atOffsetMs: 0,
      });
      await emit("我可以讲解初中地理，");
      await emit("也可以按需使用工具。");
      return baseResult;
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.updatePiStream).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "我可以讲解初中地理，也可以按需使用工具。",
    }));
  });

  it("passes persisted audience turns to Pi in order within the current message boundary", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({ userText: "我上面问了什么问题？" }));
    mocks.loadTurns.mockResolvedValueOnce([
      { id: "prior-1", direction: "inbound", messageText: "等温线是什么" },
      { id: "prior-2", direction: "inbound", messageText: "请举个例子" },
    ]);

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({ status: "completed" });
    expect(mocks.loadTurns).toHaveBeenCalledWith({
      representativeId: "rep-1",
      conversationId: "conversation-pi",
      beforeMessageId: "message-pi",
    });
    expect(mocks.piRun).toHaveBeenCalledWith(expect.objectContaining({
      history: [
        { role: "user", text: "等温线是什么" },
        { role: "user", text: "请举个例子" },
      ],
    }));
  });

  it("fails the generation instead of silently losing history when its store is unavailable", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem());
    mocks.loadTurns.mockRejectedValueOnce(new Error("history store unavailable"));
    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({ status: "failed" });
    expect(mocks.piRun).not.toHaveBeenCalled();
    expect(mocks.failGeneration).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: "history store unavailable",
    }));
  });

  it.each(["empty", "network_failure"])(
    "does not invent memory or citations for %s recall",
    async (scenario) => {
      mocks.claimGeneration.mockResolvedValueOnce(generationItem());
      if (scenario === "network_failure") {
        mocks.recallContext.mockRejectedValueOnce(new Error("provider unavailable"));
      } else {
        mocks.recallContext.mockResolvedValueOnce({ items: [], citations: [], memoryUseRunId: "empty-use" });
      }
      const baseResult = await mocks.piRun.getMockImplementation()!();
      let retrieved: unknown;
      mocks.piRun.mockImplementationOnce(async (input) => {
        retrieved = await input.capabilities.knowledge.retrieve({ query: "我的回复偏好" });
        return baseResult;
      });
      await expect(processNextPiConversationWork(config)).resolves.toMatchObject({ status: "completed" });
      expect(retrieved).toMatchObject({
        status: scenario === "empty" ? "not_found" : "unavailable",
        sources: [],
      });
      const completion = mocks.completeInline.mock.calls[0]![0];
      if (scenario === "empty") {
        expect(completion.memoryUse).toMatchObject({ injectedItemIds: [], citedItemIds: [] });
      } else {
        expect(completion.memoryUse).toBeUndefined();
      }
    },
  );

  it.each(["CONTACT_MEMORY", "REPRESENTATIVE_EXPERIENCE"])(
    "retrieves authorized %s and persists its memory-use ledger",
    async (sourceKind) => {
      mocks.claimGeneration.mockResolvedValueOnce(generationItem({ userText: "我偏好什么样的回复？" }));
      const baseResult = await mocks.piRun.getMockImplementation()!();
      mocks.recallContext.mockImplementationOnce(async (input) => ({
        memoryUseRunId: "memory-use-1",
        items: input.allowedSourceKinds.includes(sourceKind) ? [{
          memoryUseItemId: "memory-item-1",
          abstract: "Preference: reply_length=concise",
          internalSource: { sourceKind, publicTitle: "已授权记忆" },
        }] : [],
        citations: [],
      }));
      let retrieved: { text: string } | undefined;
      mocks.piRun.mockImplementationOnce(async (input) => {
        retrieved = await input.capabilities.knowledge.retrieve({ query: input.userText });
        return {
          ...baseResult,
          sources: [{ id: "memory-item-1", title: "已授权记忆", channel: "knowledge" }],
        };
      });

      await expect(processNextPiConversationWork(config)).resolves.toMatchObject({ status: "completed" });
      expect(retrieved?.text).toContain("reply_length=concise");
      expect(mocks.recallContext).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: "conversation-pi",
        contactId: "contact-pi",
        generationRunId: "run-pi",
        sourceChannel: "web",
        allowedSourceKinds: ["PUBLIC_KNOWLEDGE", "CONTACT_MEMORY", "REPRESENTATIVE_EXPERIENCE"],
      }));
      expect(mocks.completeInline).toHaveBeenCalledWith(expect.objectContaining({
        memoryUse: {
          runId: "memory-use-1",
          outcome: "completed",
          injectedItemIds: ["memory-item-1"],
          citedItemIds: ["memory-item-1"],
        },
      }));
    },
  );

  it("never submits snapshot knowledge ids as MemoryUseItem citation ids", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "分析附件",
    }));
    mocks.recallContext.mockResolvedValueOnce({
      memoryUseRunId: "memory-use-empty",
      items: [],
      citations: [],
    });
    const baseResult = await mocks.piRun.getMockImplementation()!();
    mocks.piRun.mockImplementationOnce(async (input) => {
      await input.capabilities.knowledge.retrieve({
        query: "快照资料",
        maximumResults: 3,
        context: {},
        signal: new AbortController().signal,
      });
      return {
        ...baseResult,
        text: "依据《快照资料》回答。",
        sources: [{
          id: "snapshot-knowledge-id",
          title: "快照资料",
          channel: "knowledge",
        }],
      };
    });

    await processNextPiConversationWork(config);

    expect(mocks.completeInline).toHaveBeenCalledWith(expect.objectContaining({
      memoryUse: {
        runId: "memory-use-empty",
        outcome: "completed",
        injectedItemIds: [],
        citedItemIds: [],
      },
    }));
  });

  it("does not publish model narration from a knowledge tool turn", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "地球的形状是什么？",
    }));
    mocks.probeKnowledgeMetadata.mockResolvedValue({
      status: "hit",
      candidateCount: 1,
      matchedTopics: ["地球", "形状"],
      probeRevision: "probe-hit",
    });
    const baseImplementation = mocks.piRun.getMockImplementation();
    const baseResult = await baseImplementation!();
    mocks.piRun.mockImplementation(async (input) => {
      const emit = async (event: Record<string, unknown>) => {
        await input.onEvent?.({
          traceId: "trace-stream-filter",
          runId: "run-pi",
          atOffsetMs: 1,
          ...event,
        });
      };
      await emit({ type: "model.started", module: "model" });
      await emit({ type: "response.delta", module: "response", delta: "我需要先检索授权知识。" });
      await emit({
        type: "tool.started",
        module: "knowledge",
        toolName: "retrieve_authorized_knowledge",
      });
      await emit({
        type: "tool.completed",
        module: "knowledge",
        toolName: "retrieve_authorized_knowledge",
      });
      await emit({ type: "model.started", module: "model" });
      await emit({ type: "response.delta", module: "response", delta: "地球是一个不规则球体。" });
      return baseResult;
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.updatePiStream).toHaveBeenCalledWith(expect.objectContaining({
      text: "地球是一个不规则球体。",
    }));
    expect(JSON.stringify(mocks.updatePiStream.mock.calls)).not.toContain(
      "我需要先检索",
    );
  });

  it("does not stream organization drafts or model-authored knowledge-miss advice", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "我们公司转正员工今年有几天年假？",
    }));
    const baseImplementation = mocks.piRun.getMockImplementation();
    const baseResult = await baseImplementation!();
    mocks.piRun.mockImplementation(async (input) => {
      const emit = async (event: Record<string, unknown>) => {
        await input.onEvent?.({
          traceId: "trace-role-stream-filter",
          runId: "run-pi",
          atOffsetMs: 1,
          ...event,
        });
      };
      await emit({ type: "model.started", module: "model" });
      await emit({
        type: "response.delta",
        module: "response",
        delta: "请查阅入职合同和公司 HR 系统。",
      });
      await emit({ type: "model.started", module: "model" });
      await emit({
        type: "tool.started",
        module: "orchestration",
        toolName: "retrieve_authorized_knowledge",
      });
      await emit({
        type: "retrieval.completed",
        module: "knowledge",
        status: "not_found",
        data: { sourceCount: 0 },
      });
      await emit({ type: "model.started", module: "model" });
      await emit({
        type: "response.delta",
        module: "response",
        delta: "请点击真人评估入口联系 HR 专员。",
      });
      return baseResult;
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.updatePiStream).not.toHaveBeenCalled();
  });

  it("does not stream either draft when representative-domain knowledge misses", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "地球的形状是什么？",
    }));
    mocks.getSetup.mockResolvedValueOnce({
      id: "rep-1",
      ownerName: "测试 Owner",
      tagline: "负责初中地理课程，讲解地球、地图、气候和世界地理。",
      tone: "简洁",
      handoffPrompt: "需要时可转人工。",
      humanInLoop: true,
      skillPacks: [],
      knowledgePack: { identitySummary: "Test", faq: [], materials: [], policies: [] },
      compute: { enabled: false, baseImage: "debian:bookworm-slim" },
      delegation: { enabled: true, maxSteps: 5 },
    });
    const baseResult = await mocks.piRun.getMockImplementation()!();
    mocks.piRun.mockImplementationOnce(async (input) => {
      const emit = async (event: Record<string, unknown>) => input.onEvent?.({
        traceId: "trace-domain-miss-stream",
        runId: "run-pi",
        atOffsetMs: 1,
        ...event,
      });
      await emit({ type: "model.started", module: "model" });
      await emit({ type: "response.delta", module: "response", delta: "地球是球体。" });
      await emit({ type: "model.started", module: "model" });
      await emit({
        type: "tool.started",
        module: "orchestration",
        toolName: "retrieve_authorized_knowledge",
      });
      await emit({
        type: "retrieval.completed",
        module: "knowledge",
        status: "not_found",
        data: { sourceCount: 0 },
      });
      await emit({ type: "model.started", module: "model" });
      await emit({ type: "response.delta", module: "response", delta: "根据某教材，地球是球体。" });
      return baseResult;
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.updatePiStream).not.toHaveBeenCalled();
  });

  it("does not stream drafted content before the unsigned-authorship guard runs", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "帮我写一条简短的会议通知，明天上午十点开会",
    }));
    const baseImplementation = mocks.piRun.getMockImplementation();
    const baseResult = await baseImplementation!();
    mocks.piRun.mockImplementation(async (input) => {
      await input.onEvent?.({
        type: "model.started",
        module: "model",
        traceId: "trace-unsigned-writing",
        runId: "run-pi",
        atOffsetMs: 1,
      });
      await input.onEvent?.({
        type: "response.delta",
        module: "response",
        delta: "会议通知\n\n明天上午十点开会。\n\n—— 小派",
        traceId: "trace-unsigned-writing",
        runId: "run-pi",
        atOffsetMs: 2,
      });
      return baseResult;
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.updatePiStream).not.toHaveBeenCalled();
  });

  it("does not stream unverified current-information drafts", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({
      userText: "深圳和广州今天哪里更热？",
    }));
    const baseImplementation = mocks.piRun.getMockImplementation();
    const baseResult = await baseImplementation!();
    mocks.piRun.mockImplementation(async (input) => {
      await input.onEvent?.({
        type: "model.started",
        module: "model",
        traceId: "trace-current-info",
        runId: "run-pi",
        atOffsetMs: 1,
      });
      await input.onEvent?.({
        type: "response.delta",
        module: "response",
        delta: "我猜广州今天更热。",
        traceId: "trace-current-info",
        runId: "run-pi",
        atOffsetMs: 2,
      });
      return baseResult;
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.updatePiStream).not.toHaveBeenCalled();
  });

  it("uses the exact visitor question when model query expansion misses the knowledge fence", async () => {
    mocks.probeKnowledgeMetadata.mockImplementation(async (input) => ({
      status: input.queryText === "世界上面积最大的大洲是什么？" ? "hit" : "miss",
      candidateCount: input.queryText === "世界上面积最大的大洲是什么？" ? 1 : 0,
      matchedTopics: [],
      probeRevision: "probe-test",
    }));

    await expect(resolveKnowledgeRetrievalQuery({
      item: {
        userText: "世界上面积最大的大洲是什么？",
        representativeVersionId: "version-pi",
        representativeSlug: "sktone",
        conversationId: "conversation-pi",
        contactId: "contact-pi",
        channel: "web",
      },
      modelQuery: "世界上面积最大的大洲，依据课程标准和权威教材",
    })).resolves.toBe("世界上面积最大的大洲是什么？");
    expect(mocks.probeKnowledgeMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps a model refinement only when the visitor question misses and the refinement hits", async () => {
    mocks.probeKnowledgeMetadata.mockImplementation(async (input) => ({
      status: input.queryText.includes("年假") ? "hit" : "miss",
      candidateCount: input.queryText.includes("年假") ? 1 : 0,
      matchedTopics: [],
      probeRevision: "probe-test",
    }));

    await expect(resolveKnowledgeRetrievalQuery({
      item: {
        userText: "试用期也一样吗？",
        representativeVersionId: "version-pi",
        representativeSlug: "sktone",
        conversationId: "conversation-pi",
        contactId: "contact-pi",
        channel: "web",
      },
      modelQuery: "试用期员工年假规则",
    })).resolves.toBe("试用期员工年假规则");
    expect(mocks.probeKnowledgeMetadata).toHaveBeenCalledTimes(2);
  });

  it("delivers a queued Web system message without a provider", async () => {
    mocks.claimConversationMessage.mockResolvedValueOnce({
      outboxId: "outbox-status",
      leaseAttempt: 1,
      messageId: "message-status",
      conversationId: "conversation-status",
      text: "任务已完成。",
      deliveryKind: "system_notification",
      channel: "web",
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({
      processed: true,
      status: "completed",
    });
    expect(mocks.completeConversationMessage).toHaveBeenCalledOnce();
    expect(mocks.piRun).not.toHaveBeenCalled();
  });

  it("answers an exact status command without model usage", async () => {
    mocks.claimGeneration.mockResolvedValueOnce(generationItem({ userText: "/status" }));
    mocks.loadOperationalContext.mockResolvedValue({
      conversationState: "AI_ACTIVE",
      activeCollector: null,
      latestTask: null,
      pendingApproval: null,
      activeHandoff: null,
      serviceEntitlement: null,
    });

    await expect(processNextPiConversationWork(config)).resolves.toMatchObject({ status: "completed" });
    expect(mocks.completeInline).toHaveBeenCalledWith(expect.objectContaining({
      intent: "conversation_status",
      countUsage: false,
    }));
    expect(mocks.piRun).not.toHaveBeenCalled();
  });

  it("returns idle when every Pi-owned outbox is empty", async () => {
    await expect(processNextPiConversationWork(config)).resolves.toEqual({ processed: false });
  });
});
