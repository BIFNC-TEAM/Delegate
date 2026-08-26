import { describe, expect, it, vi } from "vitest";

import { observeAccountSessionParity } from "../src/account-session-parity";

const legacy = {
  actor: "owner" as const,
  issuer: "https://auth.example.com/oidc",
  subject: "secret-subject",
  personaId: "secret-owner-id",
};

describe("Account/AppSession shadow parity", () => {
  it("classifies an exact principal match", () => {
    expect(observeAccountSessionParity({
      application: "DASHBOARD",
      legacy,
      v2: { ...legacy },
      v2Token: "opaque-token",
    }, silentLogger())).toBe("MATCH");
  });

  it("distinguishes missing, invalid, and mismatched v2 authority", () => {
    expect(observeAccountSessionParity({
      application: "DASHBOARD",
      legacy,
      v2: null,
      v2Token: null,
    }, silentLogger())).toBe("V2_COOKIE_MISSING");
    expect(observeAccountSessionParity({
      application: "DASHBOARD",
      legacy,
      v2: null,
      v2Token: "opaque-token",
    }, silentLogger())).toBe("V2_PRINCIPAL_INVALID");
    expect(observeAccountSessionParity({
      application: "DASHBOARD",
      legacy,
      v2: { ...legacy, personaId: "different-owner" },
      v2Token: "opaque-token",
    }, silentLogger())).toBe("PRINCIPAL_MISMATCH");
  });

  it("emits every mismatch without including principal or token material", () => {
    const logger = silentLogger();
    observeAccountSessionParity({
      application: "DASHBOARD",
      legacy,
      v2: { ...legacy, subject: "other-secret-subject" },
      v2Token: "super-secret-opaque-token",
    }, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(logger.warn.mock.calls);
    expect(serialized).not.toContain("secret-subject");
    expect(serialized).not.toContain("secret-owner-id");
    expect(serialized).not.toContain("super-secret-opaque-token");
    expect(serialized).toContain("PRINCIPAL_MISMATCH");
  });
});

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}
