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
