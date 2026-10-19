import type { ComputeNetworkMode } from "@delegate/compute-protocol";
import { SandboxProviderError } from "./sandbox-provider";

export type TencentSandboxTools = {
  codeTool?: string | undefined;
  allInOneTool?: string | undefined;
};

export function resolveTencentSandboxTool(config: TencentSandboxTools, networkMode: ComputeNetworkMode) {
  if (networkMode === "allowlist") throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
  if (config.allInOneTool) {
    // AIO inherits the tool's network mode. E2B allowInternetAccess=false is
    // ignored by the current AIO service; never silently use a PUBLIC tool.
    if (networkMode === "no_network") {
      throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
    }
    return config.allInOneTool;
  }
  if (!config.codeTool) throw new SandboxProviderError("CONFIG_INVALID", false);
  return config.codeTool;
}

/** The lease's baseImage describes its actual runtime selection. Tencent uses
 * a tool, not the requested Docker image. Include both to retain policy/cache
 * isolation without rewriting ComputeSession's published image contract. */
export function buildTencentLeaseImage(input: {
  domain?: string | undefined;
  tool: string;
  image: string;
}) {
  return `tencent://${input.domain ?? ""}/${encodeURIComponent(input.tool)}?image=${encodeURIComponent(input.image)}`;
}
