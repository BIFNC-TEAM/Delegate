import { describe, expect, it, vi, afterEach } from "vitest";
import { KNOWLEDGE_TEXT_CHARACTERS, KNOWLEDGE_RESULT_BYTES } from "@delegate/domain/knowledge-limits";
import { readKnowledgeResponse } from "../src/knowledge-response";
import { extractKnowledgeFile } from "../src/knowledge-library";
import { extractDocumentWithMinerU } from "../src/mineru";
import { knowledgeIngestionContext, KnowledgeProcessingPending } from "../src/knowledge-ingestion-context";

afterEach(() => vi.unstubAllEnvs());
describe("large knowledge content", () => {
  it("keeps the tail of a two-million-character text and rejects overflow without truncation", async () => {
    const text = "中".repeat(KNOWLEDGE_TEXT_CHARACTERS - 8) + "TAILMARK";
    const result = await extractKnowledgeFile({ bytes: new TextEncoder().encode(text), fileName: "large.md" });
    expect(result.text.length).toBe(KNOWLEDGE_TEXT_CHARACTERS);
    expect(result.text.endsWith("TAILMARK")).toBe(true);
    await expect(extractKnowledgeFile({ bytes: new TextEncoder().encode(text + "x"), fileName: "large.md" })).rejects.toThrow("2,000,000");
  });
  it("accepts escaped Chinese JSON under 16 MiB", async () => {
    const body = '{"md_content":"' + "\\u4e2d".repeat(KNOWLEDGE_TEXT_CHARACTERS) + '"}';
    const text = await readKnowledgeResponse(new Response(body), KNOWLEDGE_RESULT_BYTES);
    expect(JSON.parse(text).md_content.length).toBe(KNOWLEDGE_TEXT_CHARACTERS);
  });
  it("cancels chunked responses as soon as their byte allowance is exhausted", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel });
    await expect(readKnowledgeResponse(new Response(body), 2048)).rejects.toThrow("上限");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("resumes a saved MinerU task without uploading a second copy", async () => {
    const checkpoint: Record<string, string> = {};
    const save = async (key: string, value: string) => { checkpoint[key] = value; };
    let completed = false;
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      if (String(url).endsWith("/tasks")) return Response.json({ task_id: "saved-task" });
      if (String(url).endsWith("/result")) return Response.json({ results: { doc: { md_content: "完成解析，保留完整内容供检索使用。" } } });
      return Response.json({ status: completed ? "completed" : "processing" });
    }) as typeof fetch;
    const run = () => knowledgeIngestionContext.run({ checkpoint, save }, () => extractDocumentWithMinerU({ bytes: new Uint8Array([1]), fileName: "doc.pdf", env: { MINERU_API_BASE_URL: "http://mineru.test" }, fetchImpl }));
    await expect(run()).rejects.toBeInstanceOf(KnowledgeProcessingPending);
    completed = true;
    await expect(run()).resolves.toMatchObject({ text: "完成解析，保留完整内容供检索使用。" });
    expect(urls.filter((url) => url.endsWith("/tasks"))).toHaveLength(1);
  });
});
