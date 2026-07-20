import { z } from "zod";

import type { ModelProvider, ModelRuntimeEnv, ModelPricingConfig } from "./types";

const envSchema = z.object({
  DELEGATE_MODEL_ENABLED: z.string().optional(),
  DELEGATE_MODEL_PROVIDER: z.string().optional(),
  DELEGATE_MODEL_FALLBACK_PROVIDER: z.string().optional(),
  DELEGATE_MODEL_TIMEOUT_MS: z.string().optional(),
  DELEGATE_MODEL_MAX_INPUT_TOKENS: z.string().optional(),
  DELEGATE_MODEL_MAX_OUTPUT_TOKENS: z.string().optional(),
  DELEGATE_OPENAI_MODEL: z.string().optional(),
  DELEGATE_OPENAI_INPUT_COST_USD_PER_1M_TOKENS: z.string().optional(),
  DELEGATE_OPENAI_OUTPUT_COST_USD_PER_1M_TOKENS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  DELEGATE_BAILIAN_MODEL: z.string().optional(),
  DELEGATE_BAILIAN_INPUT_COST_USD_PER_1M_TOKENS: z.string().optional(),
  DELEGATE_BAILIAN_OUTPUT_COST_USD_PER_1M_TOKENS: z.string().optional(),
  DELEGATE_BAILIAN_API_KEY: z.string().optional(),
  DELEGATE_BAILIAN_BASE_URL: z.string().optional(),
  DELEGATE_ANTHROPIC_MODEL: z.string().optional(),
  DELEGATE_ANTHROPIC_INPUT_COST_USD_PER_1M_TOKENS: z.string().optional(),
  DELEGATE_ANTHROPIC_OUTPUT_COST_USD_PER_1M_TOKENS: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
});

export function resolveModelRuntimeEnv(env: NodeJS.ProcessEnv = process.env): ModelRuntimeEnv {
  const parsed = envSchema.parse(env);
  const enabled = parseBoolean(parsed.DELEGATE_MODEL_ENABLED, true);
  const provider = normalizeOptionalString(parsed.DELEGATE_MODEL_PROVIDER) ?? "openai";
  const fallbackProvider = normalizeOptionalString(parsed.DELEGATE_MODEL_FALLBACK_PROVIDER);
  const timeoutMs = parseInteger(parsed.DELEGATE_MODEL_TIMEOUT_MS, 12_000);
  const maxInputTokens = parseInteger(parsed.DELEGATE_MODEL_MAX_INPUT_TOKENS, 2_400);
  const maxOutputTokens = parseInteger(parsed.DELEGATE_MODEL_MAX_OUTPUT_TOKENS, 320);
  const openaiModel = normalizeOptionalString(parsed.DELEGATE_OPENAI_MODEL) ?? "gpt-5-mini";
  const openaiApiKey = normalizeOptionalString(parsed.OPENAI_API_KEY);
  const openaiBaseUrl = normalizeOptionalString(parsed.OPENAI_BASE_URL);
  const bailianModel = normalizeOptionalString(parsed.DELEGATE_BAILIAN_MODEL) ?? "qwen-plus";
  const bailianApiKey = normalizeOptionalString(parsed.DELEGATE_BAILIAN_API_KEY);
  const bailianBaseUrl =
    normalizeOptionalString(parsed.DELEGATE_BAILIAN_BASE_URL) ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const anthropicModel =
    normalizeOptionalString(parsed.DELEGATE_ANTHROPIC_MODEL) ?? "claude-sonnet-4-5";
  const anthropicApiKey = normalizeOptionalString(parsed.ANTHROPIC_API_KEY);
  const anthropicBaseUrl = normalizeOptionalString(parsed.ANTHROPIC_BASE_URL);
  const openaiPricing = buildPricing(
    parsed.DELEGATE_OPENAI_INPUT_COST_USD_PER_1M_TOKENS,
    parsed.DELEGATE_OPENAI_OUTPUT_COST_USD_PER_1M_TOKENS,
  );
  const bailianPricing = buildPricing(
    parsed.DELEGATE_BAILIAN_INPUT_COST_USD_PER_1M_TOKENS,
    parsed.DELEGATE_BAILIAN_OUTPUT_COST_USD_PER_1M_TOKENS,
  );
  const anthropicPricing = buildPricing(
    parsed.DELEGATE_ANTHROPIC_INPUT_COST_USD_PER_1M_TOKENS,
    parsed.DELEGATE_ANTHROPIC_OUTPUT_COST_USD_PER_1M_TOKENS,
  );
  const resolvedProvider = normalizeProvider(provider);
  const resolvedFallbackProvider = normalizeProvider(fallbackProvider);
  const providerSupported = typeof resolvedProvider !== "undefined";
  const fallbackSupported = !fallbackProvider || typeof resolvedFallbackProvider !== "undefined";
  const openaiReady = Boolean(openaiApiKey);
  const bailianReady = Boolean(bailianApiKey);
  const anthropicReady = Boolean(anthropicApiKey);

  if (!enabled) {
    return {
      enabled,
      provider,
      ...(fallbackProvider ? { fallbackProvider } : {}),
      state: "disabled",
      timeoutMs,
      maxInputTokens,
      maxOutputTokens,
      openai: {
        model: openaiModel,
        pricing: openaiPricing,
        ...(openaiApiKey ? { apiKey: openaiApiKey } : {}),
        ...(openaiBaseUrl ? { baseUrl: openaiBaseUrl } : {}),
      },
      bailian: {
        model: bailianModel,
        pricing: bailianPricing,
        ...(bailianApiKey ? { apiKey: bailianApiKey } : {}),
        ...(bailianBaseUrl ? { baseUrl: bailianBaseUrl } : {}),
      },
      anthropic: {
        model: anthropicModel,
        pricing: anthropicPricing,
        ...(anthropicApiKey ? { apiKey: anthropicApiKey } : {}),
        ...(anthropicBaseUrl ? { baseUrl: anthropicBaseUrl } : {}),
      },
    };
  }

  if (!providerSupported || !fallbackSupported) {
    return {
      enabled,
      provider,
      ...(fallbackProvider ? { fallbackProvider } : {}),
      state: "unsupported_provider",
      timeoutMs,
      maxInputTokens,
      maxOutputTokens,
      openai: {
        model: openaiModel,
        pricing: openaiPricing,
        ...(openaiApiKey ? { apiKey: openaiApiKey } : {}),
        ...(openaiBaseUrl ? { baseUrl: openaiBaseUrl } : {}),
      },
      bailian: {
        model: bailianModel,
        pricing: bailianPricing,
        ...(bailianApiKey ? { apiKey: bailianApiKey } : {}),
        ...(bailianBaseUrl ? { baseUrl: bailianBaseUrl } : {}),
      },
      anthropic: {
        model: anthropicModel,
        pricing: anthropicPricing,
        ...(anthropicApiKey ? { apiKey: anthropicApiKey } : {}),
        ...(anthropicBaseUrl ? { baseUrl: anthropicBaseUrl } : {}),
      },
    };
  }

  if (
    !isProviderReady(resolvedProvider, {
      openaiReady,
      bailianReady,
      anthropicReady,
    }) &&
    !isProviderReady(resolvedFallbackProvider, {
      openaiReady,
      bailianReady,
      anthropicReady,
    })
  ) {
    return {
      enabled,
      provider,
      ...(fallbackProvider ? { fallbackProvider } : {}),
      state: "missing_credentials",
      timeoutMs,
      maxInputTokens,
      maxOutputTokens,
      openai: {
        model: openaiModel,
        pricing: openaiPricing,
        ...(openaiBaseUrl ? { baseUrl: openaiBaseUrl } : {}),
      },
      bailian: {
        model: bailianModel,
        pricing: bailianPricing,
        ...(bailianBaseUrl ? { baseUrl: bailianBaseUrl } : {}),
      },
      anthropic: {
        model: anthropicModel,
        pricing: anthropicPricing,
        ...(anthropicBaseUrl ? { baseUrl: anthropicBaseUrl } : {}),
      },
    };
  }

  return {
    enabled,
    provider,
    ...(fallbackProvider ? { fallbackProvider } : {}),
    state: "ready",
    timeoutMs,
    maxInputTokens,
    maxOutputTokens,
    openai: {
      model: openaiModel,
      pricing: openaiPricing,
      ...(openaiApiKey ? { apiKey: openaiApiKey } : {}),
      ...(openaiBaseUrl ? { baseUrl: openaiBaseUrl } : {}),
    },
    bailian: {
      model: bailianModel,
      ...(bailianApiKey ? { apiKey: bailianApiKey } : {}),
      pricing: bailianPricing,
      ...(bailianBaseUrl ? { baseUrl: bailianBaseUrl } : {}),
    },
    anthropic: {
      model: anthropicModel,
      ...(anthropicApiKey ? { apiKey: anthropicApiKey } : {}),
      pricing: anthropicPricing,
      ...(anthropicBaseUrl ? { baseUrl: anthropicBaseUrl } : {}),
    },
  };
}

export function resolveProviderAttemptOrder(env: ModelRuntimeEnv): ModelProvider[] {
  if (env.state !== "ready") {
    return [];
  }

  const ordered = [normalizeProvider(env.provider), normalizeProvider(env.fallbackProvider)].filter(
    (provider, index, array): provider is ModelProvider =>
      typeof provider !== "undefined" && array.indexOf(provider) === index,
  );

  return ordered.filter((provider) =>
    isProviderReady(provider, {
      openaiReady: Boolean(env.openai.apiKey),
      bailianReady: Boolean(env.bailian.apiKey),
      anthropicReady: Boolean(env.anthropic.apiKey),
    }),
  );
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeProvider(value: string | undefined): ModelProvider | undefined {
  if (value === "openai" || value === "bailian" || value === "anthropic") {
    return value;
  }

  return undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseDecimal(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function buildPricing(input: string | undefined, output: string | undefined): ModelPricingConfig {
  return {
    inputCostUsdPerMillionTokens: parseDecimal(input, 0),
    outputCostUsdPerMillionTokens: parseDecimal(output, 0),
  };
}

function isProviderReady(
  provider: ModelProvider | undefined,
  readiness: {
    openaiReady: boolean;
    bailianReady: boolean;
    anthropicReady: boolean;
  },
): boolean {
  if (!provider) {
    return false;
  }

  if (provider === "openai") {
    return readiness.openaiReady;
  }

  return provider === "bailian" ? readiness.bailianReady : readiness.anthropicReady;
}
