import { createHash } from "node:crypto";
import { isolatedPythonRequestSchema, type IsolatedPythonRequest } from "@delegate/compute-protocol";
import { buildSandboxAttachmentFileName, loadGenerationInputAttachments } from "@delegate/web-data";
import { validateAgentTextOutputRequest } from "@delegate/runtime";
import { prisma } from "../prisma";
import { SessionError } from "../session-error";

export function validatePythonRequest(value: unknown): IsolatedPythonRequest {
  const request = isolatedPythonRequestSchema.parse(value);
  if (Buffer.byteLength(request.source) > 65536
    || new Set(request.inputs.map(item => item.attachmentId)).size !== request.inputs.length
    || new Set(request.inputs.map(item => item.fileName)).size !== request.inputs.length
    || request.inputs.reduce((sum, item) => sum + item.sizeBytes, 0) > 20 * 1024 * 1024) {
    throw new SessionError(400, "isolated_python_request_invalid");
  }
  const output = validateAgentTextOutputRequest(request.outputFileName ? [request.outputFileName] : []);
  if (!output.ok) throw new SessionError(400, output.reason);
  return { ...request, inputs: [...request.inputs].sort((a, b) => a.attachmentId.localeCompare(b.attachmentId)) };
}

export function pythonActionId(generationRunId: string, actionKey: string) {
  return `py_${createHash("sha256").update(JSON.stringify([generationRunId, actionKey])).digest("hex")}`;
}

/** Caller must first validate the trusted session/run/audience. Metadata only;
 * never fetch attachment bodies merely to create an approval. */
export async function verifyPythonInputManifest(generationRunId: string, request: IsolatedPythonRequest) {
  if (!request.inputs.length) return;
  const run = await prisma.generationRun.findUnique({
    where: { id: generationRunId },
    select: { inputMessage: { select: { attachments: { select: {
      id: true, fileName: true, sizeBytes: true, checksum: true, objectKey: true,
    } } } } },
  });
  for (const declared of request.inputs) {
    const record = run?.inputMessage.attachments.find(item => item.id === declared.attachmentId);
    if (!record?.objectKey || record.sizeBytes !== declared.sizeBytes || record.checksum !== declared.checksum
      || buildSandboxAttachmentFileName(record.id, record.fileName) !== declared.fileName) {
      throw new SessionError(409, "isolated_python_input_changed_or_unavailable");
    }
  }
}

export async function loadVerifiedPythonInputs(generationRunId: string, request: IsolatedPythonRequest) {
  await verifyPythonInputManifest(generationRunId, request);
  // Empty array means no files, never the legacy loader's "load all" convention.
  if (!request.inputs.length) return [];
  const loaded = await loadGenerationInputAttachments({ generationRunId, attachmentIds: request.inputs.map(item => item.attachmentId) });
  if (loaded.length !== request.inputs.length) throw new SessionError(409, "isolated_python_input_changed_or_unavailable");
  return request.inputs.map(item => {
    const actual = loaded.find(candidate => candidate.id === item.attachmentId);
    if (!actual || actual.sandboxFileName !== item.fileName || actual.checksum !== item.checksum || actual.sizeBytes !== item.sizeBytes) {
      throw new SessionError(409, "isolated_python_input_changed_or_unavailable");
    }
    return { fileName: item.fileName, content: Buffer.from(actual.base64, "base64") };
  });
}
