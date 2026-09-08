import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const taskSubmissionSchema = z.object({
  task_id: z.string().trim().min(1).max(160),
  status: z.string().trim().optional(),
}).passthrough();

const taskStatusSchema = z.object({
  status: z.enum(["pending", "processing", "completed", "failed"]),
  error: z.string().nullish(),
}).passthrough();

const parseResultSchema = z.object({
  backend: z.string().trim().optional(),
  version: z.string().trim().optional(),
  results: z.record(z.string(), z.object({
    md_content: z.string().nullish(),
  }).passthrough()),
}).passthrough();

export type MinerUConfig = {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  pollIntervalMs: number;
  parseMethod: "auto" | "txt" | "ocr";
  language: string;
  backend?: string;
};

export type MinerUExtraction = {
  text: string;
  backend: string | null;
  version: string | null;
};

export type MinerUErrorCode =
  | "mineru_unavailable"
  | "mineru_timeout"
  | "mineru_rejected"
  | "mineru_task_failed"
  | "mineru_invalid_response"
  | "mineru_empty_output";

export class MinerUError extends Error {
  readonly code: MinerUErrorCode;
  readonly retryable: boolean;

  constructor(code: MinerUErrorCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "MinerUError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function resolveMinerUConfig(
  env: NodeJS.ProcessEnv = process.env,
): MinerUConfig | null {
  const rawBaseUrl = normalize(env.MINERU_API_BASE_URL);
  if (!rawBaseUrl) return null;

  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new MinerUError(
      "mineru_unavailable",
      "MinerU API 地址格式无效。",
      false,
    );
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new MinerUError(
      "mineru_unavailable",
      "MinerU API 地址必须使用不含内嵌凭据的 HTTP/HTTPS URL。",
      false,
    );
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");

  const parseMethod = normalize(env.MINERU_PARSE_METHOD) ?? "auto";
  if (!(["auto", "txt", "ocr"] as const).includes(parseMethod as "auto" | "txt" | "ocr")) {
    throw new MinerUError(
      "mineru_unavailable",
      "MINERU_PARSE_METHOD 仅支持 auto、txt 或 ocr。",
      false,
    );
  }
  const language = normalize(env.MINERU_LANGUAGE) ?? "ch";
  if (!/^[a-zA-Z0-9_-]{1,32}$/u.test(language)) {
    throw new MinerUError(
      "mineru_unavailable",
      "MINERU_LANGUAGE 格式无效。",
      false,
    );
  }
  const backend = normalize(env.MINERU_BACKEND);
  if (backend && !/^[a-zA-Z0-9_-]{1,64}$/u.test(backend)) {
    throw new MinerUError(
      "mineru_unavailable",
      "MINERU_BACKEND 格式无效。",
      false,
    );
  }

  return {
    baseUrl: url.toString().replace(/\/$/u, ""),
    ...(normalize(env.MINERU_API_TOKEN)
      ? { token: normalize(env.MINERU_API_TOKEN)! }
      : {}),
    timeoutMs: boundedInteger(env.MINERU_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 30 * 60 * 1_000),
    pollIntervalMs: boundedInteger(env.MINERU_API_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 100, 10_000),
    parseMethod: parseMethod as "auto" | "txt" | "ocr",
    language,
    ...(backend ? { backend } : {}),
  };
}

export async function extractDocumentWithMinerU(input: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<MinerUExtraction | null> {
  const config = resolveMinerUConfig(input.env);
  if (!config) return null;

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const documentBytes = new Uint8Array(input.bytes.byteLength);
    documentBytes.set(input.bytes);
    const form = new FormData();
    form.append(
      "files",
      new Blob([documentBytes.buffer], { type: input.mimeType || "application/octet-stream" }),
      safeDocumentFileName(input.fileName),
    );
    form.append("return_md", "true");
    form.append("return_middle_json", "false");
    form.append("return_model_output", "false");
    form.append("return_content_list", "false");
    form.append("return_images", "false");
    form.append("return_original_file", "false");
    form.append("response_format_zip", "false");
    form.append("parse_method", config.parseMethod);
    form.append("lang_list", config.language);
    if (config.backend) form.append("backend", config.backend);

    const submission = await minerUFetchJson({
      fetchImpl,
      url: endpoint(config, "/tasks"),
      init: {
        method: "POST",
        headers: authorizationHeaders(config),
        body: form,
        signal: controller.signal,
      },
      operation: "提交解析任务",
    });
    const task = taskSubmissionSchema.safeParse(submission);
    if (!task.success) {
      throw new MinerUError(
        "mineru_invalid_response",
        "MinerU 返回了无效的任务信息。",
        true,
      );
    }

    await waitForTask({
      config,
      taskId: task.data.task_id,
      fetchImpl,
      signal: controller.signal,
    });
    const resultPayload = await minerUFetchJson({
      fetchImpl,
      url: endpoint(config, `/tasks/${encodeURIComponent(task.data.task_id)}/result`),
      init: { headers: authorizationHeaders(config), signal: controller.signal },
      operation: "读取解析结果",
    });
    const result = parseResultSchema.safeParse(resultPayload);
    if (!result.success) {
      throw new MinerUError(
        "mineru_invalid_response",
        "MinerU 返回了无法识别的解析结果。",
        true,
      );
    }
    const documents = Object.values(result.data.results);
    if (documents.length !== 1) {
      throw new MinerUError(
        "mineru_invalid_response",
        "MinerU 返回的文档数量与请求不一致。",
        true,
      );
    }
    const text = documents[0]?.md_content?.trim() ?? "";
    if (!text) {
      throw new MinerUError(
        "mineru_empty_output",
        "MinerU 未从该文件提取到正文。",
        false,
      );
    }
    return {
      text,
      backend: result.data.backend ?? null,
      version: result.data.version ?? null,
    };
  } catch (error) {
    if (error instanceof MinerUError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new MinerUError(
        "mineru_timeout",
        "MinerU 解析超时，请稍后重新处理。",
        true,
        { cause: error },
      );
    }
    throw new MinerUError(
      "mineru_unavailable",
      "无法连接 MinerU 解析服务。",
      true,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForTask(input: {
  config: MinerUConfig;
  taskId: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}) {
  while (true) {
    const payload = await minerUFetchJson({
      fetchImpl: input.fetchImpl,
      url: endpoint(input.config, `/tasks/${encodeURIComponent(input.taskId)}`),
      init: {
        headers: authorizationHeaders(input.config),
        signal: input.signal,
      },
      operation: "查询解析进度",
    });
    const status = taskStatusSchema.safeParse(payload);
    if (!status.success) {
      throw new MinerUError(
        "mineru_invalid_response",
        "MinerU 返回了无效的任务状态。",
        true,
      );
    }
    if (status.data.status === "completed") return;
    if (status.data.status === "failed") {
      throw new MinerUError(
        "mineru_task_failed",
        "MinerU 解析任务失败，请检查 MinerU 服务日志后重试。",
        true,
      );
    }
    await wait(input.config.pollIntervalMs, input.signal);
  }
}

async function minerUFetchJson(input: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  operation: string;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, input.init);
  } catch (error) {
    throw error;
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new MinerUError(
      "mineru_invalid_response",
      `MinerU ${input.operation}响应过大。`,
      false,
    );
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new MinerUError(
      "mineru_invalid_response",
      `MinerU ${input.operation}响应过大。`,
      false,
    );
  }
  let payload: unknown = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    throw new MinerUError(
      "mineru_invalid_response",
      `MinerU ${input.operation}返回了非 JSON 响应。`,
      true,
    );
  }
  if (!response.ok) {
    throw new MinerUError(
      "mineru_rejected",
      `MinerU ${input.operation}被拒绝（HTTP ${response.status}）。`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  return payload;
}

function endpoint(config: MinerUConfig, path: string) {
  return `${config.baseUrl}${path}`;
}

function authorizationHeaders(config: MinerUConfig): HeadersInit {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

function safeDocumentFileName(value: string): string {
  const base = value.split(/[\\/]/u).pop()?.trim() || "document.bin";
  const sanitized = base.replace(/[\0\r\n]/gu, "-").slice(-180);
  return sanitized || "document.bin";
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
