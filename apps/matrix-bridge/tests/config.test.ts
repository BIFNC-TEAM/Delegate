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
        MATRIX_BRIDGE_PORT: "4040",
      }),
    ).toMatchObject({
      port: 4040,
      homeserverToken: "a-secure-token-that-is-long-enough",
    });
  });

  it("requires outbound homeserver configuration as a complete pair", () => {
    expect(() =>
      resolveMatrixBridgeConfig({
        MATRIX_AS_HS_TOKEN: "a-secure-token-that-is-long-enough",
        MATRIX_HOMESERVER_URL: "https://matrix.example.com",
      }),
    ).toThrow("MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN");
  });
});
