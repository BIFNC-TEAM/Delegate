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
          expectedConnectionId: "111111111",
          representativeTelegramBotConnectionId: "connection-b",
          representativeTelegramBot: {
            id: "connection-b",
            botId: "222222222",
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
          expectedConnectionId: "111111111",
          representativeTelegramBotConnectionId: "connection-b",
          representativeTelegramBot: {
            id: "connection-b",
            botId: "222222222",
          },
        },
      }),
    ).toEqual({
      available: false,
      code: "telegram_connection_reassigned",
    });
  });
});
