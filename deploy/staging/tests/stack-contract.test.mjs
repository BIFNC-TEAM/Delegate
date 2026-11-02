import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const stackPath = fileURLToPath(new URL("../stack.yml", import.meta.url));
const stack = readFileSync(stackPath, "utf8");
const logtoBlock = stack.match(/\n  logto:\n[\s\S]*?\n  temporal:\n/u)?.[0] ?? "";

test("Logto Admin ingress does not intercept application Authorization headers", () => {
  assert.doesNotMatch(
    logtoBlock,
    /delegate-login-admin-auth\.basicauth/u,
    "Gateway Basic Auth conflicts with Logto's OIDC Authorization headers.",
  );
  assert.doesNotMatch(
    logtoBlock,
    /delegate-login-admin-https\.middlewares:/u,
    "Logto Admin must rely on its own administrator authentication.",
  );
});

test("all public routers use the direct rag8.cn origins", () => {
  for (const host of [
    "home.rag8.cn",
    "dashboard.rag8.cn",
    "delegate.rag8.cn",
    "delegate-pay.rag8.cn",
    "delegate-api.rag8.cn",
    "login.rag8.cn",
    "login-admin.rag8.cn",
    "delegate-matrix.rag8.cn",
    "openviking.rag8.cn",
  ]) {
    assert.ok(stack.includes(`Host(\`${host}\`)`), `missing router for ${host}`);
  }
  assert.doesNotMatch(stack, /bonary\.xyz/u);
});

test("all public HTTPS routers use the mainland HTTP-01 resolver", () => {
  const httpsRouters = Array.from(
    stack.matchAll(/traefik\.http\.routers\.([^.]+-https)\.tls\.certresolver: ([^\n]+)/gu),
  );
  assert.ok(httpsRouters.length >= 9);
  for (const [, router, resolver] of httpsRouters) {
    assert.equal(resolver.trim(), "lehttp", `${router} must use lehttp`);
  }
});


test("Logto mounts the mainland SMS adapter from the immutable release directory", () => {
  assert.match(logtoBlock, /DELEGATE_LOGTO_CONNECTOR_ROOT.*@delegate-connector-tencent-sms-cn:ro/u);
  const deploy = readFileSync(new URL("../server-deploy.sh", import.meta.url), "utf8");
  assert.ok(deploy.includes('export DELEGATE_LOGTO_CONNECTOR_ROOT="$REPO_ROOT/deploy/logto/connectors/connector-tencent-sms-cn"'));
});

test("Logto mounts the real Delegate authentication experience from the immutable release", () => {
  assert.match(
    logtoBlock,
    /DELEGATE_AUTH_EXPERIENCE_ROOT.*\/etc\/logto\/packages\/experience\/dist:ro/u,
  );
  const deploy = readFileSync(new URL("../server-deploy.sh", import.meta.url), "utf8");
  assert.ok(
    deploy.includes(
      'export DELEGATE_AUTH_EXPERIENCE_ROOT="$REPO_ROOT/.runtime/auth-experience"',
    ),
  );
  assert.ok(deploy.includes("/app/apps/auth-experience/dist/. /output/"));
  assert.ok(deploy.includes('mode.mode !== "real"'));
  assert.ok(deploy.includes("mode.localWechatCallback !== null"));
});

test("staging applies private Tencent SMS settings with Node dotenv semantics", () => {
  const deploy = readFileSync(new URL("../server-deploy.sh", import.meta.url), "utf8");
  assert.ok(deploy.includes('sms_env="$STATE_ROOT/tencent-sms.env"'));
  assert.ok(deploy.includes("Tencent SMS environment must use mode 600"));
  assert.match(
    deploy,
    /--volume "\$sms_env:\/run\/secrets\/tencent-sms\.env:ro"/u,
  );
  assert.ok(
    deploy.includes(
      "node --env-file=/run/secrets/tencent-sms.env scripts/logto-phone-auth.mjs --apply",
    ),
  );
  assert.doesNotMatch(deploy, /--env-file "\$sms_env"/u);
});
