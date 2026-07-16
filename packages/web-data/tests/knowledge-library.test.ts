import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoRepresentative } from "@delegate/domain";

import {
  archiveKnowledgeAsset,
  buildKnowledgeSummary,
  createKnowledgeAsset,
  deleteKnowledgeAsset,
  detectKnowledgeFileKind,
  extractKnowledgeFile,
  getKnowledgeAsset,
  inferKnowledgeTags,
  listKnowledgeAssets,
  updateKnowledgeAsset,
} from "../src/knowledge-library";
import { readKnowledgeSource, storeKnowledgeSource } from "../src/knowledge-storage";
import { removeKnowledgeTextIndex, splitKnowledgeText } from "../src/knowledge-vector";

describe("workspace knowledge library", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("imports, processes, searches, permissions, archives, and permanently deletes authored knowledge", async () => {
    const marker = `QA-${Date.now()}`;
    const created = await createKnowledgeAsset(null, {
      kind: "text",
      title: `${marker} 服务政策`,
      sourceText: "数字代表可以回答公开的产品与价格问题，但退款、折扣、私有文件和敏感材料必须转人工审批。",
      visibility: "owner_only",
      tags: ["政策", "政策", "QA"],
    });

    expect(created).toMatchObject({ status: "ready", processingVersion: 1 });
    expect(created.tags).toEqual(["政策", "QA"]);
    expect(created.summary).toContain("数字代表");
    expect(created.autoTags).toEqual(expect.arrayContaining(["产品", "价格", "政策"]));
    expect(created.processingLogs.map((log) => log.stage)).toEqual(["queued", "extract", "vectorize", "complete"]);
    expect(created).toMatchObject({
      vectorBackend: "memory",
      vectorChunkCount: 1,
      embeddingModel: "deterministic-demo-embedding",
    });
    expect(created.vectorUri).toContain(`/knowledge/${created.id}.md`);

    const searched = await listKnowledgeAssets(null, { query: marker });
    expect(searched.map((asset) => asset.id)).toContain(created.id);

    await expect(updateKnowledgeAsset(null, created.id, {
      visibility: "selected_representatives",
      representativeLinks: [],
    })).rejects.toMatchObject({ statusCode: 422 });

    const linked = await updateKnowledgeAsset(null, created.id, {
      visibility: "selected_representatives",
      representativeLinks: [{
        representativeId: demoRepresentative.id,
        usageMode: "both",
        reviewStatus: "approved",
        enabled: true,
        priority: 80,
      }],
    });
    expect(linked.representativeLinks[0]).toMatchObject({
      representativeId: demoRepresentative.id,
      usageMode: "both",
    });

    await expect(deleteKnowledgeAsset(null, created.id)).rejects.toMatchObject({ statusCode: 409 });
    const archived = await archiveKnowledgeAsset(null, created.id, true);
    expect(archived.status).toBe("archived");
    await deleteKnowledgeAsset(null, created.id);
    await expect(getKnowledgeAsset(null, created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("blocks private network URL imports and records a useful failed processing state", async () => {
    const asset = await createKnowledgeAsset(null, {
      kind: "url",
      title: "Private URL should be blocked",
      sourceUrl: "http://127.0.0.1:3001/internal",
    });

    expect(asset.status).toBe("failed");
    expect(asset.processingError).toContain("私有网络");
    expect(asset.processingLogs.at(-1)).toMatchObject({ level: "error", stage: "failed" });
    await archiveKnowledgeAsset(null, asset.id, true);
    await deleteKnowledgeAsset(null, asset.id);
  });

  it("extracts UTF-8 text and DOCX content and rejects unsupported or oversized files", async () => {
    const text = await extractKnowledgeFile({
      bytes: new TextEncoder().encode("Delegate knowledge text"),
      fileName: "knowledge.md",
    });
    expect(text).toEqual({ kind: "markdown", text: "Delegate knowledge text" });

    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>");
    const docxBytes = await zip.generateAsync({ type: "uint8array" });
    const docx = await extractKnowledgeFile({ bytes: docxBytes, fileName: "policy.docx" });
    expect(docx.kind).toBe("docx");
    expect(docx.text).toContain("第一段\n第二段");

    await expect(extractKnowledgeFile({ bytes: new Uint8Array([1, 2]), fileName: "image.png" })).rejects.toMatchObject({ statusCode: 422 });
    await expect(extractKnowledgeFile({ bytes: new Uint8Array(15 * 1024 * 1024 + 1), fileName: "large.txt" })).rejects.toMatchObject({ statusCode: 413 });
  });

  it("persists an original file before parsing it and can rebuild the vector index from that object", async () => {
    const body = new TextEncoder().encode("Delegate 对象存储知识正文。这个文件必须先持久化，再解析并进入向量索引。");
    const stored = await storeKnowledgeSource({
      ownerId: null,
      fileName: "object-source.txt",
      contentType: "text/plain; charset=utf-8",
      bytes: body,
    });
    expect(stored.bucket).toBe("delegate-1324808004");
    expect(stored.objectKey).toContain("knowledge/demo/");
    const loaded = await readKnowledgeSource({ bucket: stored.bucket, objectKey: stored.objectKey });
    expect(new TextDecoder().decode(loaded.bytes)).toContain("对象存储知识正文");

    const asset = await createKnowledgeAsset(null, {
      kind: "txt",
      title: "对象存储处理测试",
      originalFileName: "object-source.txt",
      mimeType: "text/plain",
      sizeBytes: body.byteLength,
      sourceObjectBucket: stored.bucket,
      sourceObjectKey: stored.objectKey,
      ...(stored.etag ? { sourceObjectEtag: stored.etag } : {}),
      sourceObjectChecksum: stored.checksum,
    });
    expect(asset).toMatchObject({
      status: "ready",
      sourceText: null,
      sourceObjectBucket: "delegate-1324808004",
      vectorBackend: "memory",
    });
    expect(asset.extractedText).toContain("必须先持久化");
    await archiveKnowledgeAsset(null, asset.id, true);
    await deleteKnowledgeAsset(null, asset.id);
    await expect(readKnowledgeSource({ bucket: stored.bucket, objectKey: stored.objectKey })).rejects.toThrow("not found");
  });

  it("detects supported file kinds and creates bounded overlapping retrieval chunks", () => {
    expect(detectKnowledgeFileKind("guide.PDF")).toBe("pdf");
    expect(detectKnowledgeFileKind("guide.md")).toBe("markdown");
    expect(() => detectKnowledgeFileKind("image.png")).toThrow("仅支持");
    const chunks = splitKnowledgeText(`${"第一段知识。".repeat(80)}\n\n${"第二段知识。".repeat(80)}`, 240, 40);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 280)).toBe(true);
  });

  it("creates concise summaries and deterministic domain tags", () => {
    const longText = `${"产品与服务说明。".repeat(60)}退款政策需要人工审批。`;
    const summary = buildKnowledgeSummary(longText);
    expect(summary.length).toBeLessThanOrEqual(320);
    expect(summary).toContain("产品与服务");
    expect(inferKnowledgeTags(longText, "价格 FAQ")).toEqual(expect.arrayContaining(["产品", "服务", "价格", "FAQ", "政策"]));
  });

  it("recursively removes OpenViking knowledge resource directories", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://delegate.test/delegate");
    vi.stubEnv("OPENVIKING_ENABLED", "true");
    vi.stubEnv("OPENVIKING_BASE_URL", "http://openviking.test");
    vi.stubEnv("OPENVIKING_API_KEY", "test-api-key");
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await removeKnowledgeTextIndex({
      ownerId: "owner_a",
      assetId: "asset_a",
      representativeSlugs: ["rep-a"],
      required: true,
    });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => new URL(request).searchParams.get("recursive") === "true")).toBe(true);
  });
});
