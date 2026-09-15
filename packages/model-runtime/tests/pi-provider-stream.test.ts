import { describe, expect, it, vi } from "vitest";

import { createPiModelBindingFromEnv } from "../src/pi/provider";

function createBinding() {
  const result = createPiModelBindingFromEnv({
    DELEGATE_MODEL_PROVIDER: "agicto",
    DELEGATE_AGICTO_API_KEY: "test-key",
    DELEGATE_AGICTO_BASE_URL: "https://provider.test/v1",
    DELEGATE_AGICTO_MODEL: "qwen-plus",
    DELEGATE_PI_MODEL_MAX_RETRIES: "0",
  });
  if (!result.ok) throw new Error(result.reason);
  return result.binding;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "completion-test",
    object: "chat.completion.chunk",
    model: "qwen-plus",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseResponse(chunks: unknown[], done = true) {
  return new Response([
    ...chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`),
    ...(done ? ["data: [DONE]\n\n"] : []),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

async function send(fetch: typeof globalThis.fetch, signal?: AbortSignal) {
  const binding = createBinding();
  const stream = await binding.streamFn(binding.model, {
    messages: [{ role: "user", content: "你好，你是谁", timestamp: 1 }],
  }, { fetch, ...(signal ? { signal } : {}) });
  return stream.result();
}

describe("Pi provider message streaming", () => {
  it("sends a message and preserves the final text and trailing usage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sseResponse([
      chunk({ role: "assistant", content: "你好" }),
      chunk({ content: "！" }, "stop"),
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]));

    const result = await send(fetch);

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "你好！" }]);
    expect(result.usage).toMatchObject({ input: 12, output: 3, totalTokens: 15 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen-plus", stream: true,
      messages: [{ role: "user", content: "你好，你是谁" }],
    });
  });

  it.each([true, false])("reports the screenshot error when finish_reason is missing (DONE=%s)", async (done) => {
    const result = await send(vi.fn(async () => sseResponse([
      chunk({ role: "assistant", content: "未完成的回答" }),
    ], done)));

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Stream ended without finish_reason");
  });

  it("rejects an empty stream instead of reporting a successful reply", async () => {
    const result = await send(vi.fn(async () => sseResponse([])));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Stream ended without finish_reason");
  });

  it("preserves a complete tool call for the agent to execute", async () => {
    const result = await send(vi.fn(async () => sseResponse([
      chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
      chunk({}, "tool_calls"),
    ])));
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([{ type: "toolCall", id: "call-1", name: "get_time", arguments: {} }]);
  });

  it("does not turn an unfinished tool call into successful execution", async () => {
    const result = await send(vi.fn(async () => sseResponse([
      chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "get_time", arguments: '{"timezone":' } }] }),
    ])));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Stream ended without finish_reason");
  });

  it("preserves output length limits instead of reporting a normal completion", async () => {
    const result = await send(vi.fn(async () => sseResponse([chunk({ content: "部分回答" }, "length")])));
    expect(result.stopReason).toBe("length");
  });

  it("reports an HTTP provider error", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { message: "Service unavailable", type: "server_error" } }, { status: 503 }));
    const result = await send(fetch);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Service unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports an error sent inside the SSE stream", async () => {
    const result = await send(vi.fn(async () => sseResponse([{ error: { message: "Provider overloaded" } }])));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Provider overloaded");
  });

  it("reports network failure", async () => {
    const result = await send(vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Connection error");
  });

  it("does not dispatch a request that was cancelled before authentication", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => sseResponse([]));
    const result = await send(fetch, controller.signal);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/abort/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
