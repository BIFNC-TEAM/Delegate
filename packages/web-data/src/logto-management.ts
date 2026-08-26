export type LogtoManagementConfig = {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  resource: string;
  requestTimeoutMs: number;
  pageSize: number;
  maxPages: number;
};

export type LogtoManagementUser = {
  id: string;
  isSuspended: boolean;
  updatedAt: number | null;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function readLogtoManagementConfig(
  env: Record<string, string | undefined> = process.env,
): LogtoManagementConfig | null {
  const clientId =
    env.LOGTO_MANAGEMENT_APP_ID?.trim()
    || env.LOGTO_M2M_APP_ID?.trim();
  const clientSecret =
    env.LOGTO_MANAGEMENT_APP_SECRET?.trim()
    || env.LOGTO_M2M_APP_SECRET?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error(
      "LOGTO_MANAGEMENT_APP_ID and LOGTO_MANAGEMENT_APP_SECRET must be configured together.",
    );
  }
  const endpoint = normalizeEndpoint(
    env.LOGTO_BACKCHANNEL_ENDPOINT?.trim()
      || env.LOGTO_ENDPOINT?.trim()
      || "",
  );
  const resource = normalizeResource(
    env.LOGTO_MANAGEMENT_API_RESOURCE?.trim()
      || "https://default.logto.app/api",
  );
  return {
    endpoint,
    clientId,
    clientSecret,
    resource,
    requestTimeoutMs: boundedInteger(
      env.LOGTO_MANAGEMENT_REQUEST_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
      "LOGTO_MANAGEMENT_REQUEST_TIMEOUT_MS",
    ),
    pageSize: boundedInteger(
      env.LOGTO_RECONCILIATION_PAGE_SIZE,
      100,
      1,
      100,
      "LOGTO_RECONCILIATION_PAGE_SIZE",
    ),
    maxPages: boundedInteger(
      env.LOGTO_RECONCILIATION_MAX_PAGES,
      100,
      1,
      10_000,
      "LOGTO_RECONCILIATION_MAX_PAGES",
    ),
  };
}

export function createLogtoManagementClient(
  config: LogtoManagementConfig,
  fetchImpl: FetchLike = fetch,
) {
  let cachedToken: { value: string; refreshAt: number } | null = null;

  const getAccessToken = async () => {
    if (cachedToken && cachedToken.refreshAt > Date.now()) {
      return cachedToken.value;
    }
    const response = await fetchImpl(
      new URL("/oidc/token", config.endpoint).toString(),
      {
        method: "POST",
        headers: {
          authorization:
            `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          resource: config.resource,
          scope: "all",
        }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      },
    );
    const payload = await response.json().catch(() => null);
    if (
      !response.ok
      || typeof payload?.access_token !== "string"
      || !payload.access_token.trim()
      || typeof payload?.expires_in !== "number"
      || payload.expires_in <= 0
    ) {
      throw new Error(
        `Logto Management API token request failed with status ${response.status}.`,
      );
    }
    cachedToken = {
      value: payload.access_token,
      refreshAt:
        Date.now() + Math.max(1, payload.expires_in - 60) * 1_000,
    };
    return cachedToken.value;
  };

  return {
    async listAllUsers(): Promise<LogtoManagementUser[]> {
      const accessToken = await getAccessToken();
      const users: LogtoManagementUser[] = [];
      for (let page = 1; page <= config.maxPages; page += 1) {
        const url = new URL("/api/users", config.endpoint);
        url.searchParams.set("page", String(page));
        url.searchParams.set("page_size", String(config.pageSize));
        const response = await fetchImpl(url.toString(), {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(payload)) {
          throw new Error(
            `Logto Management API users request failed with status ${response.status}.`,
          );
        }
        const pageUsers = payload.map(parseManagementUser);
        users.push(...pageUsers);
        if (pageUsers.length < config.pageSize) return users;
      }
      throw new Error(
        "Logto Management API user listing reached LOGTO_RECONCILIATION_MAX_PAGES before completion.",
      );
    },
  };
}

function parseManagementUser(value: unknown): LogtoManagementUser {
  if (!value || typeof value !== "object") {
    throw new Error("Logto Management API returned an invalid user record.");
  }
  const user = value as Record<string, unknown>;
  const id = typeof user.id === "string" ? user.id.trim() : "";
  if (!id || typeof user.isSuspended !== "boolean") {
    throw new Error("Logto Management API returned an invalid user record.");
  }
  return {
    id,
    isSuspended: user.isSuspended,
    updatedAt:
      typeof user.updatedAt === "number" && Number.isFinite(user.updatedAt)
        ? user.updatedAt
        : null,
  };
}

function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LOGTO_ENDPOINT or LOGTO_BACKCHANNEL_ENDPOINT is required for Management API access.");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
  ) {
    throw new Error("Logto Management API endpoint must be HTTP(S) without credentials.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function normalizeResource(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("LOGTO_MANAGEMENT_API_RESOURCE must be an HTTPS resource indicator.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
