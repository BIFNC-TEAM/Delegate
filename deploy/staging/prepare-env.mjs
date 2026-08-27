#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
  },
});

if (!values.source || !values.output) {
  throw new Error("Usage: prepare-env.mjs --source /path/to/source.env --output /path/to/env");
}

const source = existsSync(values.source)
  ? parseEnv(readFileSync(values.source, "utf8"))
  : {};
const statePath = `${values.output}/state.env`;
const existingState = existsSync(statePath)
  ? parseEnv(readFileSync(statePath, "utf8"))
  : {};

mkdirSync(values.output, { recursive: true, mode: 0o700 });
chmodSync(values.output, 0o700);

const secret = (name, create) => existingState[name] || create();
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const base64 = (bytes = 32) => randomBytes(bytes).toString("base64");
const sourceValue = (name, fallback = "") => source[name]?.trim() || fallback;
const sourceBoolean = (name, fallback) => {
  const value = sourceValue(name, fallback);
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be exactly true or false.`);
  }
  return value;
};
const sourceSubset = (names) => Object.fromEntries(
  names
    .map((name) => [name, sourceValue(name)])
    .filter(([, value]) => value),
);
const openVikingProvider = sourceValue("OPENVIKING_PROVIDER", "openai");
const hasOpenVikingModelCredentials = Boolean(
  sourceValue("OPENVIKING_MODEL_API_KEY")
  || (openVikingProvider === "volcengine"
    ? sourceValue("ARK_API_KEY")
    : sourceValue("OPENAI_API_KEY")),
);

const state = {
  POSTGRES_PASSWORD: secret("POSTGRES_PASSWORD", () => base64(36)),
  LOGTO_DB_PASSWORD: secret("LOGTO_DB_PASSWORD", () => base64(36)),
  LOGTO_SECRET_VAULT_KEK: secret("LOGTO_SECRET_VAULT_KEK", () => base64(32)),
  DELEGATE_AUTH_SESSION_SECRET: secret("DELEGATE_AUTH_SESSION_SECRET", () => hex(48)),
  REP_PUBLIC_CHAT_SESSION_SECRET: secret("REP_PUBLIC_CHAT_SESSION_SECRET", () => hex(48)),
  PUBLIC_CHAT_RATE_LIMIT_SECRET: secret("PUBLIC_CHAT_RATE_LIMIT_SECRET", () => hex(48)),
  PUBLIC_MATERIAL_LINK_SECRET: secret("PUBLIC_MATERIAL_LINK_SECRET", () => hex(48)),
  COMPUTE_BROKER_INTERNAL_TOKEN: secret("COMPUTE_BROKER_INTERNAL_TOKEN", () => hex(48)),
  ARTIFACT_STORE_ACCESS_KEY: secret("ARTIFACT_STORE_ACCESS_KEY", () => `delegate${hex(6)}`),
  ARTIFACT_STORE_SECRET_KEY: secret("ARTIFACT_STORE_SECRET_KEY", () => base64(36)),
  KNOWLEDGE_OBJECT_STORE_ACCESS_KEY: secret("KNOWLEDGE_OBJECT_STORE_ACCESS_KEY", () => `knowledge${hex(6)}`),
  KNOWLEDGE_OBJECT_STORE_SECRET_KEY: secret("KNOWLEDGE_OBJECT_STORE_SECRET_KEY", () => base64(36)),
  OPENVIKING_ROOT_API_KEY: secret("OPENVIKING_ROOT_API_KEY", () => hex(48)),
  CHANNEL_CREDENTIAL_MASTER_KEY: secret("CHANNEL_CREDENTIAL_MASTER_KEY", () => base64(32)),
  PAYOUT_CREDENTIAL_MASTER_KEY: secret("PAYOUT_CREDENTIAL_MASTER_KEY", () => base64(32)),
  MATRIX_AS_TOKEN: secret("MATRIX_AS_TOKEN", () => hex(32)),
  MATRIX_AS_HS_TOKEN: secret("MATRIX_AS_HS_TOKEN", () => hex(32)),
  LOGIN_ADMIN_PASSWORD: secret("LOGIN_ADMIN_PASSWORD", () => base64(24).replaceAll("/", "A")),
  OPENVIKING_ADMIN_PASSWORD: secret("OPENVIKING_ADMIN_PASSWORD", () => base64(24).replaceAll("/", "V")),
};

writeEnv(statePath, state);

const databaseUrl = `postgresql://delegate:${encodeURIComponent(state.POSTGRES_PASSWORD)}@postgres:5432/delegate`;
const logtoDbUrl = `postgresql://logto:${encodeURIComponent(state.LOGTO_DB_PASSWORD)}@logto-postgres:5432/logto`;

const modelKeys = [
  "DELEGATE_MODEL_ENABLED",
  "DELEGATE_MODEL_PROVIDER",
  "DELEGATE_MODEL_FALLBACK_PROVIDER",
  "DELEGATE_MODEL_PLANNER_PROVIDER",
  "DELEGATE_MODEL_TIMEOUT_MS",
  "DELEGATE_MODEL_DOCUMENT_TIMEOUT_MS",
  "DELEGATE_MODEL_MAX_INPUT_TOKENS",
  "DELEGATE_MODEL_MAX_OUTPUT_TOKENS",
  "DELEGATE_MODEL_PLANNER_MAX_OUTPUT_TOKENS",
  "DELEGATE_MODEL_DOCUMENT_MAX_OUTPUT_TOKENS",
  "DELEGATE_MODEL_DOCUMENT_MAX_PARTS",
  "DELEGATE_MODEL_API_KEY",
  "DELEGATE_MODEL_API_BASE",
  "DELEGATE_AGICTO_MODEL",
  "DELEGATE_AGICTO_API_KEY",
  "DELEGATE_AGICTO_BASE_URL",
  "DELEGATE_AGICTO_INPUT_COST_USD_PER_1M_TOKENS",
  "DELEGATE_AGICTO_OUTPUT_COST_USD_PER_1M_TOKENS",
  "DELEGATE_BAILIAN_MODEL",
  "DELEGATE_BAILIAN_API_KEY",
  "DELEGATE_BAILIAN_BASE_URL",
  "DELEGATE_BAILIAN_INPUT_COST_USD_PER_1M_TOKENS",
  "DELEGATE_BAILIAN_OUTPUT_COST_USD_PER_1M_TOKENS",
  "DELEGATE_OPENAI_MODEL",
  "DELEGATE_OPENAI_INPUT_COST_USD_PER_1M_TOKENS",
  "DELEGATE_OPENAI_OUTPUT_COST_USD_PER_1M_TOKENS",
  "DELEGATE_ANTHROPIC_MODEL",
  "DELEGATE_ANTHROPIC_INPUT_COST_USD_PER_1M_TOKENS",
  "DELEGATE_ANTHROPIC_OUTPUT_COST_USD_PER_1M_TOKENS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ARK_API_KEY",
  "ARK_API_BASE",
];

const siteEnv = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SITE_URL: "https://www.bonary.xyz",
  NEXT_PUBLIC_DASHBOARD_URL: "https://dashboard.bonary.xyz",
  NEXT_PUBLIC_REPRESENTATIVE_URL: "https://delegate.bonary.xyz",
  NEXT_PUBLIC_ENABLE_PUBLIC_DEMOS: "false",
};
writeEnv(`${values.output}/site.env`, siteEnv);

const appEnv = {
  ...siteEnv,
  DATABASE_URL: databaseUrl,
  DELEGATE_DASHBOARD_AUTH_MODE: "required",
  DELEGATE_AUTH_SESSION_SECRET: state.DELEGATE_AUTH_SESSION_SECRET,
  REP_PUBLIC_CHAT_SESSION_SECRET: state.REP_PUBLIC_CHAT_SESSION_SECRET,
  PUBLIC_CHAT_RATE_LIMIT_SECRET: state.PUBLIC_CHAT_RATE_LIMIT_SECRET,
  PUBLIC_CHAT_CLIENT_IP_HEADER: "X-Forwarded-For",
  PUBLIC_CHAT_NETWORK_REQUESTS_PER_MINUTE: "30",
  PUBLIC_CHAT_AUDIENCE_REQUESTS_PER_MINUTE: "12",
  PUBLIC_CHAT_REPRESENTATIVE_REQUESTS_PER_DAY: "5000",
  PUBLIC_MATERIAL_LINK_SECRET: state.PUBLIC_MATERIAL_LINK_SECRET,
  LOGTO_ENDPOINT: "https://login.bonary.xyz",
  LOGTO_BACKCHANNEL_ENDPOINT: "http://logto:3001",
  LOGTO_SCOPES: "openid profile email phone",
  LOGTO_ACCOUNT_CENTER_URL: "",
  DELEGATE_CREATOR_ADMISSION_MODE: "self_service",
  DELEGATE_CREATOR_ADMISSION_PRINCIPALS: "",
  DELEGATE_AUTH_IDENTITY_ISSUER_MODE: "shadow",
  DELEGATE_ACCOUNT_SESSION_MODE: "shadow",
  DELEGATE_AUTH_DEV_LOGIN: "false",
  DELEGATE_LOCAL_AUTH_BOOTSTRAP: "false",
  DEMO_REP_SLUG: sourceValue("DEMO_REP_SLUG", "lin-founder-rep"),
  TELEGRAM_BOT_ID: sourceValue("TELEGRAM_BOT_ID"),
  TELEGRAM_BOT_USERNAME: sourceValue("TELEGRAM_BOT_USERNAME"),
  TELEGRAM_CONVERSATION_PLATFORM_MODE: "worker",
  TELEGRAM_STARS_LIVE_ENABLED: "false",
  TELEGRAM_REQUEST_TIMEOUT_MS: sourceValue("TELEGRAM_REQUEST_TIMEOUT_MS", "15000"),
  CONVERSATION_OUTBOX_PROCESSING_LEASE_MS: "300000",
  COMPUTE_BROKER_URL: "http://compute-broker:4010",
  COMPUTE_BROKER_INTERNAL_TOKEN: state.COMPUTE_BROKER_INTERNAL_TOKEN,
  WORKFLOW_RUNNER_PORT: "4020",
  WORKFLOW_RUNNER_POLL_MS: "5000",
  WORKFLOW_RUNNER_BATCH_SIZE: "10",
  WORKFLOW_RUNNER_READINESS_STALE_MS: "180000",
  WORKFLOW_APPROVAL_TIMEOUT_MINUTES: "30",
  WORKFLOW_ENGINE: "temporal",
  WORKFLOW_TEMPORAL_ADDRESS: "temporal:7233",
  WORKFLOW_TEMPORAL_NAMESPACE: "delegate",
  WORKFLOW_TEMPORAL_TASK_QUEUE: "delegate-public-runtime",
  CONVERSATION_WORKER_PORT: "4040",
  CONVERSATION_WORKER_POLL_MS: "500",
  TURN_PLANNER_V2_MODE: "active_low_risk",
  TURN_PLAN_V3_MODE: "shadow",
  TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED: "false",
  MATRIX_BRIDGE_PORT: "4030",
  MATRIX_HOMESERVER_URL: "http://synapse:8008",
  MATRIX_SERVER_NAME: "matrix.bonary.xyz",
  MATRIX_AS_CONNECTION_ID: "delegate-matrix-as",
  ARTIFACT_STORE_ENDPOINT: "http://artifact-store:9000",
  ARTIFACT_STORE_BUCKET: "delegate-compute-artifacts",
  ARTIFACT_STORE_ACCESS_KEY: state.ARTIFACT_STORE_ACCESS_KEY,
  ARTIFACT_STORE_SECRET_KEY: state.ARTIFACT_STORE_SECRET_KEY,
  ARTIFACT_STORE_REGION: "us-east-1",
  KNOWLEDGE_OBJECT_STORE_ENDPOINT: "http://artifact-store:9000",
  KNOWLEDGE_OBJECT_STORE_BUCKET: "delegate-knowledge",
  KNOWLEDGE_OBJECT_STORE_ACCESS_KEY: state.ARTIFACT_STORE_ACCESS_KEY,
  KNOWLEDGE_OBJECT_STORE_SECRET_KEY: state.ARTIFACT_STORE_SECRET_KEY,
  KNOWLEDGE_OBJECT_STORE_REGION: "us-east-1",
  KNOWLEDGE_OBJECT_STORE_FORCE_PATH_STYLE: "true",
  OPENVIKING_ENABLED: "true",
  OPENVIKING_BASE_URL: "http://openviking:1933",
  OPENVIKING_INTERNAL_BASE_URL: "http://openviking:1933",
  OPENVIKING_API_KEY: state.OPENVIKING_ROOT_API_KEY,
  OPENVIKING_ROOT_API_KEY: state.OPENVIKING_ROOT_API_KEY,
  OPENVIKING_TIMEOUT_MS: "8000",
  OPENVIKING_CONSOLE_URL: "https://openviking.bonary.xyz/studio",
  OPENVIKING_AGENT_ID_PREFIX: "delegate-rep",
  OPENVIKING_RESOURCE_SYNC_ENABLED: "true",
  OPENVIKING_AUTO_RECALL_DEFAULT: "true",
  OPENVIKING_AUTO_CAPTURE_DEFAULT: "false",
  OPENVIKING_PROVIDER: openVikingProvider,
  OPENVIKING_VLM_MODEL: sourceValue("OPENVIKING_VLM_MODEL", "gpt-4o-mini"),
  OPENVIKING_EMBEDDING_MODEL: sourceValue(
    "OPENVIKING_EMBEDDING_MODEL",
    "text-embedding-3-large",
  ),
  OPENVIKING_EMBEDDING_DIMENSION: sourceValue("OPENVIKING_EMBEDDING_DIMENSION", "3072"),
  OPENVIKING_MODEL_CREDENTIALS_CONFIGURED: hasOpenVikingModelCredentials ? "true" : "false",
  ...sourceSubset(modelKeys),
};
writeEnv(`${values.output}/app.env`, appEnv);

writeEnv(`${values.output}/postgres.env`, {
  POSTGRES_DB: "delegate",
  POSTGRES_USER: "delegate",
  POSTGRES_PASSWORD: state.POSTGRES_PASSWORD,
  PGPASSWORD: state.POSTGRES_PASSWORD,
});

writeEnv(`${values.output}/artifact-store.env`, {
  MINIO_ROOT_USER: state.ARTIFACT_STORE_ACCESS_KEY,
  MINIO_ROOT_PASSWORD: state.ARTIFACT_STORE_SECRET_KEY,
  ARTIFACT_STORE_ACCESS_KEY: state.ARTIFACT_STORE_ACCESS_KEY,
  ARTIFACT_STORE_SECRET_KEY: state.ARTIFACT_STORE_SECRET_KEY,
});

const weChatKeys = [
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_MERCHANT_ID",
  "WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL_NUMBER",
  "WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_PUBLIC_KEY_ID",
  "WECHAT_PAY_PUBLIC_KEY_BASE64",
  "WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER",
  "WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64",
  "WECHAT_PAY_VERIFICATION_KEYS_JSON",
];
const weChatCollectionEnabled = sourceBoolean(
  "DELEGATE_WECHAT_PAY_COLLECTION_ENABLED",
  "false",
);
const weChatProcessingEnabled = sourceBoolean(
  "DELEGATE_WECHAT_PAY_PROCESSING_ENABLED",
  "true",
);
if (weChatCollectionEnabled === "true" && weChatProcessingEnabled !== "true") {
  throw new Error(
    "DELEGATE_WECHAT_PAY_COLLECTION_ENABLED=true requires "
    + "DELEGATE_WECHAT_PAY_PROCESSING_ENABLED=true.",
  );
}
const paymentEnv = {
  DELEGATE_WECHAT_PAY_ENABLED: "false",
  DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: weChatCollectionEnabled,
  DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: weChatProcessingEnabled,
  WECHAT_PAY_NOTIFY_URL: "https://pay.bonary.xyz/api/payments/wechat/notify",
  WECHAT_PAY_REFUND_NOTIFY_URL: "https://pay.bonary.xyz/api/payments/wechat/refund-notify",
  ...sourceSubset(weChatKeys),
};

writeEnv(`${values.output}/dashboard.env`, {
  ...paymentEnv,
  CHANNEL_CREDENTIAL_MASTER_KEY: state.CHANNEL_CREDENTIAL_MASTER_KEY,
  CHANNEL_CREDENTIAL_MASTER_KEY_VERSION: "staging-v1",
  PAYOUT_CREDENTIAL_MASTER_KEY: state.PAYOUT_CREDENTIAL_MASTER_KEY,
  PAYOUT_CREDENTIAL_MASTER_KEY_VERSION: "staging-v1",
});

writeEnv(`${values.output}/reps.env`, paymentEnv);

writeEnv(`${values.output}/workflow.env`, {
  ...paymentEnv,
  WECHAT_PAY_RECONCILIATION_POLL_MS: "5000",
  WECHAT_PAY_RECONCILIATION_BATCH_SIZE: "10",
  WECHAT_PAY_RECONCILIATION_LEASE_MS: "75000",
  WECHAT_PAY_RECONCILIATION_PENDING_BACKOFF_MS: "10000",
  WECHAT_PAY_RECONCILIATION_ERROR_BACKOFF_MS: "5000",
  WECHAT_PAY_RECONCILIATION_MAX_BACKOFF_MS: "600000",
  LOGTO_MANAGEMENT_API_RESOURCE: "https://default.logto.app/api",
  LOGTO_RECONCILIATION_POLL_MS: "900000",
});

writeEnv(`${values.output}/bot.env`, {
  CHANNEL_CREDENTIAL_MASTER_KEY: state.CHANNEL_CREDENTIAL_MASTER_KEY,
  CHANNEL_CREDENTIAL_MASTER_KEY_VERSION: "staging-v1",
  TELEGRAM_BOT_TOKEN: sourceValue("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_BOT_ID: sourceValue("TELEGRAM_BOT_ID"),
  TELEGRAM_BOT_USERNAME: sourceValue("TELEGRAM_BOT_USERNAME"),
  TELEGRAM_WEBHOOK_SECRET: sourceValue("TELEGRAM_WEBHOOK_SECRET"),
  TELEGRAM_WEB_RECHARGE_BASE_URL: "https://delegate.bonary.xyz",
  TELEGRAM_RUNTIME_RECONCILE_MS: "5000",
  TELEGRAM_RUNTIME_LEASE_MS: "120000",
  TELEGRAM_RUNTIME_LEASE_RENEW_MS: "20000",
  TELEGRAM_RUNTIME_LEASE_DB_TIMEOUT_MS: "10000",
});

const computeKeys = [
  "COMPUTE_NATIVE_OPENAI_ENABLED",
  "COMPUTE_NATIVE_OPENAI_BASE_URL",
  "COMPUTE_NATIVE_OPENAI_MODEL",
  "COMPUTE_NATIVE_ANTHROPIC_ENABLED",
  "COMPUTE_NATIVE_ANTHROPIC_BASE_URL",
  "COMPUTE_NATIVE_ANTHROPIC_MODEL",
  "COMPUTE_NATIVE_OPENCODE_ENABLED",
  "COMPUTE_NATIVE_OPENCODE_COMMAND",
  "COMPUTE_NATIVE_OPENCODE_MODEL",
  "COMPUTE_MCP_TIMEOUT_MS",
  "COMPUTE_MCP_CATALOG_REFRESH_INTERVAL_MS",
];
writeEnv(`${values.output}/compute.env`, {
  PORT: "4010",
  COMPUTE_BROKER_INTERNAL_TOKEN: state.COMPUTE_BROKER_INTERNAL_TOKEN,
  COMPUTE_RUNNER_TYPE: "docker",
  SANDBOX_PROVIDER: "docker",
  COMPUTE_RUNNER_IMAGE: "debian:bookworm-slim",
  COMPUTE_BROWSER_IMAGE: "mcr.microsoft.com/playwright:v1.58.2-noble",
  COMPUTE_BROWSER_PLAYWRIGHT_VERSION: "1.58.2",
  COMPUTE_BROWSER_MAX_COMMAND_SECONDS: "120",
  COMPUTE_HOST_WORKSPACE_ROOT: "/home/ubuntu/delegate/workspaces",
  SANDBOX_IDLE_STOP_MINUTES: "15",
  SANDBOX_CLEANUP_INTERVAL_MS: "60000",
  SANDBOX_AUTO_ARCHIVE_MINUTES: "10080",
  SANDBOX_AUTO_DELETE_MINUTES: "-1",
  ARTIFACT_STORE_ENDPOINT: "http://artifact-store:9000",
  ARTIFACT_STORE_BUCKET: "delegate-compute-artifacts",
  ARTIFACT_STORE_ACCESS_KEY: state.ARTIFACT_STORE_ACCESS_KEY,
  ARTIFACT_STORE_SECRET_KEY: state.ARTIFACT_STORE_SECRET_KEY,
  ARTIFACT_STORE_REGION: "us-east-1",
  ...sourceSubset(computeKeys),
});

const openVikingKeys = [
  "OPENVIKING_PROVIDER",
  "OPENVIKING_VLM_MODEL",
  "OPENVIKING_EMBEDDING_MODEL",
  "OPENVIKING_EMBEDDING_DIMENSION",
  "OPENVIKING_MODEL_API_KEY",
  "OPENVIKING_MODEL_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ARK_API_KEY",
  "ARK_API_BASE",
];
writeEnv(`${values.output}/openviking.env`, {
  OPENVIKING_CONFIG_FILE: "/etc/openviking/ov.conf",
  OPENVIKING_ROOT_API_KEY: state.OPENVIKING_ROOT_API_KEY,
  ...sourceSubset(openVikingKeys),
});

writeEnv(`${values.output}/logto-postgres.env`, {
  POSTGRES_DB: "logto",
  POSTGRES_USER: "logto",
  POSTGRES_PASSWORD: state.LOGTO_DB_PASSWORD,
  PGPASSWORD: state.LOGTO_DB_PASSWORD,
});

writeEnv(`${values.output}/logto.env`, {
  NODE_ENV: "production",
  DB_URL: logtoDbUrl,
  DATABASE_STATEMENT_TIMEOUT: "30000",
  ENDPOINT: "https://login.bonary.xyz",
  ADMIN_ENDPOINT: "https://login-admin.bonary.xyz",
  TRUST_PROXY_HEADER: "1",
  SECRET_VAULT_KEK: state.LOGTO_SECRET_VAULT_KEK,
  PRIVATE_KEY_ROTATION_GRACE_PERIOD: "0",
});

writeEnv(`${values.output}/temporal.env`, {
  DB: "postgres12",
  DB_PORT: "5432",
  POSTGRES_USER: "delegate",
  POSTGRES_PWD: state.POSTGRES_PASSWORD,
  POSTGRES_SEEDS: "postgres",
  POSTGRES_DB: "delegate_temporal",
});

writeEnv(`${values.output}/matrix.env`, {
  MATRIX_HOMESERVER_URL: "http://synapse:8008",
  MATRIX_SERVER_NAME: "matrix.bonary.xyz",
  MATRIX_AS_CONNECTION_ID: "delegate-matrix-as",
  MATRIX_AS_TOKEN: state.MATRIX_AS_TOKEN,
  MATRIX_AS_HS_TOKEN: state.MATRIX_AS_HS_TOKEN,
  MATRIX_BRIDGE_MAX_BODY_BYTES: "2097152",
});

const authAppsPath = `${values.output}/auth-apps.env`;
const existingAuthApps = existsSync(authAppsPath)
  ? parseEnv(readFileSync(authAppsPath, "utf8"))
  : {};
writeEnv(authAppsPath, {
  LOGTO_DASHBOARD_APP_ID: "",
  LOGTO_DASHBOARD_APP_SECRET: "",
  LOGTO_REPS_APP_ID: "",
  LOGTO_REPS_APP_SECRET: "",
  LOGTO_WEBHOOK_SIGNING_KEY: "",
  LOGTO_MANAGEMENT_APP_ID: "",
  LOGTO_MANAGEMENT_APP_SECRET: "",
  ...existingAuthApps,
});

writeEnv(`${values.output}/routing.env`, {
  LOGIN_ADMIN_BASIC_AUTH: `delegate-admin:${sha1Password(state.LOGIN_ADMIN_PASSWORD)}`,
  OPENVIKING_BASIC_AUTH: `delegate-openviking:${sha1Password(state.OPENVIKING_ADMIN_PASSWORD)}`,
});

writeEnv(`${values.output}/operator-access.env`, {
  LOGIN_ADMIN_USERNAME: "delegate-admin",
  LOGIN_ADMIN_PASSWORD: state.LOGIN_ADMIN_PASSWORD,
  OPENVIKING_ADMIN_USERNAME: "delegate-openviking",
  OPENVIKING_ADMIN_PASSWORD: state.OPENVIKING_ADMIN_PASSWORD,
});

console.log(`Prepared staging environment files in ${values.output}.`);
console.log("Secrets were written with mode 0600 and were not printed.");

function sha1Password(password) {
  return `{SHA}${createHash("sha1").update(password).digest("base64")}`;
}

function writeEnv(path, values) {
  const body = `${Object.entries(values)
    .map(([name, value]) => `${name}=${encodeEnvValue(value)}`)
    .join("\n")}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function encodeEnvValue(value) {
  const normalized = String(value ?? "");
  if (/[\r\n\0]/.test(normalized)) {
    throw new Error("Staging environment values must be single-line strings.");
  }
  return normalized;
}
