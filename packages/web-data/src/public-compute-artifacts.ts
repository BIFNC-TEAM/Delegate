import { prisma } from "./prisma";
import { readArtifactObject } from "./artifact-store";

export async function getPublicConversationArtifactDownload(input: {
  representativeSlug: string;
  artifactId: string;
  audienceIdentityId: string;
}) {
  const artifact = await prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      representative: { slug: input.representativeSlug },
      conversation: {
        audienceIdentityId: input.audienceIdentityId,
      },
      OR: [
        { retentionUntil: null },
        { retentionUntil: { gt: new Date() } },
      ],
    },
    include: {
      toolExecution: { select: { requestedPath: true } },
    },
  });
  if (!artifact) return null;

  const { buffer } = await readArtifactObject(artifact.objectKey);
  const now = new Date();
  await prisma.$transaction([
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
    fileName: resolveFileName(
      artifact.toolExecution?.requestedPath,
      artifact.kind.toLowerCase(),
      artifact.id,
      artifact.mimeType,
    ),
  };
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
