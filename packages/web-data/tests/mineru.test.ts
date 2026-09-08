import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractDocumentWithMinerU,
  resolveMinerUConfig,
} from "../src/mineru";

describe("MinerU document parsing client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays disabled until an API base URL is configured", async () => {
    expect(resolveMinerUConfig({})).toBeNull();
    await expect(extractDocumentWithMinerU({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "scan.pdf",
      env: {},
    })).resolves.toBeNull();
  });

  it("submits one bounded PDF task, polls it, and returns Markdown", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      if (requests.length === 1) {
        return jsonResponse({ task_id: "task-123", status: "pending" }, 202);
      }
      if (requests.length === 2) {
        return jsonResponse({ task_id: "task-123", status: "completed" });
      }
      return jsonResponse({
        backend: "hybrid-engine",
        version: "3.2.2",
        results: {
          scan: { md_content: "# 扫描协议\n\n这是由 MinerU OCR 提取的知识正文。" },
        },
      });
    }) as unknown as typeof fetch;

    const result = await extractDocumentWithMinerU({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "扫描协议.PDF",
      mimeType: "application/pdf",
      env: {
        MINERU_API_BASE_URL: "http://mineru.internal:8000/",
        MINERU_API_TOKEN: "secret-token",
        MINERU_PARSE_METHOD: "auto",
        MINERU_LANGUAGE: "ch",
        MINERU_BACKEND: "hybrid-engine",
      },
      fetchImpl,
    });

    expect(result).toEqual({
      text: "# 扫描协议\n\n这是由 MinerU OCR 提取的知识正文。",
      backend: "hybrid-engine",
      version: "3.2.2",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://mineru.internal:8000/tasks",
      "http://mineru.internal:8000/tasks/task-123",
      "http://mineru.internal:8000/tasks/task-123/result",
    ]);
    expect(requests[0]?.init?.headers).toEqual({ Authorization: "Bearer secret-token" });
    const form = requests[0]?.init?.body as FormData;
    expect(form.get("parse_method")).toBe("auto");
    expect(form.get("lang_list")).toBe("ch");
    expect(form.get("backend")).toBe("hybrid-engine");
    expect(form.get("return_md")).toBe("true");
    expect(form.get("response_format_zip")).toBe("false");
    expect(form.get("return_images")).toBe("false");
    expect(form.get("files")).toBeInstanceOf(File);
    expect((form.get("files") as File).name).toBe("扫描协议.PDF");
  });

  it("returns a retryable sanitized error when a MinerU task fails", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-failed" }, 202))
      .mockResolvedValueOnce(jsonResponse({
        status: "failed",
        error: "token=super-secret failed at https://private.example/path\ntrace",
      })) as unknown as typeof fetch;

    const promise = extractDocumentWithMinerU({
      bytes: new Uint8Array([1]),
      fileName: "scan.pdf",
      env: { MINERU_API_BASE_URL: "https://mineru.example" },
      fetchImpl,
    });

    await expect(promise).rejects.toMatchObject({
      code: "mineru_task_failed",
      retryable: true,
    });
    await expect(promise).rejects.not.toThrow("super-secret");
    await expect(promise).rejects.not.toThrow("private.example");
  });

  it("rejects invalid endpoint and parser configuration", () => {
    expect(() => resolveMinerUConfig({ MINERU_API_BASE_URL: "file:///tmp/mineru" }))
      .toThrow("HTTP/HTTPS");
    expect(() => resolveMinerUConfig({
      MINERU_API_BASE_URL: "https://mineru.example",
      MINERU_PARSE_METHOD: "unsafe",
    })).toThrow("MINERU_PARSE_METHOD");
  });

  it("measures response limits in bytes for multibyte content", async () => {
    const oversizedBody = "界".repeat(Math.ceil((2 * 1024 * 1024) / 3) + 1);
    const fetchImpl = vi.fn(async () =>
      new Response(oversizedBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(extractDocumentWithMinerU({
      bytes: new Uint8Array([1]),
      fileName: "scan.pdf",
      env: { MINERU_API_BASE_URL: "https://mineru.example" },
      fetchImpl,
    })).rejects.toMatchObject({ code: "mineru_invalid_response" });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
