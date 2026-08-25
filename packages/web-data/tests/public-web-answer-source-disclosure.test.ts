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
  resolvePublicWebAnswerSourceDisclosure,
} from "../src/conversation-platform";

describe("public Web answer source disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it.each([
    {
      name: "an authorized citation",
      overrides: {
        outputMessage: outputMessageFixture({
          citations: [{
            title: "Published FAQ",
            excerpt: null,
            memoryUseItem: null,
          }],
        }),
      },
    },
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

  it("returns live task and step progress using the latest task run", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(
      generationRunFixture({
        delegationTask: {
          id: "task-1",
          title: "生成研究报告",
          status: "RUNNING",
          nextActionBy: "SYSTEM",
          updatedAt: new Date("2026-08-05T03:02:00.000Z"),
          steps: [
            {
              id: "step-1",
              sequence: 1,
              title: "读取公开资料",
              status: "COMPLETED",
              startedAt: new Date("2026-08-05T03:00:00.000Z"),
              completedAt: new Date("2026-08-05T03:01:00.000Z"),
              failedAt: null,
              updatedAt: new Date("2026-08-05T03:01:00.000Z"),
            },
            {
              id: "step-2",
              sequence: 2,
              title: "生成 PDF",
              status: "RUNNING",
              startedAt: new Date("2026-08-05T03:01:00.000Z"),
              completedAt: null,
              failedAt: null,
              updatedAt: new Date("2026-08-05T03:02:00.000Z"),
            },
          ],
          generationRuns: [{
            id: "run-step-2",
            status: "PROCESSING",
            errorCode: null,
            errorMessage: null,
            contextSnapshot: null,
            outputMessage: null,
          }],
        },
      }),
    );

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot).toMatchObject({
      id: "run-1",
      status: "processing",
      taskProgress: {
        id: "task-1",
        title: "生成研究报告",
        status: "running",
        nextActionBy: "system",
        steps: [
          { id: "step-1", sequence: 1, status: "completed" },
          { id: "step-2", sequence: 2, status: "running" },
        ],
      },
    });
    expect(snapshot).not.toHaveProperty("message");
  });

  it("projects a public-safe TurnPlan and current document generation stage", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(
      generationRunFixture({
        status: GenerationRunStatus.PROCESSING,
        startedAt: new Date("2026-08-18T08:14:51.000Z"),
        contextSnapshot: {
          turnExecutionProgress: {
            version: 1,
            stage: "generating",
            part: 2,
            maxParts: 3,
            updatedAt: "2026-08-18T08:15:20.000Z",
          },
        },
        outputMessage: null,
        turnPlans: [{
          id: "turn-plan-1",
          status: "VALIDATED",
          objective: "生成中学地理学习计划文档",
          planSnapshot: {
            goals: [
              { id: "goal-1", description: "制定学习计划", priority: 1 },
              { id: "goal-2", description: "以文件形式交付", priority: 2 },
            ],
            deliverables: [{
              id: "deliverable-1",
              kind: "artifact",
              format: "markdown",
            }],
          },
          createdAt: new Date("2026-08-18T08:14:59.000Z"),
          updatedAt: new Date("2026-08-18T08:15:20.000Z"),
          actions: [{ status: "EXECUTING" }],
        }],
      }),
    );

    const snapshot = await getPublicGenerationRunSnapshot(publicRunInput);

    expect(snapshot?.turnProgress).toMatchObject({
      id: "turn-plan-1",
      objective: "生成中学地理学习计划文档",
      status: "running",
      stage: "generating",
      goals: [
        { id: "goal-1", description: "制定学习计划" },
        { id: "goal-2", description: "以文件形式交付" },
      ],
      deliverables: [{
        id: "deliverable-1",
        kind: "artifact",
        format: "markdown",
      }],
      steps: expect.arrayContaining([
        expect.objectContaining({
          stage: "generating",
          status: "running",
          detail: "2/3",
        }),
      ]),
    });
    expect(JSON.stringify(snapshot)).not.toContain("arguments");
    expect(JSON.stringify(snapshot)).not.toContain("prompt");
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
      { id: "cited", sourceDisclosure: undefined },
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

  it("restores active task progress after a public page refresh", async () => {
    mocks.conversation.findFirst.mockResolvedValue({
      state: "PROCESSING",
      freeRepliesUsed: 1,
      assignments: [],
      episodes: [],
      messages: [],
      delegationTasks: [{
        id: "task-refresh",
        title: "整理附件",
        status: "RUNNING",
        nextActionBy: "SYSTEM",
        updatedAt: new Date("2026-08-17T02:10:00.000Z"),
        steps: [{
          id: "step-refresh",
          sequence: 1,
          title: "读取文件",
          status: "RUNNING",
          startedAt: new Date("2026-08-17T02:09:00.000Z"),
          completedAt: null,
          failedAt: null,
          updatedAt: new Date("2026-08-17T02:10:00.000Z"),
        }],
      }],
    });

    const history = await getPublicConversationHistory({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      audienceId: "audience-1",
    });

    expect(history.taskProgress).toMatchObject({
      id: "task-refresh",
      status: "running",
      steps: [{ id: "step-refresh", status: "running" }],
    });
  });

  it("restores active TurnPlan progress after a public page refresh", async () => {
    mocks.conversation.findFirst.mockResolvedValue({
      state: "PROCESSING",
      freeRepliesUsed: 1,
      assignments: [],
      episodes: [],
      messages: [],
      delegationTasks: [],
      generationRuns: [{
        id: "run-turn-refresh",
        status: GenerationRunStatus.PROCESSING,
        startedAt: new Date("2026-08-18T08:14:51.000Z"),
        contextSnapshot: {
          turnExecutionProgress: {
            version: 1,
            stage: "saving",
            updatedAt: "2026-08-18T08:15:30.000Z",
          },
        },
        turnPlans: [{
          id: "turn-plan-refresh",
          status: "VALIDATED",
          objective: "生成学习计划",
          planSnapshot: {
            goals: [{ id: "goal-1", description: "生成学习计划" }],
            deliverables: [{
              id: "deliverable-1",
              kind: "artifact",
              format: "markdown",
            }],
          },
          createdAt: new Date("2026-08-18T08:14:59.000Z"),
          updatedAt: new Date("2026-08-18T08:15:30.000Z"),
          actions: [{ status: "EXECUTING" }],
        }],
      }],
    });

    const history = await getPublicConversationHistory({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      audienceId: "audience-1",
    });

    expect(history.turnProgress).toMatchObject({
      id: "turn-plan-refresh",
      stage: "saving",
      steps: expect.arrayContaining([
        expect.objectContaining({ stage: "saving", status: "running" }),
      ]),
    });
    expect(
      mocks.conversation.findFirst.mock.calls[0]![0].include.generationRuns,
    ).not.toHaveProperty("where");
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
