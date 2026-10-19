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
});
