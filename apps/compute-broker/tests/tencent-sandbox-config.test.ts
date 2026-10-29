import { describe, expect, it } from "vitest";
import { buildTencentLeaseImage, resolveTencentSandboxTool } from "../src/tencent-sandbox-config";

describe("Tencent template selection", () => {
  it("retains Code compatibility until All-in-One is configured", () => {
    expect(resolveTencentSandboxTool({ codeTool: "legacy" }, "no_network")).toBe("legacy");
    expect(resolveTencentSandboxTool({ codeTool: "legacy", allInOneTool: "aio" }, "full")).toBe("aio");
    expect(() => resolveTencentSandboxTool({}, "full")).toThrow("config_invalid");
  });

  it("separates template, region and requested-image changes from old image-only leases", () => {
    const input = { domain: "ap-guangzhou.tencentags.com", tool: "aio-v1", image: "debian:bookworm-slim" };
    const key = buildTencentLeaseImage(input);
    expect(key).not.toBe(input.image);
    expect(buildTencentLeaseImage({ ...input })).toBe(key);
    for (const change of [{ tool: "aio-v2" }, { domain: "ap-shanghai.tencentags.com" }, { image: "browser:1" }]) {
      expect(buildTencentLeaseImage({ ...input, ...change })).not.toBe(key);
    }
  });
});
