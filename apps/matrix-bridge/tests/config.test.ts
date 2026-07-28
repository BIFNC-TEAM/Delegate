import { describe, expect, it } from "vitest";

import { resolveMatrixBridgeConfig } from "../src/config";

describe("matrix bridge config", () => {
  it("requires the homeserver token to come from environment secrets", () => {
    expect(() => resolveMatrixBridgeConfig({})).toThrow("MATRIX_AS_HS_TOKEN is required");
  });

  it("parses a configured bridge without embedding credentials", () => {
    expect(
      resolveMatrixBridgeConfig({
        MATRIX_AS_HS_TOKEN: "a-secure-token-that-is-long-enough",
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_AS_TOKEN: "application-service-token",
        MATRIX_SERVER_NAME: "matrix.example.com",
        MATRIX_BRIDGE_PORT: "4040",
      }),
    ).toMatchObject({
      port: 4040,
      homeserverToken: "a-secure-token-that-is-long-enough",
      homeserverUrl: "https://matrix.example.com",
      applicationServiceToken: "application-service-token",
      serverName: "matrix.example.com",
      senderLocalpart: "_delegate_as",
    });
  });

  it("requires outbound homeserver configuration", () => {
    expect(() =>
      resolveMatrixBridgeConfig({
        MATRIX_AS_HS_TOKEN: "a-secure-token-that-is-long-enough",
      }),
    ).toThrow("MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN are required");
  });

  it("requires the Matrix server name for virtual-user registration", () => {
    expect(() =>
      resolveMatrixBridgeConfig({
        MATRIX_AS_HS_TOKEN: "a-secure-token-that-is-long-enough",
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_AS_TOKEN: "application-service-token",
      }),
    ).toThrow("MATRIX_SERVER_NAME");
  });

  it("accepts a valid server name with an explicit port", () => {
    expect(
      resolveMatrixBridgeConfig({
        MATRIX_AS_HS_TOKEN: "a-secure-token-that-is-long-enough",
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_AS_TOKEN: "application-service-token",
        MATRIX_SERVER_NAME: "MATRIX.Example.com:8448",
      }),
    ).toMatchObject({
      serverName: "MATRIX.Example.com:8448",
    });
  });

  it("accepts a bracketed IPv6 server name without folding its representation", () => {
    expect(
      resolveMatrixBridgeConfig({
        MATRIX_AS_HS_TOKEN: "a-secure-token-that-is-long-enough",
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
        MATRIX_AS_TOKEN: "application-service-token",
        MATRIX_SERVER_NAME: "[2001:DB8::1]:8448",
      }),
    ).toMatchObject({
      serverName: "[2001:DB8::1]:8448",
    });
  });
});
