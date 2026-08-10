import { describe, expect, it, vi } from "vitest";

import {
  getRepresentativeMemorySettings,
  representativeMemorySettingsUpdateSchema,
  updateRepresentativeMemorySettings,
} from "../src/memory-settings";

const basePolicy = {
  basic: {
    longTermMemoryEnabled: true,
    shortTermMemoryEnabled: true,
    contactMemoryEnabled: true,
    contactMemoryCrossChannelEnabled: false,
    representativeExperienceEnabled: false,
    autoExtract: true,
  },
  channels: {
    web: { recallEnabled: true, extractEnabled: true },
    matrix: { recallEnabled: false, extractEnabled: false },
    telegram: { recallEnabled: false, extractEnabled: false },
  },
  retention: { days: 30, expiryAction: "ARCHIVE" as const },
  advanced: {
    provider: "openviking" as const,
    recallLimit: 6,
    recallThreshold: 0.01,
  },
};

describe("representative memory settings", () => {
  it("keeps short-term memory independent and permits representative-only extraction", () => {
    expect(representativeMemorySettingsUpdateSchema.safeParse({
      expectedRevision: 0,
      policy: {
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          longTermMemoryEnabled: false,
          contactMemoryEnabled: false,
          autoExtract: false,
        },
        channels: {
          ...basePolicy.channels,
          web: { recallEnabled: false, extractEnabled: false },
        },
      },
    }).success).toBe(true);

    expect(representativeMemorySettingsUpdateSchema.safeParse({
      expectedRevision: 0,
      policy: {
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          contactMemoryEnabled: false,
          representativeExperienceEnabled: true,
        },
      },
    }).success).toBe(true);
  });

  it("allows channel-local Matrix and Telegram policy plus guarded cross-channel sharing", () => {
    const missingContact = representativeMemorySettingsUpdateSchema.safeParse({
      expectedRevision: 0,
      policy: {
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          contactMemoryEnabled: false,
          contactMemoryCrossChannelEnabled: true,
        },
      },
    });
    expect(missingContact.success).toBe(false);
    if (!missingContact.success) {
      expect(missingContact.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["policy", "basic", "contactMemoryCrossChannelEnabled"],
        }),
      ]));
    }

    const channelLocal = representativeMemorySettingsUpdateSchema.safeParse({
      expectedRevision: 0,
      policy: {
        ...basePolicy,
        channels: {
          ...basePolicy.channels,
          matrix: { recallEnabled: true, extractEnabled: true },
          telegram: { recallEnabled: true, extractEnabled: true },
        },
      },
    });
    expect(channelLocal.success).toBe(true);

    const supportedSharing = representativeMemorySettingsUpdateSchema.safeParse({
      expectedRevision: 0,
      policy: {
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          contactMemoryCrossChannelEnabled: true,
        },
      },
    });
    expect(supportedSharing.success).toBe(true);
  });

  it("returns automatic-policy defaults without inventing synchronization facts", async () => {
    const client = settingsClient({ policy: null });
    const result = await getRepresentativeMemorySettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, { client: client as never });

    expect(result.basic).toEqual({
      longTermMemoryEnabled: false,
      shortTermMemoryEnabled: true,
      contactMemoryEnabled: false,
      contactMemoryCrossChannelEnabled: false,
      contactMemoryCrossChannelSupported: true,
      representativeExperienceEnabled: false,
      autoExtract: false,
      automaticPolicyEnabled: true,
    });
    expect(result.advanced).toMatchObject({
      managedAgentId: null,
      managedNamespace: null,
      managedTargetUri: null,
      sync: null,
    });
    expect(result.basic).not.toHaveProperty("createsCandidatesOnly");
    expect(result.basic).not.toHaveProperty("automaticApprovalEnabled");
  });

  it("reports persisted managed identifiers and an evidence-backed sync snapshot", async () => {
    const policy = storedPolicy({
      contactMemoryCrossChannelEnabled: true,
      matrixRecallEnabled: true,
      matrixExtractEnabled: true,
      telegramRecallEnabled: true,
      telegramExtractEnabled: true,
    });
    const client = settingsClient({
      policy,
      sync: {
        groups: [
          { status: "QUEUED", _count: { _all: 2 } },
          { status: "ACTIVE", _count: { _all: 3 } },
          { status: "RETRYING", _count: { _all: 1 } },
          { status: "DELETE_PENDING", _count: { _all: 1 } },
        ],
        projectedAt: new Date("2026-08-06T01:00:00.000Z"),
        projectionError: {
          lastErrorCode: "projection_retryable",
          updatedAt: new Date("2026-08-06T01:10:00.000Z"),
        },
        reconciliation: {
          status: "PARTIAL",
          finishedAt: new Date("2026-08-06T01:20:00.000Z"),
          errorCode: "inventory_partial",
          updatedAt: new Date("2026-08-06T01:20:00.000Z"),
        },
      },
    });
    const result = await getRepresentativeMemorySettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: client as never,
      env: { OPENVIKING_ENABLED: "true" },
    });

    expect(result.advanced).toMatchObject({
      managedAgentId: "managed-agent",
      managedNamespace: "managed-namespace",
      managedTargetUri: "viking://managed-target",
      sync: {
        providerStatus: "DEGRADED",
        connectionStatus: "CONFIGURED",
        operationalStatus: "DEGRADED",
        inventoryCoverage: "KNOWN_PROJECTIONS_ONLY",
        capabilityCode: "openviking_inventory_no_snapshot_cursor",
        queuedCount: 2,
        activeCount: 3,
        retryingCount: 1,
        failedCount: 0,
        deletePendingCount: 1,
        lastProjectedAt: "2026-08-06T01:00:00.000Z",
        lastReconciledAt: "2026-08-06T01:20:00.000Z",
        lastErrorCode: "inventory_partial",
        reconciliationIntervalMinutes: 5,
        retryStrategy: "capped_exponential_backoff_with_leases",
      },
    });
    expect(result.basic.contactMemoryCrossChannelEnabled).toBe(true);
    expect(result.channels).toMatchObject({
      matrix: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: true,
        extractEnabled: true,
      },
      telegram: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: true,
        extractEnabled: true,
      },
    });
  });

  it("does not let the inventory capability marker hide a real projection error", async () => {
    const client = settingsClient({
      policy: storedPolicy(),
      sync: {
        groups: [{ status: "FAILED", _count: { _all: 1 } }],
        projectedAt: null,
        projectionError: {
          lastErrorCode: "projection_write_failed",
          updatedAt: new Date("2026-08-06T01:00:00.000Z"),
        },
        reconciliation: {
          status: "PARTIAL",
          finishedAt: new Date("2026-08-06T02:00:00.000Z"),
          errorCode: "openviking_inventory_no_snapshot_cursor",
          issueCount: 0,
          updatedAt: new Date("2026-08-06T02:00:00.000Z"),
        },
      },
    });
    const result = await getRepresentativeMemorySettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: client as never,
      env: { OPENVIKING_ENABLED: "true" },
    });

    expect(result.advanced.sync).toMatchObject({
      operationalStatus: "DEGRADED",
      capabilityCode: "openviking_inventory_no_snapshot_cursor",
      lastErrorCode: "projection_write_failed",
    });
  });

  it("reports a recent successful reconciliation as operationally healthy", async () => {
    const client = settingsClient({
      policy: storedPolicy(),
      sync: {
        groups: [{ status: "ACTIVE", _count: { _all: 1 } }],
        projectedAt: new Date("2026-08-07T08:00:00.000Z"),
        projectionError: null,
        reconciliation: {
          status: "SUCCEEDED",
          finishedAt: new Date("2026-08-07T08:10:00.000Z"),
          errorCode: null,
          issueCount: 0,
          updatedAt: new Date("2026-08-07T08:10:00.000Z"),
        },
      },
    });
    const result = await getRepresentativeMemorySettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: client as never,
      env: { OPENVIKING_ENABLED: "true" },
      now: () => new Date("2026-08-07T08:20:00.000Z"),
    });

    expect(result.advanced.sync).toMatchObject({
      connectionStatus: "CONFIGURED",
      operationalStatus: "HEALTHY",
    });
  });

  it("does not keep a stale historical reconciliation green", async () => {
    const client = settingsClient({
      policy: storedPolicy(),
      sync: {
        groups: [{ status: "ACTIVE", _count: { _all: 1 } }],
        projectedAt: new Date("2026-08-07T07:00:00.000Z"),
        projectionError: null,
        reconciliation: {
          status: "SUCCEEDED",
          finishedAt: new Date("2026-08-07T07:05:00.000Z"),
          errorCode: null,
          issueCount: 0,
          updatedAt: new Date("2026-08-07T07:05:00.000Z"),
        },
      },
    });
    const result = await getRepresentativeMemorySettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: client as never,
      env: { OPENVIKING_ENABLED: "true" },
      now: () => new Date("2026-08-07T08:20:00.000Z"),
    });

    expect(result.advanced.sync).toMatchObject({
      connectionStatus: "CONFIGURED",
      operationalStatus: "DEGRADED",
    });
  });

  it("persists supported flags and audits the automatic-policy update", async () => {
    const created = storedPolicy({ revision: 1 });
    const create = vi.fn(async () => created);
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const client = settingsClient({ policy: null });
    Object.assign(client, {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
      representativeMemoryPolicy: {
        findUnique: vi.fn(async () => null),
        create,
      },
      eventAudit: {
        findUnique: vi.fn(async () => null),
        create: auditCreate,
      },
    });

    const result = await updateRepresentativeMemorySettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-1",
      idempotencyKey: "settings-1",
      update: {
        expectedRevision: 0,
        policy: {
          ...basePolicy,
          basic: {
            ...basePolicy.basic,
            shortTermMemoryEnabled: false,
          },
          channels: {
            ...basePolicy.channels,
            matrix: { recallEnabled: true, extractEnabled: true },
            telegram: { recallEnabled: true, extractEnabled: true },
          },
        },
      },
    }, { client: client as never });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shortTermMemoryEnabled: false,
        contactMemoryCrossChannelEnabled: false,
        matrixRecallEnabled: true,
        matrixExtractEnabled: true,
        telegramRecallEnabled: true,
        telegramExtractEnabled: true,
        revision: 1,
      }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          action: "representative_memory_policy_updated",
        }),
      }),
    });
    expect(result.settings.basic).toMatchObject({
      shortTermMemoryEnabled: false,
      contactMemoryCrossChannelEnabled: false,
      automaticPolicyEnabled: true,
    });
  });

  it.each([
    {
      label: "long-term memory",
      mutate: () => ({
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          longTermMemoryEnabled: false,
          contactMemoryEnabled: false,
          representativeExperienceEnabled: false,
          autoExtract: false,
        },
        channels: {
          ...basePolicy.channels,
          web: { recallEnabled: false, extractEnabled: false },
        },
      }),
      expectedFilter: undefined,
    },
    {
      label: "contact memory",
      mutate: () => ({
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          contactMemoryEnabled: false,
          representativeExperienceEnabled: true,
        },
      }),
      expectedFilter: "CONTACT_CHANNEL",
    },
    {
      label: "representative experience",
      mutate: () => ({
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          representativeExperienceEnabled: false,
        },
      }),
      expectedFilter: "REPRESENTATIVE",
    },
    {
      label: "Web recall",
      mutate: () => ({
        ...basePolicy,
        basic: {
          ...basePolicy.basic,
          representativeExperienceEnabled: true,
        },
        channels: {
          ...basePolicy.channels,
          web: { recallEnabled: false, extractEnabled: true },
        },
      }),
      expectedFilter: "RECALL",
    },
  ])("queues only governed projection cleanup when disabling $label", async ({
    mutate,
    expectedFilter,
  }) => {
    const policy = mutate();
    const { projectionUpdateMany } = await runExistingPolicyUpdate(policy);

    expect(projectionUpdateMany).toHaveBeenCalledTimes(2);
    expect(projectionUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        representativeId: "rep-1",
        status: { in: expect.arrayContaining(["ACTIVE", "QUEUED", "RETRYING"]) },
      }),
      data: expect.objectContaining({
        status: "DELETE_PENDING",
        deleteRequestedAt: expect.any(Date),
        availableAt: expect.any(Date),
      }),
    }));
    expect(projectionUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: "PROJECTING" }),
      data: expect.not.objectContaining({ status: expect.anything() }),
    }));
    const calls = JSON.stringify(projectionUpdateMany.mock.calls);
    expect(calls).not.toContain("PublicKnowledgeProjectionItem");
    if (expectedFilter) expect(calls).toContain(expectedFilter);
    else expect(projectionUpdateMany.mock.calls[0]?.[0].where).not.toHaveProperty("OR");
  });

  it("does not touch long-term projections when only short-term memory is disabled", async () => {
    const { projectionUpdateMany } = await runExistingPolicyUpdate({
      ...basePolicy,
      basic: {
        ...basePolicy.basic,
        shortTermMemoryEnabled: false,
        representativeExperienceEnabled: true,
      },
    }, {
      shortTermMemoryEnabled: true,
      representativeExperienceEnabled: true,
    });

    expect(projectionUpdateMany).not.toHaveBeenCalled();
  });

  it("caps the retention horizon of existing active memories when retention is shortened", async () => {
    const { governedMemoryUpdateMany } = await runExistingPolicyUpdate({
      ...basePolicy,
      retention: { days: 7, expiryAction: "ARCHIVE" },
      basic: {
        ...basePolicy.basic,
        representativeExperienceEnabled: true,
      },
    }, { retentionDays: 90 });

    expect(governedMemoryUpdateMany).toHaveBeenCalledTimes(1);
    expect(governedMemoryUpdateMany).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        status: "ACTIVE",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date("2026-08-13T02:00:00.000Z") } },
        ],
      },
      data: { expiresAt: new Date("2026-08-13T02:00:00.000Z") },
    });
  });
});

function settingsClient(input: {
  policy: ReturnType<typeof storedPolicy> | null;
  sync?: {
    groups: Array<{ status: string; _count: { _all: number } }>;
    projectedAt: Date | null;
    projectionError: { lastErrorCode: string | null; updatedAt: Date } | null;
    reconciliation: {
      status: string;
      finishedAt: Date | null;
      errorCode: string | null;
      issueCount?: number;
      updatedAt: Date;
    } | null;
  };
}) {
  const client: Record<string, unknown> = {
    representative: {
      findUnique: vi.fn(async () => ({
        id: "rep-1",
        slug: "delegate",
        displayName: "Delegate",
        ownerId: "owner-1",
        owner: { organizationId: "org-1" },
      })),
    },
    owner: { findUnique: vi.fn(async () => null) },
    representativeMemoryPolicy: {
      findUnique: vi.fn(async () => input.policy),
    },
  };
  if (input.sync) {
    client.memoryProjectionItem = {
      groupBy: vi.fn(async () => input.sync?.groups ?? []),
      aggregate: vi.fn(async () => ({
        _max: { projectedAt: input.sync?.projectedAt ?? null },
      })),
      findFirst: vi.fn(async () => input.sync?.projectionError ?? null),
    };
    client.memoryReconciliationRun = {
      findFirst: vi.fn(async () => input.sync?.reconciliation ?? null),
    };
  }
  return client;
}

function storedPolicy(overrides: Record<string, unknown> = {}) {
  return {
    representativeId: "rep-1",
    namespaceKey: "managed-namespace",
    longTermMemoryEnabled: true,
    shortTermMemoryEnabled: true,
    contactMemoryEnabled: true,
    contactMemoryCrossChannelEnabled: false,
    representativeExperienceEnabled: false,
    autoExtract: true,
    webRecallEnabled: true,
    webExtractEnabled: true,
    matrixRecallEnabled: false,
    matrixExtractEnabled: false,
    telegramRecallEnabled: false,
    telegramExtractEnabled: false,
    retentionDays: 30,
    expiryAction: "ARCHIVE",
    provider: "openviking",
    managedAgentId: "managed-agent",
    managedTargetUri: "viking://managed-target",
    recallLimit: 6,
    recallScoreThreshold: 0.01,
    revision: 2,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    ...overrides,
  };
}

async function runExistingPolicyUpdate(
  policy: typeof basePolicy,
  currentOverrides: Record<string, unknown> = {},
) {
  const current = storedPolicy({
    representativeExperienceEnabled: true,
    ...currentOverrides,
  });
  const updated = storedPolicy({
    revision: current.revision + 1,
    longTermMemoryEnabled: policy.basic.longTermMemoryEnabled,
    shortTermMemoryEnabled: policy.basic.shortTermMemoryEnabled,
    contactMemoryEnabled: policy.basic.contactMemoryEnabled,
    contactMemoryCrossChannelEnabled:
      policy.basic.contactMemoryCrossChannelEnabled,
    representativeExperienceEnabled:
      policy.basic.representativeExperienceEnabled,
    autoExtract: policy.basic.autoExtract,
    webRecallEnabled: policy.channels.web.recallEnabled,
    webExtractEnabled: policy.channels.web.extractEnabled,
    matrixRecallEnabled: policy.channels.matrix.recallEnabled,
    matrixExtractEnabled: policy.channels.matrix.extractEnabled,
    telegramRecallEnabled: policy.channels.telegram.recallEnabled,
    telegramExtractEnabled: policy.channels.telegram.extractEnabled,
    retentionDays: policy.retention.days,
    expiryAction: policy.retention.expiryAction,
    updatedAt: new Date("2026-08-06T02:00:00.000Z"),
  });
  const projectionUpdateMany = vi.fn()
    .mockResolvedValueOnce({ count: 3 })
    .mockResolvedValueOnce({ count: 1 });
  const governedMemoryUpdateMany = vi.fn(async () => ({ count: 2 }));
  const client = settingsClient({ policy: current });
  Object.assign(client, {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
    representativeMemoryPolicy: {
      findUnique: vi.fn(async () => current),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => updated),
    },
    memoryProjectionItem: { updateMany: projectionUpdateMany },
    governedMemory: { updateMany: governedMemoryUpdateMany },
    eventAudit: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "audit-update" })),
    },
  });
  await updateRepresentativeMemorySettings({
    actorOwnerId: "owner-1",
    representativeSlug: "delegate",
    requestId: `request-${policy.basic.longTermMemoryEnabled}-${policy.basic.contactMemoryEnabled}-${policy.basic.representativeExperienceEnabled}-${policy.channels.web.recallEnabled}-${policy.basic.shortTermMemoryEnabled}`,
    idempotencyKey: `settings-${policy.basic.longTermMemoryEnabled}-${policy.basic.contactMemoryEnabled}-${policy.basic.representativeExperienceEnabled}-${policy.channels.web.recallEnabled}-${policy.basic.shortTermMemoryEnabled}`,
    update: {
      expectedRevision: current.revision,
      policy,
    },
  }, { client: client as never });
  return { projectionUpdateMany, governedMemoryUpdateMany };
}
