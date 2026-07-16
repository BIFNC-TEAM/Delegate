import { createHash, randomUUID } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const DEFAULT_KNOWLEDGE_OBJECT_BUCKET = "delegate-1324808004";

type KnowledgeObjectStoreConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export type StoredKnowledgeObject = {
  bucket: string;
  objectKey: string;
  etag: string | null;
  versionId: string | null;
  checksum: string;
};

export function buildKnowledgeOwnerObjectPrefix(ownerId?: string | null) {
  return `knowledge/${safeSegment(ownerId ?? "demo")}/`;
}

const memoryObjects = new Map<string, { body: Buffer; contentType: string }>();
let cachedClient: { signature: string; client: S3Client } | null = null;

export function getKnowledgeObjectStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeObjectStoreConfig {
  const endpoint = normalize(env.KNOWLEDGE_OBJECT_STORE_ENDPOINT)
    ?? normalize(env.ARTIFACT_STORE_ENDPOINT)
    ?? "http://localhost:9000";
  const accessKeyId = normalize(env.KNOWLEDGE_OBJECT_STORE_ACCESS_KEY)
    ?? normalize(env.TENCENTCLOUD_SECRET_ID)
    ?? normalize(env.ARTIFACT_STORE_ACCESS_KEY);
  const secretAccessKey = normalize(env.KNOWLEDGE_OBJECT_STORE_SECRET_KEY)
    ?? normalize(env.TENCENTCLOUD_SECRET_KEY)
    ?? normalize(env.ARTIFACT_STORE_SECRET_KEY);

  return {
    endpoint,
    bucket: normalize(env.KNOWLEDGE_OBJECT_STORE_BUCKET) ?? DEFAULT_KNOWLEDGE_OBJECT_BUCKET,
    region: normalize(env.KNOWLEDGE_OBJECT_STORE_REGION)
      ?? normalize(env.ARTIFACT_STORE_REGION)
      ?? "ap-guangzhou",
    forcePathStyle: parseBoolean(
      env.KNOWLEDGE_OBJECT_STORE_FORCE_PATH_STYLE,
      endpoint.includes("localhost") || endpoint.includes("127.0.0.1") || endpoint.includes("artifact-store"),
    ),
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
  };
}

export async function storeKnowledgeSource(params: {
  ownerId?: string | null;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<StoredKnowledgeObject> {
  const config = getKnowledgeObjectStoreConfig();
  const now = new Date();
  const objectKey = [
    buildKnowledgeOwnerObjectPrefix(params.ownerId).replace(/\/$/, ""),
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    randomUUID(),
    safeFileName(params.fileName),
  ].join("/");
  const body = Buffer.from(params.bytes);
  const checksum = createHash("sha256").update(body).digest("hex");

  if (useMemoryStore()) {
    memoryObjects.set(memoryKey(config.bucket, objectKey), {
      body,
      contentType: params.contentType,
    });
    return { bucket: config.bucket, objectKey, etag: checksum, versionId: null, checksum };
  }

  const result = await getClient(config).send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: params.contentType,
    Metadata: {
      "delegate-sha256": checksum,
      "delegate-owner": safeSegment(params.ownerId ?? "unknown"),
    },
  }));

  return {
    bucket: config.bucket,
    objectKey,
    etag: result.ETag?.replaceAll('"', "") ?? null,
    versionId: result.VersionId ?? null,
    checksum,
  };
}

export async function readKnowledgeSource(params: {
  bucket: string;
  objectKey: string;
}): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  if (useMemoryStore()) {
    const entry = memoryObjects.get(memoryKey(params.bucket, params.objectKey));
    if (!entry) throw new Error("Knowledge source object was not found.");
    return { bytes: new Uint8Array(entry.body), contentType: entry.contentType };
  }

  let response;
  try {
    response = await getClient(getKnowledgeObjectStoreConfig()).send(new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.objectKey,
    }));
  } catch (error) {
    if (isObjectNotFoundError(error)) {
      throw new Error("Knowledge source object was not found.", { cause: error });
    }
    throw error;
  }
  if (!response.Body) throw new Error("Knowledge source object has no content.");
  const body = await response.Body.transformToByteArray();
  return { bytes: body, contentType: response.ContentType ?? null };
}

export async function deleteKnowledgeSource(params: {
  bucket: string;
  objectKey: string;
}): Promise<void> {
  if (useMemoryStore()) {
    memoryObjects.delete(memoryKey(params.bucket, params.objectKey));
    return;
  }
  await getClient(getKnowledgeObjectStoreConfig()).send(new DeleteObjectCommand({
    Bucket: params.bucket,
    Key: params.objectKey,
  }));
}

function getClient(config: KnowledgeObjectStoreConfig): S3Client {
  const signature = JSON.stringify(config);
  if (cachedClient?.signature === signature) return cachedClient.client;
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    ...(config.accessKeyId && config.secretAccessKey
      ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
      : {}),
  });
  cachedClient = { signature, client };
  return client;
}

function useMemoryStore() {
  return !process.env.DATABASE_URL?.trim() && !process.env.KNOWLEDGE_OBJECT_STORE_ENDPOINT?.trim();
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function safeFileName(value: string): string {
  const sanitized = value.trim().replace(/[\\/\0]/g, "-").replace(/[^\p{L}\p{N}._ -]+/gu, "-");
  return sanitized.slice(-180) || "source.bin";
}

function memoryKey(bucket: string, objectKey: string) {
  return `${bucket}/${objectKey}`;
}

function isObjectNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return candidate.$metadata?.httpStatusCode === 404
    || [candidate.name, candidate.Code, candidate.code].some((value) => value === "NoSuchKey" || value === "NotFound");
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
