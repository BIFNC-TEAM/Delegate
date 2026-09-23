import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeBrowserCaptureSchema } from "../src/knowledge-web-capture";
import { createKnowledgeAsset, processKnowledgeAsset, archiveKnowledgeAsset, deleteKnowledgeAsset, replaceFailedKnowledgeUrlWithBrowserCapture } from "../src/knowledge-library";
import { prisma } from "../src/prisma";
import { demoRepresentative } from "@delegate/domain";

const capture = {
  format: "delegate-web-capture" as const, version: 1 as const,
  sourceUrl: "http://192.168.1.50/wiki/knowledge",
  title: "内部知识说明", text: "这是用户在已登录浏览器中主动采集的内部知识正文，必须保留来源并按权限建立索引。",
  capturedAt: "2026-09-23T01:00:00.000Z",
};

describe("browser-captured knowledge", () => {
  beforeEach(() => { vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("OPENVIKING_ENABLED", "false"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each(["http://192.168.1.50/wiki", "http://127.0.0.1/docs", "https://baike.baidu.com/item/61706557"])(
    "imports %s from captured text without DNS or network access, including reprocessing", async (sourceUrl) => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network must not be used"));
      vi.stubGlobal("fetch", fetchMock);
      const asset = await createKnowledgeAsset(null, { kind: "url", title: capture.title, sourceUrl, sourceText: capture.text });
      try {
        expect(asset).toMatchObject({ status: "ready", sourceUrl, sourceText: capture.text, extractedText: capture.text, vectorBackend: "memory", visibility: "owner_only" });
        expect(asset.processingLogs.some((log) => log.message.includes("浏览器采集快照"))).toBe(true);
        expect((await processKnowledgeAsset(null, asset.id)).extractedText).toBe(capture.text);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally { await archiveKnowledgeAsset(null, asset.id, true); await deleteKnowledgeAsset(null, asset.id); }
    },
  );

  it("repairs a failed URL in place, retaining permissions, tags, and representative bindings", async () => {
    const asset = await createKnowledgeAsset(null, {
      kind: "url", title: "原知识标题", sourceUrl: capture.sourceUrl, tags: ["内部"],
      visibility: "selected_representatives", representativeLinks: [{ representativeId: demoRepresentative.id }],
    });
    expect(asset.status).toBe("failed");
    const queued = await replaceFailedKnowledgeUrlWithBrowserCapture(null, asset.id, capture);
    expect(queued).toMatchObject({ id: asset.id, status: "processing", title: "原知识标题", tags: ["内部"], visibility: "selected_representatives", representativeLinks: [expect.objectContaining({ representativeId: demoRepresentative.id })] });
    await expect(replaceFailedKnowledgeUrlWithBrowserCapture(null, asset.id, capture)).rejects.toMatchObject({ statusCode: 409 });
    const done = await processKnowledgeAsset(null, asset.id);
    expect(done).toMatchObject({ status: "ready", processingError: null, extractedText: capture.text, processingVersion: 2 });
    await archiveKnowledgeAsset(null, asset.id, true);
    await expect(replaceFailedKnowledgeUrlWithBrowserCapture(null, asset.id, capture)).rejects.toMatchObject({ statusCode: 409 });
    await deleteKnowledgeAsset(null, asset.id);
  });

  it("denies a snapshot repair for another owner's asset before writing", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/test");
    const find = vi.spyOn(prisma.knowledgeAsset, "findFirst").mockResolvedValue(null);
    const update = vi.spyOn(prisma.knowledgeAsset, "updateMany");
    await expect(replaceFailedKnowledgeUrlWithBrowserCapture("owner-a", "owner-b-asset", capture)).rejects.toMatchObject({ statusCode: 404 });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "owner-b-asset", ownerId: "owner-a" } }));
    expect(update).not.toHaveBeenCalled();
  });

  it("still rejects a direct internal URL fetch without a browser snapshot", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const asset = await createKnowledgeAsset(null, { kind: "url", title: capture.title, sourceUrl: capture.sourceUrl });
    expect(asset).toMatchObject({ status: "failed", processingError: expect.stringContaining("私有网络") });
    expect(fetchMock).not.toHaveBeenCalled();
    await archiveKnowledgeAsset(null, asset.id, true); await deleteKnowledgeAsset(null, asset.id);
  });

  it.each(["", "https://", "not a URL", "file:///etc/passwd", "javascript:alert(1)", "https://name:password@example.com/"])("rejects unsupported capture source %s", async (sourceUrl) => {
    expect(knowledgeBrowserCaptureSchema.safeParse({ ...capture, sourceUrl }).success).toBe(false);
    await expect(createKnowledgeAsset(null, { kind: "url", title: capture.title, sourceUrl, sourceText: capture.text })).rejects.toThrow();
  });

  it.each([
    { text: "" }, { text: "短正文" }, { text: "x".repeat(400_001) },
    { title: "百度安全验证" }, { title: "Just a moment..." },
    { capturedAt: "invalid date" }, { version: 2 }, { format: "unknown" }, { cookies: "must not be accepted" },
  ])("rejects invalid or verification-page capture %#", (override) => {
    expect(knowledgeBrowserCaptureSchema.safeParse({ ...capture, ...override }).success).toBe(false);
  });
});
