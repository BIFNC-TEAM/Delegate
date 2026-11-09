import { Buffer } from "node:buffer";

export const SEEDREAM_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
export type SeedreamFamily = "4.0" | "4.5" | "5.0-lite" | "5.0-pro" | "5.0-flash";
export type ImageInput = { bytes: Uint8Array; mime: "image/jpeg" | "image/png" };
export type SeedreamConfig = { apiKey: string; model: string; family: SeedreamFamily; timeoutMs: number };
export class SeedreamError extends Error {
  constructor(readonly code: string, readonly outcome: "not_sent" | "rejected" | "unknown", message: string) { super(message); }
}
export function seedreamModelConfig(env: Record<string, string | undefined> = process.env): Pick<SeedreamConfig, "model" | "family"> {
  const model = env.SEEDREAM_MODEL_ID?.trim();
  if (!model || !/^(doubao-seedream-|ep-)[A-Za-z0-9_-]+$/.test(model)) throw new SeedreamError("missing_model", "not_sent", "Set SEEDREAM_MODEL_ID to an enabled official model or endpoint ID.");
  let family = env.SEEDREAM_MODEL_FAMILY;
  if (!family) {
    family = model.startsWith("doubao-seedream-5-0-lite-") ? "5.0-lite"
      : model.startsWith("doubao-seedream-5-0-pro-") ? "5.0-pro"
      : model.startsWith("doubao-seedream-5-0-flash-") ? "5.0-flash"
      : model.startsWith("doubao-seedream-4-5-") ? "4.5"
      : model.startsWith("doubao-seedream-4-0-") ? "4.0" : undefined;
  }
  if (!["4.0", "4.5", "5.0-lite", "5.0-pro", "5.0-flash"].includes(family ?? "")) {
    throw new SeedreamError("unknown_family", "not_sent", "Set SEEDREAM_MODEL_FAMILY explicitly for an endpoint ID or unrecognized model.");
  }
  return { model, family: family as SeedreamFamily };
}
export function seedreamConfig(env: Record<string, string | undefined> = process.env): SeedreamConfig {
  if (env.SEEDREAM_ENABLED !== "true") throw new SeedreamError("disabled", "not_sent", "Set SEEDREAM_ENABLED=true to enable server-side generation.");
  const apiKey = env.ARK_API_KEY?.trim();
  if (!apiKey || /\s/.test(apiKey)) throw new SeedreamError("missing_key", "not_sent", "ARK_API_KEY is missing or invalid.");
  return { ...seedreamModelConfig(env), apiKey, timeoutMs: 180_000 };
}
export function imageMime(bytes: Uint8Array): ImageInput["mime"] | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  return undefined;
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("Response too large");
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Response too large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export type GeneratedImage = ImageInput & { model: string; requestId: string | null; generatedImages: number | null };

/** Exactly one bounded request; never retries an image request or follows redirects. */
export async function generateSeedreamImage(config: SeedreamConfig, prompt: string, images: readonly ImageInput[], fetchImpl: typeof fetch = fetch): Promise<GeneratedImage> {
  const maxInputs = ["5.0-pro", "5.0-flash"].includes(config.family) ? 10 : 14;
  if (!prompt.trim() || prompt.length > 2000 || images.length < 1 || images.length > maxInputs) {
    throw new SeedreamError("invalid_input", "not_sent", "Invalid prompt or reference image count.");
  }
  for (const image of images) {
    if (!image.bytes.length || image.bytes.length > 8 * 1024 * 1024 || imageMime(image.bytes) !== image.mime) {
      throw new SeedreamError("invalid_image", "not_sent", "References must be normalized JPEG/PNG files under 8 MiB.");
    }
  }
  const body = {
    model: config.model, prompt, image: images.map(i => `data:${i.mime};base64,${Buffer.from(i.bytes).toString("base64")}`),
    size: "2K", response_format: "b64_json", watermark: false,
    ...(["5.0-pro", "5.0-flash"].includes(config.family) ? {} : { sequential_image_generation: "disabled" }),
  };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(SEEDREAM_ENDPOINT, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SeedreamError(`http_${response.status}`, response.status >= 500 ? "unknown" : "rejected", `Seedream returned HTTP ${response.status}.`);
    }
    const data = record(await boundedJson(response, 32 * 1024 * 1024));
    const images = data?.data;
    if (data?.error || !Array.isArray(images) || images.length !== 1 || record(images[0])?.error) {
      throw new SeedreamError("invalid_result", "unknown", "Seedream did not return exactly one successful image; inspect the provider record before retrying.");
    }
    const base64 = record(images[0])?.b64_json;
    if (typeof base64 !== "string" || !base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid image encoding");
    const bytes = Buffer.from(base64, "base64"); const mime = imageMime(bytes);
    if (!mime || bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== base64) throw new Error("Invalid image bytes");
    const rawId = response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid");
    const requestId = rawId && /^[A-Za-z0-9_.:-]{1,200}$/.test(rawId) ? rawId : null;
    const generated = record(data?.usage)?.generated_images;
    if (generated !== undefined && generated !== 1) throw new Error("Unexpected image usage count");
    return { bytes, mime, model: typeof data?.model === "string" ? data.model.slice(0, 200) : config.model,
      requestId, generatedImages: generated === 1 ? 1 : null };
  } catch (error) {
    if (error instanceof SeedreamError) throw error;
    // Never echo a provider body, fetch error or request (which may contain credentials/photos).
    throw new SeedreamError("outcome_unknown", "unknown", "Seedream request outcome is unknown. No automatic retry was made.");
  } finally { clearTimeout(timer); }
}

export type AvatarView = "front" | "back" | "left" | "right";
export function avatarMasterPrompt(heightCm: number): string {
  if (!Number.isFinite(heightCm) || heightCm < 50 || heightCm > 250) throw new Error("Invalid height");
  return `依据图片1至3保留同一人的五官、脸型、肤色和发型，图片4仅参考体型和衣着。生成一张写实3D角色全身正面母版，身高设定${heightCm}厘米。保持本人特征，不美化、不瘦脸、不放大眼睛。中性闭嘴，不戴眼镜。标准A姿态，双臂与躯干分离，手指自然舒展，双脚完整入画。平视、小透视、柔和均匀光线、纯浅灰背景。仅一个人物，不要文字、道具或多视图拼图。`;
}
export function avatarViewPrompt(view: AvatarView): string {
  const directions: Record<AvatarView, string> = { front: "正面，面向镜头", back: "背面，背对镜头", left: "人物自身左侧的正侧面", right: "人物自身右侧的正侧面" };
  if (!(view in directions)) throw new Error("Invalid view");
  return `图片1是已确认的人物母版，其余图片仅用于核对同一人的身份和衣着。仅改变观察角度，输出一张${directions[view]}的完整全身写实3D角色参考图。严格保持母版五官、发型、身材比例、衣服、鞋子与A姿态，不换人、不改变姿势、不戴眼镜。镜头平视，小透视，人物高度与留白一致，纯浅灰背景，柔和均匀光线。手脚完整，只有一个人物，不要文字或拼图。`;
}
