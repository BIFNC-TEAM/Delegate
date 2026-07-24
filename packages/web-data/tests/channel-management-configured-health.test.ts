import { describe, expect, it } from "vitest";

import { evaluateChannelControlPlaneHealth } from "../src/channel-management";

describe("configured Matrix channel health", () => {
  it("treats a fully configured binding without recent failures as control-plane healthy", () => {
    expect(
      evaluateChannelControlPlaneHealth({
        kind: "MATRIX",
        transport: "MATRIX",
        sourceProvider: "MATRIX",
        externalUserId: "@_delegate_rep_lin:matrix.example.org",
        legacyStatus: "CONFIGURED",
        currentHealthStatus: "UNKNOWN",
        currentLastError: null,
        latestFailure: null,
      }),
    ).toEqual({
      healthStatus: "HEALTHY",
      lastError: null,
    });
  });
});
