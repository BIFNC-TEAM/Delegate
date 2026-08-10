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

  it("restores the same factual markers in persisted Web history", async () => {
    mocks.conversation.findFirst.mockResolvedValue({
      state: "WAITING_USER",
      freeRepliesUsed: 4,
      assignments: [],
      episodes: [],
      messages: [
        historyMessageFixture({ id: "general-model" }),
        historyMessageFixture({
          id: "injected",
          outputForGenerationRuns: [{
            contextSnapshot: modelRuntimeOutcome,
            memoryUseRun: { items: [{ id: "use-item-2" }] },
          }],
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
          id: "operator",
          senderType: MessageSenderType.OPERATOR,
        }),
        historyMessageFixture({
          id: "revoked-memory-output",
          deliveryStatus: MessageDeliveryStatus.CANCELED,
          failureCode: "generation_memory_delivery_source_revoked",
          text: "A personalized answer that must remain hidden.",
        }),
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
    expect(JSON.stringify(history)).not.toContain(
      "A personalized answer that must remain hidden.",
    );
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
    errorCode: null,
    errorMessage: null,
    contextSnapshot: modelRuntimeOutcome,
    outputMessage: outputMessageFixture(),
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
    }],
    ...overrides,
  };
}
