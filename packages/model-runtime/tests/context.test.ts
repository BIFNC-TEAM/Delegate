import { demoRepresentative } from "@delegate/domain";
import { getScopedSubagent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import {
  assembleRepresentativeReplyPrompt,
  buildRepresentativeReplyPrompt,
  calculateModelUsageCost,
  generateRepresentativeReply,
  renderGroundedKnowledgeFallback,
  resolveModelRuntimeEnv,
  resolveProviderAttemptOrder,
} from "../src/index";

describe("buildRepresentativeReplyPrompt", () => {
  it("includes the public trust boundary and recalled context", () => {
    const prompt = buildRepresentativeReplyPrompt({
      representative: demoRepresentative,
      plan: {
        intent: "faq",
        audienceRole: "other",
        action: "answer_faq",
        nextStep: "answer",
        reasons: ["Intent detected: faq.", "Public answer allowed."],
        responseOutline: ["Answer the user directly.", "Offer a safe next step."],
      },
      subagent: getScopedSubagent("triage-agent"),
      userText: "你们是做什么的？",
      recentTurns: [
        {
          direction: "inbound",
          messageText: "你们是做什么的？",
          intent: "faq",
        },
      ],
      recalled: [
        {
          uri: "viking://resources/delegate/reps/lin-founder-rep/identity/bio",
          contextType: "resource",
          layer: "L1",
          score: 0.91,
          abstract: "Founder representative identity.",
          overview: "Delegate is a web-first public representative.",
        },
      ],
    });

    expect(prompt.instructions).toContain("public-facing representative");
    expect(prompt.instructions).toContain("authoritative source for factual claims");
    expect(prompt.instructions).toContain("Never imply access to private workspaces");
    expect(prompt.instructions).toContain("Active subagent boundary: Triage Agent");
    expect(prompt.instructions).toContain("Do not offer or price a paid plan");
    expect(prompt.input).toContain("Recalled public-safe context:");
    expect(prompt.input).toContain("Paid plan offer for this turn: none");
    expect(prompt.input).not.toContain("Pass (180 Stars)");
    expect(prompt.input).toContain("Reply outline:");
    expect(prompt.input).toContain("Scoped subagent boundary:");
  });

  it("builds a factual knowledge fallback when the provider is unavailable", () => {
    const reply = renderGroundedKnowledgeFallback({
      userText: "你知道佩奇吗？",
      recalled: [
        {
          uri: "viking://resources/delegate/reps/sktone/knowledge/peppa.md",
          contextType: "resource",
          layer: "L2",
          score: 0.91,
          abstract: "佩奇临时代课并带大家画恐龙。",
          content: "羚羊夫人嗓子哑了，请佩奇当小老师，教大家画恐龙。\n\n最后画出来的恐龙有翅膀、有角，还会喷彩虹色的火。",
        },
      ],
    });

    expect(reply).toContain("佩奇当小老师");
    expect(reply).toContain("画恐龙");
    expect(reply).not.toContain("dashboard");
  });

  it("does not claim a knowledge answer when recall is empty", () => {
    expect(renderGroundedKnowledgeFallback({ userText: "你知道佩奇吗？", recalled: [] })).toBeNull();
  });

  it("tracks segment inclusion and trims lower-priority context when the budget is tight", () => {
    const assembled = assembleRepresentativeReplyPrompt(
      {
        representative: demoRepresentative,
        plan: {
          intent: "pricing",
          audienceRole: "lead",
          action: "collect_quote_request",
          nextStep: "answer",
          reasons: ["Intent detected: pricing.", "Public answer allowed."],
          responseOutline: ["Answer the user directly.", "Offer a safe next step."],
        },
        subagent: getScopedSubagent("quote-agent"),
        userText: "Can you tell me your pricing and send any case studies?",
        collectorState: {
          kind: "quote",
          intent: "pricing",
          stepIndex: 1,
          sourceChannel: "private_chat",
          startedAt: new Date("2026-03-24T12:00:00.000Z").toISOString(),
          answers: {
            budget: "5000 USD",
            timeline: "2 weeks",
          },
        },
        recentTurns: [
          {
            direction: "inbound",
            messageText: "Can you tell me your pricing and send any case studies?",
            intent: "pricing",
          },
        ],
        recalled: [
          {
            uri: "viking://resources/delegate/reps/lin-founder-rep/identity/bio",
            contextType: "resource",
            layer: "L1",
            score: 0.91,
            abstract: "Founder representative identity.",
            overview: "Delegate is a web-first public representative.",
          },
        ],
      },
      {
        maxInputTokens: 320,
      },
    );

    expect(assembled.trace.segments.some((segment) => segment.kind === "collector_state")).toBe(true);
    expect(assembled.prompt.input).toContain("Active collector state:");
    expect(assembled.trace.estimatedInputTokens).toBeLessThanOrEqual(320);
    expect(assembled.trace.segments.some((segment) => segment.trimReason === "max_input_tokens")).toBe(true);
  });

  it("records clean knowledge titles and recall URIs in the context trace", () => {
    const assembled = assembleRepresentativeReplyPrompt({
      representative: demoRepresentative,
      plan: {
        intent: "faq",
        audienceRole: "other",
        action: "answer_faq",
        nextStep: "answer",
        reasons: ["Intent detected: faq.", "Public answer allowed."],
        responseOutline: ["Answer the user directly.", "Offer a safe next step."],
      },
      subagent: getScopedSubagent("triage-agent"),
      userText: "What does Delegate do?",
      recentTurns: [],
      recalled: [
        {
          uri: "viking://resources/delegate/reps/lin-founder-rep/identity/bio",
          contextType: "resource",
          layer: "L1",
          score: 0.91,
          abstract: "Founder representative identity.",
          overview: "Delegate is a web-first public representative.",
        },
      ],
    });

    expect(assembled.trace.selectedRecallUris).toEqual([
      "viking://resources/delegate/reps/lin-founder-rep/identity/bio",
    ]);
    expect(assembled.trace.selectedKnowledgeTitles.length).toBeGreaterThan(0);
    expect(assembled.trace.selectedKnowledgeTitles[0]).not.toContain("[");
    expect(assembled.trace.selectedKnowledgeTitles[0]).not.toContain("- ");
  });

  it("keeps handoff prompts out of public knowledge-heavy context", () => {
    const assembled = assembleRepresentativeReplyPrompt({
      representative: demoRepresentative,
      plan: {
        intent: "handoff",
        audienceRole: "other",
        action: "request_handoff",
        nextStep: "handoff",
        reasons: ["Intent detected: handoff.", "Human escalation required."],
        responseOutline: ["Acknowledge the request.", "Prepare a clean owner handoff."],
      },
      subagent: getScopedSubagent("handoff-agent"),
      userText: "我想直接和 founder 沟通一下。",
      recentTurns: [
        {
          direction: "inbound",
          messageText: "我想直接和 founder 沟通一下。",
          intent: "handoff",
        },
      ],
      recalled: [
        {
          uri: "viking://user/memories/events/delegate/lin-founder-rep/contact/demo",
          contextType: "memory",
          layer: "L1",
          score: 0.72,
          abstract: "The user previously asked for a human follow-up.",
          overview: "Repeat request for direct founder contact.",
        },
      ],
    });

    expect(assembled.prompt.input).toContain("Scoped subagent boundary:");
    expect(assembled.prompt.input).not.toContain("Public knowledge highlights:");
    expect(assembled.trace.segments.some((segment) => segment.kind === "public_knowledge")).toBe(
      false,
    );
  });

  it("fails fast when a subagent is paired with a disallowed conversation step", async () => {
    const result = await generateRepresentativeReply({
      representative: demoRepresentative,
      plan: {
        intent: "handoff",
        audienceRole: "other",
        action: "request_handoff",
        nextStep: "handoff",
        reasons: ["Intent detected: handoff.", "Human escalation required."],
        responseOutline: ["Acknowledge the request.", "Prepare a clean owner handoff."],
      },
      subagent: getScopedSubagent("triage-agent"),
      userText: "I need a founder handoff.",
      recentTurns: [],
      recalled: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid subagent route to fail.");
    }
    expect(result.state).toBe("invalid_subagent_route");
    expect(result.reason).toContain("triage-agent");
    expect(result.reason).toContain("handoff");
  });
});

describe("resolveModelRuntimeEnv", () => {
  it("reports missing credentials when enabled without an OpenAI key", () => {
    const env = resolveModelRuntimeEnv({
      DELEGATE_MODEL_ENABLED: "true",
      DELEGATE_MODEL_PROVIDER: "openai",
    });

    expect(env.state).toBe("missing_credentials");
  });

  it("supports a dedicated max input token budget", () => {
    const env = resolveModelRuntimeEnv({
      DELEGATE_MODEL_ENABLED: "true",
      DELEGATE_MODEL_PROVIDER: "openai",
      DELEGATE_MODEL_MAX_INPUT_TOKENS: "1800",
    });

    expect(env.maxInputTokens).toBe(1800);
  });

  it("uses Anthropic as the ready fallback provider when OpenAI credentials are missing", () => {
    const env = resolveModelRuntimeEnv({
      DELEGATE_MODEL_ENABLED: "true",
      DELEGATE_MODEL_PROVIDER: "openai",
      DELEGATE_MODEL_FALLBACK_PROVIDER: "anthropic",
      DELEGATE_ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_API_KEY: "anthropic-key",
    });

    expect(env.state).toBe("ready");
    expect(resolveProviderAttemptOrder(env)).toEqual(["anthropic"]);
  });

  it("uses Bailian after the primary OpenAI-compatible provider", () => {
    const env = resolveModelRuntimeEnv({
      DELEGATE_MODEL_ENABLED: "true",
      DELEGATE_MODEL_PROVIDER: "openai",
      DELEGATE_MODEL_FALLBACK_PROVIDER: "bailian",
      OPENAI_API_KEY: "agicto-key",
      DELEGATE_BAILIAN_API_KEY: "dashscope-key",
      DELEGATE_BAILIAN_MODEL: "qwen-plus",
    });

    expect(env.state).toBe("ready");
    expect(env.bailian.baseUrl).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    expect(resolveProviderAttemptOrder(env)).toEqual(["openai", "bailian"]);
  });

  it("calculates internal model cost from per-provider pricing", () => {
    const priced = calculateModelUsageCost({
      pricing: {
        inputCostUsdPerMillionTokens: 3,
        outputCostUsdPerMillionTokens: 15,
      },
      usage: {
        inputTokens: 10_000,
        outputTokens: 5_000,
      },
    });

    expect(priced.estimatedCostUsd).toBeCloseTo(0.105, 6);
    expect(priced.costCents).toBe(11);
  });
});
