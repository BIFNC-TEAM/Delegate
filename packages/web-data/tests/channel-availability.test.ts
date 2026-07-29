import { describe, expect, it } from "vitest";

import { resolveChannelAvailability } from "../src/channel-availability";

const available = {
  channel: "matrix" as const,
  lifecycleState: "PUBLISHED",
  activeVersionId: "version-1",
  publicMode: true,
  binding: {
    legacyStatus: "CONNECTED",
    desiredState: "ACTIVE",
    healthStatus: "HEALTHY",
  },
};

describe("canonical channel availability", () => {
  it("accepts a published, active, healthy channel", () => {
    expect(resolveChannelAvailability(available)).toEqual({
      available: true,
      code: "available",
    });
  });

  it("applies representative and channel pause before generation", () => {
    expect(
      resolveChannelAvailability({ ...available, lifecycleState: "PAUSED" }),
    ).toEqual({ available: false, code: "representative_paused" });
    expect(
      resolveChannelAvailability({
        ...available,
        binding: { ...available.binding, desiredState: "PAUSED" },
      }),
    ).toEqual({ available: false, code: "channel_paused" });
  });

  it("applies active runtime policy overlays", () => {
    const now = new Date("2026-07-23T00:00:00.000Z");
    expect(
      resolveChannelAvailability({
        ...available,
        overlays: [
          {
            enabled: true,
            priority: 100,
            startsAt: new Date("2026-07-22T00:00:00.000Z"),
            payload: { channels: { matrix: { enabled: false } } },
          },
        ],
        now,
      }),
    ).toEqual({ available: false, code: "policy_disabled" });
  });

  it("requires public mode only for the Web channel", () => {
    expect(
      resolveChannelAvailability({
        ...available,
        channel: "web",
        publicMode: false,
      }),
    ).toEqual({ available: false, code: "public_web_disabled" });
    expect(
      resolveChannelAvailability({
        ...available,
        publicMode: false,
      }),
    ).toEqual({ available: true, code: "available" });
  });

  it("blocks missing and unhealthy bindings", () => {
    expect(resolveChannelAvailability({ ...available, binding: null })).toEqual({
      available: false,
      code: "channel_not_connected",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        binding: { ...available.binding, healthStatus: "UNHEALTHY" },
      }),
    ).toEqual({ available: false, code: "channel_unhealthy" });
  });

  it("fails closed when a Telegram delivery points at a reassigned Bot", () => {
    expect(
      resolveChannelAvailability({
        ...available,
        channel: "telegram",
        telegramEndpoint: {
          conversationConnectionId: "111111111",
          representativeConnectionId: "222222222",
          conversationRepresentativeAssignmentRevision: 1,
          representativeAssignmentRevision: 2,
          expectedConnectionId: "111111111",
          representativeTelegramBotConnectionId: "connection-b",
          representativeTelegramBot: {
            id: "connection-b",
            botId: "222222222",
            status: "ACTIVE",
          },
        },
      }),
    ).toEqual({
      available: false,
      code: "telegram_connection_reassigned",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        channel: "telegram",
        telegramEndpoint: {
          conversationConnectionId: "222222222",
          representativeConnectionId: "222222222",
          conversationRepresentativeAssignmentRevision: 1,
          representativeAssignmentRevision: 1,
          expectedConnectionId: "111111111",
          representativeTelegramBotConnectionId: "connection-b",
          representativeTelegramBot: {
            id: "connection-b",
            botId: "222222222",
            status: "ACTIVE",
          },
        },
      }),
    ).toEqual({
      available: false,
      code: "telegram_connection_reassigned",
    });
  });

  it("requires an active Bot and an exact positive Telegram assignment epoch", () => {
    const telegramEndpoint = {
      conversationConnectionId: "111111111",
      representativeConnectionId: "111111111",
      expectedConnectionId: "111111111",
      representativeTelegramBotConnectionId: "connection-a",
      representativeTelegramBot: {
        id: "connection-a",
        botId: "111111111",
        status: "ACTIVE",
      },
    };
    expect(
      resolveChannelAvailability({
        ...available,
        channel: "telegram",
        telegramEndpoint: {
          ...telegramEndpoint,
          conversationRepresentativeAssignmentRevision: 1,
          representativeAssignmentRevision: 1,
        },
      }),
    ).toEqual({ available: true, code: "available" });
    expect(
      resolveChannelAvailability({
        ...available,
        channel: "telegram",
        telegramEndpoint: {
          ...telegramEndpoint,
          conversationRepresentativeAssignmentRevision: null,
          representativeAssignmentRevision: 1,
        },
      }),
    ).toEqual({
      available: false,
      code: "telegram_connection_reassigned",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        channel: "telegram",
        telegramEndpoint: {
          ...telegramEndpoint,
          // The Bot id cycled A -> B -> A, but the old conversation epoch
          // remains permanently fenced.
          conversationRepresentativeAssignmentRevision: 1,
          representativeAssignmentRevision: 3,
        },
      }),
    ).toEqual({
      available: false,
      code: "telegram_connection_reassigned",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        channel: "telegram",
        telegramEndpoint: {
          ...telegramEndpoint,
          conversationRepresentativeAssignmentRevision: 3,
          representativeAssignmentRevision: 3,
          representativeTelegramBot: {
            ...telegramEndpoint.representativeTelegramBot,
            status: "DISABLED",
          },
        },
      }),
    ).toEqual({
      available: false,
      code: "telegram_connection_reassigned",
    });
  });

  it("fails closed when a Matrix room belongs to a reassigned representative identity", () => {
    expect(
      resolveChannelAvailability({
        ...available,
        matrixEndpoint: {
          conversationRepresentativeMatrixUserId:
            "@_delegate_rep_old:example.org",
          representativeMatrixUserId: "@_delegate_rep_new:example.org",
        },
      }),
    ).toEqual({
      available: false,
      code: "matrix_identity_reassigned",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        matrixEndpoint: {
          conversationRepresentativeMatrixUserId:
            "@_delegate_rep:example.org",
          representativeMatrixUserId:
            "@_delegate_rep:example.org",
          conversationRepresentativeAssignmentRevision: 0,
          representativeAssignmentRevision: 0,
        },
      }),
    ).toEqual({
      available: false,
      code: "matrix_identity_reassigned",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        matrixEndpoint: {
          conversationRepresentativeMatrixUserId:
            "@_delegate_rep:example.org",
          representativeMatrixUserId: "@_delegate_rep:example.org",
          conversationRepresentativeAssignmentRevision: 1,
          representativeAssignmentRevision: 1,
        },
      }),
    ).toEqual({
      available: true,
      code: "available",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        matrixEndpoint: {
          // A -> B -> A returns to the same MXID, but the old room remains
          // fenced by the immutable assignment revision.
          conversationRepresentativeMatrixUserId:
            "@_delegate_rep:example.org",
          representativeMatrixUserId:
            "@_delegate_rep:example.org",
          conversationRepresentativeAssignmentRevision: 1,
          representativeAssignmentRevision: 3,
        },
      }),
    ).toEqual({
      available: false,
      code: "matrix_identity_reassigned",
    });
    expect(
      resolveChannelAvailability({
        ...available,
        matrixEndpoint: {
          conversationRepresentativeMatrixUserId:
            "@_delegate_rep:example.org",
          representativeMatrixUserId: null,
        },
      }),
    ).toEqual({
      available: true,
      code: "available",
    });
  });
});
