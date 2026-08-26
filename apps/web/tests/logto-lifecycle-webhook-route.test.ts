import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class LogtoWebhookError extends Error {
    constructor(
      readonly code: string,
      readonly statusCode: number,
    ) {
      super(code);
    }
  }
  return {
    LogtoWebhookError,
    processLogtoLifecycleWebhook: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  LOGTO_WEBHOOK_SIGNATURE_HEADER: "logto-signature-sha-256",
  LogtoWebhookError: mocks.LogtoWebhookError,
  processLogtoLifecycleWebhook: mocks.processLogtoLifecycleWebhook,
}));

import {
  GET,
  HEAD,
  POST,
} from "../app/api/auth/logto/webhook/route";

describe("Logto lifecycle webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processLogtoLifecycleWebhook.mockResolvedValue({
      status: "processed",
      effect: "SUSPENDED",
      revokedSessions: 2,
    });
  });

  it("keeps GET and HEAD side-effect free", () => {
    for (const response of [GET(), HEAD()]) {
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect(mocks.processLogtoLifecycleWebhook).not.toHaveBeenCalled();
  });

  it("passes the exact raw body and signature to lifecycle processing", async () => {
    const rawBody = '{"event":"User.Deleted"}\n';
    const response = await POST(
      new Request("https://dashboard.example.com/api/auth/logto/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "logto-signature-sha-256": "signature",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.processLogtoLifecycleWebhook).toHaveBeenCalledWith({
      rawBody,
      signature: "signature",
    });
    expect(await response.json()).toEqual({
      received: true,
      status: "processed",
    });
  });

  it("returns a stable authentication error without exposing internals", async () => {
    mocks.processLogtoLifecycleWebhook.mockRejectedValue(
      new mocks.LogtoWebhookError("INVALID_SIGNATURE", 401),
    );

    const response = await POST(
      new Request("https://dashboard.example.com/api/auth/logto/webhook", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      received: false,
      error: "INVALID_SIGNATURE",
    });
  });

  it("returns retryable unavailability for persistence failures", async () => {
    mocks.processLogtoLifecycleWebhook.mockRejectedValue(
      new Error("database unavailable with sensitive details"),
    );

    const response = await POST(
      new Request("https://dashboard.example.com/api/auth/logto/webhook", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      received: false,
      error: "LIFECYCLE_PROCESSING_UNAVAILABLE",
    });
  });
});
