import { createHash } from "node:crypto";

import {
  buildGovernedContactChannelMemoryVersionUri,
} from "@delegate/openviking";
import { describe, expect, it, vi } from "vitest";

import {
  MemoryDashboardError,
  decodeMemoryDashboardCursor,
  encodeMemoryDashboardCursor,
  evaluateMemoryRecallEligibility,
  executeMemoryDashboardAction,
  getMemoryDashboardOverview,
  getMemoryDashboardSettings,
  listMemoryDashboardEntries,
  listMemoryDashboardReconciliation,
  memoryEntriesQuerySchema,
  memoryOperationActionSchema,
  memorySettingsUpdateSchema,
} from "../src/memory-dashboard";

describe("memory dashboard business contract", () => {
  it("round-trips an opaque cursor bound to list, anchor, and filter scope", () => {
    const value = encodeMemoryDashboardCursor({
      list: "entries",
      asOf: "2026-08-04T02:00:00.000Z",
      sortAt: "2026-08-04T01:00:00.000Z",
      kind: "memory",
      id: "memory-1",
      scope: "scope-hash",
    });
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeMemoryDashboardCursor(value)).toMatchObject({
      list: "entries",
      kind: "memory",
      id: "memory-1",
      scope: "scope-hash",
    });
    expect(decodeMemoryDashboardCursor(value)?.asOf.toISOString())
      .toBe("2026-08-04T02:00:00.000Z");
  });

  it("rejects malformed cursors and unknown deep-link filters", () => {
    expect(() => decodeMemoryDashboardCursor("not+a+cursor"))
      .toThrow("cursor is invalid");
    expect(memoryEntriesQuerySchema.safeParse({
      rep: "delegate",
      rawQuery: "do not persist this",
    }).success).toBe(false);
  });

  it("accepts only explicit safe governance actions", () => {
    expect(memoryOperationActionSchema.safeParse({
      action: "request_deletion",
      memoryId: "memory-1",
      expectedUpdatedAt: "2026-08-04T01:00:00.000Z",
      reasonCode: "owner_request",
    }).success).toBe(true);
    expect(memoryOperationActionSchema.safeParse({
      action: "force_remote_delete",
      targetUri: "viking://unsafe",
    }).success).toBe(false);
  });

  it("keeps automatic extraction candidate-only and validates dependencies", () => {
    const invalid = memorySettingsUpdateSchema.safeParse({
      expectedRevision: 0,
      policy: {
        basic: {
          longTermMemoryEnabled: false,
          contactMemoryEnabled: false,
          representativeExperienceEnabled: false,
          autoExtract: true,
        },
        channels: {
          web: { recallEnabled: false, extractEnabled: true },
          matrix: { recallEnabled: false, extractEnabled: false },
          telegram: { recallEnabled: false, extractEnabled: false },
        },
        retention: { days: 30, expiryAction: "ARCHIVE" },
        advanced: {
          provider: "openviking",
          recallLimit: 6,
          recallThreshold: 0.01,
        },
      },
    });
    expect(invalid.success).toBe(false);
  });

  it("allows the representative Owner and same-organization Admin only", async () => {
    const representative = {
      id: "rep-1",
      slug: "delegate",
      displayName: "Delegate",
      ownerId: "owner-1",
      activeVersionId: null,
      owner: { organizationId: "org-1", timezone: "Asia/Shanghai" },
    };
    const policy = {
      representativeId: "rep-1",
      namespaceKey: "server_managed",
      longTermMemoryEnabled: false,
      contactMemoryEnabled: false,
      representativeExperienceEnabled: false,
      autoExtract: false,
      webRecallEnabled: false,
      webExtractEnabled: false,
      matrixRecallEnabled: true,
      matrixExtractEnabled: true,
      telegramRecallEnabled: true,
      telegramExtractEnabled: true,
      retentionDays: 30,
      expiryAction: "ARCHIVE",
      provider: "openviking",
      managedAgentId: "hidden-agent",
      managedTargetUri: "hidden-target",
      recallLimit: 6,
      recallScoreThreshold: 0.01,
      revision: 2,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-04T00:00:00.000Z"),
    };
    const ownerClient = {
      representative: { findUnique: async () => representative },
      owner: { findUnique: async () => null },
      representativeMemoryPolicy: { findUnique: async () => policy },
    };
    const ownerSettings = await getMemoryDashboardSettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, { client: ownerClient as never });
    expect(ownerSettings.revision).toBe(2);
    expect(ownerSettings.channels.matrix).toMatchObject({
      recallSupported: false,
      extractSupported: false,
      recallEnabled: false,
      extractEnabled: false,
      reasonCode: "memory_channel_disclosure_unavailable",
    });
    expect(ownerSettings.channels.telegram).toMatchObject({
      recallSupported: false,
      extractSupported: false,
      recallEnabled: false,
      extractEnabled: false,
    });
    expect(JSON.stringify(ownerSettings)).not.toContain("hidden-agent");
    expect(JSON.stringify(ownerSettings)).not.toContain("hidden-target");
    expect(JSON.stringify(ownerSettings)).not.toMatch(/(?:uri|layer|score|session)/iu);

    const adminClient = {
      ...ownerClient,
      owner: {
        findUnique: async () => ({
          organizationId: "org-1",
          timezone: "UTC",
          organizationMember: {
            organizationId: "org-1",
            role: "ADMIN",
          },
        }),
      },
    };
    await expect(getMemoryDashboardSettings({
      actorOwnerId: "admin-1",
      representativeSlug: "delegate",
    }, { client: adminClient as never })).resolves.toMatchObject({ revision: 2 });

    const analystClient = {
      ...adminClient,
      owner: {
        findUnique: async () => ({
          organizationId: "org-1",
          timezone: "UTC",
          organizationMember: {
            organizationId: "org-1",
            role: "ANALYST",
          },
        }),
      },
    };
    await expect(getMemoryDashboardSettings({
      actorOwnerId: "analyst-1",
      representativeSlug: "delegate",
    }, { client: analystClient as never })).rejects.toMatchObject({
      code: "memory_dashboard_not_found",
      statusCode: 404,
    } satisfies Partial<MemoryDashboardError>);
  });
});

describe("memory dashboard hardened service truth", () => {
  const now = new Date("2026-08-04T00:30:00.000Z");

  it("requires the complete recall fence and never advertises undisclosed channels", () => {
    const memory = eligibleMemory();
    const policy = enabledMemoryPolicy();
    const eligible = evaluateMemoryRecallEligibility({
      memory: memory as never,
      policy,
      now,
    });
    expect(eligible).toMatchObject({
      enabled: true,
      channels: {
        web: { enabled: true, reasonCode: null },
        matrix: { enabled: false },
        telegram: { enabled: false },
      },
    });

    const withoutHumanApproval = eligibleMemory();
    withoutHumanApproval.currentVersion.reviewDecisions = [{
      representativeId: "rep-1",
      outcome: "APPROVED",
      reviewerRole: "SYSTEM",
    }];
    expect(evaluateMemoryRecallEligibility({
      memory: withoutHumanApproval as never,
      policy,
      now,
    })).toMatchObject({
      enabled: false,
      reasonCode: "memory_human_approval_missing",
    });

    const unverifiedProjection = eligibleMemory();
    unverifiedProjection.currentVersion.projectionItems[0]!.writeVerifiedAt = null;
    expect(evaluateMemoryRecallEligibility({
      memory: unverifiedProjection as never,
      policy,
      now,
    })).toMatchObject({
      enabled: false,
      reasonCode: "memory_projection_not_verified",
    });

    const wrongHash = eligibleMemory();
    wrongHash.currentVersion.projectionItems[0]!.contentHash = "b".repeat(64);
    expect(evaluateMemoryRecallEligibility({
      memory: wrongHash as never,
      policy,
      now,
    })).toMatchObject({
      enabled: false,
      reasonCode: "memory_projection_not_verified",
    });
  });

  it("counts each usage stage by its own timestamp and answers by completion day", async () => {
    const stageCountWhere: Array<Record<string, unknown>> = [];
    const runCountWhere: Array<Record<string, unknown>> = [];
    const client = overviewClient({
      memoryUseItem: {
        count: vi.fn(async ({ where }) => {
          stageCountWhere.push(where);
          if ("searchedAt" in where) return 11;
          if ("scopePassedAt" in where) return 9;
          if ("safetyPassedAt" in where) return 8;
          if ("injectedAt" in where) return 5;
          if ("citedAt" in where) return 3;
          if ("displayedAt" in where) return 2;
          return 0;
        }),
        aggregate: vi.fn(async () => ({ _max: { updatedAt: now } })),
      },
      memoryUseRun: {
        count: vi.fn(async ({ where }) => {
          runCountWhere.push(where);
          return "startedAt" in where ? 4 : 2;
        }),
        aggregate: vi.fn(async () => ({ _max: { updatedAt: now } })),
      },
    });

    const overview = await getMemoryDashboardOverview({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: client as never,
      now: () => now,
      healthLoader: async () => ({ status: "healthy", reasonCode: null }),
    });

    expect(overview.metrics).toMatchObject({
      effectiveMemories: 1,
      pendingCandidates: 2,
      today: {
        questions: 4,
        searchHits: 11,
        scopePassed: 9,
        safetyPassed: 8,
        injectedIntoModel: 5,
        citedByModel: 3,
        displayedSources: 2,
        answersUsingMemory: 2,
      },
    });
    expect(stageCountWhere.find((where) => "injectedAt" in where)?.injectedAt)
      .toEqual({
        gte: new Date("2026-08-04T00:00:00.000Z"),
        lte: now,
      });
    const answerWhere = runCountWhere.find((where) => "completedAt" in where);
    expect(answerWhere).toMatchObject({
      completedAt: {
        gte: new Date("2026-08-04T00:00:00.000Z"),
        lte: now,
      },
      items: { some: { injectedAt: { not: null } } },
    });
    expect(answerWhere).not.toHaveProperty("items.some.injectedAt.gte");
  });

  it("derives published projection health from expected version items, hashes, and sync truth", async () => {
    const snapshot = publishedSnapshot();
    const client = overviewClient({
      representative: {
        findUnique: vi.fn(async () => representative("published-1")),
      },
      representativeVersion: {
        findFirst: vi.fn(async () => ({
          snapshot,
          publishedAt: new Date("2026-08-03T00:00:00.000Z"),
        })),
      },
      publicKnowledgeProjectionItem: {
        findMany: vi.fn(async () => [{
          sourceKind: "REPRESENTATIVE_VERSION_RESOURCE",
          resourceKey: "identity/profile.md",
          knowledgeAssetId: null,
          provider: "openviking",
          contentHash: "0".repeat(64),
          remoteUri: "viking://resources/delegate/versions/published-1/identity/profile.md",
          projectedAt: new Date("2026-08-04T00:05:00.000Z"),
          createdAt: new Date("2026-08-04T00:05:00.000Z"),
        }]),
      },
      representativeContextSync: {
        findFirst: vi.fn(async () => ({
          status: "retry_wait",
          itemCount: 1,
          updatedAt: new Date("2026-08-04T00:10:00.000Z"),
          finishedAt: null,
        })),
      },
    });
    const overview = await getMemoryDashboardOverview({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: client as never,
      now: () => now,
      healthLoader: async () => ({ status: "healthy", reasonCode: null }),
    });
    expect(overview.publicKnowledge).toMatchObject({
      activePublishedVersionId: "published-1",
      projectionStatus: "retrying",
      syncStatus: "retry_wait",
      syncErrorCode: "public_knowledge_sync_retry_wait",
      expectedItemCount: 5,
      projectedItemCount: 1,
      verifiedItemCount: 0,
      missingItemCount: 4,
      mismatchedItemCount: 1,
      hashTruth: "mismatch_or_incomplete",
    });
    expect(overview.metrics.anomalies.publicKnowledge).toBe(6);
    expect(overview.service.lastUpdatedAt).toBe("2026-08-04T00:30:00.000Z");
  });

  it("marks enabled memory degraded when provider model credentials are missing", async () => {
    const overview = await getMemoryDashboardOverview({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: overviewClient() as never,
      now: () => now,
      healthLoader: async () => ({
        status: "degraded",
        reasonCode: "openviking_model_credentials_missing",
      }),
    });
    expect(overview.service).toMatchObject({
      enabled: true,
      status: "degraded",
      reasonCode: "openviking_model_credentials_missing",
      requiresAttention: true,
    });
  });

  it("fails closed on cross-representative deep links", async () => {
    const client = {
      representative: { findUnique: async () => representative(null) },
      owner: { findUnique: async () => null },
      representativeMemoryPolicy: { findUnique: async () => enabledMemoryPolicy() },
      governedMemory: {
        findMany: async () => [],
        findFirst: async () => null,
      },
    };
    await expect(listMemoryDashboardEntries({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      query: { rep: "delegate", kind: "memory", entryId: "foreign-memory" },
    }, { client: client as never, now: () => now })).rejects.toMatchObject({
      code: "memory_dashboard_not_found",
      statusCode: 404,
    });
  });

  it("replays a committed extraction retry without repeating its side effects", async () => {
    const sourceText = "I prefer concise replies";
    const revisionDigest = hashText(`message-1\u0000${sourceText}`);
    const runUpdatedAt = new Date("2026-08-04T00:00:00.000Z");
    let storedAudit: Record<string, unknown> | null = null;
    let runStatus = "FAILED";
    let updatedAt = runUpdatedAt;
    const tx = {
      representative: { findUnique: async () => representative(null) },
      owner: { findUnique: async () => null },
      eventAudit: {
        findUnique: vi.fn(async () => storedAudit),
        create: vi.fn(async ({ data }) => {
          storedAudit = data;
          return data;
        }),
      },
      memoryExtractionRun: {
        findFirst: vi.fn(async ({ select }) => (
          "contactId" in select
            ? {
                id: "extract-1",
                status: runStatus,
                contactId: "contact-1",
                sourceChannel: "WEB",
                sourceConversationId: "conversation-1",
                sourceMessageId: "message-1",
                trigger: "CHANNEL_MESSAGE",
                attemptCount: 3,
                errorCode: "memory_extraction_attempts_exhausted",
                idempotencyKey: [
                  "memory-extraction",
                  "v1",
                  "CHANNEL_MESSAGE",
                  "CONTACT_CHANNEL",
                  "web",
                  revisionDigest,
                  "a".repeat(64),
                ].join(":"),
                updatedAt,
              }
            : { status: runStatus, updatedAt }
        )),
        updateMany: vi.fn(async () => {
          runStatus = "QUEUED";
          updatedAt = now;
          return { count: 1 };
        }),
      },
      message: {
        findFirst: vi.fn(async () => ({
          id: "message-1",
          conversationId: "conversation-1",
          senderType: "AUDIENCE",
          contentType: "TEXT",
          text: sourceText,
          editedAt: null,
          redactedAt: null,
          conversation: {
            representativeId: "rep-1",
            contactId: "contact-1",
            sourceChannel: "web",
          },
        })),
      },
      representativeMemoryPolicy: {
        findUnique: vi.fn(async () => ({
          ...enabledMemoryPolicy(),
          retentionDays: 30,
        })),
      },
    };
    const client = transactionClient(tx);
    const action = {
      action: "retry_extraction",
      extractionRunId: "extract-1",
      expectedUpdatedAt: runUpdatedAt.toISOString(),
      reasonCode: "owner_retry",
    };
    const first = await executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-1",
      idempotencyKey: "retry-extract-1",
      action,
    }, { client: client as never, now: () => now });
    const replay = await executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-2",
      idempotencyKey: "retry-extract-1",
      action,
    }, { client: client as never, now: () => now });
    expect(first.result).toMatchObject({
      action: "retry_extraction",
      replayed: false,
      target: { kind: "extraction", id: "extract-1" },
      status: "QUEUED",
    });
    expect(replay).toEqual({
      requestId: "request-2",
      result: { ...first.result, replayed: true },
    });
    expect(tx.memoryExtractionRun.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.message.findFirst).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toMatch(/(?:remoteUri|score|layer|sessionId|I prefer)/u);

    await expect(executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-3",
      idempotencyKey: "retry-extract-1",
      action: { ...action, reasonCode: "different_reason" },
    }, { client: client as never, now: () => now })).rejects.toMatchObject({
      code: "memory_dashboard_idempotency_conflict",
      statusCode: 409,
    });
  });

  it("rejects stale retries and non-Web extraction retries before requeue", async () => {
    const tx = {
      representative: { findUnique: async () => representative(null) },
      owner: { findUnique: async () => null },
      eventAudit: { findUnique: async () => null },
      memoryExtractionRun: {
        findFirst: vi.fn(async () => ({
          id: "extract-matrix",
          status: "FAILED",
          contactId: "contact-1",
          sourceChannel: "MATRIX",
          sourceConversationId: "conversation-1",
          sourceMessageId: "message-1",
          trigger: "CHANNEL_MESSAGE",
          attemptCount: 3,
          errorCode: "memory_extraction_attempts_exhausted",
          idempotencyKey: [
            "memory-extraction",
            "v1",
            "CHANNEL_MESSAGE",
            "CONTACT_CHANNEL",
            "matrix",
            "a".repeat(64),
            "b".repeat(64),
          ].join(":"),
          updatedAt: now,
        })),
        updateMany: vi.fn(),
      },
      message: { findFirst: vi.fn() },
    };
    await expect(executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-stale",
      idempotencyKey: "retry-stale-1",
      action: {
        action: "retry_extraction",
        extractionRunId: "extract-matrix",
        expectedUpdatedAt: "2026-08-03T23:59:59.000Z",
        reasonCode: "owner_retry",
      },
    }, { client: transactionClient(tx) as never, now: () => now }))
      .rejects.toMatchObject({ code: "memory_dashboard_version_conflict" });
    await expect(executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-1",
      idempotencyKey: "retry-matrix-1",
      action: {
        action: "retry_extraction",
        extractionRunId: "extract-matrix",
        expectedUpdatedAt: now.toISOString(),
        reasonCode: "owner_retry",
      },
    }, { client: transactionClient(tx) as never, now: () => now }))
      .rejects.toMatchObject({ code: "memory_dashboard_state_conflict" });
    expect(tx.message.findFirst).not.toHaveBeenCalled();
    expect(tx.memoryExtractionRun.updateMany).not.toHaveBeenCalled();
  });

  it("queues only an authoritative failed projection and exposes no provider coordinates", async () => {
    const memory = eligibleMemory();
    memory.currentVersion.projectionItems = [];
    let projectionStatus = "FAILED";
    let updatedAt = new Date("2026-08-04T00:00:00.000Z");
    const tx = {
      representative: { findUnique: async () => representative(null) },
      owner: { findUnique: async () => null },
      eventAudit: {
        findUnique: async () => null,
        create: vi.fn(async ({ data }) => data),
      },
      memoryProjectionItem: {
        findFirst: vi.fn(async ({ select }) => (
          "memoryId" in select
            ? {
                id: "projection-1",
                representativeId: "rep-1",
                memoryId: "memory-1",
                memoryVersionId: "version-1",
                provider: "openviking",
                lane: "RECALL",
                status: projectionStatus,
                contentHash: "a".repeat(64),
                remoteUri: projectionUri(),
                deleteRequestedAt: null,
                deletedAt: null,
                attemptCount: 3,
                lastErrorCode: "openviking_write_failed",
                updatedAt,
              }
            : { status: projectionStatus, updatedAt }
        )),
        updateMany: vi.fn(async () => {
          projectionStatus = "QUEUED";
          updatedAt = now;
          return { count: 1 };
        }),
      },
      governedMemory: { findFirst: vi.fn(async () => memory) },
      representativeMemoryPolicy: {
        findUnique: vi.fn(async () => enabledMemoryPolicy()),
      },
    };
    const response = await executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-1",
      idempotencyKey: "retry-projection-1",
      action: {
        action: "retry_projection",
        projectionItemId: "projection-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "owner_retry",
      },
    }, { client: transactionClient(tx) as never, now: () => now });
    expect(response.result).toMatchObject({
      action: "retry_projection",
      target: { kind: "projection", id: "projection-1" },
      status: "QUEUED",
    });
    expect(JSON.stringify(response)).not.toMatch(/(?:remoteUri|viking:\/\/|contentHash|score|layer)/u);
  });

  it("replays a committed reconciliation enqueue without creating another run", async () => {
    let storedAudit: Record<string, unknown> | null = null;
    const auditCreate = vi.fn(async ({ data }) => {
      storedAudit = data;
      return data;
    });
    const tx = {
      representative: { findUnique: async () => representative(null) },
      owner: { findUnique: async () => null },
      eventAudit: {
        findUnique: vi.fn(async () => storedAudit),
        create: auditCreate,
      },
      memoryReconciliationRun: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({
          id: "recon-manual-1",
          status: "QUEUED",
          createdAt: now,
        })),
      },
      representativeMemoryPolicy: {
        findUnique: vi.fn(async () => ({ provider: "openviking" })),
      },
    };
    const first = await executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-reconciliation-1",
      idempotencyKey: "manual-reconciliation-1",
      action: { action: "enqueue_reconciliation" },
    }, { client: transactionClient(tx) as never, now: () => now });
    const replay = await executeMemoryDashboardAction({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-reconciliation-2",
      idempotencyKey: "manual-reconciliation-1",
      action: { action: "enqueue_reconciliation" },
    }, { client: transactionClient(tx) as never, now: () => now });
    expect(first.result).toMatchObject({
      action: "enqueue_reconciliation",
      replayed: false,
      runId: "recon-manual-1",
    });
    expect(replay).toEqual({
      requestId: "request-reconciliation-2",
      result: { ...first.result, replayed: true },
    });
    expect(tx.memoryReconciliationRun.create).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: "owner-1",
        representativeId: "rep-1",
        idempotencyKey: "manual-reconciliation-1",
        type: "OPENVIKING_CONFIG_CHANGED",
        payload: expect.objectContaining({
          requestId: "request-reconciliation-1",
          actorRole: "OWNER",
          reasonCode: "manual_memory_reconciliation_requested",
        }),
      }),
    });
  });

  it("caps and cursor-paginates reconciliation issue details", async () => {
    const detailArgs: unknown[] = [];
    const client = {
      representative: { findUnique: async () => representative(null) },
      owner: { findUnique: async () => null },
      memoryReconciliationRun: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async (args) => {
          detailArgs.push(args);
          return reconciliationRun();
        }),
      },
    };
    const response = await listMemoryDashboardReconciliation({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      query: { rep: "delegate", runId: "recon-1", itemLimit: 1 },
    }, { client: client as never, now: () => now });
    expect(response.detail?.issues).toHaveLength(1);
    expect(response.detail?.issuesPage).toMatchObject({
      limit: 1,
      hasMore: true,
    });
    expect(response.detail?.issuesPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect((detailArgs[0] as { select: { items: { take: number } } }).select.items.take)
      .toBe(2);
  });

  it("rejects settings that claim unsupported Matrix or Telegram memory", () => {
    const parsed = memorySettingsUpdateSchema.safeParse({
      expectedRevision: 1,
      policy: settingsPolicy({ matrixRecallEnabled: true }),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => (
        issue.message.includes("pre-interaction disclosure")
      ))).toBe(true);
    }
  });

  it("requires Contact Memory for automatic and channel extraction", () => {
    const policy = settingsPolicy();
    policy.basic.contactMemoryEnabled = false;
    policy.basic.representativeExperienceEnabled = true;
    policy.basic.autoExtract = true;
    policy.channels.web.extractEnabled = true;
    const parsed = memorySettingsUpdateSchema.safeParse({
      expectedRevision: 1,
      policy,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "Automatic extraction requires Contact Memory.",
          "Channel extraction requires automatic Contact Memory extraction.",
        ]),
      );
    }
  });

  it("reports historical illegal extraction combinations as disabled", async () => {
    const illegalPolicy = {
      ...enabledMemoryPolicy(),
      contactMemoryEnabled: false,
      representativeExperienceEnabled: true,
      autoExtract: true,
      webExtractEnabled: true,
    };
    const settings = await getMemoryDashboardSettings({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: {
        representative: { findUnique: async () => representative(null) },
        owner: { findUnique: async () => null },
        representativeMemoryPolicy: { findUnique: async () => illegalPolicy },
      } as never,
    });
    expect(settings.basic).toMatchObject({
      contactMemoryEnabled: false,
      representativeExperienceEnabled: true,
      autoExtract: false,
    });
    expect(settings.channels.web.extractEnabled).toBe(false);

    const overview = await getMemoryDashboardOverview({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    }, {
      client: overviewClient({
        representativeMemoryPolicy: { findUnique: async () => illegalPolicy },
      }) as never,
      now: () => now,
      healthLoader: async () => ({ status: "healthy", reasonCode: null }),
    });
    expect(overview.channels.web.extractionEnabled).toBe(false);
  });
});

function representative(activeVersionId: string | null) {
  return {
    id: "rep-1",
    slug: "delegate",
    displayName: "Delegate",
    ownerId: "owner-1",
    activeVersionId,
    owner: { organizationId: "org-1", timezone: "UTC" },
  };
}

function enabledMemoryPolicy() {
  return {
    representativeId: "rep-1",
    namespaceKey: "server_managed",
    longTermMemoryEnabled: true,
    contactMemoryEnabled: true,
    representativeExperienceEnabled: true,
    autoExtract: true,
    webRecallEnabled: true,
    webExtractEnabled: true,
    matrixRecallEnabled: true,
    matrixExtractEnabled: true,
    telegramRecallEnabled: true,
    telegramExtractEnabled: true,
    retentionDays: 30,
    expiryAction: "ARCHIVE",
    provider: "openviking",
    managedAgentId: "private-agent",
    managedTargetUri: "viking://private-target",
    recallLimit: 6,
    recallScoreThreshold: 0.01,
    revision: 1,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-04T00:30:00.000Z"),
  };
}

function projectionUri() {
  return buildGovernedContactChannelMemoryVersionUri({
    namespaceKey: "server_managed",
    contactId: "contact-1",
    channel: "web",
    memoryId: "memory-1",
    memoryVersionId: "version-1",
  });
}

function eligibleMemory() {
  return {
    id: "memory-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    scope: "CONTACT_CHANNEL",
    sourceChannel: "WEB",
    category: "CONTACT_PREFERENCE",
    status: "ACTIVE",
    currentVersionId: "version-1",
    recallDisabledAt: null,
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    deleteRequestedAt: null,
    deletedAt: null,
    currentVersion: {
      id: "version-1",
      representativeId: "rep-1",
      scope: "CONTACT_CHANNEL",
      safeText: "Preference: reply_length=concise",
      summary: "Preference: reply_length=concise",
      contentHash: "a".repeat(64),
      purgedAt: null,
      deidentifiedAt: null,
      deidentificationMethod: null,
      sourceCandidate: {
        representativeId: "rep-1",
        contactId: "contact-1",
        scope: "CONTACT_CHANNEL",
        scopeChannel: "WEB",
        sourceKind: "AUDIENCE_MESSAGE",
        status: "APPROVED",
        contentPurgedAt: null,
        deidentifiedAt: null,
      },
      reviewDecisions: [{
        representativeId: "rep-1",
        outcome: "APPROVED",
        reviewerRole: "OWNER",
      }],
      projectionItems: [{
        representativeId: "rep-1",
        provider: "openviking",
        lane: "RECALL",
        status: "ACTIVE",
        contentHash: "a".repeat(64),
        remoteUri: projectionUri(),
        writeReceiptHash: "receipt",
        writeVerifiedAt: new Date("2026-08-03T00:00:00.000Z") as Date | null,
        projectedAt: new Date("2026-08-03T00:00:00.000Z"),
        deleteRequestedAt: null,
        deletedAt: null,
      }],
    },
  };
}

function overviewClient(overrides: Record<string, unknown> = {}) {
  const base = {
    representative: { findUnique: vi.fn(async () => representative(null)) },
    owner: { findUnique: vi.fn(async () => null) },
    representativeMemoryPolicy: {
      findUnique: vi.fn(async () => enabledMemoryPolicy()),
    },
    governedMemory: {
      findMany: vi.fn(async () => [eligibleMemory()]),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: nowDate() } })),
    },
    memoryCandidate: {
      count: vi.fn(async () => 2),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: nowDate() } })),
    },
    memoryUseRun: {
      count: vi.fn(async ({ where }) => "startedAt" in where ? 4 : 2),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: nowDate() } })),
    },
    memoryUseItem: {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: nowDate() } })),
    },
    memoryProjectionItem: {
      count: vi.fn(async () => 1),
      aggregate: vi.fn(async () => ({ _max: { updatedAt: nowDate() } })),
    },
    memoryDeletionProof: { count: vi.fn(async () => 1) },
    memoryReconciliationItem: { count: vi.fn(async () => 1) },
    memoryReconciliationRun: {
      aggregate: vi.fn(async () => ({ _max: { updatedAt: nowDate() } })),
    },
  };
  return { ...base, ...overrides };
}

function nowDate() {
  return new Date("2026-08-04T00:30:00.000Z");
}

function publishedSnapshot() {
  return {
    identity: {
      displayName: "Delegate",
      roleSummary: "Representative",
      tone: "direct",
      languages: ["zh"],
    },
    publicMode: true,
    humanInLoop: true,
    groupActivation: "mention",
    conversation: {
      freeReplyLimit: 3,
      freeScope: ["faq"],
      paywalledIntents: [],
      handoffWindowHours: 24,
      handoffPrompt: "handoff",
    },
    governance: { allowedSkills: [] },
    knowledge: {
      identitySummary: "Identity",
      faq: [],
      materials: [],
      policies: [],
    },
    knowledgeAssets: [],
    pricing: [],
  };
}

function transactionClient(tx: Record<string, unknown>) {
  return {
    ...tx,
    $transaction: async (operation: (inner: unknown) => Promise<unknown>) =>
      operation(tx),
  };
}

function hashText(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reconciliationRun() {
  const issue = (id: string, minute: number) => ({
    id,
    issueKind: "MISSING_REMOTE",
    status: "OPEN",
    reasonCode: "missing_remote",
    attemptCount: 0,
    resolvedAt: null,
    lastErrorCode: null,
    createdAt: new Date(`2026-08-04T00:${String(minute).padStart(2, "0")}:00.000Z`),
    updatedAt: nowDate(),
    projectionItem: null,
  });
  return {
    id: "recon-1",
    provider: "openviking",
    status: "PARTIAL",
    asOf: new Date("2026-08-04T00:00:00.000Z"),
    expectedCount: 2,
    observedCount: 1,
    matchedCount: 1,
    issueCount: 2,
    resolvedCount: 0,
    attemptCount: 1,
    startedAt: new Date("2026-08-04T00:00:00.000Z"),
    finishedAt: null,
    errorCode: null,
    createdAt: new Date("2026-08-04T00:00:00.000Z"),
    updatedAt: nowDate(),
    items: [issue("issue-1", 1), issue("issue-2", 2)],
  };
}

function settingsPolicy(input: { matrixRecallEnabled?: boolean } = {}) {
  return {
    basic: {
      longTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      representativeExperienceEnabled: false,
      autoExtract: false,
    },
    channels: {
      web: { recallEnabled: true, extractEnabled: false },
      matrix: {
        recallEnabled: input.matrixRecallEnabled ?? false,
        extractEnabled: false,
      },
      telegram: { recallEnabled: false, extractEnabled: false },
    },
    retention: { days: 30, expiryAction: "ARCHIVE" },
    advanced: {
      provider: "openviking",
      recallLimit: 6,
      recallThreshold: 0.01,
    },
  };
}
