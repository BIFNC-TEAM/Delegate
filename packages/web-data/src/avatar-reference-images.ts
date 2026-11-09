import { createRequire } from "node:module";
import type Sharp from "../node_modules/sharp/lib/index";
const sharp: typeof Sharp = createRequire(import.meta.url)("sharp");

/** Decode, strip metadata, preserve the full frame; never use the square profile-avatar crop. */
export async function normalizeAvatarReference(bytes: Uint8Array): Promise<Buffer> {
  if (!bytes.byteLength || bytes.byteLength > 12 * 1024 * 1024) throw new Error("Reference image exceeds 12 MiB.");
  const input = sharp(bytes, { limitInputPixels: 36_000_000, failOn: "warning" });
  const metadata = await input.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new Error("Use a static JPEG, PNG or WebP reference.");
  const result = await input.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#eeeeee" }).jpeg({ quality: 93 }).toBuffer();
  if (result.byteLength > 8 * 1024 * 1024) throw new Error("Normalized reference exceeds 8 MiB.");
  return result;
}
export async function inspectGeneratedAvatarReference(bytes: Uint8Array): Promise<{ width: number; height: number; format: "png" | "jpeg" }> {
  if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) throw new Error("Generated image exceeds 20 MiB.");
  const input = sharp(bytes, { limitInputPixels: 36_000_000, failOn: "warning" });
  const meta = await input.metadata();
  if (!["png", "jpeg"].includes(meta.format ?? "") || !meta.width || !meta.height || meta.width < 512 || meta.height < 512 || (meta.pages ?? 1) !== 1) throw new Error("Invalid or undersized generated image.");
  await input.stats(); // Force pixel decoding before marking the provider output usable.
  return { width: meta.width, height: meta.height, format: meta.format as "png" | "jpeg" };
}
