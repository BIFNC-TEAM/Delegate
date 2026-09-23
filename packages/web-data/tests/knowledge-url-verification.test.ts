import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
import { createKnowledgeAsset, archiveKnowledgeAsset, deleteKnowledgeAsset } from "../src/knowledge-library";

describe("URL verification responses", () => {
  beforeEach(() => { vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("OPENVIKING_ENABLED", "false"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it.each([401, 403, 429])("explains how to recover HTTP %s using browser capture", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("verification", { status })));
    const asset = await createKnowledgeAsset(null, { kind: "url", title: "URL", sourceUrl: "https://example.com/article" });
    expect(asset).toMatchObject({ status: "failed", vectorBackend: null });
    expect(asset.processingError).toContain(`HTTP ${status}`);
    expect(asset.processingError).toContain("浏览器采集");
    await archiveKnowledgeAsset(null, asset.id, true); await deleteKnowledgeAsset(null, asset.id);
  });
  it.each(["百度安全验证", "Just a moment...", "Sign in"])("does not index a 200 response for %s", async (title) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`<title>${title}</title><body>Please complete verification before accessing this site.</body>`)));
    const asset = await createKnowledgeAsset(null, { kind: "url", title: "URL", sourceUrl: "https://example.com/article" });
    expect(asset).toMatchObject({ status: "failed", vectorBackend: null, extractedText: null });
    expect(asset.processingError).toContain("浏览器采集");
    await archiveKnowledgeAsset(null, asset.id, true); await deleteKnowledgeAsset(null, asset.id);
  });
  it("continues to process normal public pages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<title>论坛介绍</title><main>这是可以直接读取的公开论坛介绍正文，应该继续正常生成知识摘要和检索索引。</main>")));
    const asset = await createKnowledgeAsset(null, { kind: "url", title: "URL", sourceUrl: "https://example.com/article" });
    expect(asset.status).toBe("ready");
    expect(asset.extractedText).toContain("公开论坛介绍正文");
    await archiveKnowledgeAsset(null, asset.id, true); await deleteKnowledgeAsset(null, asset.id);
  });
});
