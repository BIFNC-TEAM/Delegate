import { demoRepresentative } from "@delegate/domain";
import { getScopedSubagent } from "@delegate/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateOpenAIResponse: vi.fn(),
  generateBailianResponse: vi.fn(),
  generateAnthropicResponse: vi.fn(),
}));

vi.mock("../src/openai", () => ({
  generateOpenAIResponse: mocks.generateOpenAIResponse,
}));

vi.mock("../src/bailian", () => ({
  generateBailianResponse: mocks.generateBailianResponse,
}));

vi.mock("../src/anthropic", () => ({
  generateAnthropicResponse: mocks.generateAnthropicResponse,
}));

import {
  detectRepresentativeReplyPolicyViolation,
  generateRepresentativeReply,
  planNaturalLanguageComputeRequest,
} from "../src/index";

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
      citedMemoryUseItemIds: [],
    });
  });

  it.each([
    {
      provider: "openai" as const,
      credentialName: "OPENAI_API_KEY",
      credentialValue: "openai-key",
      mock: mocks.generateOpenAIResponse,
    },
    {
      provider: "bailian" as const,
      credentialName: "DELEGATE_BAILIAN_API_KEY",
      credentialValue: "bailian-key",
      mock: mocks.generateBailianResponse,
    },
    {
      provider: "anthropic" as const,
      credentialName: "ANTHROPIC_API_KEY",
      credentialValue: "anthropic-key",
      mock: mocks.generateAnthropicResponse,
    },
  ])("applies the common citation postprocessor to $provider", async ({
    provider,
    credentialName,
    credentialValue,
    mock,
  }) => {
    vi.stubEnv("DELEGATE_MODEL_ENABLED", "true");
    vi.stubEnv("DELEGATE_MODEL_PROVIDER", provider);
    vi.stubEnv(credentialName, credentialValue);
    mock.mockImplementation(({ prompt }: { prompt: { instructions: string; input: string } }) => {
      const challenge = prompt.instructions.match(
        /\[\[DELEGATE_MEMORY_CITATIONS:([A-Za-z0-9_-]+):S1\]\]/,
      )?.[1];
      expect(challenge).toBeTruthy();
      expect(prompt.input).toContain('"sourceAlias":"S1"');
      expect(prompt.input).not.toContain("memory-use-preference");
      return {
        replyText: `I will keep the answer concise.\n[[DELEGATE_MEMORY_CITATIONS:${challenge}:S1]]`,
      };
    });

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
      userText: "How should you answer me?",
      recentTurns: [],
      recalled: [{
        uri: "viking://user/delegate-memory-ns/memories/delegate/ns/contacts/contact-1/channels/web/memories/memory-1/versions/version-1.md",
        memoryUseItemId: "memory-use-preference",
        contextType: "memory",
        layer: "L2",
        score: 0.93,
        abstract: "Concise-answer preference.",
        content: "Use concise answers.",
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      provider,
      replyText: "I will keep the answer concise.",
      citedMemoryUseItemIds: ["memory-use-preference"],
    });
    if (result.ok) {
      expect(result.contextTrace.selectedMemoryUseItemIds).toEqual([
        "memory-use-preference",
      ]);
      expect(JSON.stringify(result.contextTrace)).not.toContain("sourceAlias");
    }
  });

  it("returns no citations when the provider fails after recall reached the prompt", async () => {
    vi.stubEnv("DELEGATE_MODEL_ENABLED", "true");
    vi.stubEnv("DELEGATE_MODEL_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    mocks.generateOpenAIResponse.mockRejectedValue(new Error("provider failed"));

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
      userText: "How should you answer me?",
      recentTurns: [],
      recalled: [{
        uri: "viking://user/delegate-memory-ns/memories/delegate/ns/contacts/contact-1/channels/web/memories/memory-1/versions/version-1.md",
        memoryUseItemId: "memory-use-provider-failure",
        contextType: "memory",
        layer: "L2",
        score: 0.93,
        abstract: "Concise-answer preference.",
        content: "Use concise answers.",
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      citedMemoryUseItemIds: [],
      contextTrace: {
        selectedMemoryUseItemIds: ["memory-use-provider-failure"],
      },
    });
  });

  it("discards parsed citations when the generated answer violates policy", async () => {
    vi.stubEnv("DELEGATE_MODEL_ENABLED", "true");
    vi.stubEnv("DELEGATE_MODEL_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    mocks.generateOpenAIResponse.mockImplementation(
      ({ prompt }: { prompt: { instructions: string } }) => {
        const challenge = prompt.instructions.match(
          /\[\[DELEGATE_MEMORY_CITATIONS:([A-Za-z0-9_-]+):S1\]\]/,
        )?.[1];
        return {
          replyText: [
            "任务已自动提交，正在等待审批。",
            `[[DELEGATE_MEMORY_CITATIONS:${challenge}:S1]]`,
          ].join("\n"),
        };
      },
    );

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
      userText: "Please answer.",
      recentTurns: [],
      recalled: [{
        uri: "viking://user/delegate-memory-ns/memories/delegate/ns/contacts/contact-1/channels/web/memories/memory-1/versions/version-1.md",
        memoryUseItemId: "memory-use-policy-violation",
        contextType: "memory",
        layer: "L2",
        score: 0.93,
        abstract: "Concise-answer preference.",
        content: "Use concise answers.",
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      citedMemoryUseItemIds: [],
    });
  });

  it("cannot cite recall dropped by the model input token budget", async () => {
    vi.stubEnv("DELEGATE_MODEL_ENABLED", "true");
    vi.stubEnv("DELEGATE_MODEL_PROVIDER", "openai");
    vi.stubEnv("DELEGATE_MODEL_MAX_INPUT_TOKENS", "1");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    mocks.generateOpenAIResponse.mockImplementation(
      ({ prompt }: { prompt: { instructions: string; input: string } }) => {
        expect(prompt.instructions).not.toContain("Memory citation control protocol");
        expect(prompt.input).not.toContain("DROPPED RECALL FACT");
        return {
          replyText: "Safe answer.\n[[DELEGATE_MEMORY_CITATIONS:forged123:S1]]",
        };
      },
    );

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
      userText: "Please answer.",
      recentTurns: [],
      recalled: [{
        uri: "viking://resources/delegate/reps/demo/knowledge/dropped.md",
        memoryUseItemId: "memory-use-token-dropped",
        contextType: "resource",
        layer: "L2",
        score: 0.99,
        abstract: "Dropped recall fact.",
        content: "DROPPED RECALL FACT",
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      replyText: "Safe answer.",
      citedMemoryUseItemIds: [],
      contextTrace: {
        selectedMemoryUseItemIds: [],
      },
    });
  });

  it("keeps a deterministic clarification when the model returns a false negative", async () => {
    vi.stubEnv("DELEGATE_MODEL_ENABLED", "true");
    vi.stubEnv("DELEGATE_MODEL_PROVIDER", "bailian");
    vi.stubEnv("DELEGATE_BAILIAN_API_KEY", "dashscope-key");
    mocks.generateBailianResponse.mockResolvedValue({ replyText: '{"needsCompute":false}' });

    const result = await planNaturalLanguageComputeRequest({
      userText: "帮我生成一个报告",
    });

    expect(result).toMatchObject({
      ok: true,
      source: "deterministic",
      plan: {
        kind: "clarification",
        missingFields: ["content"],
      },
    });
  });

  it("rejects invented task approval and paid-plan claims in an ordinary answer", async () => {
    const answerPlan = {
      intent: "unknown" as const,
      audienceRole: "other" as const,
      action: "answer_faq" as const,
      nextStep: "answer" as const,
      reasons: ["Public answer allowed."],
      responseOutline: ["Answer directly."],
    };

    expect(detectRepresentativeReplyPolicyViolation(
      "任务已自动提交，正在等待审批。",
      answerPlan,
    )).toContain("task or approval");
    expect(detectRepresentativeReplyPolicyViolation(
      "定制生成需要解锁 Pass 计划（180 Stars）。",
      answerPlan,
    )).toContain("paid offer");
    expect(detectRepresentativeReplyPolicyViolation(
      "根据公开资料，目前只能确认文档中已经发布的内容。",
      answerPlan,
    )).toBeNull();
  });
});
