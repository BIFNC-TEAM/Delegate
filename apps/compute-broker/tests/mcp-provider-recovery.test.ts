import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContextAuthorizationError } from "@delegate/runtime";
import type { McpProviderOperation } from "@delegate/compute-protocol";
import { callRemoteMcpTool, queryRemoteMcpOperation } from "../src/mcp";
import { providerFingerprint } from "../src/mcp-recovery-contract";
import { fixtureRecoveryContract, startRecoveryFixture } from "./mcp-recovery-fixture";
let fixture: Awaited<ReturnType<typeof startRecoveryFixture>>;
beforeEach(async () => { vi.stubEnv("DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS", "true"); fixture = await startRecoveryFixture(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixture.close(); });
function request(kind: "argument" | "header" = "argument") {
  const args = { amount: 7 };
  const operation: McpProviderOperation = { contract: fixtureRecoveryContract(kind), key: "delegate:original-action", argumentsHash: providerFingerprint(args), expiresAt: new Date(Date.now()+60000).toISOString() };
  return { binding: { id: "fixture", slug: "fixture", displayName: "Synthetic", serverUrl: fixture.url, transportKind: "streamable_http" as const,
    defaultToolName: "submit", allowedToolNames: ["submit", "status", "read"], maxRetries: 1, retryBackoffMs: 0 }, toolArguments: args, providerOperation: operation };
}
const submits = () => fixture.calls.filter(call => call.name === "submit");
const queries = () => fixture.calls.filter(call => call.name === "status");
describe("provider recovery over real local MCP HTTP", () => {
  it.each(["argument", "header"] as const)("recovers a lost response by the original %s key without resubmission", async kind => {
    fixture.controls.dropSubmissions = 1;
    const result = await callRemoteMcpTool(request(kind));
    expect(result.providerState).toBe("succeeded"); expect(result.recoveredByQuery).toBe(true);
    expect(submits()).toHaveLength(1); expect(queries()).toHaveLength(1); expect(fixture.effects.size).toBe(1);
    expect(queries()[0]!.arguments).toEqual({ query_key: "delegate:original-action" });
    expect(kind === "header" ? submits()[0]!.header : submits()[0]!.arguments?.request_key).toBe("delegate:original-action");
    expect(fixture.calls.filter(call => call.name !== "submit").every(call => !call.header)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PROVIDER_PRIVATE_DEBUG");
  });
  it("reuses the original payload/key when lookup is temporarily not_found; it never infers no effect", async () => {
    fixture.controls.dropSubmissions = 1; fixture.controls.status = "not_found";
    const input = request(); fixture.controls.onSubmit = () => { input.toolArguments.amount = 999; };
    const result = await callRemoteMcpTool(input);
    expect(result.providerState).toBe("succeeded"); expect(submits()).toHaveLength(2); expect(queries()).toHaveLength(1); expect(fixture.effects.size).toBe(1);
    expect(submits().map(call => call.arguments)).toEqual([{ amount: 7, request_key: "delegate:original-action" }, { amount: 7, request_key: "delegate:original-action" }]);
  });
  it.each(["pending", "failed_no_effect"])("does not resubmit after provider status %s", async state => {
    fixture.controls.dropSubmissions = 1; fixture.controls.status = state;
    expect((await callRemoteMcpTool(request())).providerState).toBe(state); expect(submits()).toHaveLength(1); expect(fixture.effects.size).toBe(0);
  });
  it("does not send a different key or resubmit once its guaranteed retention window expires", async () => {
    const input = request(); fixture.controls.dropSubmissions = 1; fixture.controls.status = "not_found";
    const now = Date.now(); fixture.controls.onSubmit = () => { vi.spyOn(Date, "now").mockReturnValue(now + 61000); };
    await expect(callRemoteMcpTool(input)).rejects.toThrow("mcp_provider_key_expired");
    expect(submits()).toHaveLength(1); expect(queries()).toHaveLength(1); expect(fixture.effects.size).toBe(1);
  });
  it("keeps a contract-less lost submission unknown despite retry configuration", async () => {
    const input = request(); fixture.controls.dropSubmissions = 1; input.providerOperation.contract = { version: 1, id: "none", mode: "none" };
    await expect(callRemoteMcpTool({ ...input, retrySafe: true })).rejects.toThrow("mcp_");
    expect(submits()).toHaveLength(1); expect(queries()).toHaveLength(0); expect(fixture.effects.size).toBe(1);
  });
  it("rejects changed payloads and model-provided managed keys before any request", async () => {
    const input = request(); input.toolArguments.amount = 8;
    await expect(callRemoteMcpTool(input)).rejects.toThrow("mcp_provider_request_changed"); expect(fixture.calls).toHaveLength(0);
    const args = { amount: 7, request_key: "model-selected" };
    await expect(callRemoteMcpTool({ ...request(), toolArguments: args, providerOperation: { ...request().providerOperation, argumentsHash: providerFingerprint(args) } })).rejects.toThrow("managed_key_conflict");
    expect(fixture.calls).toHaveLength(0);
  });
  it("stops when a status response refers to a different operation", async () => {
    fixture.controls.dropSubmissions = 1; fixture.controls.wrongStatusKey = true;
    await expect(callRemoteMcpTool(request())).rejects.toThrow("receipt_unverified"); expect(submits()).toHaveLength(1); expect(fixture.effects.size).toBe(1);
  });
  it("reauthorizes every real outbound retry and stops before the revoked second read", async () => {
    fixture.controls.dropReads = 1; const input = request(); let checks = 0;
    input.providerOperation.contract = { version: 1, id: "read", mode: "natural_read" };
    await expect(callRemoteMcpTool({ ...input, requestedToolName: "read", retrySafe: true, onBeforeToolCall: async () => { if (++checks > 1) throw new AgentContextAuthorizationError(); } })).rejects.toThrow("authorization_failed");
    expect(checks).toBe(2); expect(fixture.calls.filter(call => call.name === "read")).toHaveLength(1);
  });
  it("rejects an unverified contract instead of sending keys as authorization headers", async () => {
    const input = request("header");
    input.providerOperation.contract = { ...input.providerOperation.contract, key: { kind: "header", name: "authorization" } } as never;
    await expect(callRemoteMcpTool(input)).rejects.toThrow("contract_invalid"); expect(fixture.calls).toHaveLength(0);
  });
  it("honors zero configured retries even for naturally idempotent reads", async () => {
    const input = request(); input.binding.maxRetries = 0; input.providerOperation.contract = { version: 1, id: "read", mode: "natural_read" };
    fixture.controls.dropReads = 1;
    await expect(callRemoteMcpTool({ ...input, requestedToolName: "read" })).rejects.toThrow("mcp_");
    expect(fixture.calls.filter(call => call.name === "read")).toHaveLength(1);
  });
  it("keeps a direct processing acknowledgement pending without a duplicate submission", async () => {
    fixture.controls.status = "pending";
    const result = await callRemoteMcpTool(request());
    expect(result.providerState).toBe("pending"); expect(submits()).toHaveLength(1); expect(queries()).toHaveLength(0); expect(fixture.effects.size).toBe(0);
  });
  it("refuses to use the submission tool itself as a supposedly read-only status query", async () => {
    const input = request();
    if (input.providerOperation.contract.mode !== "keyed" || !input.providerOperation.contract.query) throw new Error("fixture contract missing");
    input.providerOperation.contract.query.toolName = "submit";
    await expect(callRemoteMcpTool(input)).rejects.toThrow("contract_invalid"); expect(fixture.calls).toHaveLength(0);
  });
  it("minimizes the low-level query summary and withholds an unrelated receipt key", async () => {
    const input = request(); await callRemoteMcpTool(input);
    const found = await queryRemoteMcpOperation({ binding: input.binding, operation: input.providerOperation });
    expect(found.state).toBe("succeeded"); expect(JSON.stringify(found)).not.toContain("SYNTHETIC_PROVIDER_PRIVATE_DEBUG");
    fixture.controls.wrongStatusKey = true;
    const unverified = await queryRemoteMcpOperation({ binding: input.binding, operation: input.providerOperation });
    expect(unverified.state).toBe("unknown"); expect(JSON.stringify(unverified)).not.toContain("wrong-operation");
  });
});
