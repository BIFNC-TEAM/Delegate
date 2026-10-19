import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("compute broker provider configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("COMPUTE_BROKER_INTERNAL_TOKEN", "test-internal-token");
    vi.stubEnv("SANDBOX_ROUTING_MODE", "legacy");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts All-in-One without requiring a legacy Code tool", async () => {
    vi.stubEnv("TENCENT_AGS_API_KEY", "key");
    vi.stubEnv("TENCENT_AGS_REGION", "ap-guangzhou");
    vi.stubEnv("TENCENT_AGS_DOMAIN", "");
    vi.stubEnv("TENCENT_AGS_CODE_TOOL", "");
    vi.stubEnv("TENCENT_AGS_ALL_IN_ONE_TOOL", " delegate-aio-pi-v1 ");
    vi.stubEnv("SANDBOX_ROUTING_MODE", "manual_poc");
    vi.stubEnv("SANDBOX_PROVIDER_ROUTING_JSON", JSON.stringify({
      version: 1, default: "tencent",
      newIdentityEnabled: { docker: false, daytona: false, tencent: true },
      phase1AllowedRepresentativeIds: [], representatives: {},
    }));
    const { computeBrokerConfig } = await import("../src/config");
    expect(computeBrokerConfig.tencent).toEqual({
      apiKey: "key", domain: "ap-guangzhou.tencentags.com", allInOneTool: "delegate-aio-pi-v1",
    });
  });

  it("treats blank optional Daytona settings as unset", async () => {
    vi.stubEnv("DAYTONA_API_URL", "");
    vi.stubEnv("DAYTONA_SANDBOX_CPU", " ");
    vi.stubEnv("DAYTONA_SANDBOX_MEMORY_GIB", "\t");
    vi.stubEnv("DAYTONA_SANDBOX_DISK_GIB", "");

    const { computeBrokerConfig } = await import("../src/config");

    expect(computeBrokerConfig.daytona).toEqual({});
  });

  it("preserves valid optional Daytona settings", async () => {
    vi.stubEnv("DAYTONA_API_URL", "https://example.daytona.test");
    vi.stubEnv("DAYTONA_SANDBOX_CPU", "2");
    vi.stubEnv("DAYTONA_SANDBOX_MEMORY_GIB", "4");
    vi.stubEnv("DAYTONA_SANDBOX_DISK_GIB", "8");
    vi.stubEnv("DAYTONA_SANDBOX_TTL_MINUTES", "120");

    const { computeBrokerConfig } = await import("../src/config");

    expect(computeBrokerConfig.daytona).toEqual({
      apiUrl: "https://example.daytona.test",
      resources: { cpu: 2, memory: 4, disk: 8 },
      ttlMinutes: 120,
    });
  });

  it.each([{
    provider: "tencent",
    mode: "legacy",
  }, {
    provider: "docker",
    mode: "manual_poc",
  }])("requires cloud routing in production for $provider/$mode", async ({ provider, mode }) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SANDBOX_PROVIDER", provider);
    vi.stubEnv("SANDBOX_ROUTING_MODE", mode);
    vi.stubEnv("SANDBOX_PROVIDER_ROUTING_JSON", JSON.stringify({
      version: 1,
      default: "tencent",
      newIdentityEnabled: { docker: false, daytona: false, tencent: true },
      phase1AllowedRepresentativeIds: [],
      representatives: {},
    }));

    await expect(import("../src/config")).rejects.toThrow(
      "sandbox_cloud_routing_required_in_production",
    );
  });
});
