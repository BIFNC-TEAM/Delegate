import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { readArtifactObject } from "./artifact-store";
import { isAgentContextArtifactAuthorized } from "./agent-context-authorization";

export async function getPublicConversationArtifactDownload(input: {
  representativeSlug: string;
  artifactId: string;
  audienceIdentityId: string;
}, options: {
  recordDownload?: boolean;
  maximumBytes?: number;
  /** Trusted adapter coordinates, never inferred from model-generated file names. */
  expectedOrigin?: { generationRunId: string; toolExecutionId?: string; approvalId?: string };
} = {}) {
  const loadAuthorized = async () => {
    const artifact = await prisma.artifact.findFirst({
      where: {
        id: input.artifactId,
        ...(options.maximumBytes !== undefined ? { sizeBytes: { lte: options.maximumBytes } } : {}),
        representative: { slug: input.representativeSlug },
        conversation: {
          audienceIdentityId: input.audienceIdentityId,
        },
        ...(options.expectedOrigin ? {
          session: { generationRunId: options.expectedOrigin.generationRunId },
          ...(options.expectedOrigin.toolExecutionId ? { toolExecutionId: options.expectedOrigin.toolExecutionId } : {}),
          ...(options.expectedOrigin.approvalId ? { toolExecution: { approvalRequestId: options.expectedOrigin.approvalId } } : {}),
        } : {}),
        OR: [
          { retentionUntil: null },
          { retentionUntil: { gt: new Date() } },
        ],
      },
      include: {
        toolExecution: { select: { requestedPath: true, sessionId: true } },
        session: { select: { generationRunId: true } },
      },
    });
    if (!artifact) return null;
    if (options.expectedOrigin && (!artifact.sessionId || artifact.toolExecution?.sessionId !== artifact.sessionId)) return null;
    if (artifact.session?.generationRunId && (!artifact.conversationId || !await isAgentContextArtifactAuthorized({
      runId: artifact.session.generationRunId, representativeId: artifact.representativeId,
      conversationId: artifact.conversationId, audienceIdentityId: input.audienceIdentityId,
      toolExecutionId: artifact.toolExecutionId, artifactId: artifact.id,
    }))) return null;
    return artifact;
  };
  const artifact = await loadAuthorized();
  if (!artifact) return null;

  const { buffer } = await readArtifactObject(artifact.objectKey);
  if (buffer.byteLength !== artifact.sizeBytes || createHash("sha256").update(buffer).digest("hex") !== artifact.sha256) return null;
  // Storage reads are asynchronous. Recheck withdrawal/recipient/retention and
  // the exact object metadata before returning bytes or recording egress.
  const current = await loadAuthorized();
  if (!current || artifactStamp(current) !== artifactStamp(artifact)) return null;
  const now = new Date();
  if (options.recordDownload !== false) await prisma.$transaction([
    prisma.artifact.update({
      where: { id: artifact.id },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: now },
    }),
    prisma.ledgerEntry.create({
      data: {
        representativeId: artifact.representativeId,
        contactId: artifact.contactId,
        conversationId: artifact.conversationId,
        sessionId: artifact.sessionId,
        toolExecutionId: artifact.toolExecutionId,
        kind: "ARTIFACT_EGRESS",
        quantity: buffer.byteLength,
        unit: "byte",
        costCents: Math.max(1, Math.ceil(buffer.byteLength / 65536)),
        notes: "public_conversation_artifact_download",
      },
    }),
  ]);

  return {
    buffer,
    mimeType: artifact.mimeType,
    createdAt: artifact.createdAt,
    fileName: resolveFileName(
      artifact.toolExecution?.requestedPath,
      artifact.kind.toLowerCase(),
      artifact.id,
      artifact.mimeType,
    ),
  };
}

function artifactStamp(artifact: { id: string; representativeId: string; contactId: string | null; conversationId: string | null;
  sessionId: string | null; toolExecutionId: string | null; objectKey: string; mimeType: string; kind: string; sizeBytes: number; sha256: string;
  toolExecution: { requestedPath: string | null; sessionId: string | null } | null; session: { generationRunId: string | null } | null }) {
  return JSON.stringify([artifact.id, artifact.representativeId, artifact.contactId, artifact.conversationId, artifact.sessionId,
    artifact.toolExecutionId, artifact.objectKey, artifact.mimeType, artifact.kind, artifact.sizeBytes, artifact.sha256,
    artifact.toolExecution?.requestedPath, artifact.toolExecution?.sessionId, artifact.session?.generationRunId]);
}

function resolveFileName(
  requestedPath: string | null | undefined,
  kind: string,
  artifactId: string,
  mimeType: string,
) {
  const requestedName = requestedPath?.split("/").pop()?.trim();
  if (requestedName) return sanitizeFileName(requestedName);
  const extension = mimeType.includes("json")
    ? "json"
    : mimeType.includes("csv")
      ? "csv"
      : mimeType.includes("png")
        ? "png"
        : mimeType.includes("jpeg")
          ? "jpg"
          : mimeType.includes("markdown")
            ? "md"
            : "txt";
  return `${sanitizeFileName(kind)}-${artifactId}.${extension}`;
}

function sanitizeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
