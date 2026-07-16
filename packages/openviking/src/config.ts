import { z } from "zod";

import { openVikingCaptureModeSchema, openVikingModeSchema } from "./types";

const envSchema = z.object({
  OPENVIKING_ENABLED: z.string().optional(),
  OPENVIKING_BASE_URL: z.string().url().optional(),
  OPENVIKING_API_KEY: z.string().optional(),
  OPENVIKING_ROOT_API_KEY: z.string().optional(),
  OPENVIKING_TIMEOUT_MS: z.string().optional(),
  OPENVIKING_CONSOLE_URL: z.string().url().optional(),
  OPENVIKING_AGENT_ID_PREFIX: z.string().optional(),
  OPENVIKING_RESOURCE_SYNC_ENABLED: z.string().optional(),
  OPENVIKING_AUTO_RECALL_DEFAULT: z.string().optional(),
  OPENVIKING_AUTO_CAPTURE_DEFAULT: z.string().optional(),
  OPENVIKING_PROVIDER: z.string().optional(),
  OPENVIKING_VLM_MODEL: z.string().optional(),
  OPENVIKING_EMBEDDING_MODEL: z.string().optional(),
  OPENVIKING_EMBEDDING_DIMENSION: z.string().optional(),
  OPENVIKING_CAPTURE_MODE_DEFAULT: z.string().optional(),
  OPENVIKING_MODEL_API_KEY: z.string().optional(),
  OPENVIKING_MODEL_API_BASE: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_API_BASE: z.string().optional(),
});

export type OpenVikingEnvConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  rootApiKey?: string;
  timeoutMs: number;
  consoleUrl?: string;
  agentIdPrefix: string;
  resourceSyncEnabled: boolean;
  autoRecallDefault: boolean;
  autoCaptureDefault: boolean;
  captureModeDefault: "semantic" | "keyword";
  provider: string;
  vlmModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  mode: "local" | "remote";
  hasModelCredentials: boolean;
};

export function resolveOpenVikingEnv(env: NodeJS.ProcessEnv = process.env): OpenVikingEnvConfig {
  const parsed = envSchema.parse(env);
  const enabled = parseBoolean(parsed.OPENVIKING_ENABLED, false);
  const baseUrl = normalizeBaseUrl(parsed.OPENVIKING_BASE_URL ?? "http://localhost:1933");
  const timeoutMs = parseInteger(parsed.OPENVIKING_TIMEOUT_MS, 8000);
  const rootApiKey = normalizeOptionalString(parsed.OPENVIKING_ROOT_API_KEY);
  const apiKey = normalizeOptionalString(parsed.OPENVIKING_API_KEY) ?? rootApiKey;
  const provider = normalizeOptionalString(parsed.OPENVIKING_PROVIDER) ?? "openai";
  const dedicatedModelApiKey = normalizeOptionalString(parsed.OPENVIKING_MODEL_API_KEY);
  const captureModeDefault = openVikingCaptureModeSchema.parse(
    normalizeOptionalString(parsed.OPENVIKING_CAPTURE_MODE_DEFAULT) ?? "semantic",
  );
  const mode = openVikingModeSchema.parse(enabled ? "remote" : "local");
  const hasOpenAiConfig = Boolean(
    (dedicatedModelApiKey ?? normalizeOptionalString(parsed.OPENAI_API_KEY)) && provider === "openai",
  );
  const hasArkConfig = Boolean(
    (dedicatedModelApiKey ?? normalizeOptionalString(parsed.ARK_API_KEY)) && provider === "volcengine",
  );

  return {
    enabled,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(rootApiKey ? { rootApiKey } : {}),
    timeoutMs,
    ...(normalizeOptionalString(parsed.OPENVIKING_CONSOLE_URL)
      ? { consoleUrl: normalizeBaseUrl(parsed.OPENVIKING_CONSOLE_URL!) }
      : {}),
    agentIdPrefix: normalizeOptionalString(parsed.OPENVIKING_AGENT_ID_PREFIX) ?? "delegate-rep",
    resourceSyncEnabled: parseBoolean(parsed.OPENVIKING_RESOURCE_SYNC_ENABLED, true),
    autoRecallDefault: parseBoolean(parsed.OPENVIKING_AUTO_RECALL_DEFAULT, true),
    autoCaptureDefault: parseBoolean(parsed.OPENVIKING_AUTO_CAPTURE_DEFAULT, true),
    captureModeDefault,
    provider,
    vlmModel: normalizeOptionalString(parsed.OPENVIKING_VLM_MODEL) ?? "gpt-4o-mini",
    embeddingModel:
      normalizeOptionalString(parsed.OPENVIKING_EMBEDDING_MODEL) ?? "text-embedding-3-large",
    embeddingDimension: parseInteger(parsed.OPENVIKING_EMBEDDING_DIMENSION, 3072),
    mode,
    hasModelCredentials: hasOpenAiConfig || hasArkConfig,
  };
}

export function buildOpenVikingAgentId(slug: string, env: OpenVikingEnvConfig): string {
  return `${env.agentIdPrefix}-${slug}`;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
