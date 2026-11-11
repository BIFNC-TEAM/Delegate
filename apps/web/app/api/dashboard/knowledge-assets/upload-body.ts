import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { KNOWLEDGE_FILE_BYTES, KNOWLEDGE_REQUEST_BYTES } from "@delegate/domain/knowledge-limits";
import { KnowledgeLibraryError } from "@delegate/web-data";

/** Spool multipart input to disk instead of retaining the complete form and file in RAM. */
export async function readKnowledgeUpload(request: Request) {
  if (!request.body) throw new KnowledgeLibraryError("请选择要上传的知识文件。", 422);
  if (Number(request.headers.get("content-length")) > KNOWLEDGE_REQUEST_BYTES) throw new KnowledgeLibraryError("文件不能超过 150 MB。", 413);
  const directory = await mkdtemp(join(tmpdir(), "delegate-knowledge-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const form = new FormData();
  let file: { name: string; type: string; size: number; arrayBuffer: () => Promise<Uint8Array> } | null = null;
  let problem: Error | null = null;
  let total = 0;
  const writes: Promise<void>[] = [];
  try {
    const parser = busboy({ defParamCharset: "utf8", headers: { "content-type": request.headers.get("content-type")! }, limits: {
      files: 1, fileSize: KNOWLEDGE_FILE_BYTES + 1, fields: 20, fieldSize: 1024 * 1024, parts: 21,
    } });
    const rejectSize = () => { problem = new KnowledgeLibraryError("文件不能超过 150 MB。", 413); };
    parser.on("filesLimit", () => { problem = new KnowledgeLibraryError("每次请求只能上传一个文件。", 422); });
    parser.on("fieldsLimit", () => { problem = new KnowledgeLibraryError("上传字段过多。", 422); });
    parser.on("partsLimit", () => { problem = new KnowledgeLibraryError("上传内容过多。", 422); });
    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) problem = new KnowledgeLibraryError("上传字段过长。", 413);
      form.set(name, value);
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "file") { stream.resume(); problem = new KnowledgeLibraryError("无效的上传文件。", 422); return; }
      const path = join(directory, "source");
      const item = { name: info.filename ?? "", type: info.mimeType, size: 0, arrayBuffer: () => readFile(path) };
      file = item;
      stream.on("limit", rejectSize);
      stream.on("data", (data: Buffer) => { item.size += data.length; });
      const write = pipeline(stream, createWriteStream(path));
      write.catch((error) => { problem = error; });
      writes.push(write);
    });
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > KNOWLEDGE_REQUEST_BYTES ? new KnowledgeLibraryError("上传请求超过 160 MB。", 413) : null, chunk);
    } });
    await pipeline(Readable.fromWeb(request.body as never), limit, parser);
    await Promise.all(writes);
    if (problem) throw problem;
    return { form, file: file as { name: string; type: string; size: number; arrayBuffer: () => Promise<Uint8Array> } | null, cleanup };
  } catch (error) {
    await Promise.allSettled(writes);
    await cleanup();
    throw error;
  }
}

const uploadSlots = globalThis as typeof globalThis & { delegateKnowledgeUploads?: number };
export function acquireKnowledgeUpload(): () => void {
  if ((uploadSlots.delegateKnowledgeUploads ?? 0) >= 2) {
    throw new KnowledgeLibraryError("当前有其他文件正在上传，请稍后重试。", 503);
  }
  uploadSlots.delegateKnowledgeUploads = (uploadSlots.delegateKnowledgeUploads ?? 0) + 1;
  return () => { uploadSlots.delegateKnowledgeUploads = Math.max(0, (uploadSlots.delegateKnowledgeUploads ?? 1) - 1); };
}
