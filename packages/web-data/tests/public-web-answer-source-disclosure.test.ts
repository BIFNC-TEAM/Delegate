import {
  GenerationRunStatus,
  MessageDeliveryStatus,
  MessageSenderType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationRun: { findFirst: vi.fn() },
  conversation: { findFirst: vi.fn() },
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    generationRun: mocks.generationRun,
    conversation: mocks.conversation,
  },
}));

import {
  getPublicConversationHistory,
  getPublicGenerationRunSnapshot,
  isSourceIndependentDeliveryAuthorized,
  resolvePublicWebAnswerSourceDisclosure,
  shouldFailOpenMemoryUseForSourceIndependentResponse,
} from "../src/conversation-platform";

describe("public Web answer source disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits only server-marked source-independent recovery delivery for the same run", () => {
    const content = {
      intent: "turn_plan_v3_source_unavailable",
      deliveryControl: {
        sourceIndependentDelivery: true,
        sourceIndependentPublicRecovery: true,
        recoveryCode: "v3_required_source_not_found",
        generationRunId: "run-1",
      },
    };

    expect(isSourceIndependentDeliveryAuthorized(content, "run-1")).toBe(true);
    expect(isSourceIndependentDeliveryAuthorized(content, "run-other")).toBe(false);
    expect(isSourceIndependentDeliveryAuthorized({
      deliveryControl: {
        sourceIndependentDelivery: true,
        generationRunId: "run-1",
      },
    }, "run-1")).toBe(false);
  });

  it("does not fail an open memory-use run before an empty public recovery finalizes it", () => {
    expect(shouldFailOpenMemoryUseForSourceIndependentResponse({
      evidenceIndependentSystemFailure: false,
      sourceIndependentPublicRecovery: true,
      memoryUseOutcome: "completed",
    })).toBe(false);
    expect(shouldFailOpenMemoryUseForSourceIndependentResponse({
      evidenceIndependentSystemFailure: false,
      sourceIndependentPublicRecovery: true,
    })).toBe(true);
    expect(shouldFailOpenMemoryUseForSourceIndependentResponse({
      evidenceIndependentSystemFailure: true,
      sourceIndependentPublicRecovery: false,
    })).toBe(true);
  });

  it.each([
    {
      name: "a model answer without authorized sources",
      input: {
        modelGenerated: true,
        hasAuthorizedCitation: false,
      },
      expected: "general_model",
    },
    {
      name: "an answer with injected authorized context",
      input: {
        modelGenerated: true,
        hasAuthorizedCitation: false,
      },
      expected: "general_model",
    },
    {
      name: "an answer with an authorized citation",
      input: {
        modelGenerated: true,
        hasAuthorizedCitation: true,
      },
      expected: "authorized_knowledge_or_memory",
    },
    {
      name: "a model answer grounded in a verified tool result",
      input: {
        modelGenerated: true,
        hasAuthorizedCitation: false,
        hasVerifiedToolEvidence: true,
      },
      expected: null,
    },
    {
      name: "a deterministic fallback",
      input: {
        modelGenerated: false,
        hasAuthorizedCitation: false,
      },
      expected: null,
    },
    {
      name: "a same-conversation recent recall",
      input: {
        modelGenerated: false,
        hasAuthorizedCitation: false,
        sameConversationRecall: true,
      },
      expected: "same_conversation",
    },
    {
      name: "an unverified tool fallback",
      input: {
        modelGenerated: true,
        hasAuthorizedCitation: false,
        unverifiedToolFallback: true,
      },
      expected: "unverified_tool_fallback",
    },
  ])("classifies $name", ({ input, expected }) => {
    expect(resolvePublicWebAnswerSourceDisclosure(input)).toBe(expected);
  });

  it("adds the marker to a source-free model run snapshot", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(
      generationRunFixture(),
    );

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot?.message).toMatchObject({
      text: "A general answer.",
      sourceDisclosure: "general_model",
      citations: [],
    });
    expect(
      mocks.generationRun.findFirst.mock.calls[0]![0].include,
    ).not.toHaveProperty("memoryUseRun");
  });

  it("does not expose a retryable failed attempt as an SSE terminal state", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(generationRunFixture({
      status: GenerationRunStatus.FAILED,
      errorCode: "provider_failed",
      errorMessage: "first attempt failed",
      outputMessage: null,
      conversation: {
        outboxEvents: [{ status: "PENDING", processedAt: null }],
      },
    }));

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot).toMatchObject({ id: "run-1", status: "processing" });
    expect(snapshot).not.toHaveProperty("errorCode");
    expect(snapshot).not.toHaveProperty("errorMessage");
  });

  it("marks an unverified tool fallback for the dedicated footer", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(generationRunFixture({
      outputMessage: outputMessageFixture({
        content: { intent: "turn_plan_v3_stable_general_fallback" },
      }),
    }));

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot?.message).toMatchObject({
      text: "A general answer.",
      sourceDisclosure: "unverified_tool_fallback",
    });
  });

  it("moves a legacy inline tool-fallback disclosure into the footer marker", async () => {
    const legacyDisclosure =
      "来源说明：外部工具本轮未执行，以下内容由通用模型根据已有知识概括；未核验相关项目或仓库的最新内容，也未引用已授权知识或记忆。";
    mocks.generationRun.findFirst.mockResolvedValue(generationRunFixture({
      outputMessage: outputMessageFixture({
        text: `${legacyDisclosure}\n\nA2A 是智能体互操作协议。`,
        content: { intent: "compute" },
      }),
    }));

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot?.message).toMatchObject({
      text: "A2A 是智能体互操作协议。",
      sourceDisclosure: "unverified_tool_fallback",
    });
  });

  it("marks a run with an authorized citation using one public source note", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(generationRunFixture({
      outputMessage: outputMessageFixture({
        citations: [{
          title: "Published FAQ",
          excerpt: null,
          memoryUseItem: null,
        }],
      }),
    }));

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot?.message?.sourceDisclosure)
      .toBe("authorized_knowledge_or_memory");
  });

  it.each([
    {
      name: "a deterministic fallback",
      overrides: {
        contextSnapshot: {
          runtimeOutcome: {
            version: 1,
            mode: "fallback",
            fallbackReason: "model_unavailable",
          },
        },
      },
    },
  ])("does not mark a run with $name", async ({ overrides }) => {
    mocks.generationRun.findFirst.mockResolvedValue(
      generationRunFixture(overrides),
    );

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot?.message).not.toHaveProperty("sourceDisclosure");
  });

  it("hides a persisted answer after its memory delivery fence is revoked", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(
      generationRunFixture({
        outputMessage: outputMessageFixture({
          deliveryStatus: MessageDeliveryStatus.CANCELED,
          failureCode: "generation_memory_delivery_source_revoked",
          text: "A personalized answer that must not be exposed.",
          citations: [{
            title: "本人历史信息",
            excerpt: null,
            memoryUseItem: { id: "use-item-1" },
          }],
        }),
      }),
    );

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot).toMatchObject({
      id: "run-1",
      status: "canceled",
    });
    expect(snapshot).not.toHaveProperty("message");
  });

  it("marks a deterministic current-episode recall as same-conversation context", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(
      generationRunFixture({
        contextSnapshot: {
          runtimeOutcome: {
            version: 1,
            mode: "fallback",
            fallbackReason: "policy_fallback",
          },
        },
        outputMessage: outputMessageFixture({
          content: { intent: "conversation_recent_recall" },
          text: "你上一条说的是：中学地理学习计划",
        }),
      }),
    );

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot?.message).toMatchObject({
      sourceDisclosure: "same_conversation",
    });
  });

  it("restores the same factual markers in persisted Web history", async () => {
    mocks.conversation.findFirst.mockResolvedValue({
      state: "WAITING_USER",
      freeRepliesUsed: 4,
      assignments: [],
      episodes: [],
      delegationTasks: [],
      messages: [
        historyMessageFixture({
          id: "revoked-memory-output",
          deliveryStatus: MessageDeliveryStatus.CANCELED,
          failureCode: "generation_memory_delivery_source_revoked",
          text: "A personalized answer that must remain hidden.",
        }),
        historyMessageFixture({
          id: "operator",
          senderType: MessageSenderType.OPERATOR,
        }),
        historyMessageFixture({
          id: "cited",
          citations: [{
            title: "本人历史信息",
            excerpt: null,
            memoryUseItem: null,
          }],
        }),
        historyMessageFixture({
          id: "injected",
          outputForGenerationRuns: [{
            contextSnapshot: modelRuntimeOutcome,
            inputMessage: { clientMessageId: "visitor-message-injected" },
            memoryUseRun: { items: [{ id: "use-item-2" }] },
          }],
        }),
        historyMessageFixture({ id: "general-model" }),
      ],
    });

    const history = await getPublicConversationHistory({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      audienceId: "audience-1",
    });

    expect(history.messages.map((message) => ({
      id: message.id,
      sourceDisclosure: message.sourceDisclosure,
    }))).toEqual([
      { id: "general-model", sourceDisclosure: "general_model" },
      { id: "injected", sourceDisclosure: "general_model" },
      { id: "cited", sourceDisclosure: "authorized_knowledge_or_memory" },
      { id: "operator", sourceDisclosure: undefined },
    ]);
    expect(
      mocks.conversation.findFirst.mock.calls[0]![0].include.messages.include
        .outputForGenerationRuns.select,
    ).not.toHaveProperty("memoryUseRun");
    expect(
      mocks.conversation.findFirst.mock.calls[0]![0].include.messages.include
        .outputForGenerationRuns.select.inputMessage.select,
    ).toEqual({ clientMessageId: true });
    expect(history.messages.find((message) => message.id === "injected"))
      .toMatchObject({
        generationInputClientMessageId: "visitor-message-injected",
      });
    expect(JSON.stringify(history)).not.toContain(
      "A personalized answer that must remain hidden.",
    );
  });

  it("loads the newest bounded message window and returns it chronologically", async () => {
    mocks.conversation.findFirst.mockResolvedValue({
      state: "WAITING_USER",
      freeRepliesUsed: 4,
      assignments: [],
      episodes: [],
      delegationTasks: [],
      messages: [
        historyMessageFixture({
          id: "newest",
          text: "最新回复",
          createdAt: new Date("2026-08-19T01:27:25.000Z"),
        }),
        historyMessageFixture({
          id: "previous",
          senderType: MessageSenderType.AUDIENCE,
          text: "最新问题",
          createdAt: new Date("2026-08-19T01:27:07.000Z"),
        }),
      ],
    });

    const history = await getPublicConversationHistory({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      audienceId: "audience-1",
      limit: 2,
    });

    expect(
      mocks.conversation.findFirst.mock.calls[0]![0].include.messages,
    ).toMatchObject({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    });
    expect(history.messages.map((message) => message.id)).toEqual([
      "previous",
      "newest",
    ]);
  });

  it("does not expose the retired Planner or Delegation progress contract", async () => {
    mocks.conversation.findFirst.mockResolvedValue({
      state: "WAITING_USER",
      freeRepliesUsed: 1,
      assignments: [],
      episodes: [],
      messages: [historyMessageFixture({
        id: "latest-audience-message",
        senderType: MessageSenderType.AUDIENCE,
      })],
      generationRuns: [],
    });

    const history = await getPublicConversationHistory({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      audienceId: "audience-1",
    });

    expect(history).not.toHaveProperty("taskProgress");
    expect(history).not.toHaveProperty("turnProgress");
  });

});

const publicRunInput = {
  representativeSlug: "delegate",
  runId: "run-1",
  audienceIdentityId: "identity-1",
  audienceId: "audience-1",
};

const modelRuntimeOutcome = {
  runtimeOutcome: { version: 1, mode: "model" },
};

function generationRunFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: GenerationRunStatus.COMPLETED,
    startedAt: new Date("2026-08-05T02:59:00.000Z"),
    errorCode: null,
    errorMessage: null,
    contextSnapshot: modelRuntimeOutcome,
    outputMessage: outputMessageFixture(),
    conversation: { outboxEvents: [] },
    delegationTask: null,
    turnPlans: [],
    ...overrides,
  };
}

function outputMessageFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-output-1",
    text: "A general answer.",
    content: null,
    deliveryStatus: MessageDeliveryStatus.SENT,
    failureCode: null,
    createdAt: new Date("2026-08-05T03:00:00.000Z"),
    citations: [],
    attachments: [],
    ...overrides,
  };
}

function historyMessageFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-output-1",
    senderType: MessageSenderType.REPRESENTATIVE,
    senderDisplayName: "Delegate",
    text: "A general answer.",
    content: null,
    deliveryStatus: MessageDeliveryStatus.SENT,
    failureCode: null,
    createdAt: new Date("2026-08-05T03:00:00.000Z"),
    citations: [],
    attachments: [],
    outputForGenerationRuns: [{
      contextSnapshot: modelRuntimeOutcome,
      inputMessage: { clientMessageId: "visitor-message-1" },
    }],
    ...overrides,
  };
}
