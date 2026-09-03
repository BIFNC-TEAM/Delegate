import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseSandboxRoutingConfig } from "../src/sandbox-routing";

const { mockPrisma, mockRegistry, mockConfig } = vi.hoisted(() => ({
  mockPrisma: {
    sandboxIdentity: { groupBy: vi.fn() },
    representative: { findMany: vi.fn() },
  },
  mockRegistry: {
    configured: vi.fn(),
  },
  mockConfig: {
    sandboxRoutingMode: "legacy" as "legacy" | "manual_poc",
    sandboxRouting: null as ReturnType<typeof parseSandboxRoutingConfig>,
  },
}));

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../src/config", () => ({ computeBrokerConfig: mockConfig }));
vi.mock("../src/sandbox-leases", () => ({
  createConfiguredProviderRegistry: () => mockRegistry,
}));

describe("sandbox readiness", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfig.sandboxRoutingMode = "legacy";
    mockConfig.sandboxRouting = null;
    mockPrisma.sandboxIdentity.groupBy.mockResolvedValue([]);
    mockPrisma.representative.findMany.mockResolvedValue([]);
    mockRegistry.configured.mockImplementation((provider: string) => provider === "docker");
    const { clearSandboxReadinessCache } = await import("../src/sandbox-readiness");
    clearSandboxReadinessCache();
  });

  it("reports an unavailable adapter for an active pinned identity", async () => {
    mockPrisma.sandboxIdentity.groupBy.mockResolvedValue([{ provider: "TENCENT" }]);
    const { getSandboxReadinessSnapshot } = await import("../src/sandbox-readiness");
    const result = await getSandboxReadinessSnapshot({ force: true });
    expect(result).toMatchObject({
      status: "degraded",
      pinnedProviders: ["tencent"],
      reasons: ["pinned_provider_unavailable:tencent"],
    });
  });

  it("reports only cloud providers as configured for new identities", async () => {
    mockRegistry.configured.mockImplementation((provider: string) =>
      provider === "docker" || provider === "tencent");
    const { getSandboxReadinessSnapshot } = await import("../src/sandbox-readiness");
    const result = await getSandboxReadinessSnapshot({ force: true });
    expect(result.configuredProviders).toEqual(["tencent"]);
  });

  it("validates manual PoC representatives and enabled providers", async () => {
    mockConfig.sandboxRoutingMode = "manual_poc";
    mockConfig.sandboxRouting = parseSandboxRoutingConfig({
      mode: "manual_poc",
      rawDocument: JSON.stringify({
        version: 1,
        default: "tencent",
        newIdentityEnabled: { docker: false, daytona: false, tencent: true },
        phase1AllowedRepresentativeIds: ["rep-test"],
        representatives: {},
      }),
    });
    mockPrisma.representative.findMany.mockResolvedValue([{
      id: "rep-test",
      sandboxTestEligible: false,
      lifecycleState: "PUBLISHED",
    }]);
    const { getSandboxReadinessSnapshot } = await import("../src/sandbox-readiness");
    const result = await getSandboxReadinessSnapshot({ force: true });
    expect(result.status).toBe("degraded");
    expect(result.reasons).toContain("sandbox_routing_representative_not_test_eligible");
    expect(result.reasons).toContain("new_identity_provider_unavailable:tencent");
  });
});
