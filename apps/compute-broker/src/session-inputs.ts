import { createHash } from "node:crypto";
import { z } from "zod";

import { ensureComputeSessionLease } from "./leases";
import { loadSessionPolicyContext } from "./policy";
import { writeSandboxLeaseInput } from "./sandbox-leases";
import { SessionError } from "./session-error";

const inputFileSchema = z.object({
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  base64: z.string().min(1).max(14 * 1024 * 1024),
}).strict();

export async function uploadComputeSessionInput(sessionId: string, rawInput: unknown) {
  const input = inputFileSchema.parse(rawInput);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.base64)) {
    throw new SessionError(400, "sandbox_input_base64_invalid");
  }
  const content = Buffer.from(input.base64, "base64");
  if (content.byteLength !== input.sizeBytes) {
    throw new SessionError(409, "sandbox_input_size_mismatch");
  }
  const checksum = createHash("sha256").update(content).digest("hex");
  if (checksum !== input.checksum) {
    throw new SessionError(409, "sandbox_input_checksum_mismatch");
  }
  const context = await loadSessionPolicyContext(sessionId);
  const leased = await ensureComputeSessionLease({
    session: context.session,
    networkMode: context.profile.networkMode,
    networkAllowlist: context.profile.networkAllowlist,
    filesystemMode: context.profile.filesystemMode,
  });
  if (!leased.sandboxLeaseId) throw new SessionError(409, "sandbox_input_runtime_unavailable");
  const transfer = await writeSandboxLeaseInput({
    leaseId: leased.sandboxLeaseId,
    sessionId: leased.id,
    path: `/workspace/inputs/${input.fileName}`,
    content,
  });
  return {
    fileName: input.fileName,
    sandboxPath: `/workspace/inputs/${input.fileName}`,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    checksum,
    transferDurationMs: transfer.durationMs,
    provider: transfer.provider,
  };
}
