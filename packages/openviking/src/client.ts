import { createHash } from "node:crypto";

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
import {
  assertExactGovernedMemoryRootUri,
  assertExactGovernedMemoryVersionUri,
  type GovernedMemoryRoot,
  type GovernedMemoryVersion,
} from "./uris";

export class OpenVikingRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenVikingRequestError";
    this.status = status;
  }
}

export class GovernedMemoryUnsupportedError extends OpenVikingRequestError {
  readonly code = "GOVERNED_MEMORY_BATCH_WRITE_UNSUPPORTED";
  readonly capability = "content.batch-write";
  readonly capabilityStatus = "degraded";

  constructor(status: number) {
    super(
      "Governed memory projection is degraded: this OpenViking deployment does not support "
      + "/api/v1/content/batch-write (requires OpenViking v0.4.12 or newer); no unsafe "
      + "content/write fallback was attempted.",
      status,
    );
    this.name = "GovernedMemoryUnsupportedError";
  }
}

export class ExactResourceUnsupportedError extends OpenVikingRequestError {
  readonly code = "EXACT_RESOURCE_BATCH_WRITE_UNSUPPORTED";
  readonly capability = "content.batch-write";
  readonly capabilityStatus = "degraded";

  constructor(status: number) {
    super(
      "Exact published-resource projection is degraded: this OpenViking deployment does not "
      + "support /api/v1/content/batch-write (requires OpenViking v0.4.12 or newer); no unsafe "
      + "resource upload fallback was attempted.",
      status,
    );
    this.name = "ExactResourceUnsupportedError";
  }
}

export class ExactResourceRootProvisionError extends OpenVikingRequestError {
  readonly code: "EXACT_RESOURCE_ROOT_PROVISION_UNSUPPORTED"
    | "EXACT_RESOURCE_ROOT_PROVISION_FAILED";
  readonly capability = "fs.mkdir";
  readonly capabilityStatus = "degraded";
  readonly failure: GovernedMemoryRootProvisionFailure;
  readonly stage: "mkdir" | "verify";

  constructor(params: {
    status: number;
    failure: GovernedMemoryRootProvisionFailure;
    stage: "mkdir" | "verify";
  }) {
    const unsupported = params.failure === "unsupported";
    super(
      unsupported
        ? "Exact published-resource root provisioning is degraded: this OpenViking deployment does not support the required mkdir contract."
        : `Exact published-resource root provisioning failed during ${params.stage}; the root was not verified ready.`,
      params.status,
    );
    this.name = "ExactResourceRootProvisionError";
    this.code = unsupported
      ? "EXACT_RESOURCE_ROOT_PROVISION_UNSUPPORTED"
      : "EXACT_RESOURCE_ROOT_PROVISION_FAILED";
    this.failure = params.failure;
    this.stage = params.stage;
  }
}

export type GovernedMemoryRootProvisionFailure =
  | "unsupported"
  | "mkdir_failed"
  | "verification_failed";

export class GovernedMemoryRootProvisionError extends OpenVikingRequestError {
  readonly code: "GOVERNED_MEMORY_ROOT_PROVISION_UNSUPPORTED"
    | "GOVERNED_MEMORY_ROOT_PROVISION_FAILED";
  readonly capability = "fs.mkdir";
  readonly capabilityStatus = "degraded";
  readonly failure: GovernedMemoryRootProvisionFailure;
  readonly stage: "mkdir" | "verify";

  constructor(params: {
    status: number;
    failure: GovernedMemoryRootProvisionFailure;
    stage: "mkdir" | "verify";
  }) {
    const unsupported = params.failure === "unsupported";
    super(
      unsupported
        ? "Governed memory root provisioning is degraded: this OpenViking deployment does "
          + "not support the required managed-user mkdir contract."
        : `Governed memory root provisioning failed during ${params.stage}; the root was not verified ready.`,
      params.status,
    );
    this.name = "GovernedMemoryRootProvisionError";
    this.code = unsupported
      ? "GOVERNED_MEMORY_ROOT_PROVISION_UNSUPPORTED"
      : "GOVERNED_MEMORY_ROOT_PROVISION_FAILED";
    this.failure = params.failure;
    this.stage = params.stage;
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
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export type GovernedMemoryWriteResult = {
  uri: string;
  rootUri: string;
  contentHash: string;
  outcome: "created" | "unchanged";
};

export type GovernedMemoryReadResult = {
  uri: string;
  content: string;
  contentHash: string;
};

export type GovernedMemoryRootEnsureResult = {
  rootUri: string;
  outcome: "ready";
};

export type ExactResourceWriteResult = {
  uri: string;
  rootUri: string;
  contentHash: string;
  outcome: "created" | "unchanged";
};

export type ExactResourceReadResult = {
  uri: string;
  content: string;
  contentHash: string;
};

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

/**
 * Validates an immutable resource leaf below one exact version-scoped root.
 * This deliberately rejects the root itself and directory targets.
 */
export function assertExactOpenVikingResourceLeaf(params: {
  rootUri: string;
  uri: string;
}): void {
  assertCanonicalOpenVikingResourceUri(params.rootUri);
  assertCanonicalOpenVikingResourceUri(params.uri);
  if (
    !params.rootUri.endsWith("/")
    || params.uri.endsWith("/")
    || params.uri === params.rootUri
    || !params.uri.startsWith(params.rootUri)
  ) {
    throw new Error("OpenViking resource URI must be an exact leaf below its pinned root.");
  }
}

export function assertExactOpenVikingResourceRootUri(rootUri: string): void {
  assertCanonicalOpenVikingResourceUri(rootUri);
  if (!rootUri.endsWith("/") || rootUri === OPENVIKING_RESOURCE_URI_PREFIX) {
    throw new Error("OpenViking exact resource root must be a canonical non-root directory URI.");
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

  /**
   * Ensures one validated managed-user memory root exists. OpenViking v0.4.12
   * mkdir creates missing ancestors of this exact target; a stat read verifies
   * the final root because mkdir intentionally treats concurrent existence as
   * success and some storage backends do not distinguish that response.
   */
  async ensureGovernedMemoryRoot(params: {
    namespaceKey: string;
    uri: string;
  }): Promise<GovernedMemoryRootEnsureResult> {
    const root = this.requireGovernedMemoryRoot(params);
    const transportRootUri = root.rootUri.slice(0, -1);

    try {
      const mkdirResult = await this.request<unknown>("/api/v1/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ uri: transportRootUri }),
      });
      if (!isRecord(mkdirResult) || mkdirResult.uri !== transportRootUri) {
        throw new GovernedMemoryRootProvisionError({
          status: 502,
          failure: "mkdir_failed",
          stage: "mkdir",
        });
      }
    } catch (error) {
      if (error instanceof GovernedMemoryRootProvisionError) throw error;
      if (!(error instanceof OpenVikingRequestError)) throw error;
      if (error.status !== 409) {
        throw new GovernedMemoryRootProvisionError({
          status: normalizeProvisionStatus(error.status),
          failure: isUnsupportedMkdirStatus(error.status) ? "unsupported" : "mkdir_failed",
          stage: "mkdir",
        });
      }
      // A concurrent creator or pre-existing path is accepted only after the
      // exact target is independently verified as a directory below.
    }

    let statResult: unknown;
    try {
      const searchParams = new URLSearchParams({ uri: transportRootUri });
      statResult = await this.request<unknown>(
        `/api/v1/fs/stat?${searchParams.toString()}`,
        { method: "GET" },
      );
    } catch (error) {
      if (!(error instanceof OpenVikingRequestError)) throw error;
      throw new GovernedMemoryRootProvisionError({
        status: normalizeProvisionStatus(error.status),
        failure: "verification_failed",
        stage: "verify",
      });
    }

    if (!isVerifiedDirectoryStat(statResult, transportRootUri)) {
      throw new GovernedMemoryRootProvisionError({
        status: isRecord(statResult) && statResult.isDir === false ? 409 : 502,
        failure: "verification_failed",
        stage: "verify",
      });
    }

    return { rootUri: root.rootUri, outcome: "ready" };
  }

  /**
   * Creates exactly one immutable governed-memory projection. The caller's
   * approved hash is checked locally before any request is issued, and the
   * OpenViking write is create-only and idempotent by final content bytes.
   */
  async createGovernedMemoryVersion(params: {
    namespaceKey: string;
    uri: string;
    safeText: string;
    contentHash: string;
    timeoutSeconds?: number;
  }): Promise<GovernedMemoryWriteResult> {
    const version = this.requireGovernedMemoryVersion(params);
    if (typeof params.safeText !== "string") {
      throw new Error("Governed memory safeText must be a string.");
    }
    if (!SHA256_HEX_PATTERN.test(params.contentHash)) {
      throw new Error("Governed memory contentHash must be a lowercase SHA-256 digest.");
    }
    if (sha256Text(params.safeText) !== params.contentHash) {
      throw new Error("Governed memory content hash does not match safeText.");
    }
    if (
      typeof params.timeoutSeconds !== "undefined"
      && (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds <= 0)
    ) {
      throw new Error("Governed memory write timeout must be a positive number of seconds.");
    }

    const transportRootUri = version.rootUri.slice(0, -1);
    let result: unknown;
    try {
      result = await this.request<unknown>("/api/v1/content/batch-write", {
        method: "POST",
        body: JSON.stringify({
          root_uri: transportRootUri,
          operations: [
            {
              uri: version.uri,
              content: params.safeText,
              precondition: { kind: "create_if_absent" },
            },
          ],
          wait: true,
          ...(typeof params.timeoutSeconds === "number"
            ? { timeout: params.timeoutSeconds }
            : {}),
        }),
        ...(typeof params.timeoutSeconds === "number"
          ? { timeoutMs: Math.max(this.timeoutMs, params.timeoutSeconds * 1000 + 5000) }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof OpenVikingRequestError
        && isUnsupportedBatchWriteStatus(error.status)
      ) {
        throw new GovernedMemoryUnsupportedError(error.status);
      }
      throw error;
    }

    return {
      uri: version.uri,
      rootUri: version.rootUri,
      contentHash: params.contentHash,
      outcome: parseGovernedMemoryBatchWriteResult({
        result,
        version,
        transportRootUri,
      }),
    };
  }

  /**
   * Creates one immutable resource leaf and verifies caller-provided bytes
   * before issuing the request. It is used for published-version projections,
   * never for mutable workspace knowledge roots.
   */
  async createExactResource(params: {
    rootUri: string;
    uri: string;
    content: string;
    contentHash: string;
    timeoutSeconds?: number;
  }): Promise<ExactResourceWriteResult> {
    assertExactOpenVikingResourceLeaf(params);
    if (typeof params.content !== "string") {
      throw new Error("OpenViking exact resource content must be a string.");
    }
    if (!SHA256_HEX_PATTERN.test(params.contentHash)) {
      throw new Error("OpenViking exact resource contentHash must be a lowercase SHA-256 digest.");
    }
    if (sha256Text(params.content) !== params.contentHash) {
      throw new Error("OpenViking exact resource content hash does not match content.");
    }
    if (
      typeof params.timeoutSeconds !== "undefined"
      && (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds <= 0)
    ) {
      throw new Error("OpenViking exact resource timeout must be a positive number of seconds.");
    }

    const transportRootUri = params.rootUri.slice(0, -1);
    let result: unknown;
    try {
      result = await this.request<unknown>("/api/v1/content/batch-write", {
        method: "POST",
        body: JSON.stringify({
          root_uri: transportRootUri,
          operations: [
            {
              uri: params.uri,
              content: params.content,
              precondition: { kind: "create_if_absent" },
            },
          ],
          wait: true,
          ...(typeof params.timeoutSeconds === "number"
            ? { timeout: params.timeoutSeconds }
            : {}),
        }),
        ...(typeof params.timeoutSeconds === "number"
          ? { timeoutMs: Math.max(this.timeoutMs, params.timeoutSeconds * 1000 + 5000) }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof OpenVikingRequestError
        && isUnsupportedBatchWriteStatus(error.status)
      ) {
        throw new ExactResourceUnsupportedError(error.status);
      }
      throw error;
    }

    return {
      uri: params.uri,
      rootUri: params.rootUri,
      contentHash: params.contentHash,
      outcome: parseExactResourceBatchWriteResult({
        result,
        rootUri: params.rootUri,
        uri: params.uri,
      }),
    };
  }

  /**
   * Creates and independently verifies one exact version-scoped resource
   * directory. A 409 is accepted only after stat proves the same URI is a
   * directory, preventing a conflicting file from being treated as ready.
   */
  async ensureExactResourceRoot(rootUri: string): Promise<{ rootUri: string }> {
    assertExactOpenVikingResourceRootUri(rootUri);
    const transportRootUri = rootUri.slice(0, -1);
    try {
      const mkdirResult = await this.request<unknown>("/api/v1/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ uri: transportRootUri }),
      });
      if (
        !isRecord(mkdirResult)
        || (typeof mkdirResult.uri !== "undefined" && mkdirResult.uri !== transportRootUri)
      ) {
        throw new ExactResourceRootProvisionError({
          status: 502,
          failure: "mkdir_failed",
          stage: "mkdir",
        });
      }
    } catch (error) {
      if (error instanceof ExactResourceRootProvisionError) throw error;
      if (!(error instanceof OpenVikingRequestError)) throw error;
      if (error.status !== 409) {
        throw new ExactResourceRootProvisionError({
          status: normalizeProvisionStatus(error.status),
          failure: isUnsupportedMkdirStatus(error.status) ? "unsupported" : "mkdir_failed",
          stage: "mkdir",
        });
      }
    }

    let statResult: unknown;
    try {
      const searchParams = new URLSearchParams({ uri: transportRootUri });
      statResult = await this.request<unknown>(
        `/api/v1/fs/stat?${searchParams.toString()}`,
        { method: "GET" },
      );
    } catch (error) {
      if (!(error instanceof OpenVikingRequestError)) throw error;
      throw new ExactResourceRootProvisionError({
        status: normalizeProvisionStatus(error.status),
        failure: "verification_failed",
        stage: "verify",
      });
    }
    if (!isVerifiedDirectoryStat(statResult, transportRootUri)) {
      throw new ExactResourceRootProvisionError({
        status: isRecord(statResult) && statResult.isDir === false ? 409 : 502,
        failure: "verification_failed",
        stage: "verify",
      });
    }
    return { rootUri };
  }

  /** Reads the complete raw UTF-8 bytes for an exact published resource. */
  async readExactResource(params: {
    rootUri: string;
    uri: string;
  }): Promise<ExactResourceReadResult> {
    assertExactOpenVikingResourceLeaf(params);
    const searchParams = new URLSearchParams({
      uri: params.uri,
      offset: "0",
      limit: "-1",
      raw: "true",
    });
    const result = await this.request<unknown>(
      `/api/v1/content/read?${searchParams.toString()}`,
      { method: "GET" },
    );
    if (typeof result !== "string") {
      throw new Error("OpenViking returned invalid exact resource content.");
    }
    return {
      uri: params.uri,
      content: result,
      contentHash: sha256Text(result),
    };
  }

  /** Reads the complete raw bytes represented as UTF-8 text for reconciliation. */
  async readGovernedMemoryVersion(params: {
    namespaceKey: string;
    uri: string;
  }): Promise<GovernedMemoryReadResult> {
    const version = this.requireGovernedMemoryVersion(params);
    const searchParams = new URLSearchParams({
      uri: version.uri,
      offset: "0",
      limit: "-1",
      raw: "true",
    });
    const result = await this.request<unknown>(
      `/api/v1/content/read?${searchParams.toString()}`,
      { method: "GET" },
    );
    if (typeof result !== "string") {
      throw new Error("OpenViking returned invalid governed memory content.");
    }
    return {
      uri: version.uri,
      content: result,
      contentHash: sha256Text(result),
    };
  }

  /** Deletes one immutable leaf only; recursive deletion is never exposed. */
  async deleteGovernedMemoryVersion(params: {
    namespaceKey: string;
    uri: string;
  }): Promise<{ uri: string }> {
    const version = this.requireGovernedMemoryVersion(params);
    const searchParams = new URLSearchParams({
      uri: version.uri,
      recursive: "false",
    });
    const result = await this.request<unknown>(
      `/api/v1/fs?${searchParams.toString()}`,
      { method: "DELETE" },
    );
    if (!isRecord(result) || result.uri !== version.uri) {
      throw new Error("OpenViking returned an invalid governed memory deletion target.");
    }
    const returnedVersion = assertExactGovernedMemoryVersionUri({
      namespaceKey: params.namespaceKey,
      uri: result.uri,
    });
    if (returnedVersion.uri !== version.uri) {
      throw new Error("OpenViking returned an invalid governed memory deletion target.");
    }
    return { uri: returnedVersion.uri };
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

  private requireGovernedMemoryVersion(params: {
    namespaceKey: string;
    uri: string;
  }): GovernedMemoryVersion {
    const version = assertExactGovernedMemoryVersionUri(params);
    if (this.scope.userId !== version.userId) {
      throw new Error(
        "OpenViking governed memory client scope does not match the URI managed user.",
      );
    }
    return version;
  }

  private requireGovernedMemoryRoot(params: {
    namespaceKey: string;
    uri: string;
  }): GovernedMemoryRoot {
    const root = assertExactGovernedMemoryRootUri(params);
    if (this.scope.userId !== root.userId) {
      throw new Error(
        "OpenViking governed memory client scope does not match the URI managed user.",
      );
    }
    return root;
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
      const json = parseApiEnvelope<T>(text);

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

function parseGovernedMemoryBatchWriteResult(params: {
  result: unknown;
  version: GovernedMemoryVersion;
  transportRootUri: string;
}): GovernedMemoryWriteResult["outcome"] {
  if (!isRecord(params.result) || params.result.root_uri !== params.transportRootUri) {
    throw new Error("OpenViking returned an invalid governed memory write result.");
  }
  const created = requireStringArray(params.result.created);
  const updated = requireStringArray(params.result.updated);
  const unchanged = requireStringArray(params.result.unchanged);
  if (updated.length !== 0 || created.length + unchanged.length !== 1) {
    throw new Error("OpenViking returned an invalid governed memory write result.");
  }

  const outcome = created.length === 1 ? "created" : "unchanged";
  const returnedUri = (created[0] ?? unchanged[0])!;
  const returnedVersion = assertExactGovernedMemoryVersionUri({
    namespaceKey: params.version.namespaceKey,
    uri: returnedUri,
  });
  if (returnedVersion.uri !== params.version.uri) {
    throw new Error("OpenViking returned an invalid governed memory write result.");
  }
  return outcome;
}

function parseExactResourceBatchWriteResult(params: {
  result: unknown;
  rootUri: string;
  uri: string;
}): ExactResourceWriteResult["outcome"] {
  const transportRootUri = params.rootUri.slice(0, -1);
  if (!isRecord(params.result) || params.result.root_uri !== transportRootUri) {
    throw new Error("OpenViking returned an invalid exact resource write result.");
  }
  const created = requireStringArray(params.result.created);
  const updated = requireStringArray(params.result.updated);
  const unchanged = requireStringArray(params.result.unchanged);
  if (updated.length !== 0 || created.length + unchanged.length !== 1) {
    throw new Error("OpenViking returned an invalid exact resource write result.");
  }
  const returnedUri = (created[0] ?? unchanged[0])!;
  assertExactOpenVikingResourceLeaf({ rootUri: params.rootUri, uri: returnedUri });
  if (returnedUri !== params.uri) {
    throw new Error("OpenViking returned an invalid exact resource write result.");
  }
  return created.length === 1 ? "created" : "unchanged";
}

function isUnsupportedBatchWriteStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

function isUnsupportedMkdirStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

function normalizeProvisionStatus(status: number): number {
  return status >= 200 && status < 300 ? 502 : status;
}

function isVerifiedDirectoryStat(value: unknown, expectedUri: string): boolean {
  if (!isRecord(value) || value.isDir !== true) return false;
  if (typeof value.uri !== "undefined") return value.uri === expectedUri;
  const expectedName = expectedUri.slice(expectedUri.lastIndexOf("/") + 1);
  return value.name === expectedName;
}

function parseApiEnvelope<T>(text: string): ApiEnvelope<T> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed as ApiEnvelope<T>) : undefined;
  } catch {
    return undefined;
  }
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("OpenViking returned an invalid governed memory write result.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
