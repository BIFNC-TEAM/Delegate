import { afterEach, expect, it, vi } from "vitest";
import { generateServiceContentSuggestion } from "../src/service-content";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(["", "  ", null])("distinguishes empty text from invalid envelope %j", async content => {
 vi.stubEnv("DELEGATE_MODEL_PROVIDER", "agicto"); vi.stubEnv("DELEGATE_AGICTO_API_KEY", "test"); vi.stubEnv("DELEGATE_MODEL_FALLBACK_PROVIDER", "");
 const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(content === null ? {} : { choices: [{finish_reason:"stop",message:{content}}] }), {status:200})); vi.stubGlobal("fetch",fetchMock);
 expect((await generateServiceContentSuggestion({serviceContent:"原文"})).status).toBe(content === null ? "model_failure" : "empty_suggestion"); expect(fetchMock).toHaveBeenCalledTimes(content === null ? 1 : 2);
});
