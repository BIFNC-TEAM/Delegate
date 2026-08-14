import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
  },
}));

import {
  enforcePublicChatNetworkAdmission,
  enforcePublicChatPrincipalAdmission,
} from "../src/public-chat-rate-limit";

const now = new Date("2026-08-14T08:00:15.000Z");

describe("public chat rate limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PUBLIC_CHAT_RATE_LIMIT_SECRET", "rate-limit-test-secret");
    vi.stubEnv("PUBLIC_CHAT_NETWORK_REQUESTS_PER_MINUTE", "30");
    vi.stubEnv("PUBLIC_CHAT_AUDIENCE_REQUESTS_PER_MINUTE", "12");
    vi.stubEnv("PUBLIC_CHAT_REPRESENTATIVE_REQUESTS_PER_DAY", "5000");
    mocks.queryRaw.mockResolvedValue([{
      count: 1,
      windowEndsAt: new Date("2026-08-14T08:01:00.000Z"),
    }]);
    mocks.executeRaw.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores only an HMAC scope key instead of the raw client address", async () => {
    await enforcePublicChatNetworkAdmission({
      clientAddress: "203.0.113.10",
      now,
    });

    const query = mocks.queryRaw.mock.calls[0]?.[0] as {
      values?: unknown[];
    };
    expect(query.values).toContainEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(query.values).not.toContain("203.0.113.10");
  });

  it("rejects a network request after the configured minute limit", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{
      count: 31,
      windowEndsAt: new Date("2026-08-14T08:01:00.000Z"),
    }]);

    await expect(enforcePublicChatNetworkAdmission({
      clientAddress: "203.0.113.10",
      now,
    })).rejects.toMatchObject({
      name: "PublicChatRateLimitError",
      scope: "network_minute",
      retryAfterSeconds: 45,
    });
  });

  it("applies audience and representative limits independently", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{
        count: 1,
        windowEndsAt: new Date("2026-08-14T08:01:00.000Z"),
      }])
      .mockResolvedValueOnce([{
        count: 5001,
        windowEndsAt: new Date("2026-08-15T00:00:00.000Z"),
      }]);

    await expect(enforcePublicChatPrincipalAdmission({
      representativeId: "rep-1",
      audienceIdentityId: "audience-1",
      now,
    })).rejects.toMatchObject({
      scope: "representative_day",
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("fails closed in production when no signing secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_CHAT_RATE_LIMIT_SECRET", "");
    vi.stubEnv("REP_PUBLIC_CHAT_SESSION_SECRET", "");

    await expect(enforcePublicChatNetworkAdmission({
      clientAddress: "203.0.113.10",
      now,
    })).rejects.toThrow("PUBLIC_CHAT_RATE_LIMIT_SECRET");
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
