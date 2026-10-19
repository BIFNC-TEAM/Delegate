import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executePythonOnExclusiveSandbox, type PythonProviderInput } from "../src/isolated-python/provider-execution";
import type { TencentAgsxSandboxLike } from "../src/tencent-agsx-provider";

function fixture() {
  const bytes = Buffer.from("/workspace/outputs is data, not a host path\n");
  const file = { fileName: "data.txt", content: bytes };
  const write = vi.fn(async () => undefined), read = vi.fn(async () => bytes);
  const run = vi.fn(async (command: string) => ({ exitCode: 0, stderr: "", stdout: command.includes("--source-base64") ? JSON.stringify({
    profile: "delegate.aio.single-python.v1", termination: "exit", exitCode: 0, stdout: bytes.toString(), stderr: "", cleanupConfirmed: true,
    namespace: { ready: true, pidNamespace: "pid:[1]", netNamespace: "net:[2]" },
  }) : "" }));
  const sandbox = { sandboxId: "synthetic", files: { write, read }, commands: { run }, kill: vi.fn(), pause: vi.fn() } as unknown as TencentAgsxSandboxLike;
  const input: PythonProviderInput = { lease: {} as never, request: { profileId: "delegate.aio.single-python.v1", actionKey: "a", source: "print('/workspace/outputs')", timeoutMs: 1000,
    inputs: [{ attachmentId: "a", fileName: file.fileName, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") }] }, inputs: [file],
    signal: new AbortController().signal, beforeDispatch: vi.fn(async () => undefined) };
  return { input, sandbox, run, write, read, bytes };
}
describe("typed provider execution", () => {
  it("preserves code/output bytes and rechecks trusted authorization before dispatch", async () => {
    const f = fixture(); const result = await executePythonOnExclusiveSandbox(f.sandbox, f.input);
    expect(result.stdout).toBe(f.bytes.toString()); expect(f.input.beforeDispatch).toHaveBeenCalledOnce();
    expect(f.run.mock.calls.filter(([command]) => command.includes("--source-base64"))).toHaveLength(1);
    expect(f.run.mock.calls.find(([command]) => command.includes("--source-base64"))![0]).toContain(Buffer.from(f.input.request.source).toString("base64"));
  });
  it("does not create a directory or upload when bytes do not match the manifest", async () => {
    const f = fixture(); f.input.inputs[0]!.content = Buffer.from("changed");
    await expect(executePythonOnExclusiveSandbox(f.sandbox, f.input)).rejects.toThrow("manifest_mismatch"); expect(f.run).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
  });
  it("does not run code when upload verification fails", async () => {
    const f = fixture(); f.read.mockResolvedValue(Buffer.from("changed"));
    await expect(executePythonOnExclusiveSandbox(f.sandbox, f.input)).rejects.toThrow("transfer_mismatch"); expect(f.run.mock.calls.some(([command]) => command.includes("--source-base64"))).toBe(false);
  });
  it("awaits asynchronous permission rejection without submitting the program", async () => {
    const f = fixture(); f.input.beforeDispatch = async () => { await Promise.resolve(); throw new Error("private_authorization_reason"); };
    await expect(executePythonOnExclusiveSandbox(f.sandbox, f.input)).rejects.toMatchObject({ mayHaveExecuted: false, code: "isolated_python_transport_failed" });
    expect(f.run.mock.calls.some(([command]) => command.includes("--source-base64"))).toBe(false);
  });
});
