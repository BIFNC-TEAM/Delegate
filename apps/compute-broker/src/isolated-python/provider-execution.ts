import { createHash, randomUUID } from "node:crypto";
import { isolatedPythonRequestSchema } from "@delegate/compute-protocol";
import type { SandboxProvider } from "../sandbox-provider";
import type { TencentAgsxSandboxLike } from "../tencent-agsx-provider";
import { executeIsolatedPython, IsolatedPythonExecutionError } from "./transport";

export type PythonProviderInput = Parameters<NonNullable<SandboxProvider["executeIsolatedPython"]>>[0];

/** Only for a fresh, exclusive lease. Source is never sent to the raw command mapper. */
export async function executePythonOnExclusiveSandbox(sandbox: TencentAgsxSandboxLike, input: PythonProviderInput) {
  const request = isolatedPythonRequestSchema.parse(input.request);
  if (input.inputs.length !== request.inputs.length
    || new Set(request.inputs.map(item => item.fileName)).size !== request.inputs.length
    || input.inputs.reduce((size, item) => size + item.content.byteLength, 0) > 20 * 1024 * 1024) {
    throw new IsolatedPythonExecutionError("isolated_python_manifest_mismatch", false, null);
  }
  for (const [index, item] of input.inputs.entries()) {
    const declared = request.inputs[index]!;
    if (item.fileName !== declared.fileName || item.content.byteLength !== declared.sizeBytes
      || createHash("sha256").update(item.content).digest("hex") !== declared.checksum) {
      throw new IsolatedPythonExecutionError("isolated_python_manifest_mismatch", false, null);
    }
  }
  input.signal.throwIfAborted();
  const directory = `/home/user/workspace/python-inputs-${randomUUID()}`;
  const prepared = await sandbox.commands.run(`/usr/bin/mkdir -m 700 '${directory}'`, { timeoutMs: 5000, requestTimeoutMs: 10000 });
  if (prepared.exitCode !== 0) throw new IsolatedPythonExecutionError("isolated_python_input_prepare_failed", false, null);
  // The exclusive lease is retired after each action. No mutable upload API or
  // another execution is allowed to access this directory while it is mounted.
  for (const item of input.inputs) {
    input.signal.throwIfAborted();
    const path = `${directory}/${item.fileName}`;
    await sandbox.files.write(path, Uint8Array.from(item.content).buffer, { requestTimeoutMs: 10000 });
    const copied = await sandbox.files.read(path, { format: "bytes", requestTimeoutMs: 10000 });
    if (!Buffer.from(copied).equals(item.content)) throw new IsolatedPythonExecutionError("isolated_python_input_transfer_mismatch", false, null);
  }
  return executeIsolatedPython({ sandbox, source: request.source, inputDirectory: directory,
    wallMs: request.timeoutMs, signal: input.signal, onPrepared: input.beforeDispatch });
}
