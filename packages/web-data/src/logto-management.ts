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

export type AccountSocialConnector = {
  id: string;
  target: string;
  name: { en: string; "zh-CN"?: string };
  editable: boolean;
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

  const userRequest = async (subject: string, method = "GET", body?: unknown) => {
    const accessToken = await getAccessToken();
    const response = await fetchImpl(new URL(`/api/users/${encodeURIComponent(subject)}`, config.endpoint).toString(), {
      method, redirect: "error",
      headers: { authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Logto account profile request failed (${response.status}).`);
    const payload = await response.json();
    if (!isRecord(payload) || payload.id !== subject || (method === "GET" && (typeof payload.hasPassword !== "boolean" || typeof payload.isSuspended !== "boolean"))) throw new Error("Invalid Logto account profile response.");
    return payload;
  };

  const getAccountBindingCapabilities = async () => {
    const read = async (path: string) => {
      const response = await fetchImpl(new URL(path, config.endpoint).toString(), { redirect: "error", signal: AbortSignal.timeout(config.requestTimeoutMs) });
      if (!response.ok) throw new Error(`Logto account settings request failed (${response.status}).`);
      return response.json();
    };
    const [experience, center] = await Promise.all([read("/api/.well-known/sign-in-exp"), read("/api/.well-known/account-center")]);
    if (!Array.isArray(experience?.signIn?.methods) || !isRecord(center?.fields)) throw new Error("Invalid Logto account settings response.");
    const emailEnabled = center.enabled === true && center.fields.email === "Edit"
      && experience.signIn.methods.some((method: unknown) => isRecord(method) && method.identifier === "email" && method.password === true);
    if (experience.socialConnectors !== undefined && !Array.isArray(experience.socialConnectors)) throw new Error("Invalid Logto social connectors response.");
    const social = new Map<string, AccountSocialConnector>();
    if (center.enabled === true && ['Edit', 'ReadOnly'].includes(center.fields.social)) {
      for (const item of experience.socialConnectors ?? []) {
        if (!isRecord(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.id)
          || typeof item.target !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(item.target) || !isRecord(item.name)
          || typeof item.name.en !== 'string' || !item.name.en.trim()) throw new Error("Invalid Logto social connector response.");
        if (item.platform === 'Native') continue;
        // Match Logto Account Center: one provider per target, preferring Web.
        if (item.platform === 'Web' || !social.has(item.target)) social.set(item.target, {
          id: item.id, target: item.target, editable: center.fields.social === 'Edit',
          name: { en: item.name.en.slice(0, 80), ...(typeof item.name['zh-CN'] === 'string' ? { 'zh-CN': item.name['zh-CN'].slice(0, 80) } : {}) },
        });
      }
    }
    return { emailEnabled, socialConnectors: [...social.values()] };
  };

  return {
    getAccountBindingCapabilities,
    getEmailBindingAvailable: async () => (await getAccountBindingCapabilities()).emailEnabled,
    getUserProfile: (subject: string) => userRequest(subject),
    updateUserAvatar: (subject: string, avatar: string) => userRequest(subject, "PATCH", { avatar }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
