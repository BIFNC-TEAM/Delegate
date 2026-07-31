#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${LOGTO_LOCAL_ENV_FILE:-${REPO_ROOT}/.local/logto/logto.env}"

# shellcheck source=deploy/logto/env.sh
source "${SCRIPT_DIR}/env.sh"
logto_load_env "$ENV_FILE"

node --input-type=module - \
  "$LOGTO_OSS_ENDPOINT" \
  "$LOGTO_OSS_ADMIN_ENDPOINT" <<'NODE'
const core = new URL(process.argv[2]);
const admin = new URL(process.argv[3]);
const fetchWithTimeout = (url) =>
  fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });

const discoveryUrl = new URL(
  "/oidc/.well-known/openid-configuration",
  core,
);
const discoveryResponse = await fetchWithTimeout(discoveryUrl);
if (!discoveryResponse.ok) {
  throw new Error(
    `OIDC discovery returned ${discoveryResponse.status} at ${discoveryUrl}`,
  );
}
const discovery = await discoveryResponse.json();
const expectedIssuer = new URL("/oidc", core).toString().replace(/\/$/u, "");
if (discovery.issuer !== expectedIssuer) {
  throw new Error(
    `Unexpected issuer ${String(discovery.issuer)}; expected ${expectedIssuer}`,
  );
}

const expectedJwks = new URL("/oidc/jwks", core).toString();
if (discovery.jwks_uri !== expectedJwks) {
  throw new Error(
    `Unexpected JWKS URI ${String(discovery.jwks_uri)}; expected ${expectedJwks}`,
  );
}
const jwksResponse = await fetchWithTimeout(expectedJwks);
if (!jwksResponse.ok) {
  throw new Error(`JWKS returned ${jwksResponse.status}`);
}
const jwks = await jwksResponse.json();
if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
  throw new Error("JWKS does not contain a signing key");
}

const tokenUrl = new URL("/oidc/token", core);
const tokenResponse = await fetch(tokenUrl, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
  }),
  redirect: "manual",
  signal: AbortSignal.timeout(5_000),
});
const tokenPayload = await tokenResponse.json().catch(() => null);
if (
  ![400, 401].includes(tokenResponse.status) ||
  !tokenPayload ||
  typeof tokenPayload !== "object" ||
  typeof tokenPayload.error !== "string"
) {
  throw new Error(
    `Token endpoint probe returned unexpected status ${tokenResponse.status}`,
  );
}

const adminResponse = await fetch(admin, {
  redirect: "follow",
  signal: AbortSignal.timeout(5_000),
});
const finalAdminUrl = new URL(adminResponse.url);
const adminContentType = adminResponse.headers.get("content-type") ?? "";
const adminBody = await adminResponse.text();
if (
  adminResponse.status !== 200 ||
  finalAdminUrl.origin !== admin.origin ||
  !adminContentType.toLowerCase().includes("text/html") ||
  !adminBody.includes('<div id="app"></div>') ||
  !adminBody.includes("/console/assets/")
) {
  throw new Error(
    `Admin Console probe did not return the expected local SPA (${adminResponse.status})`,
  );
}

console.log(`Logto smoke passed: issuer=${discovery.issuer}`);
console.log(`Admin Console is reachable on loopback: ${admin.origin}`);
NODE
