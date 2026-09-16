import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  parseAuthApps,
  requiredAuthAppKeys,
  serializeAuthApps,
  validateAuthApps,
} from "../validate-auth-apps.mjs";
import { verifyLogtoManagement } from "../verify-logto-management.mjs";
import {
  migrateUriList,
  replaceKnownOrigin,
} from "../update-logto-origins.mjs";

const serverDeploy = readFileSync(
  fileURLToPath(new URL("../server-deploy.sh", import.meta.url)),
  "utf8",
);
const prepareEnv = readFileSync(
  fileURLToPath(new URL("../prepare-env.mjs", import.meta.url)),
  "utf8",
);
const appEnvBlock = prepareEnv.match(
  /const appEnv = \{[\s\S]*?writeEnv\(`\$\{values\.output\}\/app\.env`, appEnv\);/u,
)?.[0] ?? "";
const legacyPlannerRemovalMigration = readFileSync(
  fileURLToPath(new URL(
    "../../../prisma/migrations/20260910100000_remove_legacy_planner/migration.sql",
    import.meta.url,
  )),
  "utf8",
);

test("accepts a complete Logto application bootstrap without exposing values", () => {
  const source = requiredAuthAppKeys
    .map((key, index) => `${key}=value-${index}`)
    .join("\n");

  assert.doesNotThrow(() => validateAuthApps(source));
});

test("rejects quoted values that Docker Swarm would preserve literally", () => {
  const source = requiredAuthAppKeys
    .map((key, index) => `${key}=${JSON.stringify(`value-${index}`)}`)
    .join("\n");

  assert.throws(
    () => validateAuthApps(source),
    /Docker env_file values must be unquoted; quoted LOGTO_DASHBOARD_APP_ID/u,
  );
  const normalized = serializeAuthApps(parseAuthApps(source));
  assert.doesNotThrow(() => validateAuthApps(normalized));
  assert.doesNotMatch(normalized, /["']/u);
});

test("rejects the empty application credential file produced before bootstrap", () => {
  const source = requiredAuthAppKeys
    .map((key) => `${key}=""`)
    .join("\n");

  assert.throws(
    () => validateAuthApps(source),
    /Incomplete Logto application bootstrap; missing LOGTO_DASHBOARD_APP_ID/u,
  );
});

test("probes the M2M token and Management API without returning credentials", async () => {
  const calls = [];
  const result = await verifyLogtoManagement({
    endpoint: "https://login.example.test",
    authApps: {
      LOGTO_MANAGEMENT_APP_ID: "management-id",
      LOGTO_MANAGEMENT_APP_SECRET: "management-secret",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      if (url.pathname === "/oidc/token") {
        return new Response(JSON.stringify({ access_token: "probe-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(result, { tokenStatus: 200, usersStatus: 200 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, "Bearer probe-token");
});

test("deployment waits for the replacement task and Swarm update to finish", () => {
  assert.match(serverDeploy, /--filter desired-state=running/u);
  assert.match(serverDeploy, /current_state.*== Running\*/u);
  assert.match(serverDeploy, /update_state.*== "completed"/u);
});

test("staging advertises OpenViking model capability without copying its secret", () => {
  assert.match(prepareEnv, /const hasOpenVikingModelCredentials = Boolean/u);
  assert.match(prepareEnv, /openVikingProvider === "volcengine"/u);
  assert.match(appEnvBlock, /OPENVIKING_MODEL_CREDENTIALS_CONFIGURED:/u);
  assert.doesNotMatch(appEnvBlock, /OPENVIKING_MODEL_API_KEY:/u);
});

test("staging does not emit retired Agent planner configuration", () => {
  for (const key of [
    "DELEGATE_MODEL_PLANNER_PROVIDER",
    "DELEGATE_MODEL_PLANNER_MAX_OUTPUT_TOKENS",
    "TURN_PLANNER_V2_MODE",
    "TURN_PLAN_V3_MODE",
    "TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED",
    "PENDING_CLARIFICATION_MODE",
  ]) {
    assert.equal(prepareEnv.includes(key), false);
  }
});

test("staging payment collection is an explicit persistent source flag", () => {
  assert.match(
    prepareEnv,
    /sourceBoolean\(\s*"DELEGATE_WECHAT_PAY_COLLECTION_ENABLED",\s*"false"/u,
  );
  assert.match(
    prepareEnv,
    /sourceBoolean\(\s*"DELEGATE_WECHAT_PAY_PROCESSING_ENABLED",\s*"true"/u,
  );
  assert.match(
    prepareEnv,
    /DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: weChatCollectionEnabled/u,
  );
  assert.match(
    prepareEnv,
    /DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: weChatProcessingEnabled/u,
  );
  assert.match(
    prepareEnv,
    /DELEGATE_WECHAT_PAY_COLLECTION_ENABLED=true requires/u,
  );
});

test("production Logto callback origins migrate from bonary.xyz to rag8.cn", () => {
  assert.equal(
    replaceKnownOrigin("https://dashboard.bonary.xyz/auth/callback?flow=sign_in"),
    "https://dashboard.rag8.cn/auth/callback?flow=sign_in",
  );
  assert.equal(
    replaceKnownOrigin("https://delegate.bonary.xyz/reps/demo"),
    "https://delegate.rag8.cn/reps/demo",
  );
  assert.deepEqual(
    migrateUriList(
      [
        "https://dashboard.bonary.xyz/auth/callback",
        "https://dashboard.rag8.cn/auth/callback",
      ],
      ["https://dashboard.rag8.cn/auth/callback"],
    ),
    ["https://dashboard.rag8.cn/auth/callback"],
  );
});

test("staging emits the direct rag8.cn public origins", () => {
  for (const origin of [
    "https://home.rag8.cn",
    "https://dashboard.rag8.cn",
    "https://delegate.rag8.cn",
    "https://login.rag8.cn",
    "https://login-admin.rag8.cn",
    "https://delegate-pay.rag8.cn",
    "https://openviking.rag8.cn",
  ]) {
    assert.match(prepareEnv, new RegExp(origin.replaceAll(".", "\\."), "u"));
  }
});

test("staging fails fast unless production cloud sandbox routing is supplied", () => {
  assert.match(prepareEnv, /const sandboxProvider = sourceValue\("SANDBOX_PROVIDER"\)/u);
  assert.match(prepareEnv, /sandboxRoutingMode !== "manual_poc"/u);
  assert.match(prepareEnv, /SANDBOX_PROVIDER_ROUTING_JSON/u);
  assert.match(prepareEnv, /TENCENT_AGS_API_KEY/u);
  assert.match(prepareEnv, /DAYTONA_API_KEY/u);
  assert.doesNotMatch(prepareEnv, /SANDBOX_PROVIDER: "docker"/u);
});

test("legacy planner removal drains only inert drafts before enforcing guards", () => {
  assert.match(legacyPlannerRemovalMigration, /WITH cancelable_plans AS/u);
  assert.match(
    legacyPlannerRemovalMigration,
    /plan\."status" IN \('PROPOSED', 'VALIDATED'\)/u,
  );
  assert.match(
    legacyPlannerRemovalMigration,
    /action\."status" NOT IN \('PLANNED', 'CANCELED', 'SKIPPED', 'SUCCEEDED', 'FAILED'\)/u,
  );
  assert.match(
    legacyPlannerRemovalMigration,
    /execution\."status" IN \('QUEUED', 'RUNNING', 'BLOCKED'\)/u,
  );
  assert.match(
    legacyPlannerRemovalMigration,
    /workflow\."status" IN \('QUEUED', 'RUNNING'\)/u,
  );
  assert.match(
    legacyPlannerRemovalMigration,
    /legacy planner removal blocked: active ConversationTurnPlan rows remain/u,
  );
});
