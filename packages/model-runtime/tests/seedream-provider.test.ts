import { describe, expect, it, vi } from "vitest";
import { generateSeedreamImage, seedreamConfig, seedreamModelConfig, SeedreamError, SEEDREAM_ENDPOINT, type SeedreamConfig } from "../src/seedream/index";

const image = { bytes: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), mime: "image/png" as const };
const config: SeedreamConfig = { apiKey: "SYNTHETIC_TEST_ONLY", model: "doubao-seedream-4-5-fixture", family: "4.5", timeoutMs: 1000 };
const result = () => new Response(JSON.stringify({ model: config.model, data: [{ b64_json: Buffer.from(image.bytes).toString("base64") }], usage: { generated_images: 1 } }), { headers: { "x-request-id": "test-request" } });

describe("official Seedream image adapter", () => {
  it("sends one single-image request to the official endpoint with server-only authentication", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(result());
    const generated = await generateSeedreamImage(config, "synthetic prompt", [image], transport);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(SEEDREAM_ENDPOINT);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: config.model, size: "2K", response_format: "b64_json", sequential_image_generation: "disabled" });
    expect(body.image[0]).toMatch(/^data:image\/png;base64,/);
    expect(generated.requestId).toBe("test-request");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["5.0-pro", "5.0-flash"] as const)("omits unsupported sequence parameters for %s", async family => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(result());
    await generateSeedreamImage({ ...config, family }, "fixture", [image], transport);
    expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).not.toHaveProperty("sequential_image_generation");
  });
  it("requires explicit enablement and an enabled model ID", () => {
    expect(() => seedreamConfig({})).toThrow("SEEDREAM_ENABLED");
    expect(() => seedreamConfig({ SEEDREAM_ENABLED: "true" })).toThrow("ARK_API_KEY");
    expect(() => seedreamModelConfig({ SEEDREAM_MODEL_ID: "ep-fixture" })).toThrow("FAMILY");
    expect(seedreamModelConfig({ SEEDREAM_MODEL_ID: "ep-fixture", SEEDREAM_MODEL_FAMILY: "4.5" })).toEqual({ model: "ep-fixture", family: "4.5" });
  });
  it("does not send invalid image input", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(generateSeedreamImage(config, "fixture", [{ bytes: Buffer.from("not an image"), mime: "image/png" }], transport)).rejects.toMatchObject({ outcome: "not_sent" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("never echoes a provider error body containing secrets or automatically retries", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("SYNTHETIC_TEST_ONLY private input", { status: 403 }));
    await expect(generateSeedreamImage(config, "fixture", [image], transport)).rejects.toMatchObject({ code: "http_403", outcome: "rejected", message: "Seedream returned HTTP 403." });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("treats a network failure after submission as an unknown outcome", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("SYNTHETIC_TEST_ONLY"));
    await expect(generateSeedreamImage(config, "fixture", [image], transport)).rejects.toMatchObject({ outcome: "unknown" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("aborts a stalled request without retrying", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort")))));
    await expect(generateSeedreamImage({ ...config, timeoutMs: 5 }, "fixture", [image], transport)).rejects.toBeInstanceOf(SeedreamError);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    { data: [{ url: "https://untrusted.invalid/picture.png" }] },
    { data: [{ error: { message: "private" } }] },
    { data: [{ b64_json: "bad!" }] },
    { data: [] },
    { data: [{ b64_json: image.bytes.toString("base64") }, { b64_json: image.bytes.toString("base64") }] },
  ])("rejects missing, failed, malformed or extra outputs", async body => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(generateSeedreamImage(config, "fixture", [image], transport)).rejects.toMatchObject({ outcome: "unknown" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("bounds provider response size before parsing", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "content-length": String(40*1024*1024) } }));
    await expect(generateSeedreamImage(config, "fixture", [image], transport)).rejects.toMatchObject({ outcome: "unknown" });
  });
});
