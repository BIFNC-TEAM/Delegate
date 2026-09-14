import { randomUUID } from "node:crypto";

import {
  createModels,
  createProvider,
  type Model,
} from "@earendil-works/pi-ai";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";

import { resolveModelRuntimeEnv } from "../config";
import type { ModelProvider, ModelRuntimeEnv } from "../types";
import type { PiModelAttemptEvent, PiModelBinding } from "./types";

export type PiModelBindingResult =
  | { ok: true; binding: PiModelBinding }
  | { ok: false; state: ModelRuntimeEnv["state"]; reason: string };

export function createPiModelBindingFromEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  preferredProvider?: ModelProvider,
): PiModelBindingResult {
  const env = resolveModelRuntimeEnv(processEnv);
  const piMaxOutputTokens = positiveInteger(
    processEnv.DELEGATE_PI_MAX_OUTPUT_TOKENS,
    4_096,
  );
  const piModelMaxRetries = nonNegativeInteger(
    processEnv.DELEGATE_PI_MODEL_MAX_RETRIES,
    1,
    2,
  );
  if (env.state !== "ready") {
    return {
      ok: false,
      state: env.state,
      reason: `Pi model runtime unavailable: ${env.state}.`,
    };
  }
  const order = [
    preferredProvider,
    normalizeProvider(env.provider),
    normalizeProvider(env.fallbackProvider),
  ].filter((provider, index, values): provider is ModelProvider =>
    Boolean(provider) && values.indexOf(provider) === index);
  for (const provider of order) {
    const binding = createProviderBinding(provider, env, piMaxOutputTokens, piModelMaxRetries);
    if (binding) return { ok: true, binding };
  }
  return {
    ok: false,
    state: "missing_credentials",
    reason: "No configured provider could be bound to Pi.",
  };
}

function createProviderBinding(
  provider: ModelProvider,
  env: ModelRuntimeEnv,
  piMaxOutputTokens: number,
  piModelMaxRetries: number,
): PiModelBinding | null {
  const config = env[provider];
  if (!config.apiKey) return null;
  const apiKey = config.apiKey;
  const api = provider === "anthropic"
    ? "anthropic-messages" as const
    : provider === "openai"
      ? "openai-responses" as const
      : "openai-completions" as const;
  const baseUrl = config.baseUrl ?? defaultBaseUrl(provider);
  const model: Model<typeof api> = {
    id: config.model,
    name: config.model,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: {
      input: config.pricing.inputCostUsdPerMillionTokens,
      output: config.pricing.outputCostUsdPerMillionTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: Math.max(env.maxInputTokens + piMaxOutputTokens, 16_384),
    maxTokens: piMaxOutputTokens,
    ...(api === "openai-completions"
      ? {
          compat: {
            supportsDeveloperRole: true,
            supportsUsageInStreaming: true,
            supportsFinishReason: true,
            maxTokensField: "max_tokens" as const,
            supportsStrictMode: true,
          },
        }
      : {}),
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: provider,
    name: provider,
    baseUrl,
    auth: {
      apiKey: {
        name: `${provider} API key`,
        check: async () => ({ source: "Delegate model environment", type: "api_key" }),
        resolve: async () => ({
          auth: { apiKey, baseUrl },
          source: "Delegate model environment",
        }),
      },
    },
    models: [model],
    api: api === "anthropic-messages"
      ? anthropicMessages
      : api === "openai-responses"
        ? openaiResponses
        : openaiCompletions,
  }));
  const createStreamFn = (observer?: (event: PiModelAttemptEvent) => void) =>
    ((selectedModel, context, options) => {
      const logicalCallId = randomUUID();
      const observedFetch = createObservedProviderFetch({
        fetch: options?.fetch ?? globalThis.fetch,
        observer,
        logicalCallId,
        maximumRetries: piModelMaxRetries,
        maximumRetryDelayMs: 2_000,
      });
      return models.streamSimple(selectedModel, context, {
        ...options,
        fetch: observedFetch,
        timeoutMs: env.timeoutMs,
        maxTokens: piMaxOutputTokens,
        maxRetries: piModelMaxRetries,
        maxRetryDelayMs: 2_000,
      });
    }) satisfies PiModelBinding["streamFn"];
  return {
    model,
    streamFn: createStreamFn(),
    createObservedStreamFn: (observer) => createStreamFn(observer),
    provider,
    modelId: config.model,
  };
}

export function createObservedProviderFetch(input: {
  fetch: typeof fetch;
  observer?: ((event: PiModelAttemptEvent) => void) | undefined;
  logicalCallId?: string | undefined;
  maximumRetries: number;
  maximumRetryDelayMs: number;
}): typeof fetch {
  const logicalCallId = input.logicalCallId ?? randomUUID();
  let attempt = 0;
  return async (request, init) => {
    attempt += 1;
    const currentAttempt = attempt;
    input.observer?.({ type: "start", logicalCallId, attempt: currentAttempt });
    try {
      const response = await input.fetch(request, init);
      const willRetry = !response.ok && providerResponseWillRetry(
        response,
        currentAttempt,
        input.maximumRetries,
        input.maximumRetryDelayMs,
      );
      input.observer?.({
        type: "end",
        logicalCallId,
        attempt: currentAttempt,
        status: response.ok ? "ok" : "error",
        httpStatus: response.status,
        ...(willRetry ? { willRetry: true } : {}),
      });
      return response;
    } catch (error) {
      const cancelled = init?.signal?.aborted === true;
      input.observer?.({
        type: "end",
        logicalCallId,
        attempt: currentAttempt,
        status: cancelled ? "cancelled" : "error",
        error: cancelled ? "request_aborted" : safeFetchError(error),
        ...(!cancelled && currentAttempt <= input.maximumRetries ? { willRetry: true } : {}),
      });
      throw error;
    }
  };
}

function providerResponseWillRetry(
  response: Response,
  attempt: number,
  maximumRetries: number,
  maximumRetryDelayMs: number,
) {
  if (attempt > maximumRetries) return false;
  const shouldRetry = response.headers.get("x-should-retry");
  if (shouldRetry === "false") return false;
  const retryable = shouldRetry === "true"
    || response.status === 408
    || response.status === 409
    || response.status === 429
    || response.status >= 500;
  if (!retryable) return false;
  const retryAfterMs = response.headers.get("retry-after-ms");
  const retryAfter = response.headers.get("retry-after");
  let requestedDelayMs = 0;
  if (retryAfterMs !== null) requestedDelayMs = Number.parseFloat(retryAfterMs);
  else if (retryAfter !== null) {
    const seconds = Number.parseFloat(retryAfter);
    requestedDelayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1_000;
  }
  return Number.isFinite(requestedDelayMs) && requestedDelayMs <= maximumRetryDelayMs;
}

function safeFetchError(error: unknown) {
  return error instanceof Error && error.name ? error.name : "fetch_error";
}

function nonNegativeInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 32_768)
    : fallback;
}

function normalizeProvider(value: string | undefined): ModelProvider | undefined {
  return value === "agicto"
    || value === "openai"
    || value === "bailian"
    || value === "anthropic"
    ? value
    : undefined;
}

function defaultBaseUrl(provider: ModelProvider) {
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "bailian") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (provider === "agicto") return "https://api.agicto.cn/v1";
  return "https://api.openai.com/v1";
}
