import { afterEach, expect, it, vi } from "vitest";
import { generateFaqSuggestions } from "../src/faq";

const input = { representative: { name: "示例", description: "介绍" }, sources: [{ id: "a", title: "资料", text: "线上服务" }] };
const success = JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ suggestions: [{ question: "如何服务？", answer: "线上服务", sourceIds: ["a"] }] }) } }] });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([
  ["502 HTML", new Response("<html>gateway</html>", { status: 502 })],
  ["503 empty", new Response("", { status: 503 })],
  ["200 rate limit", new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "busy" } }), { status: 200 })],
])("falls back through real adapters for %s", async (_label, response) => {
  vi.stubEnv("DELEGATE_MODEL_PROVIDER", "agicto");
  vi.stubEnv("DELEGATE_AGICTO_API_KEY", "test");
  vi.stubEnv("DELEGATE_MODEL_FALLBACK_PROVIDER", "bailian");
  vi.stubEnv("DELEGATE_BAILIAN_API_KEY", "test");
  const fetchMock = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(success, { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await generateFaqSuggestions(input);
  expect(result).toMatchObject({ status: "success", attempts: [{ provider: "agicto", kind: "retryable" }, { provider: "bailian" }] });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
