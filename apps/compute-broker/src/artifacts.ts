import { randomBytes, createHash } from "node:crypto";

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildArtifactObjectKey, resolveArtifactRetentionUntil } from "@delegate/artifacts";

import { computeBrokerConfig } from "./config";
import { prisma } from "./prisma";

const artifactClient = new S3Client({
  region: computeBrokerConfig.artifactStore.region,
  endpoint: computeBrokerConfig.artifactStore.endpoint,
  forcePathStyle: computeBrokerConfig.artifactStore.forcePathStyle,
  credentials: {
    accessKeyId: computeBrokerConfig.artifactStore.accessKeyId,
    secretAccessKey: computeBrokerConfig.artifactStore.secretAccessKey,
  },
});

let bucketReadyPromise: Promise<void> | null = null;

export async function persistExecutionArtifacts(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  sessionId: string;
  executionId: string;
  retentionDays: number;
  stdout: string;
  stderr: string;
}) {
  const artifacts = [];

  if (params.stdout.length > 0) {
    artifacts.push(
      await persistTextArtifact({
        representativeId: params.representativeId,
        representativeSlug: params.representativeSlug,
        contactId: params.contactId,
        conversationId: params.conversationId,
        sessionId: params.sessionId,
        executionId: params.executionId,
        kind: "STDOUT",
        content: params.stdout,
        retentionDays: params.retentionDays,
      }),
    );
  }

  if (params.stderr.length > 0) {
    artifacts.push(
      await persistTextArtifact({
        representativeId: params.representativeId,
        representativeSlug: params.representativeSlug,
        contactId: params.contactId,
        conversationId: params.conversationId,
        sessionId: params.sessionId,
        executionId: params.executionId,
        kind: "STDERR",
        content: params.stderr,
        retentionDays: params.retentionDays,
      }),
    );
  }

  return artifacts;
}

export async function persistJsonArtifact(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  sessionId: string;
  executionId: string;
  kind?: "JSON" | "TRACE";
  value: unknown;
  retentionDays: number;
  summary?: string;
}) {
  const body = Buffer.from(JSON.stringify(params.value, null, 2), "utf8");
  return persistBufferArtifact({
    representativeId: params.representativeId,
    representativeSlug: params.representativeSlug,
    contactId: params.contactId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    executionId: params.executionId,
    kind: params.kind ?? "JSON",
    body,
    mimeType: "application/json; charset=utf-8",
    retentionDays: params.retentionDays,
    ...(params.summary ? { summary: params.summary } : {}),
  });
}

export async function persistScreenshotArtifact(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  sessionId: string;
  executionId: string;
  retentionDays: number;
  body: Buffer;
  mimeType?: "image/png" | "image/jpeg";
  summary?: string;
}) {
  return persistBufferArtifact({
    representativeId: params.representativeId,
    representativeSlug: params.representativeSlug,
    contactId: params.contactId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    executionId: params.executionId,
    kind: "SCREENSHOT",
    body: params.body,
    mimeType: params.mimeType ?? "image/png",
    retentionDays: params.retentionDays,
    ...(params.summary ? { summary: params.summary } : {}),
  });
}

export async function persistFileArtifact(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  sessionId: string;
  executionId: string;
  retentionDays: number;
  path: string;
  content: string;
}) {
  const body = Buffer.from(params.content, "utf8");
  const preview = summarizeArtifact(params.content);
  return persistBufferArtifact({
    representativeId: params.representativeId,
    representativeSlug: params.representativeSlug,
    contactId: params.contactId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    executionId: params.executionId,
    kind: "FILE",
    body,
    mimeType: inferTextFileMimeType(params.path),
    retentionDays: params.retentionDays,
    summary: preview ? `${params.path}: ${preview}` : params.path,
  });
}

async function persistTextArtifact(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  sessionId: string;
  executionId: string;
  kind: "STDOUT" | "STDERR";
  content: string;
  retentionDays: number;
}) {
  const body = Buffer.from(params.content, "utf8");
  return persistBufferArtifact({
    representativeId: params.representativeId,
    representativeSlug: params.representativeSlug,
    contactId: params.contactId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    executionId: params.executionId,
    kind: params.kind,
    body,
    mimeType: "text/plain; charset=utf-8",
    retentionDays: params.retentionDays,
    summary: summarizeArtifact(params.content),
  });
}

export async function persistBufferArtifact(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string | null | undefined;
  conversationId?: string | null | undefined;
  sessionId: string;
  executionId: string;
  kind: "STDOUT" | "STDERR" | "FILE" | "ARCHIVE" | "SCREENSHOT" | "JSON" | "TRACE";
  body: Buffer;
  mimeType: string;
  retentionDays: number;
  summary?: string;
}) {
  const createdAt = new Date();
  const taskContext = await prisma.computeSession.findUnique({
    where: { id: params.sessionId },
    select: { delegationTaskId: true, delegationTaskStepId: true },
  });
  const artifactId = `artifact_${randomBytes(8).toString("hex")}`;
  const objectKey = buildArtifactObjectKey({
    representativeSlug: params.representativeSlug,
    contactId: params.contactId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    executionId: params.executionId,
    artifactKind: params.kind.toLowerCase() as
      | "stdout"
      | "stderr"
      | "file"
      | "archive"
      | "screenshot"
      | "json"
      | "trace",
    artifactId,
  });

  await ensureArtifactBucket();

  await artifactClient.send(
    new PutObjectCommand({
      Bucket: computeBrokerConfig.artifactStore.bucket,
      Key: objectKey,
      Body: params.body,
      ContentType: params.mimeType,
    }),
  );

  const artifact = await prisma.artifact.create({
    data: {
      id: artifactId,
      representativeId: params.representativeId,
      contactId: params.contactId ?? null,
      conversationId: params.conversationId ?? null,
      sessionId: params.sessionId,
      toolExecutionId: params.executionId,
      delegationTaskId: taskContext?.delegationTaskId ?? null,
      delegationTaskStepId: taskContext?.delegationTaskStepId ?? null,
      kind: params.kind,
      bucket: computeBrokerConfig.artifactStore.bucket,
      objectKey,
      mimeType: params.mimeType,
      sizeBytes: params.body.byteLength,
      sha256: sha256(params.body),
      retentionUntil: resolveArtifactRetentionUntil(createdAt, params.retentionDays),
      summary: params.summary?.trim() ? params.summary.trim() : null,
      createdAt,
    },
  });

  await prisma.eventAudit.create({
    data: {
      representativeId: params.representativeId,
      contactId: params.contactId ?? null,
      conversationId: params.conversationId ?? null,
      delegationTaskId: taskContext?.delegationTaskId ?? null,
      type: "ARTIFACT_STORED",
      payload: {
        artifactId: artifact.id,
        executionId: params.executionId,
        kind: params.kind.toLowerCase(),
        objectKey,
        sizeBytes: params.body.byteLength,
      },
    },
  });

  return artifact;
}

export async function readPersistedArtifactObject(objectKey: string): Promise<Buffer> {
  const response = await artifactClient.send(
    new GetObjectCommand({
      Bucket: computeBrokerConfig.artifactStore.bucket,
      Key: objectKey,
    }),
  );
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error("artifact_object_empty");
  }

  return Buffer.from(bytes);
}

function summarizeArtifact(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  return normalized.slice(0, 240);
}

function inferTextFileMimeType(path: string) {
  const extension = path.toLowerCase().split(".").pop();
  switch (extension) {
    case "json":
      return "application/json; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "md":
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function ensureArtifactBucket() {
  if (!bucketReadyPromise) {
    bucketReadyPromise = (async () => {
      try {
        await artifactClient.send(
          new HeadBucketCommand({
            Bucket: computeBrokerConfig.artifactStore.bucket,
          }),
        );
      } catch {
        await artifactClient.send(
          new CreateBucketCommand({
            Bucket: computeBrokerConfig.artifactStore.bucket,
          }),
        );
      }
    })();
  }

  return bucketReadyPromise;
}
