import { describe, expect, it } from "vitest";

import { SandboxProviderRegistry } from "../src/sandbox-provider-registry";

describe("sandbox provider registry", () => {
  it("falls back only between configured cloud providers", () => {
    expect(() => buildRegistry({ legacyProvider: "daytona" }).resolveLegacyProvider())
      .toThrow("config_invalid");
    expect(buildRegistry({
      legacyProvider: "tencent",
      daytona: { apiKey: "daytona-key" },
    }).resolveLegacyProvider()).toBe("daytona");
    expect(buildRegistry({
      legacyProvider: "docker",
      tencent: {
        apiKey: "key",
        domain: "ap-guangzhou.tencentags.com",
        codeTool: "delegate-code-v1",
      },
    }).resolveLegacyProvider()).toBe("tencent");
  });

  it("does not silently construct an unconfigured cloud provider", async () => {
    const registry = buildRegistry();
    await expect(registry.create("daytona")).rejects.toMatchObject({ code: "AUTH_INVALID" });
    await expect(registry.create("tencent")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("reports Tencent configured only when key, domain, and Tool are present", () => {
    expect(buildRegistry({
      tencent: {
        apiKey: "key",
        domain: "ap-guangzhou.tencentags.com",
        codeTool: "delegate-code-v1",
      },
    }).configured("tencent")).toBe(true);
    expect(buildRegistry({ tencent: { apiKey: "key" } }).configured("tencent")).toBe(false);
  });
});

function buildRegistry(overrides: Partial<ConstructorParameters<typeof SandboxProviderRegistry>[0]> = {}) {
  return new SandboxProviderRegistry({
    legacyProvider: "docker",
    sandboxLifecycle: {
      idleStopMinutes: 15,
      autoArchiveMinutes: 60,
      autoDeleteMinutes: -1,
    },
    daytona: {},
    tencent: {},
    ...overrides,
  });
}
