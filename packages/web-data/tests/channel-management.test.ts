import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    representative: {
      findFirst: vi.fn(),
    },
    representativeChannelBinding: {
      findFirst: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    matrixVirtualUserBinding: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    channelEventInbox: {
      findFirst: vi.fn(),
    },
    outboxEvent: {
      findFirst: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
  };
  return {
    tx,
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
});

vi.mock("../src/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

import {
  buildOwnerChannelManagementSnapshot,
  evaluateChannelControlPlaneHealth,
  provisionOwnerMatrixChannel,
  refreshOwnerChannelHealth,
  setOwnerChannelDesiredState,
} from "../src/channel-management";
import { resolveChannelAvailability } from "../src/channel-availability";

describe("channel management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps Telegram as the source when Matrix carries the transport", () => {
    const snapshot = buildOwnerChannelManagementSnapshot({
      representatives: [
        {
          id: "rep-1",
          slug: "lin",
          displayName: "Lin",
          lifecycleState: "PUBLISHED",
          activeVersionId: "version-1",
          publicMode: true,
          channelBindings: [
            {
              id: "binding-tg",
              kind: "TELEGRAM",
              transport: "MATRIX",
              sourceProvider: "TELEGRAM",
              desiredState: "ACTIVE",
              healthStatus: "HEALTHY",
              externalUserId: "telegram:42",
              status: "CONNECTED",
              displayName: "@delegate_bot",
              lastHealthCheckAt: new Date("2026-07-23T10:00:00.000Z"),
              lastError: null,
            },
          ],
        },
      ],
      ingressEvents: [
        {
          id: "in-1",
          kind: "TELEGRAM",
          transport: "MATRIX",
          sourceProvider: "TELEGRAM",
          eventType: "message",
          status: "PROCESSED",
          lastError: "token=hidden https://private.example.test/path",
          createdAt: new Date("2026-07-23T11:00:00.000Z"),
          conversation: { representativeId: "rep-1" },
        },
      ],
      egressEvents: [
        {
          id: "out-1",
          kind: "TELEGRAM",
          transport: "MATRIX",
          sourceProvider: "TELEGRAM",
          eventType: "message.send",
          status: "PROCESSED",
          lastError: null,
          createdAt: new Date("2026-07-23T11:01:00.000Z"),
          conversation: { representativeId: "rep-1" },
        },
      ],
      generatedAt: new Date("2026-07-23T12:00:00.000Z"),
      dataSource: "database",
    });

    const telegram = snapshot.representatives[0]?.channels.find(
      (channel) => channel.kind === "TELEGRAM",
    );
    expect(telegram).toMatchObject({
      bindingId: "binding-tg",
      sourceProvider: "TELEGRAM",
      transport: "MATRIX",
      routedViaMatrix: true,
      recentIngress: {
        id: "in-1",
        eventType: "message",
        status: "PROCESSED",
      },
      recentEgress: {
        id: "out-1",
        eventType: "message.send",
        status: "PROCESSED",
      },
    });
    expect(telegram?.recentIngress?.error).toContain("token=[redacted]");
    expect(telegram?.recentIngress?.error).toContain("[redacted-url]");
    expect(JSON.stringify(snapshot)).not.toContain("private.example.test");
    expect(snapshot.representatives[0]?.channels).toHaveLength(3);
    expect(
      snapshot.representatives[0]?.channels.find(
        (channel) => channel.kind === "MATRIX",
      )?.bindingId,
    ).toBeNull();
    expect(snapshot.metrics).toEqual({
      representatives: 1,
      connectedBindings: 1,
      pausedBindings: 0,
      attentionBindings: 0,
    });
  });

  it("reports incomplete metadata and dead-letter delivery without inventing provider health", () => {
    expect(
      evaluateChannelControlPlaneHealth({
        kind: "MATRIX",
        transport: null,
        sourceProvider: null,
        externalUserId: null,
        legacyStatus: "CONNECTED",
        currentHealthStatus: "UNKNOWN",
        currentLastError: null,
        latestFailure: null,
      }),
    ).toEqual({
      healthStatus: "DEGRADED",
      lastError: "Transport or source-provider metadata is missing.",
    });

    expect(
      evaluateChannelControlPlaneHealth({
        kind: "TELEGRAM",
        transport: "MATRIX",
        sourceProvider: "TELEGRAM",
        externalUserId: "telegram:42",
        legacyStatus: "CONNECTED",
        currentHealthStatus: "HEALTHY",
        currentLastError: null,
        latestFailure: {
          status: "DEAD_LETTER",
          lastError: "authorization=secret https://private.example.test",
        },
      }),
    ).toEqual({
      healthStatus: "UNHEALTHY",
      lastError: "authorization=[redacted] [redacted-url]",
    });
  });

  it.each(["DEGRADED", "UNHEALTHY"] as const)(
    "recovers a stale %s state after a successful health refresh finds no recent failure",
    (currentHealthStatus) => {
      const recovered = evaluateChannelControlPlaneHealth({
        kind: "MATRIX",
        transport: "MATRIX",
        sourceProvider: "MATRIX",
        externalUserId: "@_delegate_rep_lin:matrix.example.org",
        legacyStatus: "CONNECTED",
        currentHealthStatus,
        currentLastError: "A previous delivery failed.",
        latestFailure: null,
      });

      expect(recovered).toEqual({
        healthStatus: "HEALTHY",
        lastError: null,
      });
      expect(
        resolveChannelAvailability({
          channel: "matrix",
          lifecycleState: "PUBLISHED",
          activeVersionId: "version-1",
          publicMode: true,
          binding: {
            legacyStatus: "CONNECTED",
            desiredState: "ACTIVE",
            healthStatus: recovered.healthStatus,
          },
        }),
      ).toEqual({ available: true, code: "available" });
    },
  );

  it("clears an expired failure during an owner health refresh", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const now = new Date("2026-07-24T12:00:00.000Z");
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      desiredState: "ACTIVE",
      healthStatus: "UNHEALTHY",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "CONNECTED",
      lastError: "Matrix delivery failed.",
    });
    mocks.tx.channelEventInbox.findFirst.mockResolvedValue(null);
    mocks.tx.outboxEvent.findFirst.mockResolvedValue(null);
    mocks.tx.representativeChannelBinding.update.mockResolvedValue({
      id: "binding-matrix-1",
      healthStatus: "HEALTHY",
      lastHealthCheckAt: now,
      lastError: null,
    });
    mocks.tx.eventAudit.create.mockResolvedValue({ id: "audit-health-1" });

    try {
      await expect(
        refreshOwnerChannelHealth({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-matrix-1",
          requestId: "request-health-1",
          idempotencyKey: "idem-health-1",
          now,
        }),
      ).resolves.toMatchObject({
        healthStatus: "HEALTHY",
        lastError: null,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    const failureCutoff = new Date("2026-07-23T12:00:00.000Z");
    expect(mocks.tx.channelEventInbox.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: failureCutoff },
          status: { in: ["FAILED", "DEAD_LETTER"] },
        }),
      }),
    );
    expect(mocks.tx.outboxEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: failureCutoff },
          status: { in: ["FAILED", "DEAD_LETTER"] },
        }),
      }),
    );
    expect(mocks.tx.representativeChannelBinding.update).toHaveBeenCalledWith({
      where: { id: "binding-matrix-1" },
      data: {
        healthStatus: "HEALTHY",
        lastHealthCheckAt: now,
        lastError: null,
      },
      select: {
        id: true,
        healthStatus: true,
        lastHealthCheckAt: true,
        lastError: true,
      },
    });
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        payload: expect.objectContaining({
          action: "CHANNEL_HEALTH_CHECKED",
          before: { healthStatus: "UNHEALTHY" },
          after: { healthStatus: "HEALTHY" },
        }),
      }),
    });
  });

  it("owner-scopes state changes and writes a correlation-rich audit record", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue({
      id: "binding-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "MATRIX",
      sourceProvider: "TELEGRAM",
      desiredState: "ACTIVE",
    });
    mocks.tx.representativeChannelBinding.update.mockResolvedValue({
      id: "binding-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "MATRIX",
      sourceProvider: "TELEGRAM",
      desiredState: "PAUSED",
    });
    mocks.tx.eventAudit.create.mockResolvedValue({ id: "audit-1" });

    try {
      await setOwnerChannelDesiredState({
        ownerId: "owner-1",
        actorId: "owner-1",
        bindingId: "binding-1",
        desiredState: "PAUSED",
        requestId: "request-1",
        idempotencyKey: "idem-1",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "binding-1",
          representative: { ownerId: "owner-1" },
        },
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        payload: expect.objectContaining({
          action: "CHANNEL_DESIRED_STATE_CHANGED",
          actorId: "owner-1",
          bindingId: "binding-1",
          channelKind: "TELEGRAM",
          sourceProvider: "TELEGRAM",
          transport: "MATRIX",
          requestId: "request-1",
          idempotencyKey: "idem-1",
          before: { desiredState: "ACTIVE" },
          after: { desiredState: "PAUSED" },
        }),
      }),
    });
  });

  it("owner-scopes and bootstraps a deterministic Matrix representative user", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "Lin Founder",
      displayName: "Lin",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue(null);
    mocks.tx.matrixVirtualUserBinding.findUnique.mockResolvedValue(null);
    mocks.tx.matrixVirtualUserBinding.upsert.mockResolvedValue({
      id: "matrix-user-1",
      matrixUserId: "@_delegate_rep_lin_founder:matrix.example.org",
      displayName: "Lin",
      enabled: true,
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      externalUserId: "@_delegate_rep_lin_founder:matrix.example.org",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.create.mockResolvedValue({ id: "audit-matrix-1" });

    try {
      await expect(provisionOwnerMatrixChannel({
        ownerId: "owner-1",
        actorId: "owner-1",
        representativeId: "rep-1",
        requestId: "request-matrix-1",
        idempotencyKey: "idem-matrix-1",
      })).resolves.toMatchObject({
        binding: {
          id: "binding-matrix-1",
          externalUserId: "@_delegate_rep_lin_founder:matrix.example.org",
        },
        virtualUser: {
          matrixUserId: "@_delegate_rep_lin_founder:matrix.example.org",
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.representative.findFirst).toHaveBeenCalledWith({
      where: {
        id: "rep-1",
        ownerId: "owner-1",
      },
      select: {
        id: true,
        slug: true,
        displayName: true,
      },
    });
    expect(mocks.tx.matrixVirtualUserBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          matrixUserId: "@_delegate_rep_lin_founder:matrix.example.org",
        },
        create: expect.objectContaining({
          representativeId: "rep-1",
          ownerId: "owner-1",
          kind: "REPRESENTATIVE",
          enabled: true,
        }),
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        payload: expect.objectContaining({
          action: "MATRIX_VIRTUAL_USER_PROVISIONED",
          matrixUserId: "@_delegate_rep_lin_founder:matrix.example.org",
        }),
      }),
    });
  });
});
