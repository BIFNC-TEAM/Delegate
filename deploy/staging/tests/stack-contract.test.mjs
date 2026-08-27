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
