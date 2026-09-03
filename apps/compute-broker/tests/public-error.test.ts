import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toPublicBrokerError } from "../src/public-error";
import { SandboxProviderError } from "../src/sandbox-provider";
import { SessionError } from "../src/session-error";

describe("compute broker public error boundary", () => {
  it("returns only a stable SessionError code", () => {
    expect(toPublicBrokerError(new SessionError(
      502,
      "mcp_timeout:https://user:secret@mcp.internal/?token=hidden",
    ))).toEqual({
      statusCode: 502,
      code: "mcp_timeout",
      logPrivateDetail: false,
    });
  });

  it("maps validation failures without exposing their detail", () => {
    const parsed = z.object({ token: z.string() }).safeParse({
      token: 123,
    });
    if (parsed.success) throw new Error("Expected validation to fail.");
    expect(toPublicBrokerError(parsed.error)).toEqual({
      statusCode: 400,
      code: "invalid_request",
      logPrivateDetail: false,
    });
  });

  it("maps ordinary errors to a fixed internal error", () => {
    const result = toPublicBrokerError(
      new Error("SELECT secret FROM users at postgresql://owner:password@db.internal"),
    );
    expect(result).toEqual({
      statusCode: 500,
      code: "internal_error",
      logPrivateDetail: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/SELECT|password|db\.internal/u);
  });

  it("exposes only stable sandbox provider error codes", () => {
    expect(toPublicBrokerError(new SandboxProviderError("THROTTLED", true))).toEqual({
      statusCode: 503,
      code: "sandbox_provider_unavailable",
      logPrivateDetail: false,
    });
    expect(toPublicBrokerError(new SandboxProviderError("AUTH_INVALID", false))).toEqual({
      statusCode: 503,
      code: "sandbox_provider_unavailable",
      logPrivateDetail: true,
    });
  });

  it("maps allowlist and operation-fence failures without exposing internals", () => {
    expect(toPublicBrokerError(new Error("sandbox_phase1_representative_not_allowed"))).toEqual({
      statusCode: 403,
      code: "sandbox_phase1_representative_not_allowed",
      logPrivateDetail: false,
    });
    expect(toPublicBrokerError(new Error("sandbox_provider_operation_fence_lost"))).toEqual({
      statusCode: 409,
      code: "sandbox_creation_pending_reconciliation",
      logPrivateDetail: false,
    });
    expect(toPublicBrokerError(new Error("sandbox_provider_migration_required"))).toEqual({
      statusCode: 409,
      code: "sandbox_provider_migration_required",
      logPrivateDetail: false,
    });
  });
});
