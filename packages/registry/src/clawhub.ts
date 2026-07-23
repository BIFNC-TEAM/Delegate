import { createHash } from "node:crypto";

import { skillPackSchema, type SkillPack } from "@delegate/domain";

import {
  parseClawHubSkillManifest,
  type ClawHubRuntimeRequirements,
} from "./clawhub-manifest";

const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 512 * 1024;
const MAX_MANIFEST_RESPONSE_BYTES = 200 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;
const MAX_CATALOG_ITEMS = 200;
const MAX_REASON_CODES = 32;

const slugPattern = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ownerHandlePattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const reasonCodePattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export type ClawHubSkillSearchResult = {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
  ownerHandle?: string;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type ClawHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  moderation?: {
    isSuspicious?: boolean;
    isMalwareBlocked?: boolean;
    verdict?: string | null;
    reasonCodes?: string[];
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
  provenance?: {
    signature?: {
      algorithm?: string | null;
      keyId?: string | null;
      value?: string | null;
    } | null;
    sbomUrl?: string | null;
    attestationUrl?: string | null;
  } | null;
};

export type ClawHubRegistryProvenance = {
  signature?: { algorithm: string; keyId: string; value: string };
  sbomUrl?: string;
  attestationUrl?: string;
};

export type ClawHubSkillVerification = {
  ok: boolean;
  decision: "pass" | "fail" | "unknown";
  reasons: string[];
  slug?: string;
  publisherHandle?: string;
  version?: string;
  checkedAt?: number;
  provenance?: "server-resolved-github-import" | "unavailable";
  security: {
    status: "clean" | "suspicious" | "malicious" | "pending" | "unknown";
    passed: boolean | null;
  } | null;
};

export type ClawHubRegistryTrust = {
  source: "clawhub-verify-v1";
  version: string | null;
  verified: boolean;
  decision: "pass" | "fail" | "unknown";
  securityStatus: "clean" | "suspicious" | "malicious" | "pending" | "unknown";
  exactVersionMatch: boolean;
  exactPublisherMatch: boolean;
  skillManifestFetched: boolean;
  skillManifestParsed: boolean;
  skillManifestDigest: string | null;
  /**
   * Registry trust only. Callers must still enforce update policy, SemVer,
   * requirement diffs, and public-runtime execution boundaries.
   */
  metadataOnlyAutoUpdateEligible: boolean;
  reasons: string[];
  checkedAt?: number;
  provenance?: "server-resolved-github-import" | "unavailable";
};

export type ClawHubRepresentativeSkill = SkillPack & {
  runtimeRequirements: ClawHubRuntimeRequirements;
  registryTrust: ClawHubRegistryTrust;
  /**
   * Optional non-standard registry extension. It is not ClawHub verification.
   */
  registryProvenance?: ClawHubRegistryProvenance;
};

export type ClawHubRepresentativeSkillVersionTrust = {
  slug: string;
  ownerHandle: string | null;
  version: string;
  runtimeRequirements: ClawHubRuntimeRequirements;
  registryTrust: ClawHubRegistryTrust;
};

export type ClawHubSkillListResponse = {
  items: Array<{
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    metadata?: {
      os?: string[] | null;
      systems?: string[] | null;
    } | null;
    latestVersion?: {
      version: string;
      createdAt: number;
      changelog?: string;
    } | null;
    createdAt: number;
    updatedAt: number;
  }>;
  nextCursor?: string | null;
};

type FetchLike = typeof fetch;

type RequestParams = {
  baseUrl?: string | undefined;
  path: string;
  timeoutMs?: number | undefined;
  search?: Record<string, string | undefined> | undefined;
  fetchImpl?: FetchLike | undefined;
};

export class ClawHubRequestError extends Error {
  readonly status: number;
  readonly requestPath: string;
  readonly responseBody: string;

  constructor(params: { path: string; status: number; body: string }) {
    super(`ClawHub ${params.path} failed (${params.status}): ${params.body}`);
    this.name = "ClawHubRequestError";
    this.status = params.status;
    this.requestPath = params.path;
    this.responseBody = params.body;
  }
}

export class ClawHubContractError extends Error {
  readonly requestPath: string;

  constructor(params: { path: string; message: string }) {
    super(`ClawHub ${params.path} returned an invalid response: ${params.message}`);
    this.name = "ClawHubContractError";
    this.requestPath = params.path;
  }
}

export function resolveClawHubBaseUrl(baseUrl?: string): string {
  const envValue = process.env.DELEGATE_CLAWHUB_URL?.trim();
  const value = baseUrl?.trim() || envValue || DEFAULT_CLAWHUB_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClawHubContractError({
      path: "baseUrl",
      message: "Registry URL is invalid",
    });
  }
  if (
    url.protocol !== "https:"
    || Boolean(url.username)
    || Boolean(url.password)
    || url.pathname !== "/"
    || Boolean(url.search)
    || Boolean(url.hash)
  ) {
    throw new ClawHubContractError({
      path: "baseUrl",
      message: "Registry URL must be a credential-free HTTPS origin",
    });
  }
  const allowedHosts = new Set(
    (
      process.env.DELEGATE_CLAWHUB_ALLOWED_HOSTS
      ?? new URL(DEFAULT_CLAWHUB_URL).hostname
    )
      .split(",")
      .map((host) => host.trim().toLowerCase().replace(/\.$/u, ""))
      .filter(Boolean),
  );
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!allowedHosts.has(hostname)) {
    throw new ClawHubContractError({
      path: "baseUrl",
      message: "Registry host is not allowlisted",
    });
  }
  return url.origin;
}

export async function searchClawHubSkills(params: {
  query: string;
  limit?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillSearchResult[]> {
  const query = normalizeDisplayText(params.query, 200);
  if (!query) return [];
  const result = await fetchJson({
    baseUrl: params.baseUrl,
    path: "/api/v1/search",
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      q: query,
      limit: String(normalizeLimit(params.limit, 100)),
      nonSuspiciousOnly: "true",
    },
  });
  return normalizeSearchResponse(result, "/api/v1/search");
}

export async function listClawHubSkills(params: {
  limit?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillListResponse> {
  const result = await fetchJson({
    baseUrl: params.baseUrl,
    path: "/api/v1/skills",
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      limit: String(normalizeLimit(params.limit, 200)),
      nonSuspiciousOnly: "true",
    },
  });
  return normalizeListResponse(result, "/api/v1/skills");
}

export async function fetchClawHubSkillDetail(params: {
  slug: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillDetail> {
  const reference = requireSkillReference(params.slug);
  const path = `/api/v1/skills/${encodeURIComponent(reference.slug)}`;
  const result = await fetchJson({
    baseUrl: params.baseUrl,
    path,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      owner: reference.ownerHandle,
    },
  });
  const detail = normalizeSkillDetail(result, path);
  if (
    reference.ownerHandle
    && detail.skill
    && detail.owner?.handle !== reference.ownerHandle
  ) {
    throw contractError(path, "owner does not match the requested skill reference");
  }
  return detail;
}

export async function fetchClawHubSkillVerification(params: {
  slug: string;
  version: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillVerification> {
  const reference = requireSkillReference(params.slug);
  const version = requireVersion(params.version);
  const path = `/api/v1/skills/${encodeURIComponent(reference.slug)}/verify`;
  const result = await fetchJson({
    baseUrl: params.baseUrl,
    path,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      owner: reference.ownerHandle,
      version,
    },
  });
  return normalizeVerification(result, path);
}

export async function fetchClawHubSkillManifestPreview(params: {
  slug: string;
  version: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const reference = requireSkillReference(params.slug);
  const version = requireVersion(params.version);
  return fetchText({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(reference.slug)}/file`,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    maxBytes: MAX_MANIFEST_RESPONSE_BYTES,
    requiredContentType: "text/plain",
    search: {
      owner: reference.ownerHandle,
      path: "SKILL.md",
      version,
      preview: "1",
    },
  });
}

export async function searchClawHubRepresentativeSkills(params: {
  query: string;
  limit?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<SkillPack[]> {
  const query = params.query.trim();
  const results = query
    ? await searchClawHubSkills({
        ...params,
        query,
      })
    : (await listClawHubSkills(params)).items.map<ClawHubSkillSearchResult>((item) => ({
        score: 0,
        slug: item.slug,
        displayName: item.displayName,
        ...(item.summary ? { summary: item.summary } : {}),
        ...(item.latestVersion?.version ? { version: item.latestVersion.version } : {}),
        updatedAt: item.updatedAt,
      }));

  return results.map((result) => {
    const ownerHandle = result.ownerHandle ?? result.owner?.handle ?? undefined;
    const skillReference = buildSkillReference(result.slug, ownerHandle);
    return skillPackSchema.parse({
      id: `clawhub:${skillReference}`,
      slug: skillReference,
      displayName: result.displayName,
      source: "clawhub",
      summary:
        result.summary ??
        "Discovered from ClawHub. Review before enabling it for a public representative runtime.",
      version: result.version,
      sourceUrl: buildCanonicalSkillUrl({
        baseUrl: params.baseUrl,
        slug: result.slug,
        ownerHandle,
      }),
      ownerHandle,
      capabilityTags: [],
      executesCode: false,
      enabled: false,
      installStatus: "available",
    });
  });
}

export async function fetchClawHubRepresentativeSkill(params: {
  slug: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubRepresentativeSkill | null> {
  const reference = requireSkillReference(params.slug);
  const detail = await fetchClawHubSkillDetail({
    ...params,
    slug: reference.reference,
  });
  if (!detail.skill) {
    return null;
  }

  const version = detail.latestVersion?.version;
  const [verificationResult, manifestResult] = version
    ? await Promise.allSettled([
        fetchClawHubSkillVerification({
          ...params,
          slug: reference.reference,
          version,
        }),
        fetchClawHubSkillManifestPreview({
          ...params,
          slug: reference.reference,
          version,
        }),
      ])
    : [
        { status: "rejected", reason: new Error("Version unavailable.") } as const,
        { status: "rejected", reason: new Error("Version unavailable.") } as const,
      ];

  const verification = verificationResult.status === "fulfilled"
    ? verificationResult.value
    : undefined;
  const manifest = manifestResult.status === "fulfilled"
    ? parseClawHubSkillManifest(manifestResult.value)
    : undefined;
  const manifestSource = manifestResult.status === "fulfilled"
    ? manifestResult.value
    : undefined;
  const runtimeRequirements = manifest?.requirements ?? emptyRuntimeRequirements();
  const registryTrust = buildRegistryTrust({
    detail,
    manifest,
    manifestSource,
    verification,
    version,
    verificationAvailable: verificationResult.status === "fulfilled",
    manifestAvailable: manifestResult.status === "fulfilled",
  });
  const skillReference = buildSkillReference(
    detail.skill.slug,
    reference.ownerHandle,
  );

  const skill = skillPackSchema.parse({
    id: `clawhub:${skillReference}`,
    slug: skillReference,
    displayName: detail.skill.displayName,
    source: "clawhub",
    summary:
      detail.skill.summary ??
      "Imported from ClawHub. Review suitability for the public representative boundary before enabling.",
    version,
    sourceUrl: buildCanonicalSkillUrl({
      baseUrl: params.baseUrl,
      slug: detail.skill.slug,
      ownerHandle: detail.owner?.handle ?? undefined,
    }),
    ownerHandle: detail.owner?.handle ?? undefined,
    verificationTier: registryTrust.verified ? "clawhub-verified" : undefined,
    capabilityTags: manifest?.parsed ? manifest.capabilityTags : [],
    executesCode: false,
    enabled: false,
    installStatus: "available",
  });
  const registryProvenance = normalizeRegistryProvenance(detail.provenance);
  return {
    ...skill,
    runtimeRequirements,
    registryTrust,
    ...(registryProvenance ? { registryProvenance } : {}),
  };
}

export async function fetchClawHubRepresentativeSkillVersionTrust(params: {
  slug: string;
  version: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubRepresentativeSkillVersionTrust | null> {
  const reference = requireSkillReference(params.slug);
  const version = requireVersion(params.version);
  const detail = await fetchClawHubSkillDetail({
    slug: reference.reference,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  if (!detail.skill) return null;

  const [verificationResult, manifestResult] = await Promise.allSettled([
    fetchClawHubSkillVerification({
      slug: reference.reference,
      version,
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    }),
    fetchClawHubSkillManifestPreview({
      slug: reference.reference,
      version,
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    }),
  ]);
  const verification = verificationResult.status === "fulfilled"
    ? verificationResult.value
    : undefined;
  const manifest = manifestResult.status === "fulfilled"
    ? parseClawHubSkillManifest(manifestResult.value)
    : undefined;
  const manifestSource = manifestResult.status === "fulfilled"
    ? manifestResult.value
    : undefined;
  const registryTrust = buildRegistryTrust({
    detail,
    version,
    manifest,
    manifestSource,
    verification,
    verificationAvailable: verificationResult.status === "fulfilled",
    manifestAvailable: manifestResult.status === "fulfilled",
  });

  return {
    slug: buildSkillReference(
      detail.skill.slug,
      detail.owner?.handle ?? reference.ownerHandle,
    ),
    ownerHandle: detail.owner?.handle ?? null,
    version,
    runtimeRequirements: manifest?.requirements ?? emptyRuntimeRequirements(),
    registryTrust,
  };
}

function buildUrl(params: Pick<RequestParams, "baseUrl" | "path" | "search">): URL {
  const url = new URL(params.path, `${resolveClawHubBaseUrl(params.baseUrl)}/`);
  for (const [key, value] of Object.entries(params.search ?? {})) {
    if (!value) {
      continue;
    }
    url.searchParams.set(key, value);
  }
  return url;
}

async function fetchJson(params: RequestParams): Promise<unknown> {
  const controller = new AbortController();
  const url = buildUrl(params);
  const timeout = setTimeout(
    () => controller.abort(new Error(`ClawHub request timed out after ${params.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await (params.fetchImpl ?? fetch)(url, {
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ClawHubRequestError({
        path: url.pathname,
        status: response.status,
        body: await readErrorBody(response),
      });
    }

    const body = await readBoundedBody(response, MAX_JSON_RESPONSE_BYTES, url.pathname);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ClawHubContractError({
        path: url.pathname,
        message: "response body is not valid JSON",
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(
  params: RequestParams & { maxBytes: number; requiredContentType: string },
): Promise<string> {
  const controller = new AbortController();
  const url = buildUrl(params);
  const timeout = setTimeout(
    () => controller.abort(new Error(`ClawHub request timed out after ${params.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await (params.fetchImpl ?? fetch)(url, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ClawHubRequestError({
        path: url.pathname,
        status: response.status,
        body: await readErrorBody(response),
      });
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith(params.requiredContentType)) {
      throw new ClawHubContractError({
        path: url.pathname,
        message: `expected ${params.requiredContentType} content`,
      });
    }
    return readBoundedBody(response, params.maxBytes, url.pathname);
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await readBoundedBody(response, MAX_ERROR_RESPONSE_BYTES, "error-response")).trim();
    return text || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  requestPath: string,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ClawHubContractError({
      path: requestPath,
      message: `response exceeds ${maxBytes} bytes`,
    });
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ClawHubContractError({
        path: requestPath,
        message: `response exceeds ${maxBytes} bytes`,
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ClawHubContractError({
          path: requestPath,
          message: `response exceeds ${maxBytes} bytes`,
        });
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    if (error instanceof ClawHubContractError) throw error;
    throw new ClawHubContractError({
      path: requestPath,
      message: "response is not valid UTF-8 text",
    });
  }
}

function normalizeSearchResponse(value: unknown, path: string): ClawHubSkillSearchResult[] {
  const response = requireRecord(value, path);
  if (!Array.isArray(response.results) || response.results.length > MAX_CATALOG_ITEMS) {
    throw contractError(path, "results must be a bounded array");
  }
  return response.results.map((item) => normalizeSearchResult(item, path));
}

function normalizeSearchResult(value: unknown, path: string): ClawHubSkillSearchResult {
  const item = requireRecord(value, path);
  const slug = requireNormalizedSlug(item.slug, path);
  const displayName = requireDisplayText(item.displayName, 128, path, "displayName");
  const summary = optionalDisplayText(item.summary, 1_000, path, "summary");
  const version = optionalVersion(item.version, path);
  const updatedAt = optionalTimestamp(item.updatedAt, path, "updatedAt");
  const ownerHandle = optionalOwnerHandle(item.ownerHandle, path);
  const owner = normalizeOwner(item.owner, path);
  const score = typeof item.score === "number" && Number.isFinite(item.score)
    ? item.score
    : 0;

  return {
    score,
    slug,
    displayName,
    ...(summary ? { summary } : {}),
    ...(version ? { version } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(owner ? { owner } : {}),
  };
}

function normalizeListResponse(value: unknown, path: string): ClawHubSkillListResponse {
  const response = requireRecord(value, path);
  if (!Array.isArray(response.items) || response.items.length > MAX_CATALOG_ITEMS) {
    throw contractError(path, "items must be a bounded array");
  }
  const nextCursor = response.nextCursor === null
    ? null
    : optionalOpaqueString(response.nextCursor, 512, path, "nextCursor");
  return {
    items: response.items.map((item) => normalizeListItem(item, path)),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function normalizeListItem(
  value: unknown,
  path: string,
): ClawHubSkillListResponse["items"][number] {
  const item = requireRecord(value, path);
  const summary = optionalDisplayText(item.summary, 1_000, path, "summary");
  const tags = normalizeCatalogTags(item.tags, path);
  const metadata = normalizePlatformMetadata(item.metadata, path);
  const latestVersion = normalizeLatestVersion(item.latestVersion, path);
  return {
    slug: requireNormalizedSlug(item.slug, path),
    displayName: requireDisplayText(item.displayName, 128, path, "displayName"),
    ...(summary ? { summary } : {}),
    ...(tags ? { tags } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(latestVersion !== undefined ? { latestVersion } : {}),
    createdAt: requireTimestamp(item.createdAt, path, "createdAt"),
    updatedAt: requireTimestamp(item.updatedAt, path, "updatedAt"),
  };
}

function normalizeSkillDetail(value: unknown, path: string): ClawHubSkillDetail {
  const response = requireRecord(value, path);
  if (response.skill === null) return { skill: null };
  const skill = requireRecord(response.skill, path);
  const summary = optionalDisplayText(skill.summary, 1_000, path, "summary");
  const tags = normalizeCatalogTags(skill.tags, path);
  const latestVersion = normalizeLatestVersion(response.latestVersion, path);
  const metadata = normalizePlatformMetadata(response.metadata, path);
  const moderation = normalizeModeration(response.moderation, path);
  const owner = normalizeOwner(response.owner, path);
  const provenance = normalizeRegistryProvenance(response.provenance);

  return {
    skill: {
      slug: requireNormalizedSlug(skill.slug, path),
      displayName: requireDisplayText(skill.displayName, 128, path, "displayName"),
      ...(summary ? { summary } : {}),
      ...(tags ? { tags } : {}),
      createdAt: requireTimestamp(skill.createdAt, path, "createdAt"),
      updatedAt: requireTimestamp(skill.updatedAt, path, "updatedAt"),
    },
    ...(latestVersion !== undefined ? { latestVersion } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(moderation !== undefined ? { moderation } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(provenance
      ? {
          provenance: {
            ...(provenance.signature ? { signature: provenance.signature } : {}),
            ...(provenance.sbomUrl ? { sbomUrl: provenance.sbomUrl } : {}),
            ...(provenance.attestationUrl ? { attestationUrl: provenance.attestationUrl } : {}),
          },
        }
      : {}),
  };
}

function normalizeVerification(value: unknown, path: string): ClawHubSkillVerification {
  const response = requireRecord(value, path);
  if (typeof response.ok !== "boolean") {
    throw contractError(path, "ok must be a boolean");
  }
  const decision = response.decision === "pass" || response.decision === "fail"
    ? response.decision
    : "unknown";
  const reasons = normalizeReasonCodes(response.reasons, path);
  const slug = response.slug === undefined ? undefined : requireNormalizedSlug(response.slug, path);
  const publisherHandle = optionalOwnerHandle(response.publisherHandle, path);
  const version = optionalVersion(response.version, path);
  const checkedAt = optionalTimestamp(response.checkedAt, path, "checkedAt");
  const provenance = normalizeVerificationProvenance(response.provenance);
  const security = normalizeVerificationSecurity(response.security, path);
  return {
    ok: response.ok,
    decision,
    reasons,
    ...(slug ? { slug } : {}),
    ...(publisherHandle ? { publisherHandle } : {}),
    ...(version ? { version } : {}),
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(provenance ? { provenance } : {}),
    security,
  };
}

function normalizeVerificationSecurity(
  value: unknown,
  path: string,
): ClawHubSkillVerification["security"] {
  if (value === null || value === undefined) return null;
  const security = requireRecord(value, path);
  const status = normalizeSecurityStatus(security.status);
  if (security.passed !== undefined && typeof security.passed !== "boolean") {
    throw contractError(path, "security.passed must be a boolean");
  }
  return {
    status,
    passed: typeof security.passed === "boolean" ? security.passed : null,
  };
}

function buildRegistryTrust(input: {
  detail: ClawHubSkillDetail;
  version: string | undefined;
  verification: ClawHubSkillVerification | undefined;
  verificationAvailable: boolean;
  manifest: ReturnType<typeof parseClawHubSkillManifest> | undefined;
  manifestSource: string | undefined;
  manifestAvailable: boolean;
}): ClawHubRegistryTrust {
  const expectedSlug = input.detail.skill?.slug;
  const expectedPublisher = input.detail.owner?.handle;
  const exactVersionMatch = Boolean(
    input.version
    && expectedSlug
    && input.verification?.slug === expectedSlug
    && input.verification.version === input.version,
  );
  const exactPublisherMatch = Boolean(
    expectedPublisher
    && input.verification?.publisherHandle === expectedPublisher,
  );
  const moderationBlocked = input.detail.moderation?.isSuspicious === true
    || input.detail.moderation?.isMalwareBlocked === true
    || ["suspicious", "malicious"].includes(input.detail.moderation?.verdict?.toLowerCase() ?? "");
  const verified = Boolean(
    input.verification?.ok === true
    && input.verification.decision === "pass"
    && input.verification.reasons.length === 0
    && input.verification.security?.status === "clean"
    && input.verification.security.passed !== false
    && exactVersionMatch
    && exactPublisherMatch
    && !moderationBlocked,
  );
  const skillManifestParsed = input.manifest?.parsed === true;
  const skillManifestDigest = input.manifestSource === undefined
    ? null
    : `sha256:${createHash("sha256").update(input.manifestSource, "utf8").digest("hex")}`;
  const reasons = new Set<string>(input.verification?.reasons ?? []);

  if (!input.version) reasons.add("version.unavailable");
  if (!input.verificationAvailable) reasons.add("verify.unavailable");
  if (input.verificationAvailable && !input.verification?.ok && reasons.size === 0) {
    reasons.add("verify.failed");
  }
  if (input.verification && !exactVersionMatch) reasons.add("verify.identity_mismatch");
  if (input.verification && !exactPublisherMatch) reasons.add("verify.publisher_mismatch");
  if (
    input.verification
    && (
      input.verification.decision !== "pass"
      || input.verification.security?.status !== "clean"
      || input.verification.security.passed === false
    )
  ) {
    reasons.add("verify.not_clean");
  }
  if (moderationBlocked) reasons.add("moderation.blocked");
  if (!input.manifestAvailable) reasons.add("manifest.unavailable");
  if (input.manifestAvailable && !skillManifestParsed) {
    reasons.add(input.manifest?.reason ?? "manifest.invalid");
  }

  return {
    source: "clawhub-verify-v1",
    version: input.version ?? null,
    verified,
    decision: input.verification?.decision ?? "unknown",
    securityStatus: input.verification?.security?.status ?? "unknown",
    exactVersionMatch,
    exactPublisherMatch,
    skillManifestFetched: input.manifestAvailable,
    skillManifestParsed,
    skillManifestDigest,
    metadataOnlyAutoUpdateEligible: verified && input.manifestAvailable && skillManifestParsed,
    reasons: [...reasons].slice(0, MAX_REASON_CODES).sort(),
    ...(input.verification?.checkedAt !== undefined
      ? { checkedAt: input.verification.checkedAt }
      : {}),
    ...(input.verification?.provenance
      ? { provenance: input.verification.provenance }
      : {}),
  };
}

function normalizeLatestVersion(
  value: unknown,
  path: string,
): ClawHubSkillDetail["latestVersion"] {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const version = requireRecord(value, path);
  const changelog = optionalDisplayText(version.changelog, 2_000, path, "changelog");
  return {
    version: requireVersionValue(version.version, path),
    createdAt: requireTimestamp(version.createdAt, path, "latestVersion.createdAt"),
    ...(changelog ? { changelog } : {}),
  };
}

function normalizeOwner(
  value: unknown,
  path: string,
): ClawHubSkillDetail["owner"] {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const owner = requireRecord(value, path);
  const handle = owner.handle === null ? null : optionalOwnerHandle(owner.handle, path);
  const displayName = owner.displayName === null
    ? null
    : optionalDisplayText(owner.displayName, 128, path, "owner.displayName");
  const image = owner.image === null ? null : normalizeHttpsUrl(owner.image);
  return {
    ...(handle !== undefined ? { handle } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(image !== undefined ? { image } : {}),
  };
}

function normalizePlatformMetadata(
  value: unknown,
  path: string,
): ClawHubSkillDetail["metadata"] {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const metadata = requireRecord(value, path);
  const os = normalizePlatformArray(metadata.os, path, "metadata.os");
  const systems = normalizePlatformArray(metadata.systems, path, "metadata.systems");
  return {
    ...(os !== undefined ? { os } : {}),
    ...(systems !== undefined ? { systems } : {}),
  };
}

function normalizePlatformArray(
  value: unknown,
  path: string,
  field: string,
): string[] | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    throw contractError(path, `${field} must be a bounded string array`);
  }
  const entries = value.map((entry) => {
    if (typeof entry !== "string") {
      throw contractError(path, `${field} must contain strings`);
    }
    const normalized = entry.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(normalized)) {
      throw contractError(path, `${field} contains an invalid value`);
    }
    return normalized;
  });
  return [...new Set(entries)].sort();
}

function normalizeModeration(
  value: unknown,
  path: string,
): ClawHubSkillDetail["moderation"] {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const moderation = requireRecord(value, path);
  if (
    moderation.isSuspicious !== undefined
    && typeof moderation.isSuspicious !== "boolean"
  ) {
    throw contractError(path, "moderation.isSuspicious must be a boolean");
  }
  if (
    moderation.isMalwareBlocked !== undefined
    && typeof moderation.isMalwareBlocked !== "boolean"
  ) {
    throw contractError(path, "moderation.isMalwareBlocked must be a boolean");
  }
  const verdict = moderation.verdict === null
    ? null
    : optionalOpaqueString(moderation.verdict, 32, path, "moderation.verdict")?.toLowerCase();
  return {
    ...(moderation.isSuspicious !== undefined
      ? { isSuspicious: moderation.isSuspicious }
      : {}),
    ...(moderation.isMalwareBlocked !== undefined
      ? { isMalwareBlocked: moderation.isMalwareBlocked }
      : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(moderation.reasonCodes !== undefined
      ? { reasonCodes: normalizeReasonCodes(moderation.reasonCodes, path) }
      : {}),
  };
}

function normalizeCatalogTags(
  value: unknown,
  path: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const tags = requireRecord(value, path);
  const entries = Object.entries(tags);
  if (entries.length > 32) {
    throw contractError(path, "tags exceeds 32 entries");
  }
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toLowerCase();
    const version = typeof rawValue === "string" ? normalizeVersion(rawValue) : undefined;
    if (/^[a-z0-9][a-z0-9._-]{0,31}$/.test(key) && version) {
      normalized[key] = version;
    }
  }
  return normalized;
}

function normalizeReasonCodes(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REASON_CODES) {
    throw contractError(path, "reasons must be a bounded array");
  }
  const reasons: string[] = [];
  for (const reason of value) {
    if (typeof reason !== "string") {
      throw contractError(path, "reasons must contain strings");
    }
    const normalized = reason.trim().toLowerCase();
    reasons.push(reasonCodePattern.test(normalized) ? normalized : "verify.invalid_reason");
  }
  return [...new Set(reasons)].sort();
}

function normalizeVerificationProvenance(
  value: unknown,
): ClawHubSkillVerification["provenance"] {
  if (value === "server-resolved-github-import") return value;
  if (value === "unavailable") return value;
  return undefined;
}

function normalizeSecurityStatus(
  value: unknown,
): ClawHubSkillVerification["security"] extends infer Security
  ? Security extends { status: infer Status }
    ? Status
    : never
  : never {
  return value === "clean"
    || value === "suspicious"
    || value === "malicious"
    || value === "pending"
    ? value
    : "unknown";
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function requireNormalizedSlug(value: unknown, path: string): string {
  if (typeof value !== "string") throw contractError(path, "slug must be a string");
  const normalized = value.trim().toLowerCase();
  if (!slugPattern.test(normalized)) throw contractError(path, "slug is invalid");
  return normalized;
}

function requireSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!slugPattern.test(normalized)) {
    throw new ClawHubContractError({ path: "request", message: "slug is invalid" });
  }
  return normalized;
}

function requireSkillReference(value: string): {
  reference: string;
  slug: string;
  ownerHandle?: string;
} {
  const reference = requireSlug(value);
  if (!reference.startsWith("@")) {
    return {
      reference,
      slug: reference,
    };
  }
  const separator = reference.indexOf("/");
  const ownerHandle = reference.slice(1, separator);
  if (!ownerHandlePattern.test(ownerHandle)) {
    throw new ClawHubContractError({
      path: "request",
      message: "owner handle is invalid",
    });
  }
  return {
    reference,
    slug: reference.slice(separator + 1),
    ownerHandle,
  };
}

function buildSkillReference(slug: string, ownerHandle?: string): string {
  return slug.startsWith("@") || !ownerHandle
    ? slug
    : `@${ownerHandle}/${slug}`;
}

function optionalOwnerHandle(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw contractError(path, "owner handle must be a string");
  }
  const normalized = value.trim().toLowerCase();
  if (!ownerHandlePattern.test(normalized)) {
    throw contractError(path, "owner handle is invalid");
  }
  return normalized;
}

function requireVersion(value: string): string {
  const normalized = normalizeVersion(value);
  if (!normalized) {
    throw new ClawHubContractError({ path: "request", message: "version is invalid" });
  }
  return normalized;
}

function requireVersionValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw contractError(path, "version must be a string");
  const version = normalizeVersion(value);
  if (!version) throw contractError(path, "version is invalid");
  return version;
}

function optionalVersion(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireVersionValue(value, path);
}

function normalizeVersion(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length <= 64 && versionPattern.test(normalized) ? normalized : undefined;
}

function requireTimestamp(value: unknown, path: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw contractError(path, `${field} must be a non-negative number`);
  }
  return value;
}

function optionalTimestamp(
  value: unknown,
  path: string,
  field: string,
): number | undefined {
  return value === undefined ? undefined : requireTimestamp(value, path, field);
}

function requireDisplayText(
  value: unknown,
  maxLength: number,
  path: string,
  field: string,
): string {
  if (typeof value !== "string") throw contractError(path, `${field} must be a string`);
  const normalized = normalizeDisplayText(value, maxLength);
  if (!normalized) throw contractError(path, `${field} is empty`);
  return normalized;
}

function optionalDisplayText(
  value: unknown,
  maxLength: number,
  path: string,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireDisplayText(value, maxLength, path, field);
}

function normalizeDisplayText(value: string, maxLength: number): string | undefined {
  const withoutControls = value
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!withoutControls) return undefined;
  return Array.from(withoutControls).slice(0, maxLength).join("");
}

function optionalOpaqueString(
  value: unknown,
  maxLength: number,
  path: string,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw contractError(path, `${field} must be a string`);
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maxLength
    || /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(normalized)
  ) {
    throw contractError(path, `${field} is invalid`);
  }
  return normalized;
}

function normalizeLimit(value: number | undefined, max: number): number {
  if (value === undefined) return Math.min(20, max);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, max);
}

function buildCanonicalSkillUrl(params: {
  baseUrl?: string | undefined;
  slug: string;
  ownerHandle?: string | undefined;
}): string {
  const baseUrl = resolveClawHubBaseUrl(params.baseUrl);
  const owner = params.ownerHandle ? encodeURIComponent(params.ownerHandle) : undefined;
  const slug = encodeURIComponent(params.slug);
  return owner
    ? `${baseUrl}/${owner}/skills/${slug}`
    : `${baseUrl}/skills/${slug}`;
}

function contractError(path: string, message: string): ClawHubContractError {
  return new ClawHubContractError({ path, message });
}

function emptyRuntimeRequirements(): ClawHubRuntimeRequirements {
  return {
    requiredEnv: [],
    optionalEnv: [],
    requiredBins: [],
    anyBins: [],
    configPaths: [],
    operatingSystems: [],
    installKinds: [],
    always: false,
  };
}

function normalizeRegistryProvenance(
  value: unknown,
): ClawHubRegistryProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const provenance = value as Record<string, unknown>;
  const rawSignature = provenance.signature;
  const signatureRecord = rawSignature && typeof rawSignature === "object" && !Array.isArray(rawSignature)
    ? rawSignature as Record<string, unknown>
    : undefined;
  const algorithm = normalizeOpaqueValue(signatureRecord?.algorithm, 32, /^[A-Za-z0-9._-]+$/);
  const keyId = normalizeOpaqueValue(signatureRecord?.keyId, 256, /^[A-Za-z0-9._:@/-]+$/);
  const signatureValue = normalizeOpaqueValue(signatureRecord?.value, 512, /^[A-Za-z0-9+/=_-]+$/);
  const sbomUrl = normalizeHttpsUrl(provenance.sbomUrl);
  const attestationUrl = normalizeHttpsUrl(provenance.attestationUrl);
  const signature = algorithm && keyId && signatureValue
    ? { algorithm, keyId, value: signatureValue }
    : undefined;
  if (!signature && !sbomUrl && !attestationUrl) return undefined;
  return {
    ...(signature ? { signature } : {}),
    ...(sbomUrl ? { sbomUrl } : {}),
    ...(attestationUrl ? { attestationUrl } : {}),
  };
}

function normalizeOpaqueValue(
  value: unknown,
  maxLength: number,
  pattern: RegExp,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength && pattern.test(normalized)
    ? normalized
    : undefined;
}

function normalizeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:"
      && !url.username
      && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
