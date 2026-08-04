import {
  openVikingFindResultSchema,
  openVikingHealthSchema,
  openVikingStatusSchema,
  openVikingWaitResultSchema,
  type OpenVikingClientConfig,
  type OpenVikingClientScope,
  type OpenVikingFindResult,
  type OpenVikingHealth,
  type OpenVikingLsEntry,
  type OpenVikingStatus,
  type OpenVikingWaitResult,
} from "./types";

export class OpenVikingRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenVikingRequestError";
    this.status = status;
  }
}

type ApiEnvelope<T> = {
  status: string;
  result?: T;
  error?: {
    code?: string;
    message?: string;
  };
};

const OPENVIKING_RESOURCE_URI_PREFIX = "viking://resources/";
const OPENVIKING_RESOURCE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * Rejects cross-scope and non-canonical resource targets before any OpenViking
 * write is attempted. Percent-encoded and backslash paths are deliberately
 * refused so validation cannot disagree with a downstream URI normalizer.
 */
export function assertCanonicalOpenVikingResourceUri(uri: string): void {
  if (
    typeof uri !== "string"
    || uri !== uri.trim()
    || !uri.startsWith(OPENVIKING_RESOURCE_URI_PREFIX)
    || /[\u0000-\u0020\u007f\\%?#]/u.test(uri)
  ) {
    throw new Error("OpenViking resource target must be a canonical viking://resources/ URI.");
  }

  const suffix = uri.slice(OPENVIKING_RESOURCE_URI_PREFIX.length);
  if (!suffix) return;

  const segments = suffix.split("/");
  if (segments.at(-1) === "") segments.pop();
  if (
    !segments.length
    || segments.some(
      (segment) =>
        !segment
        || segment === "."
        || segment === ".."
        || !OPENVIKING_RESOURCE_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error("OpenViking resource target must be a canonical viking://resources/ URI.");
  }
}

export class OpenVikingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly scope: OpenVikingClientScope;

  constructor(config: OpenVikingClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey?.trim() || undefined;
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.scope = {
      ...(config.accountId ? { accountId: config.accountId } : {}),
      ...(config.userId ? { userId: config.userId } : {}),
      ...(config.agentId ? { agentId: config.agentId } : {}),
    };
  }

  withScope(scope: OpenVikingClientScope): OpenVikingClient {
    return new OpenVikingClient({
      baseUrl: this.baseUrl,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      ...this.scope,
      ...scope,
    });
  }

  async health(): Promise<OpenVikingHealth> {
    const result = await this.request<OpenVikingHealth>("/health", {
      method: "GET",
      authenticated: false,
      raw: true,
    });
    return openVikingHealthSchema.parse(result);
  }

  async status(): Promise<OpenVikingStatus> {
    const result = await this.request<OpenVikingStatus>("/api/v1/system/status", {
      method: "GET",
    });
    return openVikingStatusSchema.parse(result);
  }

  async waitProcessed(timeout?: number): Promise<OpenVikingWaitResult> {
    const result = await this.request<OpenVikingWaitResult>("/api/v1/system/wait", {
      method: "POST",
      body: JSON.stringify(timeout ? { timeout } : {}),
    });
    return openVikingWaitResultSchema.parse(result);
  }

  async tempUpload(params: {
    filename: string;
    content: string;
    contentType?: string;
  }): Promise<{ temp_path?: string; temp_file_id?: string }> {
    const formData = new FormData();
    const blob = new Blob([params.content], {
      type: params.contentType ?? "text/markdown; charset=utf-8",
    });
    formData.set("file", blob, params.filename);
    formData.set("telemetry", "false");

    return this.request<{ temp_path?: string; temp_file_id?: string }>("/api/v1/resources/temp_upload", {
      method: "POST",
      body: formData,
      json: false,
    });
  }

  async addResource(params: {
    path?: string;
    tempPath?: string;
    tempFileId?: string;
    to: string;
    reason: string;
    instruction?: string;
    wait?: boolean;
    timeout?: number;
  }): Promise<{ root_uri?: string; status?: string; source_path?: string; errors?: string[] }> {
    assertCanonicalOpenVikingResourceUri(params.to);

    const waitsForProcessing = params.wait ?? true;
    const processingTimeoutMs =
      waitsForProcessing && typeof params.timeout === "number"
        ? params.timeout * 1000 + 5000
        : undefined;

    return this.request("/api/v1/resources", {
      method: "POST",
      body: JSON.stringify({
        ...(params.path ? { path: params.path } : {}),
        ...(params.tempPath ? { temp_path: params.tempPath } : {}),
        ...(params.tempFileId ? { temp_file_id: params.tempFileId } : {}),
        to: params.to,
        reason: params.reason,
        instruction: params.instruction ?? "",
        wait: params.wait ?? true,
        ...(typeof params.timeout === "number" ? { timeout: params.timeout } : {}),
      }),
      ...(processingTimeoutMs
        ? { timeoutMs: Math.max(this.timeoutMs, processingTimeoutMs) }
        : {}),
    });
  }

  async remove(uri: string, recursive = false): Promise<{ uri?: string; estimated_deleted_count?: number }> {
    const searchParams = new URLSearchParams({ uri, recursive: String(recursive) });
    return this.request(`/api/v1/fs?${searchParams.toString()}`, { method: "DELETE" });
  }

  async ls(params: {
    uri: string;
    simple?: boolean;
    recursive?: boolean;
    limit?: number;
  }): Promise<OpenVikingLsEntry[] | string[]> {
    const searchParams = new URLSearchParams({
      uri: params.uri,
      ...(params.simple ? { simple: "true" } : {}),
      ...(params.recursive ? { recursive: "true" } : {}),
      ...(typeof params.limit === "number" ? { limit: String(params.limit) } : {}),
    });
    return this.request(`/api/v1/fs/ls?${searchParams.toString()}`, {
      method: "GET",
    });
  }

  async overview(uri: string): Promise<string> {
    return this.requestContent(`/api/v1/content/overview?uri=${encodeURIComponent(uri)}`);
  }

  async abstract(uri: string): Promise<string> {
    return this.requestContent(`/api/v1/content/abstract?uri=${encodeURIComponent(uri)}`);
  }

  async read(uri: string, limit = 80): Promise<string> {
    return this.requestContent(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}&limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async find(params: {
    query: string;
    targetUri: string;
    limit: number;
    scoreThreshold?: number;
  }): Promise<OpenVikingFindResult> {
    const result = await this.request<OpenVikingFindResult>("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify({
        query: params.query,
        target_uri: params.targetUri,
        limit: params.limit,
        ...(typeof params.scoreThreshold === "number"
          ? { score_threshold: params.scoreThreshold }
          : {}),
      }),
    });
    return openVikingFindResultSchema.parse(result);
  }

  async search(params: {
    query: string;
    targetUri: string;
    limit: number;
    scoreThreshold?: number;
    sessionId?: string;
  }): Promise<OpenVikingFindResult> {
    const result = await this.request<OpenVikingFindResult>("/api/v1/search/search", {
      method: "POST",
      body: JSON.stringify({
        query: params.query,
        target_uri: params.targetUri,
        limit: params.limit,
        ...(typeof params.scoreThreshold === "number"
          ? { score_threshold: params.scoreThreshold }
          : {}),
        ...(params.sessionId ? { session_id: params.sessionId } : {}),
      }),
    });
    return openVikingFindResultSchema.parse(result);
  }

  private async requestContent(path: string): Promise<string> {
    const result = await this.request<string>(path, {
      method: "GET",
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  private async request<T>(
    path: string,
    options: {
      method: string;
      body?: BodyInit;
      authenticated?: boolean;
      json?: boolean;
      raw?: boolean;
      timeoutMs?: number;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.timeoutMs,
    );

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: buildHeaders({
          authenticated: options.authenticated ?? true,
          json: options.json ?? !(options.body instanceof FormData),
          scope: this.scope,
          ...(this.apiKey ? { apiKey: this.apiKey } : {}),
        }),
        ...(options.body ? { body: options.body } : {}),
        signal: controller.signal,
      });

      const text = await response.text();
      const json = text ? (JSON.parse(text) as ApiEnvelope<T>) : undefined;

      if (options.raw) {
        if (!response.ok || typeof json === "undefined") {
          throw new OpenVikingRequestError(response.statusText || "OpenViking request failed.", response.status);
        }
        return json as T;
      }

      if (!response.ok || !json || json.status !== "ok") {
        throw new OpenVikingRequestError(
          json?.error?.message ?? (response.statusText || "OpenViking request failed."),
          response.status,
        );
      }

      return json.result as T;
    } catch (error) {
      if (error instanceof OpenVikingRequestError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new OpenVikingRequestError("OpenViking request timed out.", 408);
      }

      throw new OpenVikingRequestError(
        error instanceof Error ? error.message : "OpenViking request failed.",
        503,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function buildHeaders(params: {
  apiKey?: string;
  authenticated: boolean;
  json: boolean;
  scope: OpenVikingClientScope;
}): Headers {
  const headers = new Headers();

  if (params.authenticated && params.apiKey) {
    headers.set("X-API-Key", params.apiKey);
  }

  if (params.scope.accountId) {
    headers.set("X-OpenViking-Account", params.scope.accountId);
  }

  if (params.scope.userId) {
    headers.set("X-OpenViking-User", params.scope.userId);
  }

  if (params.scope.agentId) {
    headers.set("X-OpenViking-Agent", params.scope.agentId);
  }

  if (params.json) {
    headers.set("Content-Type", "application/json");
  }

  return headers;
}
