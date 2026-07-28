import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preflightWeChatPayRuntime: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  preflightWeChatPayRuntime:
    mocks.preflightWeChatPayRuntime,
  prisma: {
    $queryRaw: mocks.queryRaw,
  },
}));

import { GET } from "../app/ready/route";

describe("representative app readiness route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    mocks.preflightWeChatPayRuntime.mockReturnValue({
      ready: true,
      status: "disabled",
      collectionEnabled: false,
      processingEnabled: false,
      errorCode: null,
    });
  });

  it("is ready when the database is reachable and payment is intentionally disabled", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      service: "reps",
      databaseReady: true,
      weChatPay: {
        status: "disabled",
      },
    });
  });

  it("fails readiness with a redacted payment configuration code", async () => {
    mocks.preflightWeChatPayRuntime.mockReturnValue({
      ready: false,
      status: "misconfigured",
      collectionEnabled: false,
      processingEnabled: true,
      errorCode: "wechat_pay_configuration_invalid",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      databaseReady: true,
      weChatPay: {
        errorCode: "wechat_pay_configuration_invalid",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private-key");
  });

  it("fails readiness without exposing a database error", async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error("postgres-secret-host"),
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      databaseReady: false,
    });
    expect(JSON.stringify(body)).not.toContain(
      "postgres-secret-host",
    );
  });
});
