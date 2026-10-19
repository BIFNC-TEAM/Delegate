import { createPiModelBindingFromEnv } from "../pi/provider";
import { resolveV2Budget } from "./config";

/** Same installed PI provider client, with no hidden infrastructure retries. */
export function createV2ModelBindingFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const budget = resolveV2Budget(env);
  const result = createPiModelBindingFromEnv({ ...env, DELEGATE_PI_MODEL_MAX_RETRIES: "0", DELEGATE_PI_MAX_OUTPUT_TOKENS: String(budget.outputTokens) });
  if (!result.ok) return result;
  const model = result.binding.model;
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
