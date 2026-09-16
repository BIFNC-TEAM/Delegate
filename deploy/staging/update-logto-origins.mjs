#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const oldOrigins = new Map([
  ["https://dashboard.bonary.xyz", "https://dashboard.rag8.cn"],
  ["https://delegate.bonary.xyz", "https://delegate.rag8.cn"],
]);

export function replaceKnownOrigin(value, replacements = oldOrigins) {
  if (typeof value !== "string" || !value) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const replacement = replacements.get(url.origin);
  if (!replacement) return value;
  return `${replacement}${url.pathname}${url.search}${url.hash}`;
}

export function migrateUriList(values, required = [], replacements = oldOrigins) {
  const migrated = Array.isArray(values)
    ? values.map((value) => replaceKnownOrigin(value, replacements))
    : [];
  return Array.from(new Set([...migrated, ...required]));
}

async function managementRequest({
  endpoint,
  accessToken,
  path,
  method = "GET",
  body,
}) {
  const response = await fetch(new URL(path, endpoint), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Logto Management API ${method} ${path} failed with status ${response.status}.`);
  }
  return payload;
}

async function fetchAccessToken(endpoint) {
  const clientId = required("LOGTO_MANAGEMENT_APP_ID");
  const clientSecret = required("LOGTO_MANAGEMENT_APP_SECRET");
  const resource = process.env.LOGTO_MANAGEMENT_API_RESOURCE
    || "https://default.logto.app/api";
  const response = await fetch(new URL("/oidc/token", endpoint), {
    method: "POST",
    headers: {
      authorization:
        `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource,
      scope: "all",
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new Error(`Logto M2M token request failed with status ${response.status}.`);
  }
  return payload.access_token;
}

async function migrateApplication({
  endpoint,
  accessToken,
  applicationId,
  requiredRedirectUris,
  requiredPostLogoutRedirectUris = [],
}) {
  const path = `/api/applications/${encodeURIComponent(applicationId)}`;
  const application = await managementRequest({ endpoint, accessToken, path });
  const metadata = application?.oidcClientMetadata;
  if (!metadata || !Array.isArray(metadata.redirectUris)) {
    throw new Error(`Logto application ${applicationId} has invalid OIDC metadata.`);
  }
  const nextMetadata = {
    ...metadata,
    redirectUris: migrateUriList(metadata.redirectUris, requiredRedirectUris),
    postLogoutRedirectUris: migrateUriList(
      metadata.postLogoutRedirectUris,
      requiredPostLogoutRedirectUris,
    ),
  };
  await managementRequest({
    endpoint,
    accessToken,
    path,
    method: "PATCH",
    body: { oidcClientMetadata: nextMetadata },
  });
}

async function migrateHooks({ endpoint, accessToken }) {
  const hooks = await managementRequest({
    endpoint,
    accessToken,
    path: "/api/hooks?page=1&page_size=100",
  });
  if (!Array.isArray(hooks)) {
    throw new Error("Logto hook listing returned an invalid response.");
  }
  let updated = 0;
  for (const hook of hooks) {
    const currentUrl = hook?.config?.url;
    const nextUrl = replaceKnownOrigin(currentUrl);
    if (!hook?.id || nextUrl === currentUrl) continue;
    await managementRequest({
      endpoint,
      accessToken,
      path: `/api/hooks/${encodeURIComponent(hook.id)}`,
      method: "PATCH",
      body: {
        name: hook.name,
        events: hook.events,
        config: { ...hook.config, url: nextUrl },
        enabled: hook.enabled,
      },
    });
    updated += 1;
  }
  return updated;
}

export async function updateLogtoOrigins() {
  const endpoint = process.env.LOGTO_BACKCHANNEL_ENDPOINT
    || process.env.LOGTO_ENDPOINT
    || "http://logto:3001";
  const dashboardOrigin = canonicalOrigin(
    process.env.NEXT_PUBLIC_DASHBOARD_URL || "https://dashboard.rag8.cn",
    "NEXT_PUBLIC_DASHBOARD_URL",
  );
  const representativeOrigin = canonicalOrigin(
    process.env.NEXT_PUBLIC_REPRESENTATIVE_URL || "https://delegate.rag8.cn",
    "NEXT_PUBLIC_REPRESENTATIVE_URL",
  );
  const accessToken = await fetchAccessToken(endpoint);
  await migrateApplication({
    endpoint,
    accessToken,
    applicationId: required("LOGTO_DASHBOARD_APP_ID"),
    requiredRedirectUris: [`${dashboardOrigin}/auth/callback`],
    requiredPostLogoutRedirectUris: [`${dashboardOrigin}/auth/logout/callback`],
  });
  await migrateApplication({
    endpoint,
    accessToken,
    applicationId: required("LOGTO_REPS_APP_ID"),
    requiredRedirectUris: [`${representativeOrigin}/auth/callback`],
  });
  const hooksUpdated = await migrateHooks({ endpoint, accessToken });
  console.log(`logto-origins: applications=2 hooks=${hooksUpdated}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function canonicalOrigin(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free HTTPS origin.`);
  }
  return url.origin;
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  await updateLogtoOrigins();
}
