import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContextAuthorizationError } from "@delegate/runtime";
import { executeNativeComputerUseLoop } from "../src/native-browser";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("native model context boundary", () => {
  it.each(["openai", "anthropic"] as const)("withholds retained context from %s when authorization is withdrawn", async provider => {
    vi.stubEnv("COMPUTE_NATIVE_OPENAI_ENABLED", "true"); vi.stubEnv("COMPUTE_NATIVE_OPENAI_MODEL", "synthetic-model"); vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
    vi.stubEnv("COMPUTE_NATIVE_ANTHROPIC_ENABLED", "true"); vi.stubEnv("COMPUTE_NATIVE_ANTHROPIC_MODEL", "synthetic-model"); vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key");
    const send = vi.fn(); vi.stubGlobal("fetch", send); const execute = vi.fn();
    const authorizeContext = vi.fn(async () => { throw new AgentContextAuthorizationError(); });
    await expect(executeNativeComputerUseLoop({ provider, task: "SYNTHETIC_PRIVATE_CANARY", maxSteps: 1, allowMutations: false,
      screenshotBase64: "AA==", screenshotMimeType: "image/png", executeActionBatch: execute, authorizeContext }))
      .rejects.toThrow("agent_context_authorization_failed");
    expect(authorizeContext).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});
