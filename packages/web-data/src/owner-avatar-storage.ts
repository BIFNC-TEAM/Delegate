import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createRequire } from "node:module";
import type Sharp from "../node_modules/sharp/lib/index";
import { getKnowledgeObjectStoreConfig } from "./knowledge-storage";
// sharp 0.35 is already pinned by this repository. Its exports map omits the
// typings entry; use its shipped declarations without weakening TS checks.
const sharp: typeof Sharp = createRequire(import.meta.url)("sharp");

export const MAX_AVATAR_FILE_BYTES = 5 * 1024 * 1024;
const MAX_STORED_BYTES = 1024 * 1024;
const referencePattern = /^\/api\/avatars\/([a-f0-9]{32})\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
export class AvatarUploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function ownerSegment(ownerId: string) { return createHash("sha256").update(ownerId).digest("hex").slice(0, 32); }
function dashboardOrigin() {
  const url = new URL(process.env.NEXT_PUBLIC_DASHBOARD_URL || "");
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new AvatarUploadError(503, "Avatar display origin is not configured.");
  return url.origin;
}
export function avatarObjectKey(owner: string, id: string) {
  if (!referencePattern.test(`/api/avatars/${owner}/${id}`)) throw new AvatarUploadError(404, "Avatar not found.");
  return `avatars/${owner}/${id}.jpg`;
}
export function managedAvatarObjectKey(url: string, ownerId?: string): string | null {
  try {
    const value = new URL(url); const match = value.pathname.match(referencePattern);
    if (value.origin !== dashboardOrigin() || value.search || value.hash || !match || (ownerId && match[1] !== ownerSegment(ownerId))) return null;
    return avatarObjectKey(match[1]!, match[2]!);
  } catch { return null; }
}
function storeClient() {
  const config = getKnowledgeObjectStoreConfig();
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || !/^cos\.[a-z0-9-]+\.myqcloud\.com$/u.test(endpoint.hostname) || !config.accessKeyId || !config.secretAccessKey) throw new AvatarUploadError(503, "Tencent COS is not configured for avatars.");
  return { bucket: config.bucket, client: new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }) };
}
export async function normalizeOwnerAvatar(bytes: Uint8Array): Promise<Buffer> {
  if (!bytes.byteLength || bytes.byteLength > MAX_AVATAR_FILE_BYTES) throw new AvatarUploadError(413, "Choose an image no larger than 5 MB.");
  const header = Buffer.from(bytes.subarray(0, 12));
  const supported = (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    || header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (header.subarray(0, 4).toString() === "RIFF" && header.subarray(8, 12).toString() === "WEBP");
  if (!supported) throw new AvatarUploadError(415, "Use a JPEG, PNG, or WebP image.");
  try {
    const input = sharp(bytes, { limitInputPixels: 20_000_000, failOn: "warning" });
    const metadata = await input.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format || "") || (metadata.pages ?? 1) !== 1) throw new AvatarUploadError(415, "Use a non-animated JPEG, PNG, or WebP image.");
    // Decode/re-encode rather than trusting filename or MIME. Strip EXIF/GPS,
    // normalize rotation, and store only a bounded square JPEG.
    const result = await input.rotate().resize(512, 512, { fit: "cover" }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
    if (result.length > MAX_STORED_BYTES) throw new AvatarUploadError(413, "The processed avatar is too large.");
    return result;
  } catch (error) {
    if (error instanceof AvatarUploadError) throw error;
    throw new AvatarUploadError(400, "The image is damaged, unsupported, or has too many pixels.");
  }
}
export async function storeOwnerAvatar(ownerId: string, bytes: Uint8Array) {
  const normalized = await normalizeOwnerAvatar(bytes);
  const owner = ownerSegment(ownerId); const id = randomUUID(); const key = avatarObjectKey(owner, id);
  const url = new URL(`/api/avatars/${owner}/${id}`, dashboardOrigin()).toString();
  const { bucket, client } = storeClient();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: normalized, ContentType: "image/jpeg", ACL: "private",
    Metadata: { "delegate-sha256": createHash("sha256").update(normalized).digest("hex") } }), { abortSignal: AbortSignal.timeout(20_000) });
  return { key, url };
}
export async function deleteOwnerAvatarObject(key: string) {
  if (!/^avatars\/[a-f0-9]{32}\/[a-f0-9-]{36}\.jpg$/u.test(key)) throw new AvatarUploadError(400, "Invalid avatar reference.");
  const { client, bucket } = storeClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
}
export async function readOwnerAvatarObject(owner: string, id: string) {
  const key = avatarObjectKey(owner, id); const { client, bucket } = storeClient();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
    if (!result.Body || result.ContentType !== "image/jpeg" || (result.ContentLength ?? 0) > MAX_STORED_BYTES) throw new AvatarUploadError(502, "Invalid avatar object.");
    const parts: Buffer[] = []; let size = 0;
    for await (const part of result.Body as AsyncIterable<Uint8Array>) { size += part.length; if (size > MAX_STORED_BYTES) throw new AvatarUploadError(502, "Invalid avatar object."); parts.push(Buffer.from(part)); }
    return Buffer.concat(parts);
  } catch (error) {
    if (error && typeof error === "object" && ("name" in error && ["NoSuchKey", "NotFound"].includes(String(error.name)))) throw new AvatarUploadError(404, "Avatar not found.");
    throw error;
  }
}
