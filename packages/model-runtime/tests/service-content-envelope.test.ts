import { afterEach, expect, it, vi } from "vitest";
import { generateServiceContentSuggestion } from "../src/service-content";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([
  ["openai", "OPENAI_API_KEY", { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "" }] }] }, "empty_suggestion", 2],
  ["openai", "OPENAI_API_KEY", { status: "completed", output: [] }, "model_failure", 1],
  ["openai", "OPENAI_API_KEY", { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }, "model_failure", 1],
  ["anthropic", "ANTHROPIC_API_KEY", { stop_reason: "end_turn", content: [{ type: "text", text: " " }] }, "empty_suggestion", 2],
  ["anthropic", "ANTHROPIC_API_KEY", { stop_reason: "end_turn", content: [] }, "model_failure", 1],
  ["anthropic", "ANTHROPIC_API_KEY", { stop_reason: "end_turn", content: [{ type: "tool_use", id: "x" }] }, "model_failure", 1],
])("%s checks text blocks before retrying", async (provider, key, payload, status, calls) => {
  vi.stubEnv("DELEGATE_MODEL_PROVIDER", provider as string);
  vi.stubEnv(key as string, "test");
  vi.stubEnv("DELEGATE_MODEL_FALLBACK_PROVIDER", "");
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await generateServiceContentSuggestion({ serviceContent: "原文" })).status).toBe(status);
  expect(fetchMock).toHaveBeenCalledTimes(calls as number);
});
