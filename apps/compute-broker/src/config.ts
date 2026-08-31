import { artifactStoreConfigSchema } from "@delegate/artifacts";
import { z } from "zod";

import { parseSandboxRoutingConfig } from "./sandbox-routing";

const blankEnvValueToUndefined = (value: unknown) =>
  typeof value === "string" && !value.trim() ? undefined : value;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4010),
  COMPUTE_BROKER_INTERNAL_TOKEN: z.string().min(1),
  COMPUTE_RUNNER_TYPE: z.enum(["docker", "vm"]).default("docker"),
  SANDBOX_PROVIDER: z.enum(["docker", "daytona", "tencent"]).default("docker"),
  SANDBOX_ROUTING_MODE: z.enum(["legacy", "manual_poc"]).default("legacy"),
  SANDBOX_PROVIDER_ROUTING_JSON: z.string().optional(),
  COMPUTE_RUNNER_IMAGE: z.string().min(1).default("debian:bookworm-slim"),
  COMPUTE_BROWSER_IMAGE: z.string().min(1).default("mcr.microsoft.com/playwright:v1.58.2-noble"),
  COMPUTE_BROWSER_PLAYWRIGHT_VERSION: z.string().min(1).default("1.58.2"),
  COMPUTE_BROWSER_MAX_COMMAND_SECONDS: z.coerce.number().int().positive().default(120),
  COMPUTE_BROWSER_COST_CENTS_PER_MINUTE: z.coerce.number().int().nonnegative().default(3),
  COMPUTE_NATIVE_OPENAI_ENABLED: z.string().optional(),
  COMPUTE_NATIVE_OPENAI_BASE_URL: z.string().url().optional(),
  COMPUTE_NATIVE_OPENAI_MODEL: z.string().optional(),
  COMPUTE_NATIVE_OPENAI_COST_CENTS_PER_STEP: z.coerce.number().int().nonnegative().default(6),
  COMPUTE_NATIVE_ANTHROPIC_ENABLED: z.string().optional(),
  COMPUTE_NATIVE_ANTHROPIC_BASE_URL: z.string().url().optional(),
  COMPUTE_NATIVE_ANTHROPIC_MODEL: z.string().optional(),
  COMPUTE_NATIVE_ANTHROPIC_COST_CENTS_PER_STEP: z.coerce.number().int().nonnegative().default(8),
  COMPUTE_NATIVE_OPENCODE_ENABLED: z.string().optional(),
  COMPUTE_NATIVE_OPENCODE_COMMAND: z.string().min(1).default("opencode"),
  COMPUTE_NATIVE_OPENCODE_MODEL: z.string().optional(),
  COMPUTE_NATIVE_OPENCODE_COST_CENTS_PER_STEP: z.coerce.number().int().nonnegative().default(6),
  COMPUTE_NATIVE_MAX_STEPS: z.coerce.number().int().positive().max(8).default(3),
  COMPUTE_NATIVE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),
  COMPUTE_MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  COMPUTE_MCP_CATALOG_REFRESH_INTERVAL_MS: z.coerce.number().int().min(5_000)
    .default(120_000),
  COMPUTE_MCP_DEFAULT_COST_CENTS_PER_CALL: z.coerce.number().int().nonnegative().default(4),
  COMPUTE_MCP_MAX_REQUEST_BYTES: z.coerce.number().int().positive().max(1024 * 1024)
    .default(256 * 1024),
  COMPUTE_MCP_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().max(16 * 1024 * 1024)
    .default(4 * 1024 * 1024),
  COMPUTE_MCP_MAX_TOOL_LIST_BYTES: z.coerce.number().int().positive().max(4 * 1024 * 1024)
    .default(1024 * 1024),
  COMPUTE_MCP_MAX_TOOL_COUNT: z.coerce.number().int().positive().max(2000).default(500),
  COMPUTE_MCP_MAX_JSON_DEPTH: z.coerce.number().int().positive().max(64).default(32),
  COMPUTE_MCP_MAX_JSON_NODES: z.coerce.number().int().positive().max(200_000).default(50_000),
  COMPUTE_HOST_WORKSPACE_ROOT: z.preprocess(
    (value) => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().min(1).default(process.cwd()),
  ),
  SANDBOX_IDLE_STOP_MINUTES: z.coerce.number().int().positive().default(15),
  SANDBOX_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SANDBOX_AUTO_ARCHIVE_MINUTES: z.coerce.number().int().default(7 * 24 * 60),
  SANDBOX_AUTO_DELETE_MINUTES: z.coerce.number().int().default(-1),
  SANDBOX_MAX_STDOUT_BYTES: z.coerce.number().int().positive().max(16 * 1024 * 1024)
    .default(1024 * 1024),
  SANDBOX_MAX_STDERR_BYTES: z.coerce.number().int().positive().max(16 * 1024 * 1024)
    .default(1024 * 1024),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_API_URL: z.preprocess(blankEnvValueToUndefined, z.string().url().optional()),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_SANDBOX_CPU: z.preprocess(
    blankEnvValueToUndefined,
    z.coerce.number().positive().optional(),
  ),
  DAYTONA_SANDBOX_MEMORY_GIB: z.preprocess(
    blankEnvValueToUndefined,
    z.coerce.number().positive().optional(),
  ),
  DAYTONA_SANDBOX_DISK_GIB: z.preprocess(
    blankEnvValueToUndefined,
    z.coerce.number().positive().optional(),
  ),
  TENCENT_AGS_API_KEY: z.string().optional(),
  TENCENT_AGS_DOMAIN: z.string().optional(),
  TENCENT_AGS_REGION: z.string().optional(),
  TENCENT_AGS_CODE_TOOL: z.string().optional(),
  ARTIFACT_STORE_ENDPOINT: z.string().url().default("http://artifact-store:9000"),
  ARTIFACT_STORE_BUCKET: z.string().min(1).default("delegate-compute-artifacts"),
  ARTIFACT_STORE_ACCESS_KEY: z.string().min(1).default("delegate"),
  ARTIFACT_STORE_SECRET_KEY: z.string().min(1).default("delegate-secret-key"),
  ARTIFACT_STORE_REGION: z.string().min(1).default("us-east-1"),
});

const parsed = envSchema.parse(process.env);
const daytonaResources = buildDaytonaResources(parsed);
const sandboxRouting = parseSandboxRoutingConfig({
  mode: parsed.SANDBOX_ROUTING_MODE,
  rawDocument: parsed.SANDBOX_PROVIDER_ROUTING_JSON,
  nodeEnv: parsed.NODE_ENV,
});
validateManualProviderCredentials(parsed, sandboxRouting);

export const computeBrokerConfig = {
  port: parsed.PORT,
  internalToken: parsed.COMPUTE_BROKER_INTERNAL_TOKEN,
  runnerType: parsed.COMPUTE_RUNNER_TYPE,
  sandboxProvider: parsed.SANDBOX_PROVIDER,
  sandboxRoutingMode: parsed.SANDBOX_ROUTING_MODE,
  sandboxRouting,
  runnerImage: parsed.COMPUTE_RUNNER_IMAGE,
  browserImage: parsed.COMPUTE_BROWSER_IMAGE,
  browserPlaywrightVersion: parsed.COMPUTE_BROWSER_PLAYWRIGHT_VERSION,
  browserMaxCommandSeconds: parsed.COMPUTE_BROWSER_MAX_COMMAND_SECONDS,
  browserCostCentsPerMinute: parsed.COMPUTE_BROWSER_COST_CENTS_PER_MINUTE,
  nativeComputerUse: {
    maxSteps: parsed.COMPUTE_NATIVE_MAX_STEPS,
    maxOutputTokens: parsed.COMPUTE_NATIVE_MAX_OUTPUT_TOKENS,
    openai: {
      enabled: parseBoolean(parsed.COMPUTE_NATIVE_OPENAI_ENABLED, true),
      ...(normalizeOptionalString(parsed.COMPUTE_NATIVE_OPENAI_BASE_URL)
        ? { baseUrl: normalizeOptionalString(parsed.COMPUTE_NATIVE_OPENAI_BASE_URL) }
        : {}),
      ...(normalizeOptionalString(parsed.COMPUTE_NATIVE_OPENAI_MODEL)
        ? { model: normalizeOptionalString(parsed.COMPUTE_NATIVE_OPENAI_MODEL) }
        : {}),
      costCentsPerStep: parsed.COMPUTE_NATIVE_OPENAI_COST_CENTS_PER_STEP,
    },
    anthropic: {
      enabled: parseBoolean(parsed.COMPUTE_NATIVE_ANTHROPIC_ENABLED, true),
      ...(normalizeOptionalString(parsed.COMPUTE_NATIVE_ANTHROPIC_BASE_URL)
        ? { baseUrl: normalizeOptionalString(parsed.COMPUTE_NATIVE_ANTHROPIC_BASE_URL) }
        : {}),
      ...(normalizeOptionalString(parsed.COMPUTE_NATIVE_ANTHROPIC_MODEL)
        ? { model: normalizeOptionalString(parsed.COMPUTE_NATIVE_ANTHROPIC_MODEL) }
        : {}),
      costCentsPerStep: parsed.COMPUTE_NATIVE_ANTHROPIC_COST_CENTS_PER_STEP,
    },
    opencode: {
      enabled: parseBoolean(parsed.COMPUTE_NATIVE_OPENCODE_ENABLED, false),
      command: parsed.COMPUTE_NATIVE_OPENCODE_COMMAND,
      ...(normalizeOptionalString(parsed.COMPUTE_NATIVE_OPENCODE_MODEL)
        ? { model: normalizeOptionalString(parsed.COMPUTE_NATIVE_OPENCODE_MODEL) }
        : {}),
      costCentsPerStep: parsed.COMPUTE_NATIVE_OPENCODE_COST_CENTS_PER_STEP,
    },
  },
  mcpTimeoutMs: parsed.COMPUTE_MCP_TIMEOUT_MS,
  mcpCatalogRefreshIntervalMs: parsed.COMPUTE_MCP_CATALOG_REFRESH_INTERVAL_MS,
  mcpDefaultCostCentsPerCall: parsed.COMPUTE_MCP_DEFAULT_COST_CENTS_PER_CALL,
  mcpPayloadLimits: {
    maxRequestBytes: parsed.COMPUTE_MCP_MAX_REQUEST_BYTES,
    maxResponseBytes: parsed.COMPUTE_MCP_MAX_RESPONSE_BYTES,
    maxToolListBytes: parsed.COMPUTE_MCP_MAX_TOOL_LIST_BYTES,
    maxToolCount: parsed.COMPUTE_MCP_MAX_TOOL_COUNT,
    maxJsonDepth: parsed.COMPUTE_MCP_MAX_JSON_DEPTH,
    maxJsonNodes: parsed.COMPUTE_MCP_MAX_JSON_NODES,
  },
  hostWorkspaceRoot: parsed.COMPUTE_HOST_WORKSPACE_ROOT,
  sandboxLifecycle: {
    idleStopMinutes: parsed.SANDBOX_IDLE_STOP_MINUTES,
    cleanupIntervalMs: parsed.SANDBOX_CLEANUP_INTERVAL_MS,
    autoArchiveMinutes: parsed.SANDBOX_AUTO_ARCHIVE_MINUTES,
    autoDeleteMinutes: parsed.SANDBOX_AUTO_DELETE_MINUTES,
  },
  sandboxOutputLimits: {
    maxStdoutBytes: parsed.SANDBOX_MAX_STDOUT_BYTES,
    maxStderrBytes: parsed.SANDBOX_MAX_STDERR_BYTES,
  },
  daytona: {
    ...(normalizeOptionalString(parsed.DAYTONA_API_KEY)
      ? { apiKey: normalizeOptionalString(parsed.DAYTONA_API_KEY) }
      : {}),
    ...(normalizeOptionalString(parsed.DAYTONA_API_URL)
      ? { apiUrl: normalizeOptionalString(parsed.DAYTONA_API_URL) }
      : {}),
    ...(normalizeOptionalString(parsed.DAYTONA_TARGET)
      ? { target: normalizeOptionalString(parsed.DAYTONA_TARGET) }
      : {}),
    ...(daytonaResources ? { resources: daytonaResources } : {}),
  },
  tencent: {
    ...(normalizeOptionalString(parsed.TENCENT_AGS_API_KEY)
      ? { apiKey: normalizeOptionalString(parsed.TENCENT_AGS_API_KEY) }
      : {}),
    ...(resolveTencentDomain(parsed)
      ? { domain: resolveTencentDomain(parsed) }
      : {}),
    ...(normalizeOptionalString(parsed.TENCENT_AGS_CODE_TOOL)
      ? { codeTool: normalizeOptionalString(parsed.TENCENT_AGS_CODE_TOOL) }
      : {}),
  },
  artifactStore: artifactStoreConfigSchema.parse({
    endpoint: parsed.ARTIFACT_STORE_ENDPOINT,
    bucket: parsed.ARTIFACT_STORE_BUCKET,
    accessKeyId: parsed.ARTIFACT_STORE_ACCESS_KEY,
    secretAccessKey: parsed.ARTIFACT_STORE_SECRET_KEY,
    region: parsed.ARTIFACT_STORE_REGION,
    forcePathStyle: true,
  }),
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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

function buildDaytonaResources(parsedEnv: z.infer<typeof envSchema>) {
  const resources = {
    ...(typeof parsedEnv.DAYTONA_SANDBOX_CPU === "number" ? { cpu: parsedEnv.DAYTONA_SANDBOX_CPU } : {}),
    ...(typeof parsedEnv.DAYTONA_SANDBOX_MEMORY_GIB === "number"
      ? { memory: parsedEnv.DAYTONA_SANDBOX_MEMORY_GIB }
      : {}),
    ...(typeof parsedEnv.DAYTONA_SANDBOX_DISK_GIB === "number" ? { disk: parsedEnv.DAYTONA_SANDBOX_DISK_GIB } : {}),
  };

  return Object.keys(resources).length ? resources : undefined;
}

function resolveTencentDomain(parsedEnv: z.infer<typeof envSchema>) {
  const explicitDomain = normalizeOptionalString(parsedEnv.TENCENT_AGS_DOMAIN);
  if (explicitDomain) return explicitDomain.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  const region = normalizeOptionalString(parsedEnv.TENCENT_AGS_REGION);
  return region ? `${region}.tencentags.com` : undefined;
}

function validateManualProviderCredentials(
  parsedEnv: z.infer<typeof envSchema>,
  routing: ReturnType<typeof parseSandboxRoutingConfig>,
) {
  if (!routing) return;
  if (
    routing.document.newIdentityEnabled.daytona &&
    !normalizeOptionalString(parsedEnv.DAYTONA_API_KEY)
  ) {
    throw new Error("sandbox_daytona_credentials_required");
  }
  if (
    routing.document.newIdentityEnabled.tencent &&
    (!normalizeOptionalString(parsedEnv.TENCENT_AGS_API_KEY) ||
      !resolveTencentDomain(parsedEnv) ||
      !normalizeOptionalString(parsedEnv.TENCENT_AGS_CODE_TOOL))
  ) {
    throw new Error("sandbox_tencent_configuration_required");
  }
}
