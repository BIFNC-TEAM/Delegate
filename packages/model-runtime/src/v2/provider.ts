import { createPiModelBindingFromEnv } from "../pi/provider";
import { resolveV2Budget } from "./config";
import { z } from "zod";

/** Same installed PI provider client, with no hidden infrastructure retries. */
export function createV2ModelBindingFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const budget = resolveV2Budget(env);
  // Explicit deployment capability, never inferred from a question or model name.
  const profile = z.enum(["auto", "qwen-chat-template"]).parse(env.DELEGATE_V2_REASONING_PROFILE ?? "auto");
  const modelEnv = resolveV2ModelEnv(env);
  const result = createPiModelBindingFromEnv({ ...modelEnv, DELEGATE_PI_MODEL_MAX_RETRIES: "0", DELEGATE_PI_MAX_OUTPUT_TOKENS: String(budget.outputTokens) });
  if (!result.ok) return result;
  const model = result.binding.model;
  if (profile === "qwen-chat-template") {
    if (model.api !== "openai-completions") throw new Error("V2 qwen-chat-template requires an OpenAI-compatible Chat Completions transport.");
    // Verified against the configured server's OpenAPI schema and live on/off
    // probes. PI 0.85.1 encodes these fields and clamps thinking to answer room.
    return { ...result, binding: { ...result.binding, model: { ...model, reasoning: true, compat: {
      ...model.compat, supportsDeveloperRole: false, supportsReasoningEffort: false,
      thinkingFormat: "qwen-chat-template" as const, thinkingTokenBudgetField: "thinking_token_budget" as const,
    } } } };
  }
  // Only the tested Qwen Plus hybrid profile. This is provider capability
  // metadata, not task routing; unverified model families retain their binding.
  // PI 0.85.1 sends enable_thinking/thinking_budget natively for this profile.
  if (model.api !== "openai-completions" || model.id !== "qwen-plus"
    || !["agicto", "bailian"].includes(result.binding.provider)) return result;
  return { ...result, binding: { ...result.binding, model: { ...model, reasoning: true, compat: {
    ...model.compat, supportsDeveloperRole: false, supportsReasoningEffort: false,
    thinkingFormat: "qwen" as const, thinkingTokenBudgetField: "thinking_budget" as const,
  } } } };
}

/** Shared endpoint resolution for the worker readiness probe and the V2 client. */
export function resolveV2ModelEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.DELEGATE_AGENT_VERSION && env.DELEGATE_AGENT_VERSION !== "v2") throw new Error("Only Agent V2 is supported; the legacy runtime is retired.");
  const hasEndpointOverride = [env.DELEGATE_V2_MODEL_BASE_URL, env.DELEGATE_V2_MODEL_ID, env.DELEGATE_V2_MODEL_API_KEY].some(value => value !== undefined);
  // A complete chat connection keeps document-generation settings separate and
  // prevents sending inherited credentials to a new URL.
  const endpoint = hasEndpointOverride ? z.object({ baseUrl: z.string().url(), id: z.string().trim().min(1), apiKey: z.string().trim().min(1) })
    .parse({ baseUrl: env.DELEGATE_V2_MODEL_BASE_URL, id: env.DELEGATE_V2_MODEL_ID, apiKey: env.DELEGATE_V2_MODEL_API_KEY }) : undefined;
  return endpoint ? { ...env, DELEGATE_MODEL_PROVIDER: "agicto", DELEGATE_MODEL_FALLBACK_PROVIDER: "",
    DELEGATE_AGICTO_BASE_URL: endpoint.baseUrl, DELEGATE_AGICTO_MODEL: endpoint.id, DELEGATE_AGICTO_API_KEY: endpoint.apiKey,
    // New endpoints must not inherit a different model's accounting rates.
    DELEGATE_AGICTO_INPUT_COST_USD_PER_1M_TOKENS: env.DELEGATE_V2_MODEL_INPUT_COST_USD_PER_1M_TOKENS ?? "0",
    DELEGATE_AGICTO_OUTPUT_COST_USD_PER_1M_TOKENS: env.DELEGATE_V2_MODEL_OUTPUT_COST_USD_PER_1M_TOKENS ?? "0",
  } : env;
}
