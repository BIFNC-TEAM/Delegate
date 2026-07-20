import { demoRepresentative } from "@delegate/domain";
import { getScopedSubagent } from "@delegate/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateOpenAIResponse: vi.fn(),
  generateBailianResponse: vi.fn(),
}));

vi.mock("../src/openai", () => ({
  generateOpenAIResponse: mocks.generateOpenAIResponse,
}));

vi.mock("../src/bailian", () => ({
  generateBailianResponse: mocks.generateBailianResponse,
}));

import { generateRepresentativeReply } from "../src/index";

describe("provider fallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("switches from the primary OpenAI-compatible provider to Bailian", async () => {
    vi.stubEnv("DELEGATE_MODEL_ENABLED", "true");
    vi.stubEnv("DELEGATE_MODEL_PROVIDER", "openai");
    vi.stubEnv("DELEGATE_MODEL_FALLBACK_PROVIDER", "bailian");
    vi.stubEnv("OPENAI_API_KEY", "agicto-key");
    vi.stubEnv("DELEGATE_BAILIAN_API_KEY", "dashscope-key");
    vi.stubEnv("DELEGATE_BAILIAN_MODEL", "qwen-plus");
    mocks.generateOpenAIResponse.mockRejectedValue(new Error("primary timed out"));
    mocks.generateBailianResponse.mockResolvedValue({ replyText: "百炼备用回答" });

    const result = await generateRepresentativeReply({
      representative: demoRepresentative,
      plan: {
        intent: "faq",
        audienceRole: "other",
        action: "answer_faq",
        nextStep: "answer",
        reasons: ["Public answer allowed."],
        responseOutline: ["Answer directly."],
      },
      subagent: getScopedSubagent("triage-agent"),
      userText: "你们提供什么服务？",
      recentTurns: [],
      recalled: [],
    });

    expect(mocks.generateOpenAIResponse).toHaveBeenCalledOnce();
    expect(mocks.generateBailianResponse).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      provider: "bailian",
      model: "qwen-plus",
      replyText: "百炼备用回答",
    });
  });
});
