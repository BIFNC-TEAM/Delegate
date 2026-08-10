import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    representative: {
      findFirst: vi.fn(),
    },
    telegramBotConnection: {
      findFirst: vi.fn(),
    },
    representativeChannelBinding: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    matrixVirtualUserBinding: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    channelEventInbox: {
      findFirst: vi.fn(),
    },
    outboxEvent: {
      findFirst: vi.fn(),
    },
    eventAudit: {
      findFirst: vi.fn(),
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
  assignOwnerTelegramBotConnection,
  buildOwnerChannelManagementSnapshot,
  disconnectOwnerMatrixChannel,
  evaluateChannelControlPlaneHealth,
  provisionOwnerMatrixChannel,
  provisionOwnerTelegramChannel,
  refreshOwnerChannelHealth,
  resolveRepresentativeMatrixEndpoint,
  resolveRepresentativeTelegramBotConnectionId,
  resolveRepresentativeTelegramBotEndpoint,
  setOwnerChannelDesiredState,
} from "../src/channel-management";
import { resolveChannelAvailability } from "../src/channel-availability";

const originalMatrixHomeserverUrl = process.env.MATRIX_HOMESERVER_URL;

describe("channel management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    mocks.tx.eventAudit.findFirst.mockResolvedValue(null);
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue(null);
    mocks.tx.matrixVirtualUserBinding.updateMany.mockResolvedValue({
      count: 1,
    });
    mocks.tx.representativeChannelBinding.updateMany.mockResolvedValue({
      count: 1,
    });
  });

  afterEach(() => {
    if (originalMatrixHomeserverUrl === undefined) {
      delete process.env.MATRIX_HOMESERVER_URL;
    } else {
      process.env.MATRIX_HOMESERVER_URL = originalMatrixHomeserverUrl;
    }
  });

  it("uses a cold-start Bot id only for an explicitly active and available legacy Telegram binding", async () => {
    const findFirst = vi.fn();
    const client = {
      representativeChannelBinding: { findFirst },
    };
    const env = { TELEGRAM_BOT_ID: "8718299151" };

    findFirst.mockResolvedValueOnce({
      connectionId: null,
      telegramBotConnectionId: null,
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      status: "CONNECTED",
      telegramBotConnection: null,
    });
    await expect(
      resolveRepresentativeTelegramBotConnectionId(
        "lin",
        env,
        client as never,
      ),
    ).resolves.toBe("8718299151");

    findFirst.mockResolvedValueOnce({
      connectionId: null,
      telegramBotConnectionId: null,
      desiredState: "PAUSED",
      healthStatus: "UNKNOWN",
      status: "CONNECTED",
      telegramBotConnection: null,
    });
    await expect(
      resolveRepresentativeTelegramBotConnectionId(
        "lin",
        env,
        client as never,
      ),
    ).resolves.toBeNull();

    findFirst.mockResolvedValueOnce(null);
    await expect(
      resolveRepresentativeTelegramBotConnectionId(
        "matrix-only",
        env,
        client as never,
      ),
    ).resolves.toBeNull();

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "TELEGRAM",
          representative: { slug: "lin" },
          AND: [
            {
              OR: [
                { transport: null },
                { transport: "TELEGRAM" },
              ],
            },
            {
              OR: [
                { sourceProvider: null },
                { sourceProvider: "TELEGRAM" },
              ],
            },
          ],
        }),
      }),
    );
  });

  it("returns the Bot id for an active managed Telegram connection", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      connectionId: "stale-public-id",
      telegramBotConnectionId: "telegram-connection-1",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      status: "CONFIGURED",
      telegramBotConnection: {
        botId: "8718299151",
        status: "ACTIVE",
        revokedAt: null,
        activeCredentialId: "credential-1",
      },
    });

    await expect(
      resolveRepresentativeTelegramBotConnectionId(
        "lin",
        {
          TELEGRAM_BOT_ID: "9999999999",
          TELEGRAM_BOT_TOKEN: "9999999999:legacy-token",
        },
        { representativeChannelBinding: { findFirst } } as never,
      ),
    ).resolves.toBe("8718299151");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          telegramBotConnectionId: true,
          telegramBotConnection: {
            select: {
              botId: true,
              username: true,
              status: true,
              revokedAt: true,
              activeCredentialId: true,
            },
          },
        }),
      }),
    );
  });

  it("returns the safe Bot endpoint needed by the public binding page", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      connectionId: "stale-public-id",
      telegramBotConnectionId: "telegram-connection-1",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      status: "CONFIGURED",
      telegramBotConnection: {
        botId: "8718299151",
        username: "delegate_test_bot",
        status: "ACTIVE",
        revokedAt: null,
        activeCredentialId: "credential-1",
      },
    });

    await expect(
      resolveRepresentativeTelegramBotEndpoint(
        "lin",
        {},
        { representativeChannelBinding: { findFirst } } as never,
      ),
    ).resolves.toEqual({
      botId: "8718299151",
      username: "delegate_test_bot",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          telegramBotConnection: {
            select: expect.objectContaining({
              botId: true,
              username: true,
            }),
          },
        }),
      }),
    );
  });

  it("returns the exact Matrix endpoint only when the representative binding and virtual user are routable", async () => {
    const findChannelBinding = vi.fn().mockResolvedValue({
      representativeId: "rep-lin",
      connectionId: "delegate-matrix-as",
      externalUserId: "@_delegate_rep_lin:MATRIX.EXAMPLE",
      desiredState: "ACTIVE",
      healthStatus: "DEGRADED",
      status: "CONFIGURED",
    });
    const findVirtualUser = vi.fn().mockResolvedValue({
      matrixUserId: "@_delegate_rep_lin:MATRIX.EXAMPLE",
      enabled: true,
    });

    await expect(
      resolveRepresentativeMatrixEndpoint(
        "lin",
        {
          MATRIX_HOMESERVER_URL: "https://matrix.example",
          MATRIX_SERVER_NAME: "MATRIX.EXAMPLE",
          MATRIX_AS_CONNECTION_ID: "Delegate-Matrix-AS",
        },
        {
          representativeChannelBinding: { findFirst: findChannelBinding },
          matrixVirtualUserBinding: { findFirst: findVirtualUser },
        } as never,
      ),
    ).resolves.toEqual({
      matrixUserId: "@_delegate_rep_lin:MATRIX.EXAMPLE",
      connectionId: "delegate-matrix-as",
    });
    expect(findChannelBinding).toHaveBeenCalledWith({
      where: {
        kind: "MATRIX",
        representative: { slug: "lin" },
        AND: [
          {
            OR: [
              { transport: null },
              { transport: "MATRIX" },
            ],
          },
          {
            OR: [
              { sourceProvider: null },
              { sourceProvider: "MATRIX" },
            ],
          },
        ],
      },
      select: {
        representativeId: true,
        connectionId: true,
        externalUserId: true,
        desiredState: true,
        healthStatus: true,
        status: true,
      },
    });
    expect(findVirtualUser).toHaveBeenCalledWith({
      where: {
        matrixUserId: "@_delegate_rep_lin:MATRIX.EXAMPLE",
        representativeId: "rep-lin",
        kind: "REPRESENTATIVE",
        enabled: true,
      },
      select: {
        matrixUserId: true,
        enabled: true,
      },
    });
  });

  it.each([
    {
      label: "paused",
      binding: { desiredState: "PAUSED" },
      virtualUser: { enabled: true },
    },
    {
      label: "legacy-disabled",
      binding: { status: "DISABLED" },
      virtualUser: { enabled: true },
    },
    {
      label: "unhealthy",
      binding: { healthStatus: "UNHEALTHY" },
      virtualUser: { enabled: true },
    },
    {
      label: "wrong-connection",
      binding: { connectionId: "other-as" },
      virtualUser: { enabled: true },
    },
    {
      label: "server-name-case-mismatch",
      binding: {
        externalUserId: "@_delegate_rep_lin:MATRIX.EXAMPLE",
      },
      virtualUser: {
        matrixUserId: "@_delegate_rep_lin:MATRIX.EXAMPLE",
        enabled: true,
      },
    },
    {
      label: "missing-virtual-user",
      binding: {},
      virtualUser: null,
    },
    {
      label: "disabled-virtual-user",
      binding: {},
      virtualUser: { enabled: false },
    },
  ])(
    "fails closed for a Matrix endpoint whose control-plane state is $label",
    async ({ binding: bindingOverride, virtualUser }) => {
      const findChannelBinding = vi.fn().mockResolvedValue({
        representativeId: "rep-lin",
        connectionId: "delegate-matrix-as",
        externalUserId: "@_delegate_rep_lin:matrix.example",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
        status: "CONFIGURED",
        ...bindingOverride,
      });
      const findVirtualUser = vi.fn().mockResolvedValue(
        virtualUser === null
          ? null
          : {
              matrixUserId: "@_delegate_rep_lin:matrix.example",
              ...virtualUser,
            },
      );

      await expect(
        resolveRepresentativeMatrixEndpoint(
          "lin",
          {
            MATRIX_HOMESERVER_URL: "https://matrix.example",
            MATRIX_SERVER_NAME: "matrix.example",
            MATRIX_AS_CONNECTION_ID: "delegate-matrix-as",
          },
          {
            representativeChannelBinding: { findFirst: findChannelBinding },
            matrixVirtualUserBinding: { findFirst: findVirtualUser },
          } as never,
        ),
      ).resolves.toBeNull();
    },
  );

  it("does not expose a Matrix endpoint from database state without a configured adapter", async () => {
    const findChannelBinding = vi.fn();
    const findVirtualUser = vi.fn();

    await expect(
      resolveRepresentativeMatrixEndpoint(
        "lin",
        {},
        {
          representativeChannelBinding: { findFirst: findChannelBinding },
          matrixVirtualUserBinding: { findFirst: findVirtualUser },
        } as never,
      ),
    ).resolves.toBeNull();
    expect(findChannelBinding).not.toHaveBeenCalled();
    expect(findVirtualUser).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "disabled",
      status: "DISABLED",
      revokedAt: null,
      activeCredentialId: "credential-1",
    },
    {
      label: "revoked",
      status: "ACTIVE",
      revokedAt: new Date("2026-07-27T00:00:00.000Z"),
      activeCredentialId: "credential-1",
    },
    {
      label: "without an active credential",
      status: "ACTIVE",
      revokedAt: null,
      activeCredentialId: null,
    },
  ])(
    "fails closed for a managed Telegram connection that is $label",
    async ({ status, revokedAt, activeCredentialId }) => {
      const findFirst = vi.fn().mockResolvedValue({
        connectionId: "8718299151",
        telegramBotConnectionId: "telegram-connection-1",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
        status: "CONFIGURED",
        telegramBotConnection: {
          botId: "8718299151",
          status,
          revokedAt,
          activeCredentialId,
        },
      });

      await expect(
        resolveRepresentativeTelegramBotConnectionId(
          "lin",
          {
            TELEGRAM_BOT_ID: "9999999999",
            TELEGRAM_BOT_TOKEN: "9999999999:legacy-token",
          },
          { representativeChannelBinding: { findFirst } } as never,
        ),
      ).resolves.toBeNull();
    },
  );

  it("does not fall back to env when a managed Telegram binding is unavailable", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      desiredState: "ACTIVE",
      healthStatus: "UNHEALTHY",
      status: "CONFIGURED",
      telegramBotConnection: {
        botId: "8718299151",
        status: "ACTIVE",
        revokedAt: null,
        activeCredentialId: "credential-1",
      },
    });

    await expect(
      resolveRepresentativeTelegramBotConnectionId(
        "lin",
        {
          TELEGRAM_BOT_ID: "9999999999",
          TELEGRAM_BOT_TOKEN: "9999999999:legacy-token",
        },
        { representativeChannelBinding: { findFirst } } as never,
      ),
    ).resolves.toBeNull();
  });

  it("keeps a legacy binding's persisted Bot id ahead of env fallback", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      connectionId: "8718299151",
      telegramBotConnectionId: null,
      desiredState: "ACTIVE",
      healthStatus: "DEGRADED",
      status: "CONNECTED",
      telegramBotConnection: null,
    });

    await expect(
      resolveRepresentativeTelegramBotConnectionId(
        "lin",
        {
          TELEGRAM_BOT_ID: "9999999999",
          TELEGRAM_BOT_TOKEN: "9999999999:legacy-token",
        },
        { representativeChannelBinding: { findFirst } } as never,
      ),
    ).resolves.toBe("8718299151");
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

  it("exposes safe Matrix configuration and channel connection ids without credentials", () => {
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    const previousHomeserverUrl = process.env.MATRIX_HOMESERVER_URL;
    const previousConnectionId = process.env.MATRIX_AS_CONNECTION_ID;
    const previousAsToken = process.env.MATRIX_AS_TOKEN;
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_AS_CONNECTION_ID = "Delegate-Matrix-AS";
    process.env.MATRIX_AS_TOKEN = "matrix-secret-that-must-not-leak";

    try {
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
                id: "binding-matrix",
                connectionId: "delegate-matrix-as",
                kind: "MATRIX",
                transport: "MATRIX",
                sourceProvider: "MATRIX",
                desiredState: "ACTIVE",
                healthStatus: "HEALTHY",
                externalUserId: "@_delegate_rep_lin:matrix.example.org",
                status: "CONFIGURED",
                displayName: "Lin",
                lastHealthCheckAt: null,
                lastError: null,
              },
            ],
          },
        ],
        ingressEvents: [],
        egressEvents: [],
        generatedAt: new Date("2026-07-29T01:00:00.000Z"),
        dataSource: "database",
      });

      expect(snapshot.matrixConfiguration).toEqual({
        available: true,
        serverName: "matrix.example.org",
        connectionId: "delegate-matrix-as",
        managedUserPrefix: "_delegate_rep_",
      });
      expect(
        snapshot.representatives[0]?.channels.find(
          (channel) => channel.kind === "MATRIX",
        )?.connectionId,
      ).toBe("delegate-matrix-as");
      expect(JSON.stringify(snapshot)).not.toContain(
        "matrix-secret-that-must-not-leak",
      );

      delete process.env.MATRIX_HOMESERVER_URL;
      const unavailableSnapshot = buildOwnerChannelManagementSnapshot({
        representatives: [],
        ingressEvents: [],
        egressEvents: [],
        generatedAt: new Date("2026-07-29T01:01:00.000Z"),
        dataSource: "database",
      });
      expect(unavailableSnapshot.matrixConfiguration).toMatchObject({
        available: false,
        serverName: "matrix.example.org",
        connectionId: "delegate-matrix-as",
      });
    } finally {
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
      if (previousHomeserverUrl === undefined) {
        delete process.env.MATRIX_HOMESERVER_URL;
      } else {
        process.env.MATRIX_HOMESERVER_URL = previousHomeserverUrl;
      }
      if (previousConnectionId === undefined) {
        delete process.env.MATRIX_AS_CONNECTION_ID;
      } else {
        process.env.MATRIX_AS_CONNECTION_ID = previousConnectionId;
      }
      if (previousAsToken === undefined) delete process.env.MATRIX_AS_TOKEN;
      else process.env.MATRIX_AS_TOKEN = previousAsToken;
    }
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

  it("does not let a database-only refresh erase Matrix bridge runtime evidence", () => {
    expect(
      evaluateChannelControlPlaneHealth({
        kind: "MATRIX",
        transport: "MATRIX",
        sourceProvider: "MATRIX",
        externalUserId: "@_delegate_rep_lin:matrix.example.org",
        legacyStatus: "CONFIGURED",
        currentHealthStatus: "DEGRADED",
        currentLastError: "matrix_join_502",
        latestFailure: null,
      }),
    ).toEqual({
      healthStatus: "DEGRADED",
      lastError: "matrix_join_502",
    });
  });

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
      connectionId: "delegate-matrix-as",
      telegramBotConnectionId: null,
      endpointAssignmentRevision: 1,
      desiredState: "ACTIVE",
      healthStatus: "UNHEALTHY",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "CONNECTED",
      lastError: "Matrix delivery failed.",
    });
    mocks.tx.channelEventInbox.findFirst.mockResolvedValue(null);
    mocks.tx.outboxEvent.findFirst.mockResolvedValue(null);
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
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.tx.channelEventInbox.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceProvider: "MATRIX",
          connectionId: "delegate-matrix-as",
          createdAt: { gte: failureCutoff },
          status: { in: ["FAILED", "DEAD_LETTER"] },
          conversation: {
            representativeId: "rep-1",
            channelBindings: {
              some: {
                kind: "MATRIX",
                representativeBindingId: "binding-matrix-1",
                representativeAssignmentRevision: 1,
              },
            },
          },
        }),
      }),
    );
    expect(mocks.tx.outboxEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceProvider: "MATRIX",
          connectionId: "delegate-matrix-as",
          createdAt: { gte: failureCutoff },
          status: { in: ["FAILED", "DEAD_LETTER"] },
          conversation: {
            representativeId: "rep-1",
            channelBindings: {
              some: {
                kind: "MATRIX",
                representativeBindingId: "binding-matrix-1",
                representativeAssignmentRevision: 1,
              },
            },
          },
        }),
      }),
    );
    expect(
      mocks.tx.representativeChannelBinding.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: "binding-matrix-1",
        connectionId: "delegate-matrix-as",
        telegramBotConnectionId: null,
        endpointAssignmentRevision: 1,
        desiredState: "ACTIVE",
        healthStatus: "UNHEALTHY",
        status: "CONNECTED",
        lastError: "Matrix delivery failed.",
      },
      data: {
        healthStatus: "HEALTHY",
        lastHealthCheckAt: now,
        lastError: null,
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

  it("rejects a health result when the channel identity changed mid-refresh", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue({
      id: "binding-telegram-health-cas",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "1234567890",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      externalUserId: "@delegate_bot",
      status: "CONFIGURED",
      lastError: null,
    });
    mocks.tx.channelEventInbox.findFirst.mockResolvedValue(null);
    mocks.tx.outboxEvent.findFirst.mockResolvedValue(null);
    mocks.tx.representativeChannelBinding.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    try {
      await expect(
        refreshOwnerChannelHealth({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-telegram-health-cas",
          requestId: "request-health-stale",
          idempotencyKey: "idem-health-stale",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Channel binding changed while its health was being refreshed.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
    expect(mocks.tx.channelEventInbox.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceProvider: "TELEGRAM",
          connectionId: "1234567890",
          conversation: {
            representativeId: "rep-1",
            channelBindings: {
              some: {
                kind: "TELEGRAM",
                representativeBindingId:
                  "binding-telegram-health-cas",
                representativeAssignmentRevision: 1,
              },
            },
          },
        }),
      }),
    );
    expect(mocks.tx.outboxEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceProvider: "TELEGRAM",
          connectionId: "1234567890",
          conversation: {
            representativeId: "rep-1",
            channelBindings: {
              some: {
                kind: "TELEGRAM",
                representativeBindingId:
                  "binding-telegram-health-cas",
                representativeAssignmentRevision: 1,
              },
            },
          },
        }),
      }),
    );
  });

  it("does not let a manual refresh mark a disabled managed Telegram Bot healthy", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const now = new Date("2026-07-24T13:00:00.000Z");
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue({
      id: "binding-telegram-disabled",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "1234567890",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "ACTIVE",
      healthStatus: "UNHEALTHY",
      externalUserId: "@delegate_bot",
      status: "CONFIGURED",
      lastError: "Telegram Bot connection is disabled.",
      telegramBotConnection: {
        id: "telegram-connection-1",
        status: "DISABLED",
        revokedAt: null,
        activeCredentialId: "credential-1",
        credentialRevision: 1,
        activeCredential: {
          id: "credential-1",
          version: 1,
          status: "ACTIVE",
        },
      },
    });
    mocks.tx.channelEventInbox.findFirst.mockResolvedValue(null);
    mocks.tx.outboxEvent.findFirst.mockResolvedValue(null);
    mocks.tx.eventAudit.create.mockResolvedValue({
      id: "audit-telegram-disabled-health",
    });

    try {
      await expect(
        refreshOwnerChannelHealth({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-telegram-disabled",
          requestId: "request-telegram-disabled-health",
          idempotencyKey: "idem-telegram-disabled-health",
          now,
        }),
      ).resolves.toMatchObject({
        healthStatus: "UNHEALTHY",
        lastError: "Managed Telegram Bot connection is disabled.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(
      mocks.tx.representativeChannelBinding.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          healthStatus: "UNHEALTHY",
          lastHealthCheckAt: now,
          lastError: "Managed Telegram Bot connection is disabled.",
        },
      }),
    );
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
      connectionId: "1234567890",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "ACTIVE",
      status: "CONFIGURED",
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
        expectedCurrentEndpointAssignmentRevision: 1,
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
          after: {
            desiredState: "PAUSED",
            endpointAssignmentRevision: 1,
          },
        }),
      }),
    });
    expect(mocks.tx.$executeRaw.mock.calls[0]?.[1]).toBe(
      "telegram-bot-channel:rep-1",
    );
  });

  it("rejects stale pause or resume requests after a Matrix disconnect", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue({
      id: "binding-matrix-disconnected",
      representativeId: "rep-1",
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      connectionId: "delegate-matrix-as",
      telegramBotConnectionId: null,
      endpointAssignmentRevision: 2,
      desiredState: "DISCONNECTED",
      status: "DISCONNECTED",
    });

    try {
      await expect(
        setOwnerChannelDesiredState({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-matrix-disconnected",
          desiredState: "ACTIVE",
          expectedCurrentEndpointAssignmentRevision: 2,
          requestId: "request-stale-resume",
          idempotencyKey: "idem-stale-resume",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Disconnected channels must be reconnected before they can be paused or resumed.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.$executeRaw.mock.calls[0]?.[1]).toBe(
      "matrix-virtual-user:rep-1",
    );
    expect(mocks.tx.representativeChannelBinding.update).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("uses a connection-aware CAS even for no-op channel state requests", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue({
      id: "binding-telegram-cas",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "1234567890",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 2,
      desiredState: "ACTIVE",
      status: "CONFIGURED",
    });
    try {
      await expect(
        setOwnerChannelDesiredState({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-telegram-cas",
          desiredState: "ACTIVE",
          expectedCurrentEndpointAssignmentRevision: 1,
          requestId: "request-stale-noop",
          idempotencyKey: "idem-stale-noop",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Channel binding changed since it was loaded.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(
      mocks.tx.representativeChannelBinding.updateMany,
    ).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("replays the same channel state request once and rejects a reused key with another state", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    const binding = {
      id: "binding-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "1234567890",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 3,
      desiredState: "PAUSED",
      status: "CONFIGURED",
    };
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue(binding);
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      payload: {
        action: "CHANNEL_DESIRED_STATE_CHANGED",
        bindingId: "binding-1",
        idempotencyKey: "idem-state",
        desiredState: "PAUSED",
        expectedCurrentEndpointAssignmentRevision: 3,
        endpointAssignmentRevision: 3,
      },
    });

    try {
      await expect(
        setOwnerChannelDesiredState({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-1",
          desiredState: "PAUSED",
          expectedCurrentEndpointAssignmentRevision: 3,
          requestId: "request-replay",
          idempotencyKey: "idem-state",
        }),
      ).resolves.toEqual(binding);
      await expect(
        setOwnerChannelDesiredState({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-1",
          desiredState: "ACTIVE",
          expectedCurrentEndpointAssignmentRevision: 3,
          requestId: "request-conflict",
          idempotencyKey: "idem-state",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Idempotency key was already used for a different channel request on this binding.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.update).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a paused binding on an idempotent Telegram Bot assignment replay", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "8718299151" })
      .mockResolvedValueOnce({
        id: "telegram-connection-1",
        botId: "8718299151",
        username: "delegate_test_bot",
        displayName: "Delegate",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "PAUSED",
      healthStatus: "DEGRADED",
      externalUserId: "@delegate_test_bot",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      payload: {
        action: "REPRESENTATIVE_TELEGRAM_BOT_ASSIGNED",
        bindingId: "binding-telegram-1",
        telegramBotConnectionId: "telegram-connection-1",
        idempotencyKey: "assignment-replay",
        after: {
          telegramBotConnectionId: "telegram-connection-1",
          connectionId: "8718299151",
          desiredState: "PAUSED",
          endpointAssignmentRevision: 1,
        },
      },
    });

    try {
      await expect(
        assignOwnerTelegramBotConnection({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          telegramBotConnectionId: "telegram-connection-1",
          requestId: "request-assignment-replay",
          idempotencyKey: "assignment-replay",
        }),
      ).resolves.toMatchObject({
        binding: {
          id: "binding-telegram-1",
          desiredState: "PAUSED",
          healthStatus: "DEGRADED",
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.tx.eventAudit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          representativeId: "rep-1",
          type: "CHANNEL_CONFIGURATION_CHANGED",
        }),
      }),
    );
  });

  it("rejects a Telegram assignment replay after the channel desired state changed", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "8718299151" })
      .mockResolvedValueOnce({
        id: "telegram-connection-1",
        botId: "8718299151",
        username: "delegate_test_bot",
        displayName: "Delegate",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "PAUSED",
      healthStatus: "DEGRADED",
      externalUserId: "@delegate_test_bot",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      payload: {
        action: "REPRESENTATIVE_TELEGRAM_BOT_ASSIGNED",
        bindingId: "binding-telegram-1",
        telegramBotConnectionId: "telegram-connection-1",
        idempotencyKey: "assignment-replay-before-pause",
        after: {
          telegramBotConnectionId: "telegram-connection-1",
          connectionId: "8718299151",
          desiredState: "ACTIVE",
          endpointAssignmentRevision: 1,
        },
      },
    });

    try {
      await expect(
        assignOwnerTelegramBotConnection({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          telegramBotConnectionId: "telegram-connection-1",
          requestId: "request-assignment-replay-before-pause",
          idempotencyKey: "assignment-replay-before-pause",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Telegram channel binding changed after the idempotent assignment completed.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("rejects a Telegram assignment key reused for another Bot", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "2222222222" })
      .mockResolvedValueOnce({
        id: "telegram-connection-2",
        botId: "2222222222",
        username: "delegate_second_bot",
        displayName: "Delegate Two",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_test_bot",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      payload: {
        action: "REPRESENTATIVE_TELEGRAM_BOT_ASSIGNED",
        bindingId: "binding-telegram-1",
        telegramBotConnectionId: "telegram-connection-1",
        idempotencyKey: "assignment-reused",
      },
    });

    try {
      await expect(
        assignOwnerTelegramBotConnection({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          telegramBotConnectionId: "telegram-connection-2",
          requestId: "request-assignment-reused",
          idempotencyKey: "assignment-reused",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Idempotency key was already used for a different Telegram Bot assignment on this representative.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("rejects an old Telegram assignment replay after the representative switched Bots", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "8718299151" })
      .mockResolvedValueOnce({
        id: "telegram-connection-1",
        botId: "8718299151",
        username: "delegate_first_bot",
        displayName: "Delegate One",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "2222222222",
      telegramBotConnectionId: "telegram-connection-2",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "2222222222",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      payload: {
        action: "REPRESENTATIVE_TELEGRAM_BOT_ASSIGNED",
        bindingId: "binding-telegram-1",
        telegramBotConnectionId: "telegram-connection-1",
        idempotencyKey: "assignment-old-bot-replay",
      },
    });

    try {
      await expect(
        assignOwnerTelegramBotConnection({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          telegramBotConnectionId: "telegram-connection-1",
          requestId: "request-old-bot-replay",
          idempotencyKey: "assignment-old-bot-replay",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Telegram channel binding changed after the idempotent assignment completed.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("keeps a paused binding paused when the same Bot is assigned with a new request", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    const existingBinding = {
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "PAUSED",
      healthStatus: "DEGRADED",
      externalUserId: "@delegate_test_bot",
      status: "CONFIGURED",
    };
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "8718299151" })
      .mockResolvedValueOnce({
        id: "telegram-connection-1",
        botId: "8718299151",
        username: "delegate_test_bot",
        displayName: "Delegate",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue(
      existingBinding,
    );
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue(
      existingBinding,
    );
    mocks.tx.eventAudit.create.mockResolvedValue({
      id: "audit-assignment-noop",
    });

    try {
      await expect(
        assignOwnerTelegramBotConnection({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          telegramBotConnectionId: "telegram-connection-1",
          requestId: "request-assignment-noop",
          idempotencyKey: "assignment-noop",
        }),
      ).resolves.toMatchObject({
        binding: {
          desiredState: "PAUSED",
          healthStatus: "DEGRADED",
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "CHANNEL_CONFIGURATION_CHANGED",
        payload: expect.objectContaining({
          action: "REPRESENTATIVE_TELEGRAM_BOT_ASSIGNED",
          changed: false,
          before: expect.objectContaining({
            desiredState: "PAUSED",
          }),
          after: expect.objectContaining({
            desiredState: "PAUSED",
          }),
        }),
      }),
    });
  });

  it("keeps a paused binding paused when atomically switching to another Bot", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    const existingBinding = {
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "PAUSED",
      healthStatus: "DEGRADED",
      externalUserId: "@delegate_first_bot",
      status: "CONFIGURED",
    };
    const switchedBinding = {
      ...existingBinding,
      connectionId: "2222222222",
      telegramBotConnectionId: "telegram-connection-2",
      endpointAssignmentRevision: 2,
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_second_bot",
    };
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "2222222222" })
      .mockResolvedValueOnce({
        id: "telegram-connection-2",
        botId: "2222222222",
        username: "delegate_second_bot",
        displayName: "Delegate Two",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue(
      existingBinding,
    );
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue(
      switchedBinding,
    );
    mocks.tx.eventAudit.create.mockResolvedValue({ id: "audit-switch" });

    try {
      await expect(
        assignOwnerTelegramBotConnection({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          telegramBotConnectionId: "telegram-connection-2",
          expectedCurrentTelegramBotConnectionId: "telegram-connection-1",
          requestId: "request-assignment-switch",
          idempotencyKey: "assignment-switch",
        }),
      ).resolves.toMatchObject({
        binding: {
          telegramBotConnectionId: "telegram-connection-2",
          endpointAssignmentRevision: 2,
          desiredState: "PAUSED",
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          telegramBotConnectionId: "telegram-connection-2",
          endpointAssignmentRevision: { increment: 1 },
          desiredState: "PAUSED",
        }),
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          expectedCurrentTelegramBotConnectionIdWasProvided: true,
          expectedCurrentTelegramBotConnectionId: "telegram-connection-1",
          before: expect.objectContaining({
            telegramBotConnectionId: "telegram-connection-1",
            desiredState: "PAUSED",
          }),
          after: expect.objectContaining({
            telegramBotConnectionId: "telegram-connection-2",
            desiredState: "PAUSED",
            endpointAssignmentRevision: 2,
          }),
        }),
      }),
    });
  });

  it("rejects a stale Telegram Bot assignment CAS before mutating the binding", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "2222222222" })
      .mockResolvedValueOnce({
        id: "telegram-connection-2",
        botId: "2222222222",
        username: "delegate_second_bot",
        displayName: "Delegate Two",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_first_bot",
      status: "CONFIGURED",
    });

    try {
      await expect(
        assignOwnerTelegramBotConnection({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          telegramBotConnectionId: "telegram-connection-2",
          expectedCurrentTelegramBotConnectionId: "stale-connection",
          requestId: "request-assignment-stale",
          idempotencyKey: "assignment-stale",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Telegram channel binding changed since it was loaded.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("reactivates a disconnected Telegram binding when the same Bot is reassigned", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    const existingBinding = {
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      telegramBotConnectionId: "telegram-connection-1",
      endpointAssignmentRevision: 1,
      desiredState: "DISCONNECTED",
      healthStatus: "UNKNOWN",
      externalUserId: "@delegate_test_bot",
      status: "DISCONNECTED",
    };
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      displayName: "Lin",
    });
    mocks.tx.telegramBotConnection.findFirst
      .mockResolvedValueOnce({ botId: "8718299151" })
      .mockResolvedValueOnce({
        id: "telegram-connection-1",
        botId: "8718299151",
        username: "delegate_test_bot",
        displayName: "Delegate",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
      });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue(
      existingBinding,
    );
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      ...existingBinding,
      endpointAssignmentRevision: 2,
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      status: "CONFIGURED",
    });

    try {
      await assignOwnerTelegramBotConnection({
        ownerId: "owner-1",
        actorId: "owner-1",
        representativeId: "rep-1",
        telegramBotConnectionId: "telegram-connection-1",
        expectedCurrentTelegramBotConnectionId: "telegram-connection-1",
        requestId: "request-assignment-reconnect",
        idempotencyKey: "assignment-reconnect",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          desiredState: "ACTIVE",
          endpointAssignmentRevision: { increment: 1 },
          status: "CONFIGURED",
          lastHealthCheckAt: null,
          lastError: null,
        }),
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          changed: false,
          reconnected: true,
          after: expect.objectContaining({ desiredState: "ACTIVE" }),
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
      endpointAssignmentRevision: 1,
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
    expect(mocks.tx.representativeChannelBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          endpointAssignmentRevision: 1,
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
    expect(mocks.tx.$executeRaw.mock.calls[0]?.[1]).toBe(
      "matrix-virtual-user:rep-1",
    );
    expect(mocks.tx.$executeRaw.mock.calls[1]?.[1]).toBe(
      "matrix-virtual-user-id:@_delegate_rep_lin_founder:matrix.example.org",
    );
  });

  it("refuses Matrix identity writes when the Application Service route is incomplete", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    delete process.env.MATRIX_HOMESERVER_URL;

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          expectedCurrentMatrixUserId: null,
          requestId: "request-matrix-unavailable",
          idempotencyKey: "idem-matrix-unavailable",
        }),
      ).rejects.toMatchObject({
        statusCode: 503,
        message:
          "Matrix Application Service must be fully configured before managing representative identities.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not duplicate a Matrix provisioning audit when a request is replayed", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue({
      id: "matrix-user-1",
      matrixUserId: "@_delegate_rep_lin:matrix.example.org",
    });
    mocks.tx.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      id: "matrix-user-1",
      matrixUserId: "@_delegate_rep_lin:matrix.example.org",
      representativeId: "rep-1",
      kind: "REPRESENTATIVE",
      displayName: "Lin",
      enabled: true,
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 1,
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      id: "audit-matrix-existing",
      payload: {
        action: "MATRIX_VIRTUAL_USER_PROVISIONED",
        bindingId: "binding-matrix-1",
        matrixVirtualUserBindingId: "matrix-user-1",
        matrixUserId: "@_delegate_rep_lin:matrix.example.org",
        connectionId: "delegate-matrix-as",
        endpointAssignmentRevision: 1,
        idempotencyKey: "idem-matrix-replay",
        after: {
          matrixUserId: "@_delegate_rep_lin:matrix.example.org",
          connectionId: "delegate-matrix-as",
          endpointAssignmentRevision: 1,
          desiredState: "ACTIVE",
        },
      },
    });

    try {
      await provisionOwnerMatrixChannel({
        ownerId: "owner-1",
        actorId: "owner-1",
        representativeId: "rep-1",
        requestId: "request-matrix-replay",
        idempotencyKey: "idem-matrix-replay",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.eventAudit.findFirst).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        type: "CHANNEL_CONFIGURATION_CHANGED",
        payload: {
          path: ["idempotencyKey"],
          equals: "idem-matrix-replay",
        },
      },
      select: { payload: true },
    });
    expect(mocks.tx.matrixVirtualUserBinding.upsert).not.toHaveBeenCalled();
    expect(
      mocks.tx.representativeChannelBinding.upsert,
    ).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("does not reconnect a disconnected Matrix channel when its provisioning request is replayed", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue(null);
    mocks.tx.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      id: "matrix-user-1",
      matrixUserId: "@_delegate_rep_lin:matrix.example.org",
      representativeId: "rep-1",
      kind: "REPRESENTATIVE",
      displayName: "Lin",
      enabled: false,
    });
    mocks.tx.matrixVirtualUserBinding.upsert.mockResolvedValue({
      id: "matrix-user-1",
      matrixUserId: "@_delegate_rep_lin:matrix.example.org",
      displayName: "Lin",
      enabled: true,
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      desiredState: "DISCONNECTED",
      healthStatus: "UNKNOWN",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "DISCONNECTED",
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      id: "audit-matrix-existing",
      payload: {
        action: "MATRIX_VIRTUAL_USER_PROVISIONED",
        bindingId: "binding-matrix-1",
        matrixVirtualUserBindingId: "matrix-user-1",
        matrixUserId: "@_delegate_rep_lin:matrix.example.org",
        connectionId: "delegate-matrix-as",
        idempotencyKey: "idem-matrix-replay-after-disconnect",
      },
    });

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          requestId: "request-matrix-replay-after-disconnect",
          idempotencyKey: "idem-matrix-replay-after-disconnect",
        }),
      ).rejects.toMatchObject({
        name: "ChannelManagementError",
        statusCode: 409,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.upsert).not.toHaveBeenCalled();
    expect(
      mocks.tx.representativeChannelBinding.upsert,
    ).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("reactivates a disconnected Matrix channel without replacing its assignment", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue(null);
    mocks.tx.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      id: "matrix-user-1",
      representativeId: "rep-1",
      kind: "REPRESENTATIVE",
    });
    mocks.tx.matrixVirtualUserBinding.upsert.mockResolvedValue({
      id: "matrix-user-1",
      matrixUserId: "@_delegate_rep_lin:matrix.example.org",
      displayName: "Lin",
      enabled: true,
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 1,
      endpointLifecycleRevision: 4,
      desiredState: "DISCONNECTED",
      healthStatus: "UNKNOWN",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "DISCONNECTED",
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      endpointAssignmentRevision: 1,
      endpointLifecycleRevision: 5,
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "CONFIGURED",
    });

    try {
      await provisionOwnerMatrixChannel({
        ownerId: "owner-1",
        actorId: "owner-1",
        representativeId: "rep-1",
        requestId: "request-matrix-reconnect",
        idempotencyKey: "idem-matrix-reconnect",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ enabled: true }),
      }),
    );
    const update = mocks.tx.representativeChannelBinding.upsert.mock.calls[0]?.[0]
      .update;
    expect(update).toEqual(expect.objectContaining({
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      status: "CONFIGURED",
      lastHealthCheckAt: null,
      lastError: null,
    }));
    expect(update).not.toHaveProperty("endpointAssignmentRevision");
    expect(update).toEqual(expect.objectContaining({
      endpointLifecycleRevision: { increment: 1 },
    }));
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          endpointLifecycleRevision: 5,
          before: expect.objectContaining({
            endpointAssignmentRevision: 1,
            endpointLifecycleRevision: 4,
            desiredState: "DISCONNECTED",
          }),
          after: expect.objectContaining({
            endpointAssignmentRevision: 1,
            endpointLifecycleRevision: 5,
            desiredState: "ACTIVE",
          }),
        }),
      }),
    });
  });

  it("atomically replaces a paused Matrix identity while preserving history and pause state", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    const oldMatrixUserId = "@_delegate_rep_lin:matrix.example.org";
    const newMatrixUserId = "@_delegate_rep_support:matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 1,
      desiredState: "PAUSED",
      healthStatus: "DEGRADED",
      externalUserId: oldMatrixUserId,
      status: "CONFIGURED",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue({
      matrixUserId: oldMatrixUserId,
      ownerId: "owner-1",
    });
    mocks.tx.matrixVirtualUserBinding.findUnique.mockResolvedValue(null);
    mocks.tx.matrixVirtualUserBinding.upsert.mockResolvedValue({
      id: "matrix-user-new",
      matrixUserId: newMatrixUserId,
      displayName: "Lin",
      enabled: true,
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 2,
      desiredState: "PAUSED",
      healthStatus: "UNKNOWN",
      externalUserId: newMatrixUserId,
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.create.mockResolvedValue({ id: "audit-replace" });

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          matrixUserId: newMatrixUserId,
          replaceExisting: true,
          expectedCurrentMatrixUserId: oldMatrixUserId,
          requestId: "request-matrix-replace",
          idempotencyKey: "idem-matrix-replace",
        }),
      ).resolves.toMatchObject({
        binding: {
          id: "binding-matrix-1",
          desiredState: "PAUSED",
          externalUserId: newMatrixUserId,
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matrixUserId: newMatrixUserId },
        create: expect.objectContaining({
          matrixUserId: newMatrixUserId,
          ownerId: "owner-1",
          representativeId: "rep-1",
          enabled: true,
        }),
      }),
    );
    expect(mocks.tx.matrixVirtualUserBinding.updateMany).toHaveBeenCalledWith({
      where: {
        matrixUserId: oldMatrixUserId,
        representativeId: "rep-1",
        kind: "REPRESENTATIVE",
        enabled: true,
        OR: [
          { ownerId: "owner-1" },
          { ownerId: null },
        ],
      },
      data: { enabled: false },
    });
    expect(
      mocks.tx.matrixVirtualUserBinding.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.tx.matrixVirtualUserBinding.upsert.mock.invocationCallOrder[0]!,
    );
    expect(mocks.tx.representativeChannelBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          representativeId_kind: {
            representativeId: "rep-1",
            kind: "MATRIX",
          },
        },
        update: expect.objectContaining({
          externalUserId: newMatrixUserId,
          endpointAssignmentRevision: { increment: 1 },
          desiredState: "PAUSED",
          healthStatus: "UNKNOWN",
          lastHealthCheckAt: null,
          lastError: null,
        }),
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          action: "MATRIX_VIRTUAL_USER_REPLACED",
          replaceExisting: true,
          before: expect.objectContaining({
            matrixUserId: oldMatrixUserId,
            desiredState: "PAUSED",
          }),
          after: expect.objectContaining({
            matrixUserId: newMatrixUserId,
            endpointAssignmentRevision: 2,
            desiredState: "PAUSED",
          }),
        }),
      }),
    });
  });

  it("replays an identical paused Matrix replacement without mutating history again", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    const oldMatrixUserId = "@_delegate_rep_lin:matrix.example.org";
    const newMatrixUserId = "@_delegate_rep_support:matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 2,
      desiredState: "PAUSED",
      healthStatus: "UNKNOWN",
      externalUserId: newMatrixUserId,
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      payload: {
        action: "MATRIX_VIRTUAL_USER_REPLACED",
        bindingId: "binding-matrix-1",
        matrixVirtualUserBindingId: "matrix-user-new",
        matrixUserId: newMatrixUserId,
        connectionId: "delegate-matrix-as",
        endpointAssignmentRevision: 2,
        requestedMatrixUserIdWasProvided: true,
        requestedMatrixUserId: newMatrixUserId,
        replaceExisting: true,
        expectedCurrentMatrixUserIdWasProvided: true,
        before: {
          matrixUserId: oldMatrixUserId,
        },
        after: {
          matrixUserId: newMatrixUserId,
          connectionId: "delegate-matrix-as",
          endpointAssignmentRevision: 2,
          desiredState: "PAUSED",
        },
      },
    });
    mocks.tx.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      id: "matrix-user-new",
      matrixUserId: newMatrixUserId,
      representativeId: "rep-1",
      ownerId: "owner-1",
      kind: "REPRESENTATIVE",
      displayName: "Lin",
      enabled: true,
    });

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          matrixUserId: newMatrixUserId,
          replaceExisting: true,
          expectedCurrentMatrixUserId: oldMatrixUserId,
          requestId: "request-matrix-replace-replay",
          idempotencyKey: "idem-matrix-replace",
        }),
      ).resolves.toMatchObject({
        binding: {
          desiredState: "PAUSED",
          externalUserId: newMatrixUserId,
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.matrixVirtualUserBinding.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("rejects a Matrix provisioning replay after the channel desired state changed", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    const matrixUserId = "@_delegate_rep_lin:matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 1,
      desiredState: "PAUSED",
      healthStatus: "UNKNOWN",
      externalUserId: matrixUserId,
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      payload: {
        action: "MATRIX_VIRTUAL_USER_PROVISIONED",
        bindingId: "binding-matrix-1",
        matrixVirtualUserBindingId: "matrix-user-1",
        matrixUserId,
        connectionId: "delegate-matrix-as",
        endpointAssignmentRevision: 1,
        idempotencyKey: "idem-matrix-replay-before-pause",
        after: {
          matrixUserId,
          connectionId: "delegate-matrix-as",
          endpointAssignmentRevision: 1,
          desiredState: "ACTIVE",
        },
      },
    });

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          requestId: "request-matrix-replay-before-pause",
          idempotencyKey: "idem-matrix-replay-before-pause",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Idempotency key was already used for a different Matrix channel request on this representative.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.findUnique).not.toHaveBeenCalled();
    expect(
      mocks.tx.representativeChannelBinding.upsert,
    ).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("rejects a stale Matrix identity CAS before enabling or replacing users", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      connectionId: "delegate-matrix-as",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@_delegate_rep_current:matrix.example.org",
      status: "CONFIGURED",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue({
      matrixUserId: "@_delegate_rep_current:matrix.example.org",
      ownerId: "owner-1",
    });

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          matrixUserId: "@_delegate_rep_next:matrix.example.org",
          replaceExisting: true,
          expectedCurrentMatrixUserId:
            "@_delegate_rep_stale:matrix.example.org",
          requestId: "request-matrix-stale",
          idempotencyKey: "idem-matrix-stale",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Matrix channel binding changed since it was loaded.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.matrixVirtualUserBinding.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("rejects Matrix identities outside the configured managed namespace", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          matrixUserId: "@alice:matrix.example.org",
          requestId: "request-matrix-namespace",
          idempotencyKey: "idem-matrix-namespace",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          matrixUserId: "@_delegate_rep_lin:other.example.org",
          requestId: "request-matrix-server",
          idempotencyKey: "idem-matrix-server",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a managed Matrix identity owned by another workspace", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "matrix.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue(null);
    mocks.tx.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      id: "matrix-user-other",
      matrixUserId: "@_delegate_rep_support:matrix.example.org",
      representativeId: "rep-other",
      ownerId: "owner-other",
      kind: "REPRESENTATIVE",
    });

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          matrixUserId: "@_delegate_rep_support:matrix.example.org",
          expectedCurrentMatrixUserId: null,
          requestId: "request-matrix-collision",
          idempotencyKey: "idem-matrix-collision",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Managed Matrix user is already assigned to another principal.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
  });

  it("requires an explicit disconnect before moving a managed Matrix identity to another homeserver", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousServerName = process.env.MATRIX_SERVER_NAME;
    process.env.DATABASE_URL = "postgresql://test";
    process.env.MATRIX_SERVER_NAME = "new.example.org";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "lin",
      displayName: "Lin",
    });
    mocks.tx.matrixVirtualUserBinding.findFirst.mockResolvedValue({
      id: "matrix-user-1",
      matrixUserId: "@_delegate_rep_lin:old.example.org",
    });

    try {
      await expect(
        provisionOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          requestId: "request-matrix-migrate",
          idempotencyKey: "idem-matrix-migrate",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousServerName === undefined) delete process.env.MATRIX_SERVER_NAME;
      else process.env.MATRIX_SERVER_NAME = previousServerName;
    }

    expect(mocks.tx.matrixVirtualUserBinding.upsert).not.toHaveBeenCalled();
  });

  it("disconnects only the owner's Matrix channel and disables its virtual user", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representativeChannelBinding.findFirst.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 1,
      endpointLifecycleRevision: 5,
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "CONNECTED",
    });
    mocks.tx.representativeChannelBinding.update.mockResolvedValue({
      id: "binding-matrix-1",
      representativeId: "rep-1",
      kind: "MATRIX",
      transport: "MATRIX",
      sourceProvider: "MATRIX",
      connectionId: "delegate-matrix-as",
      endpointAssignmentRevision: 1,
      endpointLifecycleRevision: 6,
      desiredState: "DISCONNECTED",
      healthStatus: "UNKNOWN",
      externalUserId: "@_delegate_rep_lin:matrix.example.org",
      status: "DISCONNECTED",
    });

    try {
      await expect(
        disconnectOwnerMatrixChannel({
          ownerId: "owner-1",
          actorId: "owner-1",
          bindingId: "binding-matrix-1",
          expectedCurrentEndpointAssignmentRevision: 1,
          requestId: "request-matrix-disconnect",
          idempotencyKey: "idem-matrix-disconnect",
        }),
      ).resolves.toMatchObject({
        binding: {
          endpointLifecycleRevision: 6,
          desiredState: "DISCONNECTED",
          status: "DISCONNECTED",
        },
        changed: true,
        replayed: false,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(
      mocks.tx.representativeChannelBinding.findFirst,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "binding-matrix-1",
          kind: "MATRIX",
          representative: { ownerId: "owner-1" },
        },
      }),
    );
    expect(mocks.tx.matrixVirtualUserBinding.updateMany).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        kind: "REPRESENTATIVE",
        enabled: true,
      },
      data: { enabled: false },
    });
    expect(mocks.tx.representativeChannelBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          desiredState: "DISCONNECTED",
          endpointLifecycleRevision: { increment: 1 },
        }),
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        payload: expect.objectContaining({
          action: "MATRIX_CHANNEL_DISCONNECTED",
          endpointLifecycleRevision: 6,
          before: expect.objectContaining({
            endpointLifecycleRevision: 5,
          }),
          after: expect.objectContaining({
            endpointLifecycleRevision: 6,
          }),
          changed: true,
        }),
      }),
    });
    expect(mocks.tx.$executeRaw.mock.calls[0]?.[1]).toBe(
      "matrix-virtual-user:rep-1",
    );
  });

  it("owner-scopes and provisions the configured managed Telegram Bot for a representative", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "sktone",
      displayName: "SKTone",
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "",
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      externalUserId: "@delegate_bot",
      status: "CONFIGURED",
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      desiredState: "ACTIVE",
      healthStatus: "UNKNOWN",
      externalUserId: "@delegate_bot",
      status: "CONFIGURED",
    });
    mocks.tx.eventAudit.create.mockResolvedValue({ id: "audit-telegram-1" });

    try {
      await expect(
        provisionOwnerTelegramChannel(
          {
            ownerId: "owner-1",
            actorId: "owner-1",
            representativeId: "rep-1",
            requestId: "request-telegram-1",
            idempotencyKey: "idem-telegram-1",
          },
          {
            TELEGRAM_BOT_ID: "8718299151",
            TELEGRAM_BOT_USERNAME: "delegate_bot",
          },
        ),
      ).resolves.toMatchObject({
        binding: {
          id: "binding-telegram-1",
          externalUserId: "@delegate_bot",
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
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
    expect(mocks.tx.representativeChannelBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          representativeId_kind: {
            representativeId: "rep-1",
            kind: "TELEGRAM",
          },
        },
        create: expect.objectContaining({
          representativeId: "rep-1",
          kind: "TELEGRAM",
          transport: "TELEGRAM",
          sourceProvider: "TELEGRAM",
          connectionId: "8718299151",
          externalUserId: "@delegate_bot",
          desiredState: "ACTIVE",
          healthStatus: "UNKNOWN",
          status: "CONFIGURED",
        }),
        update: {},
      }),
    );
    expect(
      mocks.tx.representativeChannelBinding.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "binding-telegram-1",
        }),
        data: expect.not.objectContaining({
          desiredState: expect.anything(),
          healthStatus: expect.anything(),
          status: expect.anything(),
        }),
      }),
    );
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        payload: expect.objectContaining({
          action: "TELEGRAM_BOT_CHANNEL_PROVISIONED",
          connectionId: "8718299151",
          externalUserId: "@delegate_bot",
        }),
      }),
    });
  });

  it("fails closed when no numeric Telegram Bot id is available for provisioning", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";

    try {
      await expect(
        provisionOwnerTelegramChannel(
          {
            ownerId: "owner-1",
            actorId: "owner-1",
            representativeId: "rep-1",
            requestId: "request-telegram-2",
            idempotencyKey: "idem-telegram-2",
          },
          {},
        ),
      ).rejects.toMatchObject({
        name: "ChannelManagementError",
        statusCode: 503,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when the Telegram Bot id and token prefix disagree", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";

    try {
      await expect(
        provisionOwnerTelegramChannel(
          {
            ownerId: "owner-1",
            actorId: "owner-1",
            representativeId: "rep-1",
            requestId: "request-telegram-mismatch",
            idempotencyKey: "idem-telegram-mismatch",
          },
          {
            TELEGRAM_BOT_ID: "8718299151",
            TELEGRAM_BOT_TOKEN: "9999999999:test-only-token",
          },
        ),
      ).rejects.toMatchObject({
        name: "ChannelManagementError",
        statusCode: 503,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("preserves a compatible Telegram binding's paused and healthy state", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "sktone",
      displayName: "SKTone",
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      desiredState: "PAUSED",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_bot",
      status: "CONNECTED",
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      desiredState: "PAUSED",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_bot",
      status: "CONNECTED",
    });

    try {
      await expect(
        provisionOwnerTelegramChannel(
          {
            ownerId: "owner-1",
            actorId: "owner-1",
            representativeId: "rep-1",
            requestId: "request-telegram-paused",
            idempotencyKey: "idem-telegram-paused",
          },
          {
            TELEGRAM_BOT_ID: "8718299151",
            TELEGRAM_BOT_USERNAME: "delegate_bot",
          },
        ),
      ).resolves.toMatchObject({
        binding: {
          desiredState: "PAUSED",
          healthStatus: "HEALTHY",
          status: "CONNECTED",
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(
      mocks.tx.representativeChannelBinding.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([{ connectionId: "" }]),
            }),
          ]),
        }),
        data: expect.not.objectContaining({
          desiredState: expect.anything(),
          healthStatus: expect.anything(),
          status: expect.anything(),
        }),
      }),
    );
  });

  it.each([
    {
      label: "a Matrix transport",
      transport: "MATRIX",
      sourceProvider: "TELEGRAM",
      connectionId: "matrix-appservice",
    },
    {
      label: "a different Telegram Bot",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "9999999999",
    },
  ])("rejects replacing $label", async (existing) => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "sktone",
      displayName: "SKTone",
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_bot",
      status: "CONNECTED",
      ...existing,
    });

    try {
      await expect(
        provisionOwnerTelegramChannel(
          {
            ownerId: "owner-1",
            actorId: "owner-1",
            representativeId: "rep-1",
            requestId: `request-${existing.connectionId}`,
            idempotencyKey: `idem-${existing.connectionId}`,
          },
          {
            TELEGRAM_BOT_ID: "8718299151",
            TELEGRAM_BOT_USERNAME: "delegate_bot",
          },
        ),
      ).rejects.toMatchObject({
        name: "ChannelManagementError",
        statusCode: 409,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(
      mocks.tx.representativeChannelBinding.updateMany,
    ).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("fails closed when the binding changes during the conditional update", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "sktone",
      displayName: "SKTone",
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_bot",
      status: "CONNECTED",
    });
    mocks.tx.representativeChannelBinding.updateMany.mockResolvedValue({
      count: 0,
    });

    try {
      await expect(
        provisionOwnerTelegramChannel(
          {
            ownerId: "owner-1",
            actorId: "owner-1",
            representativeId: "rep-1",
            requestId: "request-telegram-race",
            idempotencyKey: "idem-telegram-race",
          },
          {
            TELEGRAM_BOT_ID: "8718299151",
            TELEGRAM_BOT_USERNAME: "delegate_bot",
          },
        ),
      ).rejects.toMatchObject({
        name: "ChannelManagementError",
        statusCode: 409,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(
      mocks.tx.representativeChannelBinding.findUnique,
    ).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("fails closed when the representative is outside the owner scope", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue(null);

    try {
      await expect(
        provisionOwnerTelegramChannel(
          {
            ownerId: "owner-1",
            actorId: "owner-1",
            representativeId: "rep-other-owner",
            requestId: "request-telegram-owner-scope",
            idempotencyKey: "idem-telegram-owner-scope",
          },
          {
            TELEGRAM_BOT_ID: "8718299151",
            TELEGRAM_BOT_USERNAME: "delegate_bot",
          },
        ),
      ).rejects.toMatchObject({
        name: "ChannelManagementError",
        statusCode: 404,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.representativeChannelBinding.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });

  it("does not duplicate the audit event when an idempotency key is replayed", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test";
    mocks.tx.representative.findFirst.mockResolvedValue({
      id: "rep-1",
      slug: "sktone",
      displayName: "SKTone",
    });
    mocks.tx.representativeChannelBinding.upsert.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      transport: "TELEGRAM",
      sourceProvider: "TELEGRAM",
      connectionId: "8718299151",
      desiredState: "PAUSED",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_bot",
      status: "CONNECTED",
    });
    mocks.tx.representativeChannelBinding.findUnique.mockResolvedValue({
      id: "binding-telegram-1",
      representativeId: "rep-1",
      kind: "TELEGRAM",
      desiredState: "PAUSED",
      healthStatus: "HEALTHY",
      externalUserId: "@delegate_bot",
      status: "CONNECTED",
    });
    mocks.tx.eventAudit.findFirst.mockResolvedValue({
      id: "audit-telegram-existing",
    });

    try {
      await provisionOwnerTelegramChannel(
        {
          ownerId: "owner-1",
          actorId: "owner-1",
          representativeId: "rep-1",
          requestId: "request-telegram-replay",
          idempotencyKey: "idem-telegram-replay",
        },
        {
          TELEGRAM_BOT_ID: "8718299151",
          TELEGRAM_BOT_USERNAME: "delegate_bot",
        },
      );
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(mocks.tx.eventAudit.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        representativeId: "rep-1",
        AND: expect.arrayContaining([
          {
            payload: {
              path: ["action"],
              equals: "TELEGRAM_BOT_CHANNEL_PROVISIONED",
            },
          },
          {
            payload: {
              path: ["idempotencyKey"],
              equals: "idem-telegram-replay",
            },
          },
        ]),
      }),
      select: { id: true },
    });
    expect(mocks.tx.eventAudit.create).not.toHaveBeenCalled();
  });
});
