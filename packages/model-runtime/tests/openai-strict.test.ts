import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: mocks.create };
  },
}));

import { generateOpenAIResponse } from "../src/openai";
import type { ModelRuntimeEnv } from "../src/types";

describe("OpenAI strict structured output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({
      id: "response-1",
      status: "completed",
      output_text: '{"protocolVersion":2}',
    });
  });

  it("sends planner schemas as strict json_schema instead of json_object", async () => {
    await generateOpenAIResponse({
      env: buildEnv(),
      prompt: {
        instructions: "Plan safely.",
        input: "User turn",
        strictJsonSchema: {
          name: "delegate_turn_plan_proposal_v2",
          description: "Strict plan proposal",
          schema: {
            type: "object",
            properties: { protocolVersion: { type: "integer", const: 2 } },
            required: ["protocolVersion"],
            additionalProperties: false,
          },
        },
      },
    });

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      text: {
        format: {
          type: "json_schema",
          name: "delegate_turn_plan_proposal_v2",
          description: "Strict plan proposal",
          schema: expect.objectContaining({ additionalProperties: false }),
          strict: true,
        },
      },
    }));
  });
});

function buildEnv(): ModelRuntimeEnv {
  const pricing = {
    inputCostUsdPerMillionTokens: 0,
    outputCostUsdPerMillionTokens: 0,
  };
  return {
    enabled: true,
    provider: "openai",
    state: "ready",
    timeoutMs: 5_000,
    documentTimeoutMs: 60_000,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
    documentMaxOutputTokens: 4_000,
    documentMaxParts: 3,
    agicto: { model: "qwen-test", pricing },
    openai: { model: "gpt-test", apiKey: "test-key", pricing },
    bailian: { model: "qwen-test", pricing },
    anthropic: { model: "claude-test", pricing },
  };
}
