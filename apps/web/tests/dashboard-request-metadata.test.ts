import { describe, expect, it } from "vitest";

import { resolveDashboardRequestMetadata } from "../app/api/dashboard/request-metadata";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("dashboard request metadata", () => {
  it("preserves trimmed safe request and idempotency tokens", () => {
    const metadata = resolveDashboardRequestMetadata(new Request(
      "http://localhost/api/dashboard/settings",
      {
        headers: {
          "x-request-id": " request.settings:1 ",
          "idempotency-key": " settings-profile_1 ",
        },
      },
    ));

    expect(metadata).toEqual({
      requestId: "request.settings:1",
      idempotencyKey: "settings-profile_1",
    });
  });

  it("generates one request token and reuses it when headers are missing", () => {
    const metadata = resolveDashboardRequestMetadata(new Request(
      "http://localhost/api/dashboard/settings",
    ));

    expect(metadata.requestId).toMatch(uuidPattern);
    expect(metadata.idempotencyKey).toBe(metadata.requestId);
  });

  it("rejects illegal or oversized tokens at the request boundary", () => {
    const illegalRequest = resolveDashboardRequestMetadata(new Request(
      "http://localhost/api/dashboard/settings",
      {
        headers: {
          "x-request-id": "request with spaces",
          "idempotency-key": "idempotency/key",
        },
      },
    ));
    expect(illegalRequest.requestId).toMatch(uuidPattern);
    expect(illegalRequest.idempotencyKey).toBe(illegalRequest.requestId);

    const oversizedRequest = resolveDashboardRequestMetadata(new Request(
      "http://localhost/api/dashboard/settings",
      {
        headers: {
          "x-request-id": "r".repeat(192),
          "idempotency-key": "i".repeat(192),
        },
      },
    ));
    expect(oversizedRequest.requestId).toMatch(uuidPattern);
    expect(oversizedRequest.idempotencyKey).toBe(
      oversizedRequest.requestId,
    );
  });
});
