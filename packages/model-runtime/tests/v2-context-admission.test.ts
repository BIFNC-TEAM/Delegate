import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { describe, expect, it, vi } from "vitest";
import { DelegateAgentV2, type V2RunInput } from "../src/v2";
import { createV2ModelBindingFromEnv } from "../src/v2/provider";

function request(available: number): V2RunInput {
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  faux.setResponses([fauxAssistantMessage("bounded answer")]);
  const models = createModels(); models.setProvider(faux.provider);
  const history = fauxAssistantMessage("previous evidence");
  history.timestamp = 0;
  history.usage = { input: 9000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 10000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return { requestId: "context-test", sessionId: "context-test", scope: "fixture", userText: "x", timezone: "Asia/Shanghai",
    history: [history], model: { provider: "faux", modelId: "faux", model: { ...faux.getModel(), contextWindow: 10001 + 4096 + available }, streamFn: models.streamSimple.bind(models) },
    tools: [{ name: "lookup", label: "lookup", category: "knowledge", effect: "read", description: "fixture evidence",
      parameters: Type.Object({}), execute: vi.fn(async () => ({ text: "must not run" })) }],
    context: { traceId: "trace", runId: "context-test", sessionId: "context-test", timezone: "Asia/Shanghai", attachments: [], idempotencyKey: "context-test" },
    authorize: vi.fn(async () => undefined) };
}

describe("V2 SDK context admission", () => {
  it.each([1, 64, 1023])("stops before provider invocation with %i tokens of room", async room => {
    const input = request(room); const stream = vi.fn(input.model.streamFn); input.model.streamFn = stream;
    const result = await new DelegateAgentV2().run(input);
    expect(result).toMatchObject({ status: "partial", error: "context_limit", modelCalls: 0, toolCalls: 0 });
    expect(result.text).toContain("1024"); expect(stream).not.toHaveBeenCalled();
    expect(input.tools[0]!.execute).not.toHaveBeenCalled();
  });
  it.each([1024, 2048, 6500])("admits exactly %i tokens and retains tools and history", async room => {
    const input = request(room); const base = input.model.streamFn;
    input.model.streamFn = (model, context, options) => {
      expect(options?.maxTokens).toBe(room); expect(context.tools?.some(t => t.name === "lookup")).toBe(true);
      expect(context.messages[0]).toMatchObject({ role: "assistant", usage: { totalTokens: 10000 } });
      expect(context.systemPrompt).toContain('"finalAnswerOnly":false');
      expect(clampMaxTokensToContext(model, context, options!.maxTokens!)).toBe(room);
      return base(model, context, options);
    };
    const result = await new DelegateAgentV2().run(input);
    expect(result).toMatchObject({ status: "completed", modelCalls: 1, toolCalls: 0, text: "bounded answer" });
    expect(input.authorize).toHaveBeenCalledWith("release", undefined, undefined);
  });
  it("retains tools when the full output target fits", async () => {
    const input = request(8192); const base = input.model.streamFn;
    input.model.streamFn = (model, context, options) => {
      expect(options?.maxTokens).toBe(8192); expect(context.tools?.some(t => t.name === "lookup")).toBe(true);
      return base(model, context, options);
    };
    expect((await new DelegateAgentV2().run(input)).status).toBe("completed");
  });
  it("executes an authorized tool with less than 8k output room", async () => {
    const input = request(6500);
    const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const models = createModels(); models.setProvider(faux.provider);
    let turns = 0;
    input.model.streamFn = (model, context, options) => {
      if (++turns === 1) { expect(options?.maxTokens).toBe(6500); expect(context.tools?.some(t => t.name === "lookup")).toBe(true); }
      return models.streamSimple(model, context, options);
    };
    const result = await new DelegateAgentV2().run(input);
    expect(input.tools[0]!.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ modelCalls: 2, toolCalls: 1, text: "done" });
  });
  it.each([1023, 1024])("checks the actual SDK serializer at the %i boundary", async room => {
    const input = request(room);
    const binding = createV2ModelBindingFromEnv({ DELEGATE_MODEL_PROVIDER: "bailian", DELEGATE_BAILIAN_API_KEY: "fixture",
      DELEGATE_BAILIAN_BASE_URL: "https://fixture.invalid/v1", DELEGATE_BAILIAN_MODEL: "fixture" });
    if (!binding.ok) throw Error(binding.reason);
    const fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(1024); expect(body.tools.some((t: any) => t.function.name === "lookup")).toBe(true);
      expect(body.messages.some((m: any) => m.role === "assistant" && m.content === "previous evidence")).toBe(true);
      return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"wire answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    input.model = { ...binding.binding, model: { ...binding.binding.model, contextWindow: input.model.model.contextWindow },
      streamFn: (model, context, options) => binding.binding.streamFn(model, context, { ...options, fetch }) };
    const result = await new DelegateAgentV2().run(input);
    expect(fetch).toHaveBeenCalledTimes(room < 1024 ? 0 : 1);
    expect(result.modelCalls).toBe(room < 1024 ? 0 : 1);
    if (room === 1024) expect(result.text).toBe("wire answer");
  });
});
