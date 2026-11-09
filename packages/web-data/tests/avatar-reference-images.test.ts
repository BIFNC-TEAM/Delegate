import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { normalizeAvatarReference, inspectGeneratedAvatarReference } from "../src/avatar-reference-images";
const sharp = createRequire(import.meta.url)("sharp");

describe("avatar reconstruction references", () => {
  it("preserves a portrait's full aspect ratio instead of cropping to the profile avatar square", async () => {
    const input = await sharp({ create: { width: 1200, height: 2400, channels: 3, background: "#cba" } }).jpeg().withMetadata().toBuffer();
    const normalized = await normalizeAvatarReference(input);
    const info = await sharp(normalized).metadata();
    expect([info.width, info.height]).toEqual([1024, 2048]);
    expect(info.exif).toBeUndefined();
  });
  it("rejects non-image and oversized input", async () => {
    await expect(normalizeAvatarReference(Buffer.from("private text"))).rejects.toThrow();
    await expect(normalizeAvatarReference(Buffer.alloc(12*1024*1024+1))).rejects.toThrow("12 MiB");
  });
  it("fully validates a generated image and rejects tiny placeholder outputs", async () => {
    const good = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#abc" } }).png().toBuffer();
    expect(await inspectGeneratedAvatarReference(good)).toEqual({ width: 1024, height: 1536, format: "png" });
    await expect(inspectGeneratedAvatarReference(good.subarray(0, 100))).rejects.toThrow();
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#abc" } }).png().toBuffer();
    await expect(inspectGeneratedAvatarReference(tiny)).rejects.toThrow();
  });
});
