import { describe, expect, it, vi } from "vitest";

import {
  createLogtoManagementClient,
  readLogtoManagementConfig,
} from "../src/logto-management";

describe("Logto Management API client", () => {
  it("is disabled without credentials and rejects partial configuration", () => {
    expect(readLogtoManagementConfig({})).toBeNull();
    expect(() => readLogtoManagementConfig({
      LOGTO_MANAGEMENT_APP_ID: "app-id",
    })).toThrow("must be configured together");
  });

  it("uses OSS defaults and bounded reconciliation settings", () => {
    expect(readLogtoManagementConfig({
      LOGTO_ENDPOINT: "https://auth.example.com",
      LOGTO_MANAGEMENT_APP_ID: "app-id",
      LOGTO_MANAGEMENT_APP_SECRET: "app-secret",
    })).toMatchObject({
      endpoint: "https://auth.example.com",
      resource: "https://default.logto.app/api",
      pageSize: 100,
      maxPages: 100,
    });
  });

  it("accepts the previous local M2M variable names without copying secrets", () => {
    expect(readLogtoManagementConfig({
      LOGTO_ENDPOINT: "https://auth.example.com",
      LOGTO_M2M_APP_ID: "legacy-app-id",
      LOGTO_M2M_APP_SECRET: "legacy-app-secret",
    })).toMatchObject({
      clientId: "legacy-app-id",
      clientSecret: "legacy-app-secret",
    });
  });

  it("fetches one client-credentials token and paginates users", async () => {
    const requests: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/oidc/token") {
        return Response.json({
          access_token: "management-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "all",
        });
      }
      const page = Number(parsed.searchParams.get("page"));
      return Response.json(
        page === 1
          ? [
              { id: "user-1", isSuspended: false, updatedAt: 1 },
              { id: "user-2", isSuspended: true, updatedAt: 2 },
            ]
          : [],
      );
    });
    const client = createLogtoManagementClient({
      endpoint: "https://auth.example.com",
      clientId: "app-id",
      clientSecret: "app-secret",
      resource: "https://default.logto.app/api",
      requestTimeoutMs: 15_000,
      pageSize: 2,
      maxPages: 5,
    }, fetchImpl);

    await expect(client.listAllUsers()).resolves.toEqual([
      { id: "user-1", isSuspended: false, updatedAt: 1 },
      { id: "user-2", isSuspended: true, updatedAt: 2 },
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization:
        `Basic ${Buffer.from("app-id:app-secret").toString("base64")}`,
    });
    expect(String(requests[0]?.init?.body)).toContain(
      "grant_type=client_credentials",
    );
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: "Bearer management-token",
    });
  });

  it("fails closed when the page cap is reached without a short final page", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new URL(url).pathname === "/oidc/token"
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json([{ id: "user-1", isSuspended: false }]),
    );
    const client = createLogtoManagementClient({
      endpoint: "https://auth.example.com",
      clientId: "app-id",
      clientSecret: "app-secret",
      resource: "https://default.logto.app/api",
      requestTimeoutMs: 15_000,
      pageSize: 1,
      maxPages: 1,
    }, fetchImpl);

    await expect(client.listAllUsers()).rejects.toThrow("MAX_PAGES");
  });
});
