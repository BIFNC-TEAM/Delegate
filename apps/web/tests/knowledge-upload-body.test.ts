import { describe, expect, it } from "vitest";
import { readKnowledgeUpload } from "../app/api/dashboard/knowledge-assets/upload-body";

function streamedFile(size: number) {
  const encoder = new TextEncoder();
  let sent = 0;
  let opened = false;
  const body = new ReadableStream({ pull(controller) {
    if (!opened) { opened = true; controller.enqueue(encoder.encode('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="边界.md"\r\nContent-Type: text/markdown\r\n\r\n')); return; }
    if (sent < size) { const count = Math.min(1024 * 1024, size - sent); sent += count; controller.enqueue(new Uint8Array(count)); return; }
    controller.enqueue(encoder.encode('\r\n--test-boundary--\r\n')); controller.close();
  } });
  return new Request("http://localhost/upload", { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=test-boundary" } } as RequestInit);
}

describe("streaming knowledge upload", () => {
  it("accepts exactly 150 MiB, including a UTF-8 filename", async () => {
    const upload = await readKnowledgeUpload(streamedFile(150 * 1024 * 1024));
    try { expect(upload.file?.size).toBe(150 * 1024 * 1024); expect(upload.file?.name).toBe("边界.md"); }
    finally { await upload.cleanup(); }
  }, 30_000);
  it("rejects one byte over 150 MiB even without a content-length header", async () => {
    await expect(readKnowledgeUpload(streamedFile(150 * 1024 * 1024 + 1))).rejects.toThrow("150 MB");
  }, 30_000);
  it("spools a file larger than the previous limit and preserves metadata and bytes", async () => {
    const bytes = new Uint8Array(16 * 1024 * 1024); bytes[bytes.length - 1] = 77;
    const form = new FormData(); form.set("file", new Blob([bytes]), "large.pdf"); form.set("title", "测试");
    const upload = await readKnowledgeUpload(new Request("http://localhost/upload", { method: "POST", body: form }));
    try {
      expect(upload.form.get("title")).toBe("测试");
      expect(upload.file?.size).toBe(bytes.length);
      expect((await upload.file!.arrayBuffer()).at(-1)).toBe(77);
    } finally { await upload.cleanup(); }
  });
  it("rejects an oversized request before consuming it", async () => {
    const request = new Request("http://localhost/upload", { method: "POST", body: "x", headers: { "content-length": String(161 * 1024 * 1024) } });
    await expect(readKnowledgeUpload(request)).rejects.toThrow("150 MB");
  });
  it("rejects multiple files instead of silently losing one", async () => {
    const form = new FormData(); form.append("file", new Blob(["one"]), "one.md"); form.append("file", new Blob(["two"]), "two.md");
    await expect(readKnowledgeUpload(new Request("http://localhost/upload", { method: "POST", body: form }))).rejects.toThrow("一个文件");
  });
});
