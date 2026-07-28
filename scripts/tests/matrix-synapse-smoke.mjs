#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const localInstance = resolveLocalInstance(process.env.MATRIX_LOCAL_INSTANCE);
const localStateDirectory =
  localInstance === "e2e" ? "matrix-e2e" : "matrix";
const config = {
  ...process.env,
  ...(await readLocalEnv(
    path.join(repoRoot, ".local", localStateDirectory, "matrix.env"),
  )),
};
const homeserverUrl =
  config.MATRIX_LOCAL_HOMESERVER_URL
  ?? "http://127.0.0.1:8008";
const bridgeUrl =
  config.MATRIX_LOCAL_BRIDGE_URL
  ?? "http://127.0.0.1:4030";
const serverName = required("MATRIX_SERVER_NAME");
const asToken = required("MATRIX_AS_TOKEN");
const hsToken = required("MATRIX_AS_HS_TOKEN");
const username = required("MATRIX_LOCAL_TEST_USERNAME");
const password = required("MATRIX_LOCAL_TEST_PASSWORD");
const suffix = randomBytes(6).toString("hex");
const virtualLocalpart = `_delegate_smoke_${suffix}`;
const virtualUserId = `@${virtualLocalpart}:${serverName}`;

await expectStatus(
  fetch(new URL("/_matrix/client/versions", homeserverUrl)),
  200,
  "Synapse versions",
);
await expectStatus(
  fetch(new URL("/ready", bridgeUrl)),
  200,
  "Delegate Matrix bridge readiness",
);
await expectStatus(
  fetch(new URL("/_matrix/app/v1/ping", bridgeUrl), { method: "POST" }),
  403,
  "Delegate Matrix bridge rejects an unauthenticated homeserver",
);
await expectStatus(
  fetch(new URL("/_matrix/app/v1/ping", bridgeUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${hsToken}` },
  }),
  200,
  "Delegate Matrix bridge accepts the configured homeserver token",
);

const login = await jsonRequest("/_matrix/client/v3/login", {
  method: "POST",
  body: {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: username },
    password,
  },
});
const userToken = requireString(login, "access_token", "Matrix login");
const userId = requireString(login, "user_id", "Matrix login");

await jsonRequest("/_matrix/client/v3/register", {
  method: "POST",
  token: asToken,
  body: {
    type: "m.login.application_service",
    username: virtualLocalpart,
    inhibit_login: true,
  },
});
const virtualWhoami = await jsonRequest(
  `/_matrix/client/v3/account/whoami?user_id=${encodeURIComponent(virtualUserId)}`,
  { token: asToken },
);
if (virtualWhoami.user_id !== virtualUserId) {
  throw new Error(
    `Application Service impersonation expected ${virtualUserId}, got `
    + `${String(virtualWhoami.user_id)}.`,
  );
}

// Keep the protocol-only room outside the AS namespace. Putting an
// unprovisioned managed user in a room would correctly make Delegate reject
// the transaction and could delay the following business-path E2E.
const room = await jsonRequest("/_matrix/client/v3/createRoom", {
  method: "POST",
  token: userToken,
  body: {
    preset: "private_chat",
    name: `Matrix Client API smoke ${suffix}`,
  },
});
const roomId = requireString(room, "room_id", "Matrix room creation");

const body = `delegate matrix protocol smoke ${suffix}`;
await jsonRequest(
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${suffix}`,
  {
    method: "PUT",
    token: userToken,
    body: { msgtype: "m.text", body },
  },
);

const members = await jsonRequest(
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
  { token: userToken },
);
const joined = Object.keys(members.joined ?? {}).sort();
const expectedMembers = [userId];
if (JSON.stringify(joined) !== JSON.stringify(expectedMembers)) {
  throw new Error(
    `Expected the Client API smoke user ${userId}, got ${joined.join(", ")}.`,
  );
}

const encryptionResponse = await fetch(
  matrixUrl(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`,
  ),
  { headers: { authorization: `Bearer ${userToken}` } },
);
if (encryptionResponse.status !== 404) {
  throw new Error(
    `Expected an unencrypted room (404 encryption state), got ${encryptionResponse.status}.`,
  );
}

const messages = await jsonRequest(
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`
  + "?dir=b&limit=20",
  { token: userToken },
);
const found = Array.isArray(messages.chunk)
  && messages.chunk.some(
    (event) =>
      event?.type === "m.room.message"
      && event?.sender === userId
      && event?.content?.body === body,
  );
if (!found) {
  throw new Error("The Matrix message was not visible to the Application Service user.");
}

console.log(
  `result=matrix_synapse_protocol_smoke_passed room=${roomId} `
  + `audience=${userId} appservice_user=${virtualUserId}`,
);

async function jsonRequest(resource, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  const response = await fetch(matrixUrl(resource), {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${resource} failed (${response.status}): `
      + JSON.stringify(payload),
    );
  }
  return payload;
}

function matrixUrl(resource) {
  return new URL(resource, homeserverUrl);
}

function required(name) {
  const value = config[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is missing. Run \`pnpm matrix:local:init\` first.`,
    );
  }
  return value;
}

function requireString(payload, key, operation) {
  const value = payload?.[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`${operation} returned no ${key}.`);
  }
  return value;
}

async function expectStatus(responsePromise, expected, operation) {
  const response = await responsePromise;
  if (response.status !== expected) {
    throw new Error(`${operation}: expected HTTP ${expected}, got ${response.status}.`);
  }
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

function resolveLocalInstance(value) {
  const instance = value?.trim() || "normal";
  if (instance !== "normal" && instance !== "e2e") {
    throw new Error("MATRIX_LOCAL_INSTANCE must be normal or e2e.");
  }
  return instance;
}
