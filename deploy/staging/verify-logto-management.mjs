import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateAuthApps } from "./validate-auth-apps.mjs";

export async function verifyLogtoManagement({
  endpoint,
  authApps,
  fetchImpl = fetch,
}) {
  const tokenResponse = await fetchImpl(new URL("/oidc/token", endpoint), {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(
        `${authApps.LOGTO_MANAGEMENT_APP_ID}:${authApps.LOGTO_MANAGEMENT_APP_SECRET}`,
        "utf8",
      ).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: "https://default.logto.app/api",
      scope: "all",
    }),
  });
  const tokenPayload = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || typeof tokenPayload?.access_token !== "string") {
    throw new Error(`Logto M2M token probe failed with status ${tokenResponse.status}`);
  }

  const usersResponse = await fetchImpl(
    new URL("/api/users?page=1&page_size=1", endpoint),
    { headers: { authorization: `Bearer ${tokenPayload.access_token}` } },
  );
  const usersPayload = await usersResponse.json().catch(() => null);
  if (!usersResponse.ok || !Array.isArray(usersPayload)) {
    throw new Error(`Logto Management API probe failed with status ${usersResponse.status}`);
  }

  return { tokenStatus: tokenResponse.status, usersStatus: usersResponse.status };
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const envPath = process.argv[2]
    ?? "/home/ubuntu/delegate/shared/env/auth-apps.env";
  const endpoint = process.argv[3] ?? "https://login.bonary.xyz";
  const result = await verifyLogtoManagement({
    endpoint,
    authApps: validateAuthApps(readFileSync(envPath, "utf8")),
  });
  console.log(
    `logto-management: token=${result.tokenStatus} users=${result.usersStatus}`,
  );
}
