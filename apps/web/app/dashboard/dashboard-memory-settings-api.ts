export type MemoryRepresentative = {
  id?: string;
  slug: string;
  displayName: string;
};

export type MemorySettingsPolicy = {
  basic: {
    longTermMemoryEnabled: boolean;
    shortTermMemoryEnabled: boolean;
    contactMemoryEnabled: boolean;
    contactMemoryCrossChannelEnabled: boolean;
    representativeExperienceEnabled: boolean;
    autoExtract: boolean;
  };
  channels: Record<"web" | "matrix" | "telegram", {
    recallEnabled: boolean;
    extractEnabled: boolean;
  }>;
  retention: {
    days: number;
    expiryAction: "ARCHIVE" | "DELETE";
  };
  advanced: {
    provider: "openviking";
    recallLimit: number;
    recallThreshold: number;
  };
};

export type MemorySettings = {
  representative: MemoryRepresentative;
  configured: boolean;
  revision: number;
  basic: MemorySettingsPolicy["basic"] & {
    automaticPolicyEnabled: true;
    /**
     * Capability truth reported by the runtime. Older servers omit this field;
     * clients must fail closed instead of assuming cross-channel sharing exists.
     */
    contactMemoryCrossChannelSupported?: boolean;
  };
  channels: Record<"web" | "matrix" | "telegram", {
    recallSupported: boolean;
    extractSupported: boolean;
    recallEnabled: boolean;
    extractEnabled: boolean;
    reasonCode?: string;
  }>;
  retention: MemorySettingsPolicy["retention"];
  advanced: MemorySettingsPolicy["advanced"] & {
    namespaceManagedByServer: true;
    targetManagedByServer: true;
    managedAgentId: string | null;
    managedNamespace: string | null;
    managedTargetUri: string | null;
    managedUserId?: string | null;
    managedUriStrategy?: "PER_MEMORY_VERSION" | string | null;
    sync: {
      /** Provider configuration/connection truth. */
      connectionStatus?: "CONFIGURED" | "DISABLED" | "MISCONFIGURED" | null;
      /** Projection/reconciliation operating state. */
      operationalStatus?: "HEALTHY" | "AVAILABLE" | "IDLE" | "DEGRADED" | "FAILED" | null;
      /** A known provider capability limitation, not an operational error. */
      capabilityCode?: "openviking_inventory_no_snapshot_cursor" | string | null;
      /** Legacy aggregate status retained for compatibility with older servers. */
      providerStatus: string | null;
      inventoryCoverage: string;
      queuedCount: number;
      activeCount: number;
      retryingCount: number;
      failedCount: number;
      deletePendingCount: number;
      lastProjectedAt: string | null;
      lastReconciledAt: string | null;
      lastErrorCode: string | null;
      reconciliationIntervalMinutes: number;
      retryStrategy: string;
    } | null;
  };
  updatedAt: string | null;
  settingsHref: string;
};

export type MemorySettingsUpdateResponse = {
  replayed: boolean;
  requestId: string;
  settings: MemorySettings;
};

type MemorySettingsEnvelope<T> = T | { data: T };

export class MemorySettingsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "MemorySettingsRequestError";
  }
}

export async function loadMemorySettings(
  representativeSlug: string,
  signal?: AbortSignal,
) {
  return requestMemorySettings<MemorySettings>(
    representativeSlug,
    signal ? { signal } : undefined,
  );
}

export async function updateMemorySettings(
  representativeSlug: string,
  expectedRevision: number,
  policy: MemorySettingsPolicy,
) {
  const idempotencyKey = createClientRequestId();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestMemorySettings<MemorySettingsUpdateResponse>(
        representativeSlug,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "X-Request-Id": createClientRequestId(),
          },
          body: JSON.stringify({ expectedRevision, policy }),
        },
      );
    } catch (error) {
      if (attempt === 0 && isRetryableSettingsFailure(error)) continue;
      throw error;
    }
  }
  throw new MemorySettingsRequestError(
    "Memory settings retry was exhausted.",
    503,
    "memory_settings_retry_exhausted",
  );
}

export function isRetryableSettingsFailure(error: unknown) {
  if (error instanceof MemorySettingsRequestError) return error.status >= 500;
  return error instanceof TypeError;
}

async function requestMemorySettings<T>(
  representativeSlug: string,
  init?: RequestInit,
): Promise<T> {
  const search = new URLSearchParams({ rep: representativeSlug.trim() });
  const response = await fetch(
    `/api/dashboard/memory/settings?${search.toString()}`,
    { cache: "no-store", ...init },
  );
  const body = await response.json().catch(() => null) as
    | MemorySettingsEnvelope<T>
    | { error?: string; code?: string }
    | null;
  if (!response.ok) {
    const errorMessage = readStringField(body, "error");
    const errorCode = readStringField(body, "code");
    throw new MemorySettingsRequestError(
      errorMessage ?? "Representative memory settings are unavailable.",
      response.status,
      errorCode,
    );
  }
  if (!body || typeof body !== "object") {
    throw new MemorySettingsRequestError(
      "Representative memory settings are unavailable.",
      response.status,
      "memory_settings_invalid_response",
    );
  }
  return "data" in body ? body.data as T : body as T;
}

function createClientRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `memory-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[field];
  return typeof candidate === "string" ? candidate : null;
}
