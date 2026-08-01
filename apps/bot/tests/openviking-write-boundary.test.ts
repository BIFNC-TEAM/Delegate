import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeStoreMocks = vi.hoisted(() => ({
  recordOpenVikingRecallTrace: vi.fn(),
  setConversationOpenVikingSession: vi.fn(),
}));
const webDataMocks = vi.hoisted(() => ({
  recallRepresentativeContext: vi.fn(),
}));

vi.mock("../src/runtime-store", () => runtimeStoreMocks);
vi.mock("@delegate/web-data", () => webDataMocks);

import {
  captureTurnToOpenViking,
  recallOpenVikingContext,
  storeCollectorMemory,
  storePaymentMemory,
} from "../src/openviking-runtime";

describe("OpenViking long-term write boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENVIKING_ENABLED", "true");
    vi.stubEnv("OPENVIKING_BASE_URL", "https://openviking.test");
    vi.stubEnv("OPENAI_API_KEY", "test-model-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps turn, collector, and payment writes fail-closed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = buildConversationContext();

    await captureTurnToOpenViking({
      context,
      chatId: 42,
      userText: "private user message",
      assistantText: "private assistant reply",
      recalled: [],
      reason: "answer_turn",
    });
    await storeCollectorMemory({
      context,
      collectorState: {
        kind: "quote",
        intent: "quote",
        stepIndex: 1,
        answers: { email: "visitor@example.com" },
      } as never,
      summary: "Sensitive quote intake",
    });
    await storePaymentMemory({
      context,
      planName: "Deep help",
      starsAmount: 500,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtimeStoreMocks.setConversationOpenVikingSession).not.toHaveBeenCalled();
    expect(runtimeStoreMocks.recordOpenVikingRecallTrace).not.toHaveBeenCalled();
  });

  it("does not call long-term write helpers from the Telegram runtime", () => {
    const source = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("captureTurnToOpenViking");
    expect(source).not.toContain("storeCollectorMemory");
    expect(source).not.toContain("storePaymentMemory");
    expect(source).toContain("recallOpenVikingContext");
  });

  it("uses the centralized published-version and contact allowlist for recall", async () => {
    webDataMocks.recallRepresentativeContext.mockResolvedValue({
      items: [
        {
          uri: "viking://resources/delegate/reps/lin-founder-rep/versions/version-1/faq/index.md",
          contextType: "resource",
          layer: "L2",
          score: 0.9,
          abstract: "Published FAQ",
          content: "Published FAQ",
        },
      ],
      citations: [],
    });

    const result = await recallOpenVikingContext({
      context: buildConversationContext(),
      chatId: 42,
      queryText: "What is the policy?",
    });

    expect(webDataMocks.recallRepresentativeContext).toHaveBeenCalledWith({
      representativeSlug: "lin-founder-rep",
      conversationId: "conversation-1",
      contactId: "contact-1",
      queryText: "What is the policy?",
    });
    expect(result).toHaveLength(1);
  });
});

function buildConversationContext() {
  return {
    representativeId: "rep-1",
    representativeSlug: "lin-founder-rep",
    contactId: "contact-1",
    conversationId: "conversation-1",
    openviking: {
      enabled: true,
      autoCapture: true,
      autoRecall: true,
      recallLimit: 6,
      recallScoreThreshold: 0.01,
    },
  } as never;
}
