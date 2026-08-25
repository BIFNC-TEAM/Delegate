import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

import { generateAgictoResponse } from "../src/agicto";
import type { ModelRuntimeEnv } from "../src/types";

describe("AGICTO OpenAI-compatible transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      id: "agicto-response-1",
      choices: [{
        finish_reason: "stop",
        message: { content: '{"protocolVersion":2}' },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses only the AGICTO credential, endpoint, model, and provider identity", async () => {
    const result = await generateAgictoResponse({
      env: buildEnv(),
      prompt: {
        instructions: "Return JSON.",
        input: "Plan this turn.",
        responseFormat: "json_object",
      },
    });

    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, request] = mocks.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.agicto.cn/v1/chat/completions");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer agicto-test-key",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "qwen-plus",
      max_tokens: 2_048,
      response_format: { type: "json_object" },
    });
    expect(result).toMatchObject({
      replyText: '{"protocolVersion":2}',
      completion: { status: "complete" },
      usage: {
        provider: "agicto",
        model: "qwen-plus",
        totalTokens: 30,
      },
    });
  });

  it("fails explicitly when AGICTO returns an HTTP-200 error envelope", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        message: "insufficient API quota",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(generateAgictoResponse({
      env: buildEnv(),
      prompt: {
        instructions: "Write a document.",
        input: "A geography tutorial.",
      },
    })).rejects.toThrow(
      "AGICTO API error (insufficient_quota): insufficient API quota",
    );
  });

  it("sends native strict JSON Schema without a truncating token ceiling", async () => {
    await expect(generateAgictoResponse({
      env: buildEnv(),
      prompt: {
        instructions: "Return a strict object.",
        input: "Plan this turn.",
        strictJsonSchema: {
          name: "turn_plan",
          schema: { type: "object" },
        },
      },
    })).resolves.toMatchObject({ replyText: '{"protocolVersion":2}' });
    const [, request] = mocks.fetch.mock.calls[0]!;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "turn_plan",
          strict: true,
          schema: { type: "object" },
        },
      },
    });
    expect(body).not.toHaveProperty("max_tokens");
  });
});

function buildEnv(): ModelRuntimeEnv {
  const pricing = {
    inputCostUsdPerMillionTokens: 0,
    outputCostUsdPerMillionTokens: 0,
  };
  return {
    enabled: true,
    provider: "agicto",
    state: "ready",
    timeoutMs: 60_000,
    documentTimeoutMs: 60_000,
    maxInputTokens: 2_400,
    maxOutputTokens: 2_048,
    documentMaxOutputTokens: 2_048,
    documentMaxParts: 3,
    agicto: {
      model: "qwen-plus",
      apiKey: "agicto-test-key",
      baseUrl: "https://api.agicto.cn/v1",
      pricing,
    },
    openai: { model: "gpt-4o-mini", pricing },
    bailian: { model: "qwen-plus", pricing },
    anthropic: { model: "claude-sonnet-4-5", pricing },
  };
}
