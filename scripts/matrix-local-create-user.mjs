#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const localInstance = resolveLocalInstance(process.env.MATRIX_LOCAL_INSTANCE);
const localStateDirectory =
  localInstance === "e2e" ? "matrix-e2e" : "matrix";
const localEnv = await readLocalEnv(
  path.join(repoRoot, ".local", localStateDirectory, "matrix.env"),
);
const config = {
  ...process.env,
  ...localEnv,
  ...(process.env.MATRIX_LOCAL_USER_USERNAME
    ? { MATRIX_LOCAL_USER_USERNAME: process.env.MATRIX_LOCAL_USER_USERNAME }
    : {}),
  ...(process.env.MATRIX_LOCAL_USER_PASSWORD
    ? { MATRIX_LOCAL_USER_PASSWORD: process.env.MATRIX_LOCAL_USER_PASSWORD }
    : {}),
};

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/matrix-local-create-user.mjs [username] [--admin]\n"
    + "Set MATRIX_LOCAL_USER_PASSWORD to override the generated password. "
    + "Passwords are intentionally not accepted as command-line arguments.",
  );
  process.exit(0);
}

const cliArguments = process.argv.slice(2);
const unknownOptions = cliArguments.filter(
  (value) => value.startsWith("--") && value !== "--admin",
);
if (unknownOptions.length > 0) {
  throw new Error(`Unknown option: ${unknownOptions[0]}`);
}
const positionalArguments = cliArguments.filter(
  (value) => !value.startsWith("--"),
);
if (positionalArguments.length > 1) {
  throw new Error(
    "Passwords must not be passed on the command line. "
    + "Set MATRIX_LOCAL_USER_PASSWORD in the process environment.",
  );
}
const username =
  positionalArguments[0]
  ?? config.MATRIX_LOCAL_USER_USERNAME
  ?? config.MATRIX_LOCAL_TEST_USERNAME
  ?? "delegate_test";
const password =
  config.MATRIX_LOCAL_USER_PASSWORD
  ?? config.MATRIX_LOCAL_TEST_PASSWORD;
const admin = process.argv.includes("--admin");
const homeserverUrl =
  config.MATRIX_LOCAL_HOMESERVER_URL
  ?? "http://127.0.0.1:8008";
const registrationSecretBase64 =
  config.MATRIX_LOCAL_REGISTRATION_SHARED_SECRET_BASE64;
const registrationSecret =
  registrationSecretBase64
  && /^[A-Za-z0-9+/]+={0,2}$/.test(registrationSecretBase64)
    ? Buffer.from(registrationSecretBase64, "base64")
    : undefined;

if (!/^[a-z0-9._=-]+$/i.test(username)) {
  throw new Error(`Invalid Matrix localpart: ${username}`);
}
if (typeof password !== "string" || !password || password.length > 1024) {
  throw new Error(
    "No password was provided and MATRIX_LOCAL_TEST_PASSWORD is missing.",
  );
}
if (!registrationSecret || registrationSecret.length === 0) {
  throw new Error(
    "Run `pnpm matrix:local:init` before creating a local Matrix user.",
  );
}
const parsedHomeserverUrl = new URL(homeserverUrl);
if (
  parsedHomeserverUrl.protocol !== "http:"
  || !["127.0.0.1", "localhost", "[::1]"].includes(
    parsedHomeserverUrl.hostname,
  )
  || parsedHomeserverUrl.username
  || parsedHomeserverUrl.password
  || (parsedHomeserverUrl.pathname !== "/" && parsedHomeserverUrl.pathname !== "")
  || parsedHomeserverUrl.search
  || parsedHomeserverUrl.hash
) {
  throw new Error(
    "MATRIX_LOCAL_HOMESERVER_URL must be an uncredentialed local HTTP origin.",
  );
}

const result = await createOrVerifyLocalUser({
  homeserverUrl,
  registrationSecret,
  username,
  password,
  admin,
});
console.log(
  `result=${result} matrix_user=@${username}:${config.MATRIX_SERVER_NAME ?? "matrix.local"}`,
);

export async function createOrVerifyLocalUser(input) {
  const existingLogin = await loginLocalUser(input);
  if (existingLogin.ok) {
    return "matrix_local_user_already_ready";
  }

  const nonceResponse = await fetch(
    new URL("/_synapse/admin/v1/register", input.homeserverUrl),
  );
  if (!nonceResponse.ok) {
    throw new Error(
      `Synapse shared-secret registration nonce failed (${nonceResponse.status}).`,
    );
  }
  const noncePayload = await nonceResponse.json();
  if (typeof noncePayload.nonce !== "string" || !noncePayload.nonce) {
    throw new Error("Synapse returned an invalid registration nonce.");
  }

  const mac = createHmac("sha1", input.registrationSecret)
    .update(input.nonce ?? noncePayload.nonce)
    .update("\0")
    .update(input.username)
    .update("\0")
    .update(input.password)
    .update("\0")
    .update(input.admin ? "admin" : "notadmin")
    .digest("hex");
  const registerResponse = await fetch(
    new URL("/_synapse/admin/v1/register", input.homeserverUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: noncePayload.nonce,
        username: input.username,
        password: input.password,
        admin: input.admin,
        mac,
      }),
    },
  );
  const registerPayload = await registerResponse.json().catch(() => ({}));
  if (registerResponse.ok) return "matrix_local_user_created";
  if (registerPayload?.errcode !== "M_USER_IN_USE") {
    throw new Error(
      `Synapse shared-secret registration failed (${registerResponse.status}): `
      + JSON.stringify(registerPayload),
    );
  }

  const repeatedLogin = await loginLocalUser(input);
  if (!repeatedLogin.ok) {
    if (repeatedLogin.status === 429) {
      throw new Error(
        "Synapse is still applying an earlier login rate limit. Restart the "
        + "local Synapse service once so the generated local-test rate policy "
        + "takes effect.",
      );
    }
    throw new Error(
      "The local Matrix user already exists but its generated password no longer matches. "
      + `Synapse returned ${repeatedLogin.status}. Remove .local/${localStateDirectory} to `
      + "recreate the disposable Synapse state.",
    );
  }
  return "matrix_local_user_already_ready";
}

async function loginLocalUser(input) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(
      new URL("/_matrix/client/v3/login", input.homeserverUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: {
            type: "m.id.user",
            user: input.username,
          },
          password: input.password,
        }),
      },
    );
    if (response.ok) return { ok: true, status: response.status };
    const payload = await response.json().catch(() => ({}));
    if (response.status !== 429) {
      return { ok: false, status: response.status, payload };
    }
    const retryAfterMs = Number(payload.retry_after_ms);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Number.isFinite(retryAfterMs)
          ? Math.min(Math.max(retryAfterMs, 250), 5_000)
          : 1_000,
      ),
    );
  }
  return { ok: false, status: 429 };
}

function resolveLocalInstance(value) {
  const instance = value?.trim() || "normal";
  if (instance !== "normal" && instance !== "e2e") {
    throw new Error("MATRIX_LOCAL_INSTANCE must be normal or e2e.");
  }
  return instance;
}

async function readLocalEnv(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
