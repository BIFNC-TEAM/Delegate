import { createPiModelBindingFromEnv } from "../pi/provider";
import { resolveV2Budget } from "./config";

/** Same installed PI provider client, with no hidden infrastructure retries. */
export function createV2ModelBindingFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const budget = resolveV2Budget(env);
  return createPiModelBindingFromEnv({ ...env, DELEGATE_PI_MODEL_MAX_RETRIES: "0", DELEGATE_PI_MAX_OUTPUT_TOKENS: String(budget.outputTokens) });
}
