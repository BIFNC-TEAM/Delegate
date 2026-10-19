import type { CodeExecutionPreflight, ComputeFilesystemMode, ComputeNetworkMode } from "@delegate/compute-protocol";
import { generalCodeExecutionAvailability } from "@delegate/compute-protocol";
import { computeBrokerConfig } from "./config";

export function requiresGeneralCodeProfile(input: { capability: string; browserMode?: string; nativeProvider?: string | undefined }) {
  return input.capability === "exec" || input.capability === "process"
    || (input.capability === "browser" && input.browserMode === "native" && input.nativeProvider === "opencode");
}

/** No current adapter has a registered, verified general-code profile covering
 * ALL these controls. PUBLIC AIO's permitted egress is not a no-side-effect
 * boundary; SDK timeouts do not prove descendant termination. Keep this gate
 * closed until an implementation and real environment evidence support it.
 * Owner approval, code hashes, compiler labels and environment flags cannot
 * register a profile. Controlled browser commands use their separate contract. */
export function evaluateCodeExecutionPreflight(input: {
  networkMode: ComputeNetworkMode;
  filesystemMode: ComputeFilesystemMode;
}): CodeExecutionPreflight {
  return {
    ...generalCodeExecutionAvailability,
    codeClassification: "untrusted_code",
    requestedNetworkMode: input.networkMode,
    requestedFilesystemMode: input.filesystemMode,
    requiredControls: ["network", "filesystem", "credentials", "resources", "session_state"],
  };
}

/** A distinct structured path, never a permit for exec/process commands. The
 * launcher fails closed if actual runtime controls cannot be installed. */
export function evaluatePythonExecutionPreflight(input: {
  networkMode: ComputeNetworkMode;
  filesystemMode: ComputeFilesystemMode;
  maxCommandSeconds?: number;
}): CodeExecutionPreflight {
  const configured = Boolean(computeBrokerConfig.tencent.apiKey && computeBrokerConfig.tencent.domain && computeBrokerConfig.tencent.allInOneTool);
  const available = configured && input.filesystemMode === "ephemeral_full";
  return { ...evaluateCodeExecutionPreflight(input), available,
    profileId: available ? "delegate.aio.single-python.v1" : null,
    maximumDurationMs: Math.max(100, Math.min(30000, (input.maxCommandSeconds ?? 30) * 1000)),
    reason: available ? "code_execution_profile_verified" : "code_execution_profile_unverified" };
}
