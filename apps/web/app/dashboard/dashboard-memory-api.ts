export type MemorySection = "overview" | "entries" | "usage" | "operations";

export type MemoryChannel = "WEB" | "MATRIX" | "TELEGRAM";
export type MemorySourceKind =
  | "PUBLIC_KNOWLEDGE"
  | "CONTACT_MEMORY"
  | "REPRESENTATIVE_EXPERIENCE";

export type MemoryPage = {
  asOf: string;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type MemoryRepresentative = {
  id?: string;
  slug: string;
  displayName: string;
};

export type MemoryOverview = {
  representative: MemoryRepresentative;
  metrics: {
    effectiveMemories: number;
    pendingCandidates: number;
    today: {
      questions: number;
      searchHits: number;
      scopePassed: number;
      safetyPassed: number;
      injectedIntoModel: number;
      citedByModel: number;
      displayedSources: number;
      answersUsingMemory: number;
    };
    anomalies: {
      total: number;
      projection: number;
      cleanup: number;
      reconciliation: number;
    };
  };
  service: {
    status: string;
    enabled: boolean;
    lastUpdatedAt: string | null;
    requiresAttention: boolean;
  };
  channels: Record<"web" | "matrix" | "telegram", {
    recallSupported: boolean;
    extractionSupported: boolean;
    recallEnabled: boolean;
    extractionEnabled: boolean;
  }>;
  publicKnowledge: {
    managedInKnowledgeLibrary: true;
    activePublishedVersionId: string | null;
    projectedItemCount: number;
    lastProjectedAt: string | null;
    knowledgeLibraryHref: string;
  };
  generatedAt: string;
};

export type MemoryReviewRecord = {
  outcome: string;
  reasonCode?: string | null;
  reviewerRole?: string | null;
  createdAt: string;
};

export type MemoryEntry = {
  id: string;
  kind: "candidate" | "memory";
  memoryType?: "contact" | "representative_experience";
  scope: string;
  category: string;
  status: string;
  sourceKind?: string | null;
  sourceChannel?: MemoryChannel | null;
  summary?: string | null;
  safeText?: string | null;
  contact?: { id?: string; label: string } | null;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  extractionReasonCode?: string | null;
  extraction?: {
    sourceKind?: string | null;
    reasonCode?: string | null;
    deidentifiedAt?: string | null;
  } | null;
  safety?: {
    classification?: string | null;
    reasonCode?: string | null;
  } | null;
  provenance?: {
    inboxHref?: string | null;
  } | null;
  reviews?: MemoryReviewRecord[];
  recentUse?: Array<{
    injectedAt?: string | null;
    citedAt?: string | null;
    displayedAt?: string | null;
    inboxHref?: string | null;
  }>;
  version?: {
    number?: number | null;
    safeText?: string | null;
    summary?: string | null;
  } | null;
  lifecycle?: { expiresAt?: string | null } | null;
  cleanup?: {
    status?: string | null;
    attemptCount?: number;
    updatedAt?: string | null;
  } | null;
};

export type MemoryEntryDetail = MemoryEntry;

export type MemoryEntriesResponse = {
  representative: MemoryRepresentative;
  page: MemoryPage;
  items: MemoryEntry[];
  detail?: MemoryEntryDetail | null;
};

export type MemoryUseSource = {
  id: string;
  sourceKind: MemorySourceKind;
  title?: string | null;
  stages: {
    searchedAt?: string | null;
    scopeCheckedAt?: string | null;
    scopePassedAt?: string | null;
    safetyCheckedAt?: string | null;
    safetyPassedAt?: string | null;
    injectedAt?: string | null;
    citedAt?: string | null;
    displayedAt?: string | null;
  };
  rejectionReasonCode?: string | null;
};

export type MemoryUseRun = {
  id: string;
  status: string;
  sourceChannel: MemoryChannel;
  createdAt: string;
  completedAt?: string | null;
  reasonCode?: string | null;
  trigger?: {
    inboxHref?: string | null;
  } | null;
  counts: {
    searchHits: number;
    scopePassed: number;
    safetyPassed: number;
    injectedIntoModel: number;
    citedByModel: number;
    displayedSources: number;
    unmappedProviderCandidates: number;
  };
  sources?: MemoryUseSource[];
  displayedSources?: Array<{
    id: string;
    title: string;
    sourceKind: MemorySourceKind;
  }>;
};

export type MemoryUsageResponse = {
  representative: MemoryRepresentative;
  page: MemoryPage;
  items: MemoryUseRun[];
  detail?: MemoryUseRun | null;
};

export type MemoryReasonCount = {
  reasonCode: string;
  count: number;
};

export type MemoryOperation = {
  id: string;
  kind: "extraction" | "projection" | "cleanup" | string;
  status: string;
  sourceChannel?: MemoryChannel | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  provenance?: {
    inboxHref?: string | null;
  } | null;
  counts?: {
    candidates?: number;
    accepted?: number;
    rejected?: number;
    quarantined?: number;
    succeeded?: number;
    failed?: number;
  };
  reasons?: MemoryReasonCount[];
  memory?: {
    id: string;
    scope?: string;
    category?: string;
    sourceChannel?: MemoryChannel | null;
    summary?: string | null;
  } | null;
  attemptCount?: number;
  errorCode?: string | null;
  updatedAt?: string;
  environment?: "staging" | "recall";
  projectedAt?: string | null;
  deleteRequestedAt?: string | null;
  deletedAt?: string | null;
  verifiedItemCount?: number;
  partialSuccess?: boolean;
  knowledgeLibraryHref?: string | null;
  retry?: {
    supported: boolean;
    available: boolean;
    reasonCode?: string | null;
  } | null;
};

export type MemoryOperationsResponse = {
  representative: MemoryRepresentative;
  page: MemoryPage;
  items: MemoryOperation[];
  detail?: MemoryOperation | null;
};

export type MemoryReconciliationRun = {
  id: string;
  status: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  inventoryStatus?: string;
  coverage: {
    expected: number;
    observed: number;
    matched: number;
    issues: number;
    resolved: number;
  };
  attemptCount: number;
  errorCode?: string | null;
  issuesPage?: {
    asOf: string;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  issues?: Array<{
    id: string;
    issueKind: string;
    status: string;
    reasonCode?: string | null;
    attemptCount: number;
    resolvedAt?: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type MemoryReconciliationResponse = {
  representative: MemoryRepresentative;
  page: MemoryPage;
  items: MemoryReconciliationRun[];
  detail?: MemoryReconciliationRun | null;
  inventoryCapability?: {
    inventoryStatus: "partial" | string;
    exactKnownProjectionChecks: "supported" | string;
    remoteEnumeration: "unsupported" | string;
    reasonCode: string;
    automaticUnknownObjectDeletion: boolean;
  } | null;
};

export type MemorySettingsPolicy = {
  basic: {
    longTermMemoryEnabled: boolean;
    contactMemoryEnabled: boolean;
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
    createsCandidatesOnly: true;
    automaticApprovalEnabled: false;
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
  };
  updatedAt: string | null;
  settingsHref: string;
};

export type MemorySettingsUpdateResponse = {
  replayed: boolean;
  requestId: string;
  settings: MemorySettings;
};

export type MemoryListParams = Record<string, string | undefined>;

type MemoryEnvelope<T> = T | { data: T };

export class MemoryDashboardRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "MemoryDashboardRequestError";
  }
}

export async function loadMemoryOverview(
  representativeSlug: string,
  signal?: AbortSignal,
) {
  return requestMemory<MemoryOverview>(
    "overview",
    { rep: representativeSlug },
    signal ? { signal } : undefined,
  );
}

export async function loadMemoryEntries(
  representativeSlug: string,
  params: MemoryListParams,
  signal?: AbortSignal,
) {
  return requestMemory<MemoryEntriesResponse>("entries", {
    ...params,
    rep: representativeSlug,
  }, signal ? { signal } : undefined);
}

export async function loadMemoryUsage(
  representativeSlug: string,
  params: MemoryListParams,
  signal?: AbortSignal,
) {
  return requestMemory<MemoryUsageResponse>("usage", {
    ...params,
    rep: representativeSlug,
  }, signal ? { signal } : undefined);
}

export async function loadMemoryOperations(
  representativeSlug: string,
  params: MemoryListParams,
  signal?: AbortSignal,
) {
  return requestMemory<MemoryOperationsResponse>("operations", {
    ...params,
    rep: representativeSlug,
  }, signal ? { signal } : undefined);
}

export async function loadMemoryReconciliation(
  representativeSlug: string,
  params: MemoryListParams,
  signal?: AbortSignal,
) {
  return requestMemory<MemoryReconciliationResponse>("reconciliation", {
    ...params,
    rep: representativeSlug,
  }, signal ? { signal } : undefined);
}

export async function loadMemorySettings(
  representativeSlug: string,
  signal?: AbortSignal,
) {
  return requestMemory<MemorySettings>(
    "settings",
    { rep: representativeSlug },
    signal ? { signal } : undefined,
  );
}

export async function updateMemorySettings(
  representativeSlug: string,
  expectedRevision: number,
  policy: MemorySettingsPolicy,
) {
  return writeMemory<MemorySettingsUpdateResponse>(
    "settings",
    representativeSlug,
    "PATCH",
    { expectedRevision, policy },
  );
}

export async function executeMemoryAction(
  representativeSlug: string,
  action: Record<string, unknown>,
) {
  return writeMemory<unknown>(
    "operations",
    representativeSlug,
    "POST",
    action,
  );
}

async function writeMemory<T>(
  resource: "operations" | "settings",
  representativeSlug: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
) {
  const idempotencyKey = createClientRequestId();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestMemory<T>(
        resource,
        { rep: representativeSlug },
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "X-Request-Id": createClientRequestId(),
          },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      if (attempt === 0 && isRetryableActionFailure(error)) continue;
      throw error;
    }
  }
  throw new MemoryDashboardRequestError(
    "Memory action retry was exhausted.",
    503,
    "memory_dashboard_retry_exhausted",
  );
}

export function isRetryableActionFailure(error: unknown) {
  if (error instanceof MemoryDashboardRequestError) {
    return error.status >= 500;
  }
  return error instanceof TypeError;
}

async function requestMemory<T>(
  resource: "overview" | "entries" | "usage" | "operations" | "reconciliation" | "settings",
  params: MemoryListParams,
  init?: RequestInit,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value?.trim()) search.set(key, value.trim());
  }
  const response = await fetch(`/api/dashboard/memory/${resource}?${search.toString()}`, {
    cache: "no-store",
    ...init,
  });
  const body = await response.json().catch(() => null) as
    | MemoryEnvelope<T>
    | { error?: string; code?: string }
    | null;
  if (!response.ok) {
    const errorBody = isRecord(body) ? body as Record<string, unknown> : null;
    throw new MemoryDashboardRequestError(
      typeof errorBody?.error === "string"
        ? errorBody.error
        : "Memory data is unavailable.",
      response.status,
      typeof errorBody?.code === "string" ? errorBody.code : null,
    );
  }
  if (!body || typeof body !== "object") {
    throw new MemoryDashboardRequestError(
      "Memory data is unavailable.",
      response.status,
      "memory_dashboard_invalid_response",
    );
  }
  return "data" in body ? body.data as T : body as T;
}

function createClientRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
