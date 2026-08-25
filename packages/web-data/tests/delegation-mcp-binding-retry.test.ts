import { describe, expect, it } from "vitest";

import { assertPersistedDelegationMcpRetryBinding } from "../src/delegation-tasks";

describe("delegation MCP retry binding fence", () => {
  it("fails closed when the task step has no persisted binding", () => {
    expect(() => assertPersistedDelegationMcpRetryBinding({
      persistedRequestBindingId: "binding-original",
      persistedStepBindingId: null,
      allowedMcpBindingIds: ["binding-original"],
      retryBindingId: "binding-original",
    })).toThrow("missing its persisted binding coordinate");
  });

  it("rejects planner drift to another enabled connector", () => {
    expect(() => assertPersistedDelegationMcpRetryBinding({
      persistedRequestBindingId: "binding-original",
      persistedStepBindingId: "binding-original",
      allowedMcpBindingIds: ["binding-original"],
      retryBindingId: "binding-drifted",
    })).toThrow("changed its chosen MCP binding");
  });

  it("does not recover a binding by widening a missing resource allowlist", () => {
    expect(() => assertPersistedDelegationMcpRetryBinding({
      persistedRequestBindingId: "binding-original",
      persistedStepBindingId: "binding-original",
      allowedMcpBindingIds: [],
      retryBindingId: "binding-original",
    })).toThrow("not present in its persisted resource policy");
  });

  it("accepts only the exact binding captured in request, step and policy", () => {
    expect(assertPersistedDelegationMcpRetryBinding({
      persistedRequestBindingId: "binding-original",
      persistedStepBindingId: "binding-original",
      allowedMcpBindingIds: ["binding-original"],
      retryBindingId: "binding-original",
    })).toBe("binding-original");
  });
});
