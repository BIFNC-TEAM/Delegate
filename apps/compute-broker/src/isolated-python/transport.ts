import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { TencentAgsxSandboxLike } from "../tencent-agsx-provider";

export const isolatedPythonProfile = "delegate.aio.single-python.v1";
const receiptSchema = z.object({
  profile: z.literal(isolatedPythonProfile),
  termination: z.enum(["exit", "command_timeout", "output_limit", "cancelled", "setup_failed", "setup_timeout", "cleanup_unconfirmed", "invalid_output"]),
  exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), cleanupConfirmed: z.boolean(),
  wallMs: z.number().nonnegative().optional(), setupError: z.string().regex(/^[a-z0-9_]{1,100}$/u).optional(),
  namespace: z.object({ ready: z.literal(true), pidNamespace: z.string().regex(/^pid:\[\d+\]$/u), netNamespace: z.string().regex(/^net:\[\d+\]$/u) }).optional(),
});
export type IsolatedPythonReceipt = z.infer<typeof receiptSchema>;

export class IsolatedPythonExecutionError extends Error {
  constructor(readonly code: string, readonly mayHaveExecuted: boolean, readonly controlDirectory: string | null) {
    super(code);
    this.name = "IsolatedPythonExecutionError";
  }
}

/** Fixed, trusted bootstrap. Caller must supply a new/scoped CODE environment.
 * This component deliberately does NOT register or enable the Broker profile. */
export async function executeIsolatedPython(input: {
  sandbox: TencentAgsxSandboxLike; source: string; inputDirectory: string;
  wallMs?: number; outputBytes?: number; signal?: AbortSignal;
  /** Trusted control-plane diagnostics/reconciliation only; never Agent input. */
  onPrepared?: (controlDirectory: string) => void | Promise<void>;
}): Promise<IsolatedPythonReceipt> {
  const wallMs = input.wallMs ?? 5000;
  const outputBytes = input.outputBytes ?? 65536;
  if (!Number.isInteger(wallMs) || wallMs < 100 || wallMs > 30000 || !Number.isInteger(outputBytes) || outputBytes < 1 || outputBytes > 65536
    || typeof input.source !== "string" || !input.source || Buffer.byteLength(input.source) > 65536 || typeof input.inputDirectory !== "string" || !/^\/home\/user\/workspace\/[A-Za-z0-9/_-]+$/u.test(input.inputDirectory)
    || input.inputDirectory.includes("..")) throw new IsolatedPythonExecutionError("isolated_python_input_invalid", false, null);
  input.signal?.throwIfAborted();
  const folder = `/tmp/delegate-bootstrap-${randomUUID()}`;
  const launcher = await readFile(new URL("./launcher.py", import.meta.url)).catch(() => {
    throw new IsolatedPythonExecutionError("isolated_python_bootstrap_unavailable", false, null);
  });
  let cancelRequest: Promise<unknown> | undefined;
  const cancel = () => { cancelRequest ??= input.sandbox.files.write(`${folder}/cancel`, Uint8Array.from(Buffer.from("cancel")).buffer, { requestTimeoutMs: 5000 }).catch(() => undefined); };
  let sent = false;
  let cleanupConfirmed = false;
  try {
    const prepared = await input.sandbox.commands.run(`/usr/bin/mkdir -m 700 '${folder}'`, { timeoutMs: 5000, requestTimeoutMs: 10000 });
    if (prepared.exitCode !== 0) throw new IsolatedPythonExecutionError("isolated_python_bootstrap_unavailable", false, folder);
    await input.sandbox.files.write(`${folder}/launcher.py`, Uint8Array.from(launcher).buffer, { requestTimeoutMs: 10000 });
    input.signal?.throwIfAborted();
    await input.onPrepared?.(folder);
    input.signal?.throwIfAborted();
    input.signal?.addEventListener("abort", cancel, { once: true });
    const command = `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/python3 -I -S '${folder}/launcher.py' --source-base64 '${Buffer.from(input.source).toString("base64")}' --inputs '${input.inputDirectory}' --wall-ms ${wallMs} --output-bytes ${outputBytes} --cancel-file '${folder}/cancel' --state-file '${folder}/state.json'`;
    sent = true;
    const result = await input.sandbox.commands.run(command, { timeoutMs: wallMs + 20000, requestTimeoutMs: wallMs + 25000 });
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 512 * 1024) throw new IsolatedPythonExecutionError("isolated_python_receipt_invalid", true, folder);
    const receipt = receiptSchema.parse(JSON.parse(result.stdout));
    if (!receipt.cleanupConfirmed || (receipt.termination === "exit" && (!receipt.namespace || receipt.exitCode === null || receipt.setupError))
      || (receipt.termination !== "exit" && receipt.exitCode !== null)
      || Buffer.byteLength(receipt.stdout) > outputBytes || Buffer.byteLength(receipt.stderr) > outputBytes) {
      throw new IsolatedPythonExecutionError("isolated_python_receipt_invalid", true, folder);
    }
    cleanupConfirmed = true;
    return receipt;
  } catch (error) {
    if (sent) cancel();
    if (error instanceof IsolatedPythonExecutionError) throw error;
    // Never propagate SDK exceptions or a JSON parse excerpt containing output.
    throw new IsolatedPythonExecutionError(input.signal?.aborted && !sent ? "isolated_python_cancelled_before_dispatch" : "isolated_python_transport_failed", sent, folder);
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    await cancelRequest;
    // Only this unguessable trusted bootstrap directory, never a user workspace.
    if (!sent || cleanupConfirmed) await input.sandbox.commands.run(`/usr/bin/rm -rf -- '${folder}'`, { timeoutMs: 5000, requestTimeoutMs: 10000 }).catch(() => undefined);
  }
}
