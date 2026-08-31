import { describe, expect, it } from "vitest";

import {
  parseSandboxRoutingConfig,
  resolveProviderForNewIdentity,
  validateSandboxRoutingRepresentatives,
} from "../src/sandbox-routing";

const baseDocument = {
  version: 1,
  default: "tencent",
  newIdentityEnabled: {
    docker: false,
    daytona: true,
    tencent: true,
  },
  phase1AllowedRepresentativeIds: ["rep-tencent", "rep-daytona"],
  representatives: {
    "rep-daytona": "daytona",
  },
};

describe("sandbox routing", () => {
  it("keeps legacy mode compatible without a routing document", () => {
    expect(parseSandboxRoutingConfig({ mode: "legacy" })).toBeNull();
  });

  it("resolves an allowlisted override before the default", () => {
    const routing = parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify(baseDocument),
      nodeEnv: "production",
    });
    expect(routing).not.toBeNull();
    expect(resolveProviderForNewIdentity(routing!, "rep-daytona")).toEqual({
      provider: "daytona",
      decisionSource: "manual_override",
    });
    expect(resolveProviderForNewIdentity(routing!, "rep-tencent")).toEqual({
      provider: "tencent",
      decisionSource: "default",
    });
    expect(routing?.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects non-allowlisted new identities", () => {
    const routing = parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify(baseDocument),
    });
    expect(() => resolveProviderForNewIdentity(routing!, "rep-customer")).toThrow(
      "sandbox_phase1_representative_not_allowed",
    );
  });

  it("rejects duplicate raw JSON keys before JSON.parse can overwrite them", () => {
    const raw = JSON.stringify(baseDocument).replace(
      '"default":"tencent"',
      '"default":"tencent","default":"daytona"',
    );
    expect(() => parseSandboxRoutingConfig({ mode: "manual_poc", rawDocument: raw })).toThrow(
      "sandbox_routing_duplicate_key",
    );
  });

  it("rejects overrides outside the Phase 1 allowlist", () => {
    expect(() => parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify({
        ...baseDocument,
        representatives: { "rep-customer": "daytona" },
      }),
    })).toThrow("sandbox_routing_override_not_allowlisted");
  });

  it("requires one atomic reroute before disabling a provider", () => {
    expect(() => parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify({
        ...baseDocument,
        newIdentityEnabled: {
          ...baseDocument.newIdentityEnabled,
          tencent: false,
        },
      }),
    })).toThrow("sandbox_routing_default_provider_disabled");
  });

  it("forbids Docker admission in production manual mode", () => {
    expect(() => parseSandboxRoutingConfig({
      mode: "manual_poc",
      nodeEnv: "production",
      rawDocument: JSON.stringify({
        ...baseDocument,
        default: "docker",
        newIdentityEnabled: {
          ...baseDocument.newIdentityEnabled,
          docker: true,
        },
      }),
    })).toThrow("sandbox_routing_docker_forbidden_in_production");
  });

  it("validates every allowlisted representative as an active test fixture", () => {
    const routing = parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify(baseDocument),
    });
    expect(() => validateSandboxRoutingRepresentatives(routing!, [
      { id: "rep-tencent", active: true, sandboxTestEligible: true },
      { id: "rep-daytona", active: true, sandboxTestEligible: false },
    ])).toThrow("sandbox_routing_representative_not_test_eligible");
    expect(() => validateSandboxRoutingRepresentatives(routing!, [
      { id: "rep-tencent", active: true, sandboxTestEligible: true },
      { id: "rep-daytona", active: true, sandboxTestEligible: true },
    ])).not.toThrow();
  });

  it("produces the same digest for documents with different object-key order", () => {
    const left = parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify(baseDocument),
    });
    const right = parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify({
        representatives: baseDocument.representatives,
        phase1AllowedRepresentativeIds: baseDocument.phase1AllowedRepresentativeIds,
        newIdentityEnabled: {
          tencent: true,
          docker: false,
          daytona: true,
        },
        default: "tencent",
        version: 1,
      }),
    });
    expect(left?.digest).toBe(right?.digest);
  });
});
