import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAudienceTool } from "../src/compute-client";
const request = { capability: "mcp" as const, subagentId: "compute-agent" as const, hasPaidEntitlement: false, browserMode: "deterministic" as const,
  maxSteps: 1, allowMutations: false, rejectApprovalWait: true, logicalAction: { version: 1 as const, ordinal: 1 } };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("V2 broker feature contract", () => {
  it("does not send an execution to an older broker that would strip the restriction", async () => {
    vi.stubEnv("COMPUTE_BROKER_INTERNAL_TOKEN", "local-test-token");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 })); vi.stubGlobal("fetch", fetch);
    await expect(executeAudienceTool("session", request)).rejects.toThrow("does not support");
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![0]).toContain("/features");
  });
  it("sends the monotonic restriction only after feature confirmation", async () => {
    vi.stubEnv("COMPUTE_BROKER_INTERNAL_TOKEN", "local-test-token");
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"rejectApprovalWait":1}', { status: 200 })).mockResolvedValueOnce(new Response('{"outcome":"failed"}', { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await executeAudienceTool("session", request);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({ rejectApprovalWait: true, logicalAction: { ordinal: 1 } });
  });
});
