import { describe, expect, it, vi } from "vitest";
import { executeIsolatedPython, IsolatedPythonExecutionError, isolatedPythonProfile } from "../src/isolated-python/transport";

function fixture(value: Record<string, unknown> = {}) {
  const receipt = { profile: isolatedPythonProfile, termination: "exit", exitCode: 0, stdout: "1012\n", stderr: "", cleanupConfirmed: true,
    namespace: { ready: true, pidNamespace: "pid:[42]", netNamespace: "net:[43]" }, ...value };
  const run = vi.fn(async (command: string) => ({ exitCode: 0, stdout: command.includes("--source-base64") ? JSON.stringify(receipt) : "", stderr: "" }));
  const write = vi.fn(async (_path: string, _content: ArrayBuffer, _options?: { requestTimeoutMs?: number }) => undefined);
  const sandbox = { sandboxId: "fixture", commands: { run }, files: { write, read: vi.fn() }, pause: vi.fn(), kill: vi.fn() };
  const request = { sandbox, source: "print(1+2+1009)", inputDirectory: "/home/user/workspace/session-inputs" };
  return { request, run, write };
}

describe("isolated Python trusted transport (mock RPC, real command assembly)", () => {
  it("sends source as data to a fixed bootstrap and only releases a coherent receipt", async () => {
    const { request, run, write } = fixture();
    const source = "print('value with $(literal) and quotes')";
    expect(await executeIsolatedPython({ ...request, source })).toMatchObject({ termination: "exit", stdout: "1012\n", cleanupConfirmed: true });
    const command = run.mock.calls.find(call => call[0].includes("--source-base64"))![0];
    expect(command).toContain(Buffer.from(source).toString("base64")); expect(command).not.toContain("$(literal)");
    expect(command).toContain("/usr/bin/env -i"); expect(write).toHaveBeenCalledOnce();
    expect(run.mock.calls.at(-1)![0]).toMatch(/^\/usr\/bin\/rm -rf -- '\/tmp\/delegate-bootstrap-[a-f0-9-]+'$/);
  });
  it.each([
    { inputDirectory: "/etc" }, { inputDirectory: "/home/user/workspace/../secret" }, { wallMs: 0 }, { wallMs: 30001 }, { outputBytes: 65537 }, { source: "a".repeat(65537) },
  ])("rejects invalid input before any RPC: %j", async change => {
    const { request, run, write } = fixture();
    await expect(executeIsolatedPython({ ...request, ...change })).rejects.toMatchObject({ code: "isolated_python_input_invalid", mayHaveExecuted: false });
    expect(run).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it.each([
    { cleanupConfirmed: false }, { namespace: undefined }, { exitCode: null }, { termination: "command_timeout", exitCode: 0 }, { stdout: "x".repeat(65537) }, { profile: "untrusted" },
  ])("withholds malformed/incomplete receipts and retains cancellation state: %j", async change => {
    const { request, run, write } = fixture(change);
    await expect(executeIsolatedPython(request)).rejects.toBeInstanceOf(IsolatedPythonExecutionError);
    expect(write.mock.calls.some(call => String(call[0]).endsWith("/cancel"))).toBe(true);
    expect(run.mock.calls.some(call => call[0].startsWith("/usr/bin/rm"))).toBe(false);
  });
  it("does not submit source after a cancellation during bootstrap preparation", async () => {
    const { request, run } = fixture(); const controller = new AbortController();
    await expect(executeIsolatedPython({ ...request, signal: controller.signal, onPrepared: () => controller.abort() }))
      .rejects.toMatchObject({ code: "isolated_python_cancelled_before_dispatch", mayHaveExecuted: false });
    expect(run.mock.calls.some(call => call[0].includes("--source-base64"))).toBe(false);
  });
  it("does not expose a private transport exception or replay uncertain execution", async () => {
    const { request, run } = fixture();
    run.mockImplementation(async command => { if (command.includes("--source-base64")) throw new Error("PRIVATE_SDK_TOKEN_SYNTHETIC"); return { exitCode: 0, stdout: "", stderr: "" }; });
    const error = await executeIsolatedPython(request).catch(value => value);
    expect(error).toMatchObject({ code: "isolated_python_transport_failed", mayHaveExecuted: true });
    expect(String(error)).not.toContain("PRIVATE_SDK_TOKEN_SYNTHETIC");
    expect(run.mock.calls.filter(call => call[0].includes("--source-base64"))).toHaveLength(1);
  });
});
