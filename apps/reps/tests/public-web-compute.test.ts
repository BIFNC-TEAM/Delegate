import { describe, expect, it } from "vitest";

import { normalizePublicComputeSessionRequest } from "../app/reps/[slug]/web-compute";

describe("public web compute session request", () => {
  it("normalizes a browser-agent compute session request", () => {
    expect(
      normalizePublicComputeSessionRequest({
        generationRunId: "run-1",
        subagentId: "browser-agent",
        requestedCapabilities: ["browser", "browser", "unknown"],
        reason: "Open a page for the audience.",
      }),
    ).toEqual({
      generationRunId: "run-1",
      subagentId: "browser-agent",
      requestedCapabilities: ["browser"],
      reason: "Open a page for the audience.",
    });
  });

  it("rejects browser capability on the compute-agent lane", () => {
    expect(() =>
      normalizePublicComputeSessionRequest({
        generationRunId: "run-1",
        subagentId: "compute-agent",
        requestedCapabilities: ["browser"],
        reason: "Try to use the wrong lane.",
      }),
    ).toThrowError("Subagent compute-agent cannot request capability browser.");
  });

  it("rejects exec capability on the browser-agent lane", () => {
    expect(() =>
      normalizePublicComputeSessionRequest({
        generationRunId: "run-1",
        subagentId: "browser-agent",
        requestedCapabilities: ["exec"],
        reason: "Try to run a command from browser lane.",
      }),
    ).toThrowError("Subagent browser-agent cannot request capability exec.");
  });

  it("requires a server-owned generation run", () => {
    expect(() =>
      normalizePublicComputeSessionRequest({
        subagentId: "browser-agent",
        requestedCapabilities: ["browser"],
        reason: "Try to create an unscoped session.",
      }),
    ).toThrowError("generationRunId is required.");
  });
});
