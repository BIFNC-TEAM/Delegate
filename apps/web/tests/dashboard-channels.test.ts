import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class ChannelManagementError extends Error {
    constructor(
      message: string,
      readonly statusCode: 400 | 404 | 409 | 503,
    ) {
      super(message);
    }
  }
  class TelegramBotConnectionError extends Error {
    constructor(
      message: string,
      readonly statusCode: 400 | 404 | 409 | 503,
    ) {
      super(message);
    }
  }
  return {
    ChannelManagementError,
    TelegramBotConnectionError,
    assignOwnerTelegramBotConnection: vi.fn(),
    createOrRotateOwnerTelegramBotConnection: vi.fn(),
    dashboardAuthErrorResponse: vi.fn(),
    getOwnerChannelManagementSnapshot: vi.fn(),
    provisionOwnerMatrixChannel: vi.fn(),
    requireDashboardApiOwnerSession: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  ChannelManagementError: routeMocks.ChannelManagementError,
  TelegramBotConnectionError: routeMocks.TelegramBotConnectionError,
  assignOwnerTelegramBotConnection:
    routeMocks.assignOwnerTelegramBotConnection,
  createOrRotateOwnerTelegramBotConnection:
    routeMocks.createOrRotateOwnerTelegramBotConnection,
  getOwnerChannelManagementSnapshot:
    routeMocks.getOwnerChannelManagementSnapshot,
  provisionOwnerMatrixChannel: routeMocks.provisionOwnerMatrixChannel,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: routeMocks.dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession:
    routeMocks.requireDashboardApiOwnerSession,
}));

import { POST as assignChannel } from "../app/api/dashboard/channels/route";
import { POST as createTelegramBot } from "../app/api/dashboard/channels/telegram-bots/route";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-channels.tsx", import.meta.url),
  "utf8",
);
const framework = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const listRoute = readFileSync(
  new URL("../app/api/dashboard/channels/route.ts", import.meta.url),
  "utf8",
);
const telegramBotsRoute = readFileSync(
  new URL(
    "../app/api/dashboard/channels/telegram-bots/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const stateRoute = readFileSync(
  new URL(
    "../app/api/dashboard/channels/[bindingId]/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const healthRoute = readFileSync(
  new URL(
    "../app/api/dashboard/channels/[bindingId]/health/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const channelErrors = readFileSync(
  new URL("../app/api/dashboard/channels/errors.ts", import.meta.url),
  "utf8",
);
const management = readFileSync(
  new URL(
    "../../../packages/web-data/src/channel-management.ts",
    import.meta.url,
  ),
  "utf8",
);
const representativeOperations = readFileSync(
  new URL(
    "../app/dashboard/dashboard-representative-operations.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("dashboard channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.dashboardAuthErrorResponse.mockReturnValue(null);
    routeMocks.requireDashboardApiOwnerSession.mockResolvedValue({
      ownerId: "owner-1",
    });
    routeMocks.createOrRotateOwnerTelegramBotConnection.mockResolvedValue({
      connection: {
        id: "telegram-connection-1",
        botId: "8718299151",
        username: "delegate_bot",
        displayName: "Delegate Bot",
        label: "Support",
        status: "ACTIVE",
        healthStatus: "HEALTHY",
        verificationStatus: "VERIFIED",
        lastVerifiedAt: "2026-07-27T10:00:00.000Z",
        lastHealthCheckAt: "2026-07-27T10:00:00.000Z",
        lastError: null,
        credentialRevision: 1,
        referenceCount: 0,
        activeReferenceCount: 0,
      },
      created: true,
      rotated: false,
    });
    routeMocks.assignOwnerTelegramBotConnection.mockResolvedValue({
      binding: { id: "binding-telegram-1" },
    });
  });

  it("renders real channel data instead of the framework blueprint", () => {
    expect(framework).toContain('props.activeView === "channels"');
    expect(framework).toContain("<DashboardChannels");
    expect(framework).toContain('"channels", "audit"');
    expect(component).toContain("OwnerChannelManagementSnapshot");
    expect(component).toContain("/api/dashboard/channels");
    expect(component).toContain("Telegram · via Matrix");
    expect(component).toContain("channel.legacyStatus");
    expect(component).toContain("channel.recentIngress");
    expect(component).toContain("channel.recentEgress");
    expect(component).toContain("配置 Bot");
    expect(component).toContain("切换 Bot");
    expect(component).toContain("同一个 Bot 可以被多个代表复用");
    expect(component).toContain("referenceCount");
    expect(component).toContain("Bot ID");
    expect(component).toContain("bot.healthStatus");
    expect(component).toContain('bot.status === "ACTIVE"');
    expect(component).toContain('channel.kind === "TELEGRAM"');
  });

  it("adds verified Telegram Bots without exposing credentials in snapshots", () => {
    expect(component).toContain("/api/dashboard/channels/telegram-bots");
    expect(component).toContain('type="password"');
    expect(component).toContain('autoComplete="new-password"');
    expect(component).toContain('aria-modal="true"');
    expect(component).toContain('role="dialog"');
    expect(component).toContain('event.key === "Escape"');
    expect(component).toContain("页面不会再次显示");
    expect(component).not.toContain("TELEGRAM_BOT_TOKEN");

    expect(telegramBotsRoute).toContain(
      "createOrRotateOwnerTelegramBotConnection",
    );
    expect(telegramBotsRoute).toContain("requireDashboardApiOwnerSession");
    expect(telegramBotsRoute).toContain("resolveChannelRequestMetadata");
    expect(telegramBotsRoute).toContain('"Cache-Control": "private, no-store"');
    expect(
      telegramBotsRoute.indexOf("requireDashboardApiOwnerSession"),
    ).toBeLessThan(telegramBotsRoute.indexOf("request.json()"));
    expect(channelErrors).toContain("TelegramBotConnectionError");
    expect(channelErrors).toContain("fallbackMessage");
    expect(channelErrors).toContain('"Cache-Control": "private, no-store"');
  });

  it("assigns a selected Bot per representative and keeps Matrix provisioning separate", () => {
    expect(listRoute).toContain("assignOwnerTelegramBotConnection");
    expect(listRoute).toContain("telegramBotConnectionId");
    expect(listRoute).toContain("provisionOwnerMatrixChannel");
    expect(listRoute).not.toContain("provisionOwnerTelegramChannel");
    expect(component).toContain("selectedTelegramBotId");
    expect(component).toContain("telegramBotConnectionId");
    expect(component).toContain("其他数字代表的 Bot 配置不受影响");
  });

  it("links representative readiness and summary to channel operations", () => {
    expect(representativeOperations).toContain('item.id === "channel"');
    expect(representativeOperations).toContain(
      "buildChannelsHref(activeSlug, locale)",
    );
    expect(representativeOperations).toContain("前往发布渠道");
    expect(representativeOperations).toContain("&view=channels&lang=");
  });

  it("authenticates every endpoint and disables private response caching", () => {
    expect(listRoute).toContain("requireDashboardApiOwnerSession");
    expect(listRoute).toContain('"Cache-Control": "private, no-store"');
    expect(stateRoute).toContain("requireDashboardApiOwnerSession");
    expect(stateRoute).toContain("resolveChannelRequestMetadata");
    expect(stateRoute).toContain("desiredState");
    expect(stateRoute.indexOf("requireDashboardApiOwnerSession")).toBeLessThan(
      stateRoute.indexOf("request.json()"),
    );
    expect(healthRoute).toContain("requireDashboardApiOwnerSession");
    expect(healthRoute).toContain("resolveChannelRequestMetadata");
    expect(healthRoute).toContain(
      "configuration_and_recent_delivery_history",
    );
    expect(telegramBotsRoute).toContain("requireDashboardApiOwnerSession");
    expect(listRoute).toContain(
      'body.channel === "TELEGRAM"',
    );
  });

  it("owner-scopes mutations and audits actor, before/after, and correlation metadata", () => {
    expect(management).toContain("representative: { ownerId }");
    expect(management).toContain('action: "CHANNEL_DESIRED_STATE_CHANGED"');
    expect(management).toContain('action: "CHANNEL_HEALTH_CHECKED"');
    expect(management).toContain(
      'action: "TELEGRAM_BOT_CHANNEL_PROVISIONED"',
    );
    expect(management).toContain("actorId");
    expect(management).toContain("requestId");
    expect(management).toContain("idempotencyKey");
    expect(management).toContain("before:");
    expect(management).toContain("after:");
  });

  it("verifies a Bot token server-side and never returns the credential", async () => {
    const token = "8718299151:AASecretTokenValueThatMustNotBeReturned";
    const response = await createTelegramBot(new Request(
      "http://localhost/api/dashboard/channels/telegram-bots",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "telegram-create-1",
          "X-Request-Id": "telegram-request-1",
        },
        body: JSON.stringify({ token, label: "Support" }),
      },
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.createOrRotateOwnerTelegramBotConnection)
      .toHaveBeenCalledWith({
        ownerId: "owner-1",
        actorId: "owner-1",
        token,
        label: "Support",
        requestId: "telegram-request-1",
        idempotencyKey: "telegram-create-1",
      });
    const responseText = await response.text();
    expect(responseText).toContain("telegram-connection-1");
    expect(responseText).not.toContain(token);
    expect(responseText).not.toContain("AASecretTokenValue");
  });

  it("requires a selected Bot when assigning Telegram and owner-scopes the mutation", async () => {
    const missing = await assignChannel(channelAssignmentRequest({
      channel: "TELEGRAM",
      representativeId: "rep-1",
    }));
    expect(missing.status).toBe(400);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.assignOwnerTelegramBotConnection).not.toHaveBeenCalled();

    const response = await assignChannel(channelAssignmentRequest({
      channel: "TELEGRAM",
      representativeId: "rep-1",
      telegramBotConnectionId: "telegram-connection-1",
    }));
    expect(response.status).toBe(201);
    expect(routeMocks.assignOwnerTelegramBotConnection).toHaveBeenCalledWith({
      ownerId: "owner-1",
      actorId: "owner-1",
      representativeId: "rep-1",
      telegramBotConnectionId: "telegram-connection-1",
      requestId: "channel-request-1",
      idempotencyKey: "channel-assign-1",
    });
  });

  it("keeps unexpected credential failures private", async () => {
    const token = "8718299151:AASecretTokenValueThatMustNotBeReturned";
    routeMocks.createOrRotateOwnerTelegramBotConnection.mockRejectedValueOnce(
      new Error(`postgres://owner:${token}@private.example/channel`),
    );
    const response = await createTelegramBot(new Request(
      "http://localhost/api/dashboard/channels/telegram-bots",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    ));
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(responseText).toContain("Failed to verify and add Telegram Bot.");
    expect(responseText).not.toContain(token);
    expect(responseText).not.toContain("private.example");
  });
});

function channelAssignmentRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/dashboard/channels", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "channel-assign-1",
      "X-Request-Id": "channel-request-1",
    },
    body: JSON.stringify(body),
  });
}
