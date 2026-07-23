import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toPublicBrokerError } from "../src/public-error";
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
});
