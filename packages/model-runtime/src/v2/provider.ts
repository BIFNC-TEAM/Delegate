import { createPiModelBindingFromEnv } from "../pi/provider";
import { resolveV2Budget } from "./config";
import { z } from "zod";

/** Same installed PI provider client, with no hidden infrastructure retries. */
export function createV2ModelBindingFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const budget = resolveV2Budget(env);
  // Explicit deployment capability, never inferred from a question or model name.
  const profile = z.enum(["auto", "qwen-chat-template"]).parse(env.DELEGATE_V2_REASONING_PROFILE ?? "auto");
  const result = createPiModelBindingFromEnv({ ...env, DELEGATE_PI_MODEL_MAX_RETRIES: "0", DELEGATE_PI_MAX_OUTPUT_TOKENS: String(budget.outputTokens) });
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
