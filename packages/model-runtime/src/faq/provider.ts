import { generateAgictoResponse } from "../agicto";
import { generateAnthropicResponse } from "../anthropic";
import { generateBailianResponse } from "../bailian";
import { generateOpenAIResponse } from "../openai";
import type { ModelProvider, ModelRuntimeEnv, RepresentativeReplyPrompt } from "../types";

export async function callProvider(provider: ModelProvider, env: ModelRuntimeEnv, prompt: RepresentativeReplyPrompt) {
  if (provider === "agicto") {
    return generateAgictoResponse({ env, prompt });
  }
  if (provider === "bailian") {
    return generateBailianResponse({ env, prompt });
  }
  if (provider === "openai") {
    return generateOpenAIResponse({ env, prompt });
  }
  return generateAnthropicResponse({ env, prompt });
}
export function classifyFailure(error: unknown): "timeout" | "retryable" | "invalid_output" | "non_retryable" {
  if (!(error instanceof Error)) {
    return "non_retryable";
  }
  if (/timeout|timed out|abort/i.test(error.name + " " + error.message)) {
    return "timeout";
  }
  const status = "status" in error && typeof error.status === "number" ? error.status : Number(error.message.match(/HTTP (\d{3})/)?.[1]);
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (status === 429 || status >= 500 || status === 408 || status === 409 || /insufficient_quota|quota[_ ]exceeded|rate_limit|server_overloaded/i.test(code + " " + error.message)) {
    return "retryable";
  }
  if (((status >= 200 && status < 300) && /non-JSON|invalid response envelope/i.test(error.message)) || /returned no text output\./i.test(error.message)) {
    return "invalid_output";
  }
  if (error instanceof TypeError || /network|connection|fetch failed/i.test(error.message)) {
    return "retryable";
  }
  return "non_retryable";
}
