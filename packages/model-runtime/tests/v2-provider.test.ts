import { describe, expect, it } from "vitest";
import { createV2ModelBindingFromEnv } from "../src/v2/provider";
import { createPiModelBindingFromEnv } from "../src/pi/provider";

const env = { DELEGATE_MODEL_PROVIDER: "bailian", DELEGATE_BAILIAN_API_KEY: "fixture-not-a-real-key",
  DELEGATE_BAILIAN_BASE_URL: "https://fixture.invalid/v1", DELEGATE_BAILIAN_MODEL: "qwen-plus" };

describe("V2 verified Qwen native reasoning wire contract", () => {
  it("uses one native stream with bounded thinking and preserves answer room", async () => {
    const binding = createV2ModelBindingFromEnv(env);
    if (!binding.ok) throw Error(binding.reason);
    let sent: any;
    const stream = await binding.binding.streamFn(binding.binding.model, {
      systemPrompt: "fixture system", messages: [{ role: "user", content: "fixture", timestamp: 0 }],
    }, { reasoning: "low", thinkingBudgets: { low: 1024 }, maxTokens: 2048,
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      } });
    expect((await stream.result()).stopReason).toBe("stop");
    expect(sent).toMatchObject({ enable_thinking: true, thinking_budget: 1024, max_tokens: 2048 });
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.messages[0].role).toBe("system");
  });
  it("can explicitly disable thinking without changing legacy bindings", async () => {
    const binding = createV2ModelBindingFromEnv({ ...env, DELEGATE_V2_THINKING_TOKENS: "0" });
    const legacy = createPiModelBindingFromEnv(env);
    if (!binding.ok || !legacy.ok) throw Error("fixture binding failed");
    expect(legacy.binding.model.reasoning).toBe(false);
    let sent: any;
    const stream = await binding.binding.streamFn(binding.binding.model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      } });
    await stream.result();
    expect(sent.enable_thinking).toBe(false); expect(sent.thinking_budget).toBeUndefined();
  });
  it("does not guess Qwen features for an unverified model", () => {
    const binding = createV2ModelBindingFromEnv({ ...env, DELEGATE_BAILIAN_MODEL: "unverified-model" });
    if (!binding.ok) throw Error(binding.reason);
    expect(binding.binding.model.reasoning).toBe(false);
    expect(binding.binding.model.compat).not.toHaveProperty("thinkingFormat");
  });
  it.each([true, false])("encodes the opt-in chat-template profile with thinking enabled=%s", async enabled => {
    const settings = { ...env, DELEGATE_BAILIAN_MODEL: "qwen3.8-27b", DELEGATE_V2_REASONING_PROFILE: "qwen-chat-template" };
    const binding = createV2ModelBindingFromEnv(settings);
    const legacy = createPiModelBindingFromEnv(settings);
    if (!binding.ok || !legacy.ok) throw Error("fixture binding failed");
    expect(legacy.binding.model.reasoning).toBe(false);
    let sent: any;
    const stream = await binding.binding.streamFn(binding.binding.model, {
      systemPrompt: "fixture system", messages: [{ role: "user", content: "fixture", timestamp: 0 }],
    }, { ...(enabled ? { reasoning: "low" as const } : {}), thinkingBudgets: { low: 1024 }, maxTokens: 2048,
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      } });
    expect((await stream.result()).stopReason).toBe("stop");
    expect(sent).toMatchObject({ chat_template_kwargs: { enable_thinking: enabled, preserve_thinking: true }, max_tokens: 2048 });
    expect(sent.thinking_token_budget).toBe(enabled ? 1024 : undefined);
    expect(sent.enable_thinking).toBeUndefined();
    expect(sent.thinking_budget).toBeUndefined();
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.messages[0].role).toBe("system");
  });
  it("rejects unknown profiles and incompatible transports", () => {
    expect(() => createV2ModelBindingFromEnv({ ...env, DELEGATE_V2_REASONING_PROFILE: "typo" })).toThrow();
    expect(() => createV2ModelBindingFromEnv({ DELEGATE_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "fixture",
      DELEGATE_V2_REASONING_PROFILE: "qwen-chat-template" })).toThrow(/Chat Completions/);
  });
  it("uses a V2-only endpoint without changing the legacy model or inheriting its credentials/rates", async () => {
    const settings = { ...env, DELEGATE_AGICTO_INPUT_COST_USD_PER_1M_TOKENS: "100",
      DELEGATE_V2_MODEL_BASE_URL: "https://v2.fixture.invalid/v1", DELEGATE_V2_MODEL_ID: "qwen3.8-27b",
      DELEGATE_V2_MODEL_API_KEY: "v2-fixture-key", DELEGATE_V2_REASONING_PROFILE: "qwen-chat-template" };
    const unchanged = { ...settings };
    const v2 = createV2ModelBindingFromEnv(settings), legacy = createPiModelBindingFromEnv(settings);
    if (!v2.ok || !legacy.ok) throw Error("fixture binding failed");
    expect(v2.binding.model).toMatchObject({ id: "qwen3.8-27b", baseUrl: "https://v2.fixture.invalid/v1", cost: { input: 0, output: 0 } });
    expect(legacy.binding.model).toMatchObject({ id: "qwen-plus", baseUrl: env.DELEGATE_BAILIAN_BASE_URL });
    const stream = await v2.binding.streamFn(v2.binding.model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://v2.fixture.invalid/v1/chat/completions");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer v2-fixture-key");
        return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      } });
    expect((await stream.result()).stopReason).toBe("stop");
    expect(settings).toEqual(unchanged);
  });
  it("rejects incomplete V2 endpoint overrides instead of inheriting an unrelated key", () => {
    expect(() => createV2ModelBindingFromEnv({ ...env, DELEGATE_V2_MODEL_BASE_URL: "https://v2.fixture.invalid/v1" })).toThrow();
  });
});
