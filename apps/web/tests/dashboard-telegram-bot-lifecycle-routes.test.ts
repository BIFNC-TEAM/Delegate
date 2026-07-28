import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class ChannelManagementError extends Error {
    constructor(
      message: string,
      readonly statusCode: 400 | 403 | 404 | 409 | 503,
    ) {
      super(message);
    }
  }
  class TelegramBotConnectionError extends Error {
    constructor(
      message: string,
      readonly statusCode: 400 | 403 | 404 | 409 | 503,
    ) {
      super(message);
    }
  }
  return {
    ChannelManagementError,
    TelegramBotConnectionError,
    dashboardAuthErrorResponse: vi.fn(),
    requireDashboardApiOwnerSession: vi.fn(),
    revokeOwnerTelegramBotConnection: vi.fn(),
    rotateOwnerTelegramBotConnection: vi.fn(),
    setOwnerChannelDesiredState: vi.fn(),
    setOwnerTelegramBotConnectionStatus: vi.fn(),
    unassignOwnerTelegramBotConnection: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  ChannelManagementError: routeMocks.ChannelManagementError,
  TelegramBotConnectionError: routeMocks.TelegramBotConnectionError,
  revokeOwnerTelegramBotConnection:
    routeMocks.revokeOwnerTelegramBotConnection,
  rotateOwnerTelegramBotConnection:
    routeMocks.rotateOwnerTelegramBotConnection,
  setOwnerChannelDesiredState: routeMocks.setOwnerChannelDesiredState,
  setOwnerTelegramBotConnectionStatus:
    routeMocks.setOwnerTelegramBotConnectionStatus,
  unassignOwnerTelegramBotConnection:
    routeMocks.unassignOwnerTelegramBotConnection,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: routeMocks.dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession:
    routeMocks.requireDashboardApiOwnerSession,
}));

import {
  DELETE as revokeTelegramBot,
  PATCH as updateTelegramBot,
} from "../app/api/dashboard/channels/telegram-bots/[connectionId]/route";
import {
  DELETE as unassignTelegramBinding,
} from "../app/api/dashboard/channels/[bindingId]/route";

const connectionId = "telegram-connection-1";
const bindingId = "telegram-binding-1";
const secretToken =
  "8718299151:AASecretTokenValueThatMustNeverLeaveTheServer";
const secretSentinel = "SECRET_CREDENTIAL_SENTINEL";
const dashboardChannelsSource = readFileSync(
  new URL("../app/dashboard/dashboard-channels.tsx", import.meta.url),
  "utf8",
);

const safeConnection = {
  id: connectionId,
  botId: "8718299151",
  username: "delegate_bot",
  displayName: "Delegate Bot",
  label: "Support",
  status: "ACTIVE",
  healthStatus: "HEALTHY",
  verificationStatus: "VERIFIED",
  lastVerifiedAt: "2026-07-28T02:00:00.000Z",
  lastHealthCheckAt: "2026-07-28T02:00:00.000Z",
  lastError: null,
  credentialRevision: 2,
  referenceCount: 1,
  activeReferenceCount: 1,
};

describe("dashboard Telegram Bot lifecycle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.dashboardAuthErrorResponse.mockReturnValue(null);
    routeMocks.requireDashboardApiOwnerSession.mockResolvedValue({
      ownerId: "owner-1",
    });
    routeMocks.rotateOwnerTelegramBotConnection.mockResolvedValue({
      connection: {
        ...safeConnection,
        token: secretSentinel,
        ciphertext: secretSentinel,
      },
      changed: true,
      replayed: false,
      rotated: true,
      token: secretSentinel,
    });
    routeMocks.setOwnerTelegramBotConnectionStatus.mockResolvedValue({
      connection: safeConnection,
      changed: true,
      replayed: false,
    });
    routeMocks.revokeOwnerTelegramBotConnection.mockResolvedValue({
      connection: {
        ...safeConnection,
        status: "REVOKED",
      },
      changed: true,
      replayed: false,
    });
    routeMocks.unassignOwnerTelegramBotConnection.mockResolvedValue({
      binding: {
        id: bindingId,
        representativeId: "rep-1",
        telegramBotConnectionId: null,
        connectionId: null,
        desiredState: "PAUSED",
        status: "DISCONNECTED",
      },
      changed: true,
      replayed: false,
      token: secretSentinel,
    });
  });

  it("wires every lifecycle action to explicit confirmations and HTTP methods", () => {
    expect(dashboardChannelsSource).toContain("更新 Token");
    expect(dashboardChannelsSource).toContain("停用 Bot");
    expect(dashboardChannelsSource).toContain("恢复 Bot");
    expect(dashboardChannelsSource).toContain("撤销 Bot");
    expect(dashboardChannelsSource).toContain("从此代表解绑");
    expect(dashboardChannelsSource).toContain(
      "/api/dashboard/channels/telegram-bots/",
    );
    expect(dashboardChannelsSource).toContain(
      'method: action === "revoke" ? "DELETE" : "PATCH"',
    );
    expect(dashboardChannelsSource).toContain(
      "?telegramBotConnectionId=${encodeURIComponent(selectedTelegramBot!.id)}",
    );
    expect(dashboardChannelsSource).toContain('method: "DELETE"');
    expect(dashboardChannelsSource).toContain("确认停用");
    expect(dashboardChannelsSource).toContain("确认解绑");
    expect(dashboardChannelsSource).toContain(
      "这是不可恢复的工作区级操作",
    );
    expect(dashboardChannelsSource).toContain(
      "telegramRevokeConfirmation.trim()",
    );
    expect(dashboardChannelsSource).toContain(
      "!== telegramRevokeConfirmationLabel",
    );
    expect(dashboardChannelsSource).toContain(
      'setTelegramDialogMode(telegramBots.length ? "existing" : "add")',
    );
    expect(dashboardChannelsSource).toContain(
      "|| telegramBots[0]?.id",
    );
  });

  it("rotates a credential with owner scope and never returns credential fields", async () => {
    const response = await updateTelegramBot(
      lifecycleRequest("PATCH", {
        action: "rotate",
        token: secretToken,
        label: " Rotated support ",
        ownerId: "spoofed-owner",
        actorId: "spoofed-actor",
      }),
      connectionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.rotateOwnerTelegramBotConnection).toHaveBeenCalledWith({
      ownerId: "owner-1",
      actorId: "owner-1",
      telegramBotConnectionId: connectionId,
      token: secretToken,
      label: "Rotated support",
      requestId: "telegram-lifecycle-request",
      idempotencyKey: "telegram-lifecycle-idempotency",
    });
    const responseText = await response.text();
    expect(responseText).toContain('"action":"rotate"');
    expect(responseText).toContain(connectionId);
    expect(responseText).not.toContain(secretToken);
    expect(responseText).not.toContain(secretSentinel);
    expect(responseText).not.toContain("ciphertext");
  });

  it.each([
    {
      action: "disable",
      status: "DISABLED",
    },
    {
      action: "resume",
      status: "ACTIVE",
    },
  ] as const)(
    "$action maps to the explicit connection status and request metadata",
    async ({ action, status }) => {
      routeMocks.setOwnerTelegramBotConnectionStatus.mockResolvedValueOnce({
        connection: {
          ...safeConnection,
          status,
        },
        changed: true,
        replayed: false,
      });
      const response = await updateTelegramBot(
        lifecycleRequest("PATCH", { action }),
        connectionContext(),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(
        routeMocks.setOwnerTelegramBotConnectionStatus,
      ).toHaveBeenCalledWith({
        ownerId: "owner-1",
        actorId: "owner-1",
        telegramBotConnectionId: connectionId,
        status,
        requestId: "telegram-lifecycle-request",
        idempotencyKey: "telegram-lifecycle-idempotency",
      });
      await expect(response.json()).resolves.toMatchObject({
        action,
        changed: true,
        connection: { id: connectionId, status },
        requestId: "telegram-lifecycle-request",
      });
    },
  );

  it("revokes a Bot connection through DELETE with idempotency metadata", async () => {
    const response = await revokeTelegramBot(
      lifecycleRequest("DELETE"),
      connectionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.revokeOwnerTelegramBotConnection).toHaveBeenCalledWith({
      ownerId: "owner-1",
      actorId: "owner-1",
      telegramBotConnectionId: connectionId,
      requestId: "telegram-lifecycle-request",
      idempotencyKey: "telegram-lifecycle-idempotency",
    });
    await expect(response.json()).resolves.toMatchObject({
      action: "revoke",
      changed: true,
      connection: {
        id: connectionId,
        status: "REVOKED",
      },
      requestId: "telegram-lifecycle-request",
    });
  });

  it("unassigns one representative binding without exposing service internals", async () => {
    const response = await unassignTelegramBinding(
      new Request(
        `http://localhost/api/dashboard/channels/${bindingId}?telegramBotConnectionId=${connectionId}`,
        {
          method: "DELETE",
          headers: {
            "Idempotency-Key": "telegram-lifecycle-idempotency",
            "X-Request-Id": "telegram-lifecycle-request",
          },
        },
      ),
      { params: Promise.resolve({ bindingId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.unassignOwnerTelegramBotConnection).toHaveBeenCalledWith({
      ownerId: "owner-1",
      actorId: "owner-1",
      bindingId,
      telegramBotConnectionId: connectionId,
      requestId: "telegram-lifecycle-request",
      idempotencyKey: "telegram-lifecycle-idempotency",
    });
    const responseText = await response.text();
    expect(responseText).toContain('"changed":true');
    expect(responseText).toContain('"representativeId":"rep-1"');
    expect(responseText).toContain('"telegramBotConnectionId":null');
    expect(responseText).not.toContain(secretSentinel);
  });

  it("returns 409 when a lifecycle key is reused for a different action", async () => {
    const message =
      "Idempotency key was already used for a different Telegram Bot request on this resource.";
    const firstResponse = await updateTelegramBot(
      lifecycleRequest("PATCH", { action: "disable" }),
      connectionContext(),
    );
    routeMocks.setOwnerTelegramBotConnectionStatus.mockRejectedValueOnce(
      new routeMocks.TelegramBotConnectionError(message, 409),
    );

    const reusedResponse = await updateTelegramBot(
      lifecycleRequest("PATCH", { action: "resume" }),
      connectionContext(),
    );

    expect(firstResponse.status).toBe(200);
    expect(reusedResponse.status).toBe(409);
    expect(reusedResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    await expect(reusedResponse.json()).resolves.toEqual({ error: message });
  });

  it("returns 409 when an unassign key is reused with another connection payload", async () => {
    const message =
      "Idempotency key was already used for a different Telegram Bot request on this resource.";
    const firstResponse = await unassignTelegramBinding(
      unassignRequest(connectionId),
      { params: Promise.resolve({ bindingId }) },
    );
    routeMocks.unassignOwnerTelegramBotConnection.mockRejectedValueOnce(
      new routeMocks.TelegramBotConnectionError(message, 409),
    );

    const reusedResponse = await unassignTelegramBinding(
      unassignRequest("telegram-connection-2"),
      { params: Promise.resolve({ bindingId }) },
    );

    expect(firstResponse.status).toBe(200);
    expect(reusedResponse.status).toBe(409);
    expect(reusedResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    await expect(reusedResponse.json()).resolves.toEqual({ error: message });
  });

  it("rejects an unassign request without the expected Bot connection", async () => {
    const response = await unassignTelegramBinding(
      new Request(
        `http://localhost/api/dashboard/channels/${bindingId}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ bindingId }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error:
        "telegramBotConnectionId is required to unbind a Telegram channel.",
    });
    expect(
      routeMocks.unassignOwnerTelegramBotConnection,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      body: null,
      expectedError: "action must be rotate, disable, or resume.",
    },
    {
      body: { action: "replace" },
      expectedError: "action must be rotate, disable, or resume.",
    },
    {
      body: { action: "rotate", token: "" },
      expectedError: "A valid Telegram Bot token is required.",
    },
    {
      body: {
        action: "rotate",
        token: secretToken,
        label: "x".repeat(101),
      },
      expectedError: "label must be at most 100 characters.",
    },
  ])(
    "rejects invalid lifecycle input without calling the data layer",
    async ({ body, expectedError }) => {
      const response = await updateTelegramBot(
        lifecycleRequest("PATCH", body),
        connectionContext(),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      await expect(response.json()).resolves.toEqual({ error: expectedError });
      expect(
        routeMocks.rotateOwnerTelegramBotConnection,
      ).not.toHaveBeenCalled();
      expect(
        routeMocks.setOwnerTelegramBotConnectionStatus,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      status: 403,
      message: "Telegram Bot connection is unavailable.",
    },
    {
      status: 404,
      message: "Telegram Bot connection not found.",
    },
    {
      status: 409,
      message: "Telegram Bot connection still has active references.",
    },
  ] as const)(
    "preserves classified $status lifecycle errors",
    async ({ status, message }) => {
      routeMocks.revokeOwnerTelegramBotConnection.mockRejectedValueOnce(
        new routeMocks.TelegramBotConnectionError(message, status),
      );
      const response = await revokeTelegramBot(
        lifecycleRequest("DELETE"),
        connectionContext(),
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      await expect(response.json()).resolves.toEqual({ error: message });
    },
  );

  it("authenticates before parsing lifecycle input", async () => {
    const accessError = new Error("forbidden");
    routeMocks.requireDashboardApiOwnerSession.mockRejectedValueOnce(
      accessError,
    );
    routeMocks.dashboardAuthErrorResponse.mockImplementationOnce((error) =>
      error === accessError
        ? new Response(JSON.stringify({ error: "Forbidden." }), {
            status: 403,
            headers: {
              "Cache-Control": "private, no-store",
              "Content-Type": "application/json",
            },
          })
        : null
    );
    const request = lifecycleRequest("PATCH", {
      action: "rotate",
      token: secretToken,
    });
    const jsonSpy = vi.spyOn(request, "json");

    const response = await updateTelegramBot(request, connectionContext());

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(
      routeMocks.rotateOwnerTelegramBotConnection,
    ).not.toHaveBeenCalled();
  });

  it("masks unexpected credential failures with a fixed no-store response", async () => {
    routeMocks.rotateOwnerTelegramBotConnection.mockRejectedValueOnce(
      new Error(
        `postgres://owner:${secretToken}@private.example/${secretSentinel}`,
      ),
    );
    const response = await updateTelegramBot(
      lifecycleRequest("PATCH", {
        action: "rotate",
        token: secretToken,
      }),
      connectionContext(),
    );
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(responseText).toContain(
      "Failed to update Telegram Bot connection.",
    );
    expect(responseText).not.toContain(secretToken);
    expect(responseText).not.toContain(secretSentinel);
    expect(responseText).not.toContain("private.example");
  });
});

function lifecycleRequest(
  method: "PATCH" | "DELETE",
  body?: Record<string, unknown> | null,
) {
  return new Request(
    `http://localhost/api/dashboard/channels/telegram-bots/${connectionId}`,
    {
      method,
      headers: {
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        "Idempotency-Key": "telegram-lifecycle-idempotency",
        "X-Request-Id": "telegram-lifecycle-request",
      },
      ...(body === undefined
        ? {}
        : { body: body === null ? "null" : JSON.stringify(body) }),
    },
  );
}

function connectionContext() {
  return { params: Promise.resolve({ connectionId }) };
}

function unassignRequest(telegramBotConnectionId: string) {
  return new Request(
    `http://localhost/api/dashboard/channels/${bindingId}?telegramBotConnectionId=${telegramBotConnectionId}`,
    {
      method: "DELETE",
      headers: {
        "Idempotency-Key": "telegram-lifecycle-idempotency",
        "X-Request-Id": "telegram-lifecycle-request",
      },
    },
  );
}
