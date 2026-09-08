import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoRepresentative } from "@delegate/domain";

import {
  archiveKnowledgeAsset,
  buildKnowledgeSummary,
  createKnowledgeAsset,
  deleteKnowledgeAsset,
  detectKnowledgeFileKind,
  extractKnowledgeFile,
  findKnowledgeFileConflicts,
  getKnowledgeAsset,
  inferKnowledgeTags,
  listKnowledgeAssets,
  processKnowledgeAsset,
  queueKnowledgeAssetProcessing,
  replaceKnowledgeAssetSource,
  resolveUniqueKnowledgeAssetTitle,
  setRepresentativeKnowledgeAssetBindings,
  updateKnowledgeAsset,
} from "../src/knowledge-library";
import { checksumKnowledgeSource, readKnowledgeSource, storeKnowledgeSource } from "../src/knowledge-storage";
import { removeKnowledgeTextIndex, splitKnowledgeText } from "../src/knowledge-vector";

describe("workspace knowledge library", () => {
  beforeEach(() => {
    for (const key of [
      "DATABASE_URL",
      "KNOWLEDGE_OBJECT_STORE_ENDPOINT",
      "KNOWLEDGE_OBJECT_STORE_BUCKET",
      "KNOWLEDGE_OBJECT_STORE_REGION",
      "KNOWLEDGE_OBJECT_STORE_ACCESS_KEY",
      "KNOWLEDGE_OBJECT_STORE_SECRET_KEY",
      "KNOWLEDGE_OBJECT_STORE_FORCE_PATH_STYLE",
      "ARTIFACT_STORE_ENDPOINT",
      "ARTIFACT_STORE_BUCKET",
      "ARTIFACT_STORE_REGION",
      "ARTIFACT_STORE_ACCESS_KEY",
      "ARTIFACT_STORE_SECRET_KEY",
      "TENCENTCLOUD_SECRET_ID",
      "TENCENTCLOUD_SECRET_KEY",
      "MINERU_API_BASE_URL",
      "MINERU_API_TOKEN",
      "MINERU_API_TIMEOUT_MS",
      "MINERU_API_POLL_INTERVAL_MS",
      "MINERU_PARSE_METHOD",
      "MINERU_LANGUAGE",
      "MINERU_BACKEND",
    ]) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("imports, processes, searches, permissions, archives, and permanently deletes authored knowledge", async () => {
    const marker = `QA-${Date.now()}`;
    const created = await createKnowledgeAsset(null, {
      kind: "text",
      title: `${marker} 服务政策`,
      sourceText: "对外代理可以回答公开的产品与价格问题，但退款、折扣、私有文件和敏感材料必须转人工审批。",
      visibility: "owner_only",
      tags: ["政策", "政策", "QA"],
    });

    expect(created).toMatchObject({ status: "ready", processingVersion: 1 });
    expect(created.tags).toEqual(["政策", "QA"]);
    expect(created.summary).toContain("对外代理");
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

  it("queues reprocessing idempotently before background work starts", async () => {
    const created = await createKnowledgeAsset(null, {
      kind: "text",
      title: `Queued processing ${Date.now()}`,
      sourceText: "这份知识用于验证重新处理会先立即入队，再由后台任务完成向量索引。",
      visibility: "owner_only",
    });

    const queued = await queueKnowledgeAssetProcessing(null, created.id);
    expect(queued).toMatchObject({ queued: true, asset: { status: "processing" } });
    const duplicate = await queueKnowledgeAssetProcessing(null, created.id);
    expect(duplicate).toMatchObject({ queued: false, asset: { status: "processing" } });

    const processed = await processKnowledgeAsset(null, created.id);
    expect(processed).toMatchObject({ status: "ready", processingError: null });
    await archiveKnowledgeAsset(null, created.id, true);
    await deleteKnowledgeAsset(null, created.id);
  });

  it("allows long OpenViking indexing to finish behind the asynchronous route", () => {
    const vectorSource = readFileSync(
      new URL("../src/knowledge-vector.ts", import.meta.url),
      "utf8",
    );

    expect(vectorSource).toContain("const KNOWLEDGE_INDEX_TIMEOUT_SECONDS = 300");
    expect(vectorSource).toContain("timeout: KNOWLEDGE_INDEX_TIMEOUT_SECONDS");
    expect(vectorSource).toContain("KNOWLEDGE_INDEX_TIMEOUT_SECONDS + 15");
  });

  it("links ready workspace assets to a representative without duplicating the source", async () => {
    const existing = await listKnowledgeAssets(null);
    const existingLinkedIds = existing
      .filter((asset) =>
        asset.representativeLinks.some(
          (link) => link.representativeId === demoRepresentative.id && link.enabled,
        ),
      )
      .map((asset) => asset.id);
    const created = await createKnowledgeAsset(null, {
      kind: "text",
      title: `Representative binding ${Date.now()}`,
      sourceText: "这是一份工作区知识源，只保存一次，并通过显式授权关系提供给指定对外代理检索使用。",
      visibility: "owner_only",
    });

    const linked = await setRepresentativeKnowledgeAssetBindings(
      null,
      demoRepresentative.slug,
      [...existingLinkedIds, created.id],
    );
    expect(linked.changedAssetIds).toContain(created.id);
    expect(linked.selectedAssetIds).toContain(created.id);
    await expect(getKnowledgeAsset(null, created.id)).resolves.toMatchObject({
      visibility: "selected_representatives",
      representativeLinks: [
        expect.objectContaining({
          representativeId: demoRepresentative.id,
          usageMode: "qa_source",
          enabled: true,
        }),
      ],
    });

    const unlinked = await setRepresentativeKnowledgeAssetBindings(
      null,
      demoRepresentative.slug,
      existingLinkedIds,
    );
    expect(unlinked.changedAssetIds).toContain(created.id);
    await expect(getKnowledgeAsset(null, created.id)).resolves.toMatchObject({
      visibility: "owner_only",
      representativeLinks: [],
    });

    const failed = await createKnowledgeAsset(null, {
      kind: "url",
      title: `Unavailable binding ${Date.now()}`,
      sourceUrl: "http://127.0.0.1/representative-binding",
    });
    await expect(
      setRepresentativeKnowledgeAssetBindings(
        null,
        demoRepresentative.slug,
        [...existingLinkedIds, failed.id],
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    await archiveKnowledgeAsset(null, created.id, true);
    await deleteKnowledgeAsset(null, created.id);
    await archiveKnowledgeAsset(null, failed.id, true);
    await deleteKnowledgeAsset(null, failed.id);
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

  it("extracts a real PDF with an embedded worker and rejects image-only PDFs", async () => {
    const pdf = await extractKnowledgeFile({
      bytes: buildTestPdf("Delegate PDF knowledge extraction works in production."),
      fileName: "knowledge.pdf",
      mimeType: "application/pdf",
    });
    expect(pdf).toEqual({
      kind: "pdf",
      text: expect.stringContaining("Delegate PDF knowledge extraction works in production."),
      extractionBackend: "pdfjs",
    });

    await expect(extractKnowledgeFile({
      bytes: buildTestPdf(),
      fileName: "scan.pdf",
      mimeType: "application/pdf",
    })).rejects.toThrow("当前未配置 MinerU");
  });

  it("routes scanned PDFs through MinerU and retains local text fallback", async () => {
    vi.stubEnv("MINERU_API_BASE_URL", "http://mineru.internal:8000");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-scan" }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        backend: "hybrid-engine",
        version: "3.2.2",
        results: {
          scan: { md_content: "# OCR 正文\n\nMinerU 已识别扫描协议中的有效知识内容。" },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(extractKnowledgeFile({
      bytes: buildTestPdf(),
      fileName: "scan.pdf",
      mimeType: "application/pdf",
    })).resolves.toEqual({
      kind: "pdf",
      text: "# OCR 正文\n\nMinerU 已识别扫描协议中的有效知识内容。",
      extractionBackend: "mineru",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("service offline")));
    await expect(extractKnowledgeFile({
      bytes: buildTestPdf("Delegate text PDF remains available when MinerU is offline."),
      fileName: "text.pdf",
      mimeType: "application/pdf",
    })).resolves.toMatchObject({
      kind: "pdf",
      extractionBackend: "pdfjs_fallback",
      text: expect.stringContaining("Delegate text PDF remains available"),
    });

    await expect(extractKnowledgeFile({
      bytes: buildTestPdf(),
      fileName: "scan.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("无法连接 MinerU"),
    });
  });

  it.each([
    ["brief.docx", "docx"],
    ["brief.pptx", "pptx"],
    ["budget.xlsx", "xlsx"],
    ["whiteboard.png", "image"],
    ["receipt.JPG", "image"],
    ["photo.jpeg", "image"],
  ] as const)("routes %s through MinerU as %s knowledge", async (fileName, kind) => {
    vi.stubEnv("MINERU_API_BASE_URL", "http://mineru.internal:8000");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: `task-${kind}` }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        backend: "hybrid-engine",
        version: "3.2.2",
        results: {
          document: { md_content: `# ${kind}\n\nMinerU extracted enough reusable knowledge from ${fileName}.` },
        },
      })));

    await expect(extractKnowledgeFile({
      bytes: new Uint8Array([1, 2, 3]),
      fileName,
    })).resolves.toMatchObject({
      kind,
      extractionBackend: "mineru",
      text: expect.stringContaining("MinerU extracted enough reusable knowledge"),
    });
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

  it("detects duplicate files, resolves same-name copies, and safely replaces a stored source", async () => {
    const marker = `conflict-${Date.now()}`;
    const originalBytes = new TextEncoder().encode("Delegate 第一版知识正文，包含足够长度用于重复检测和安全替换测试。");
    const original = await storeKnowledgeSource({
      ownerId: null,
      fileName: `${marker}.txt`,
      contentType: "text/plain",
      bytes: originalBytes,
    });
    const created = await createKnowledgeAsset(null, {
      kind: "txt",
      title: marker,
      originalFileName: `${marker}.txt`,
      mimeType: "text/plain",
      sizeBytes: originalBytes.byteLength,
      sourceObjectBucket: original.bucket,
      sourceObjectKey: original.objectKey,
      sourceObjectChecksum: original.checksum,
      tags: ["保留标签"],
    });

    const exact = await findKnowledgeFileConflicts(null, {
      fileName: `${marker}.txt`,
      checksum: checksumKnowledgeSource(originalBytes),
    });
    expect(exact.exact?.id).toBe(created.id);
    expect(exact.sameName?.id).toBe(created.id);
    await expect(resolveUniqueKnowledgeAssetTitle(null, marker)).resolves.toBe(`${marker} (2)`);

    const replacementBytes = new TextEncoder().encode("Delegate 第二版知识正文，内容已经改变，覆盖后必须重新解析并重建向量索引。");
    const sameName = await findKnowledgeFileConflicts(null, {
      fileName: `${marker}.txt`,
      checksum: checksumKnowledgeSource(replacementBytes),
    });
    expect(sameName.exact).toBeNull();
    expect(sameName.sameName?.id).toBe(created.id);

    const replacement = await storeKnowledgeSource({
      ownerId: null,
      fileName: `${marker}.txt`,
      contentType: "text/plain",
      bytes: replacementBytes,
    });
    const replaced = await replaceKnowledgeAssetSource(null, created.id, {
      kind: "txt",
      originalFileName: `${marker}.txt`,
      mimeType: "text/plain",
      sizeBytes: replacementBytes.byteLength,
      sourceObjectBucket: replacement.bucket,
      sourceObjectKey: replacement.objectKey,
      sourceObjectChecksum: replacement.checksum,
    });
    expect(replaced).toMatchObject({
      id: created.id,
      title: marker,
      status: "processing",
      tags: ["保留标签"],
      sourceObjectKey: replacement.objectKey,
      sourceObjectChecksum: replacement.checksum,
      vectorBackend: null,
    });
    await expect(readKnowledgeSource({ bucket: original.bucket, objectKey: original.objectKey })).rejects.toThrow("not found");

    const processed = await processKnowledgeAsset(null, created.id);
    expect(processed).toMatchObject({ status: "ready", processingError: null });
    expect(processed.extractedText).toContain("第二版知识正文");
    await archiveKnowledgeAsset(null, created.id, true);
    await deleteKnowledgeAsset(null, created.id);
  });

  it("detects supported file kinds and creates bounded overlapping retrieval chunks", () => {
    expect(detectKnowledgeFileKind("guide.PDF")).toBe("pdf");
    expect(detectKnowledgeFileKind("slides.pptx")).toBe("pptx");
    expect(detectKnowledgeFileKind("budget.xlsx")).toBe("xlsx");
    expect(detectKnowledgeFileKind("scan.PNG")).toBe("image");
    expect(detectKnowledgeFileKind("photo.jpeg")).toBe("image");
    expect(detectKnowledgeFileKind("guide.md")).toBe("markdown");
    expect(() => detectKnowledgeFileKind("image.bmp")).toThrow("仅支持");
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

function buildTestPdf(text = ""): Uint8Array {
  const content = text ? `BT /F1 14 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = source.length;
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
