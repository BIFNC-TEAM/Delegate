import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  beginRepresentativeMcpBindingHealthObservation,
  isNewerMcpBindingHealthObservation,
  recordRepresentativeMcpBindingFailure,
  recordRepresentativeMcpBindingSuccess,
  type McpBindingHealthObservationOrder,
} from "../src/mcp-bindings";
import {
  McpTransportError,
  toMcpExecutionFailureSummary,
  toMcpHealthFailureCode,
} from "../src/mcp";
import { SessionError } from "../src/session-error";

describe("MCP binding health observation ordering", () => {
  it("uses request start time first and generation as the deterministic tie-breaker", () => {
    const current = observation("2026-07-23T12:00:01.000Z", 2n);

    expect(isNewerMcpBindingHealthObservation(
      observation("2026-07-23T12:00:02.000Z", 1n),
      current,
    )).toBe(true);
    expect(isNewerMcpBindingHealthObservation(
      observation("2026-07-23T12:00:00.000Z", 99n),
      current,
    )).toBe(false);
    expect(isNewerMcpBindingHealthObservation(
      observation("2026-07-23T12:00:01.000Z", 3n),
      current,
    )).toBe(true);
    expect(isNewerMcpBindingHealthObservation(
      observation("2026-07-23T12:00:01.000Z", 2n),
      current,
    )).toBe(false);
  });

  it("models a newer request completing before an older request without allowing rollback", () => {
    const older = observation("2026-07-23T12:00:00.000Z", 1n);
    const newer = observation("2026-07-23T12:00:01.000Z", 2n);
    let persisted: McpBindingHealthObservationOrder | null = null;

    for (const completed of [newer, older]) {
      if (isNewerMcpBindingHealthObservation(completed, persisted)) {
        persisted = completed;
      }
    }

    expect(persisted).toEqual(newer);
  });

  it("fails closed before touching storage when an observation token is invalid", async () => {
    await expect(beginRepresentativeMcpBindingHealthObservation({
      bindingId: "",
      configRevision: 0,
      startedAt: new Date(Number.NaN),
    })).resolves.toBeNull();

    const invalidToken = {
      bindingId: "binding",
      configRevision: 1,
      requestGeneration: 0n,
      startedAt: new Date("2026-07-23T12:00:00.000Z"),
    };
    await expect(recordRepresentativeMcpBindingSuccess({
      observation: invalidToken,
    })).resolves.toBe(false);
    await expect(recordRepresentativeMcpBindingFailure({
      observation: invalidToken,
      failureReason: "network_error",
    })).resolves.toBe(false);
  });
});

describe("MCP binding health failure codes", () => {
  it("persists only the stable transport classification", () => {
    const error = new McpTransportError(
      "timeout",
      "streamable_http",
      1,
      true,
      "https://user:secret@example.com/mcp?token=top-secret timed out",
    );
    const code = toMcpHealthFailureCode(error);

    expect(code).toBe("mcp_timeout");
    expect(code).not.toMatch(/https|secret|token=/u);
    expect(toMcpExecutionFailureSummary(error)).toBe("mcp_timeout");
  });

  it("accepts only allowlisted SessionError prefixes and strips all detail", () => {
    const allowed = toMcpHealthFailureCode(new SessionError(
      409,
      "mcp_tool_not_exposed_by_server:https://example.com/mcp?token=top-secret",
    ));
    const crafted = toMcpHealthFailureCode(new SessionError(
      502,
      "mcp_token_exfiltration:https://example.com/mcp?token=top-secret",
    ));

    expect(allowed).toBe("mcp_tool_not_exposed_by_server");
    expect(crafted).toBe("mcp_execution_failed");
    expect(`${allowed} ${crafted}`).not.toMatch(/https|secret|token=/u);
  });

  it("maps arbitrary failures to a generic non-sensitive code", () => {
    const privateError = new Error("Bearer top-secret at https://example.com/mcp");
    const code = toMcpHealthFailureCode(privateError);
    const summary = toMcpExecutionFailureSummary(privateError);

    expect(code).toBe("mcp_execution_failed");
    expect(code).not.toMatch(/https|secret|bearer/u);
    expect(summary).toBe("mcp_execution_failed");
    expect(summary).not.toMatch(/https|secret|bearer/u);
  });

  it("uses the stable MCP summary at the execution persistence boundary", () => {
    const source = readFileSync(new URL("../src/executions.ts", import.meta.url), "utf8");

    expect(source).toContain('params.input.capability === "mcp"');
    expect(source).toContain("? toMcpExecutionFailureSummary(error)");
  });
});

function observation(
  startedAt: string,
  requestGeneration: bigint,
): McpBindingHealthObservationOrder {
  return {
    startedAt: new Date(startedAt),
    requestGeneration,
  };
}
