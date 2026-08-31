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

    const { computeBrokerConfig } = await import("../src/config");

    expect(computeBrokerConfig.daytona).toEqual({
      apiUrl: "https://example.daytona.test",
      resources: { cpu: 2, memory: 4, disk: 8 },
    });
  });
});
