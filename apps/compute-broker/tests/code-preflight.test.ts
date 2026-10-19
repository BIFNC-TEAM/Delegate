import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lifecycle-hooks", () => ({ computeLifecycleHooks: { emit: vi.fn() } }));
vi.mock("@delegate/web-data", () => ({ finalizeComputeApprovalConversation: vi.fn() }));
import { normalizeExecutionInput, resolveEffectiveDecision } from "../src/executions";
import { verifyInlineCompiledTask } from "../src/policy";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const context = { session: { runtimeClass: "CODE" }, profile: { networkMode: "full", filesystemMode: "ephemeral_full" }, runtimeAuthority: { compute: { autoApproveTokenLimit: 10000 } } };
describe("code integrity is not execution authority", () => {
  it("rejects approval waits atomically when the caller cannot resume them", () => {
    for (const input of [
      { capability: "browser", browserMode: "deterministic", allowMutations: false },
      { capability: "mcp", serverVerifiedReadOnlyMcp: true, approvalRequired: true },
    ]) {
      expect(resolveEffectiveDecision({ context: context as never, input: { ...input, rejectApprovalWait: true } as never,
        decision: { decision: input.capability === "browser" ? "ask" : "allow", reason: "current_policy" } })).toEqual({ decision: "deny", reason: "caller_cannot_resume_approval" });
    }
    expect(resolveEffectiveDecision({ context: context as never, input: { capability: "browser", browserMode: "deterministic", rejectApprovalWait: true } as never,
      decision: { decision: "allow", reason: "current_policy" } })).toEqual({ decision: "allow", reason: "current_policy" });
  });
  it.each(["print(55)", "import urllib.request\nurllib.request.urlopen('https://example.invalid/side-effect')"])("does not admit arbitrary code solely because both hashes match: %s", source => {
    const request = { capability: "exec" as const, subagentId: "compute-agent" as const, hasPaidEntitlement: false, browserMode: "deterministic" as const, maxSteps: 1, allowMutations: false,
      command: `python -c "import base64;exec(compile(base64.b64decode('${Buffer.from(source).toString("base64")}'),'<pi-agent>','exec'))"`,
      compiledTask: { compilerVersion: "sandbox-task-compiler.v1" as const, instructionHash: hash("run"), codeHash: hash(source), riskClass: "self_contained_compute" as const, compilerProvider: "delegate-pi-runtime" } };
    const integrity = verifyInlineCompiledTask({ input: request, generationInputText: "run" });
    expect(integrity).toBe(true);
    const decision = resolveEffectiveDecision({ context: context as never, input: normalizeExecutionInput(request, undefined, false, integrity), decision: { decision: "allow", reason: "published_policy_allow" } });
    expect(decision).toMatchObject({ decision: "deny", reason: "code_execution_profile_unverified" });
  });
  it.each(["exec", "process"])("does not classify a punctuation-free %s command as harmless", capability => {
    const decision = resolveEffectiveDecision({ context: context as never, input: { capability, command: "curl https://example.invalid/side-effect" } as never, decision: { decision: "allow", reason: "allow" } });
    expect(decision).toMatchObject({ decision: "deny", reason: "code_execution_profile_unverified" });
  });
  it("does not turn an unknown runtime boundary into safety by asking for approval", () => {
    const decision = resolveEffectiveDecision({ context: context as never, input: { capability: "exec", command: "echo hello", serverVerifiedCompiledTask: true } as never, decision: { decision: "ask", reason: "owner_ask" } });
    expect(decision).toMatchObject({ decision: "deny", reason: "code_execution_profile_unverified" });
  });
  it("preserves authorized deterministic public browsing", () => {
    expect(resolveEffectiveDecision({ context: context as never, input: { capability: "browser", browserMode: "deterministic", allowMutations: false, estimatedTokens: 1 } as never,
      decision: { decision: "allow", reason: "owner_allow" } })).toEqual({ decision: "allow", reason: "owner_allow" });
  });
  it.each([false, true])("does not bypass code admission via the OpenCode browser CLI (mutations=%s)", allowMutations => {
    expect(resolveEffectiveDecision({ context: context as never, input: { capability: "browser", browserMode: "native", nativeProvider: "opencode", allowMutations, estimatedTokens: 1 } as never,
      decision: { decision: "allow", reason: "owner_allow" } })).toMatchObject({ decision: "deny", reason: "code_execution_profile_unverified" });
  });
  it("preserves the separate approval rule for typed native browser mutations", () => {
    expect(resolveEffectiveDecision({ context: context as never, input: { capability: "browser", browserMode: "native", nativeProvider: "openai", allowMutations: true, estimatedTokens: 1 } as never,
      decision: { decision: "allow", reason: "owner_allow" } })).toMatchObject({ decision: "ask", reason: "native_browser_mutation_requires_approval" });
  });
});
