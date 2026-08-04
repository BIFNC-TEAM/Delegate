import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webDataMocks = vi.hoisted(() => ({
  recallRepresentativeContext: vi.fn(),
}));

vi.mock("@delegate/web-data", () => webDataMocks);

import { recallOpenVikingContext } from "../src/openviking-runtime";

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

  it("does not expose or call legacy long-term write helpers", () => {
    const telegramSource = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );
    const openVikingRuntimeSource = readFileSync(
      new URL("../src/openviking-runtime.ts", import.meta.url),
      "utf8",
    );
    const runtimeStoreSource = readFileSync(
      new URL("../src/runtime-store.ts", import.meta.url),
      "utf8",
    );

    for (const source of [telegramSource, openVikingRuntimeSource]) {
      expect(source).not.toContain("captureTurnToOpenViking");
      expect(source).not.toContain("storeCollectorMemory");
      expect(source).not.toContain("storePaymentMemory");
    }
    expect(telegramSource).toContain("recallOpenVikingContext");
    expect(runtimeStoreSource).not.toContain("setConversationOpenVikingSession");
    expect(runtimeStoreSource).not.toContain("recordOpenVikingCommitTrace");
    expect(runtimeStoreSource).not.toContain("recordOpenVikingRecallTrace");
  });

  it("disables recall in the legacy Telegram runtime without a GenerationRun ledger", async () => {
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
      queryText: "What is the policy?",
    });

    expect(webDataMocks.recallRepresentativeContext).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

function buildConversationContext() {
  return {
    representativeId: "rep-1",
    representativeSlug: "lin-founder-rep",
    contactId: "contact-1",
    conversationId: "conversation-1",
    openviking: {
      autoRecall: true,
    },
  } as never;
}
