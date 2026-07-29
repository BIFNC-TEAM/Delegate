import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class OwnerSettingsError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly statusCode: number,
      readonly fieldErrors?: Record<string, string>,
    ) {
      super(message);
      this.name = "OwnerSettingsError";
    }
  }

  class RepresentativeAccessError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
      this.name = "RepresentativeAccessError";
    }
  }

  return {
    OwnerSettingsError,
    RepresentativeAccessError,
    dashboardAuthErrorResponse: vi.fn(),
    getOwnerSettingsSnapshot: vi.fn(),
    requireDashboardApiOwnerSession: vi.fn(),
    updateOwnerNotificationSettings: vi.fn(),
    updateOwnerProfileSettings: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  RepresentativeAccessError: mocks.RepresentativeAccessError,
}));

vi.mock("@delegate/web-data/owner-settings", () => ({
  OwnerSettingsError: mocks.OwnerSettingsError,
  getOwnerSettingsSnapshot: mocks.getOwnerSettingsSnapshot,
  updateOwnerNotificationSettings: mocks.updateOwnerNotificationSettings,
  updateOwnerProfileSettings: mocks.updateOwnerProfileSettings,
}));

vi.mock("@delegate/web-ui", () => ({
  localeCookieName: "delegate_locale",
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession:
    mocks.requireDashboardApiOwnerSession,
}));

import {
  GET,
  PATCH,
} from "../app/api/dashboard/settings/route";

describe("dashboard settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardApiOwnerSession.mockResolvedValue({
      ownerId: " owner-1 ",
    });
    mocks.dashboardAuthErrorResponse.mockImplementation((error: unknown) => {
      if (!(error instanceof mocks.RepresentativeAccessError)) return null;
      return Response.json(
        { error: error.message },
        {
          status: error.statusCode,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    });
    mocks.getOwnerSettingsSnapshot.mockResolvedValue(settingsSnapshot());
    mocks.updateOwnerProfileSettings.mockResolvedValue(settingsSnapshot("en"));
    mocks.updateOwnerNotificationSettings.mockResolvedValue(settingsSnapshot());
  });

  it("authenticates GET before loading owner-scoped settings without a rep parameter", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardApiOwnerSession).toHaveBeenCalledTimes(1);
    expect(mocks.getOwnerSettingsSnapshot).toHaveBeenCalledWith({
      ownerId: "owner-1",
    });
    expect(
      mocks.requireDashboardApiOwnerSession.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.getOwnerSettingsSnapshot.mock.invocationCallOrder[0]!,
    );
  });

  it("returns a private 401 when the dashboard auth guard rejects an anonymous GET", async () => {
    mocks.requireDashboardApiOwnerSession.mockRejectedValue(
      new mocks.RepresentativeAccessError("Authentication required.", 401),
    );

    const response = await GET();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
    });
    expect(mocks.getOwnerSettingsSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an optional-development null session before parsing PATCH JSON", async () => {
    mocks.requireDashboardApiOwnerSession.mockResolvedValue(null);
    const request = patchRequest({
      section: "profile",
      profile: validProfile(),
    });
    const json = vi.spyOn(request, "json");

    const response = await PATCH(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(json).not.toHaveBeenCalled();
    expect(mocks.updateOwnerProfileSettings).not.toHaveBeenCalled();
    expect(mocks.updateOwnerNotificationSettings).not.toHaveBeenCalled();
  });

  it("authenticates before parsing and dispatches a profile update without rep context", async () => {
    const request = patchRequest(
      {
        section: "profile",
        profile: validProfile(),
      },
      "http://localhost/api/dashboard/settings",
    );
    const json = vi.spyOn(request, "json");

    const response = await PATCH(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      mocks.requireDashboardApiOwnerSession.mock.invocationCallOrder[0],
    ).toBeLessThan(json.mock.invocationCallOrder[0]!);
    expect(mocks.updateOwnerProfileSettings).toHaveBeenCalledWith({
      ownerId: "owner-1",
      profile: validProfile(),
      requestId: "settings-request-1",
      idempotencyKey: "settings-idempotency-1",
    });
    expect(mocks.updateOwnerNotificationSettings).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain(
      "delegate_locale=en",
    );
    await expect(response.json()).resolves.toMatchObject({
      profile: { preferredLocale: "en" },
      requestId: "settings-request-1",
    });
  });

  it("dispatches notifications independently of an ignored rep query and does not set a locale cookie", async () => {
    const notifications = validNotifications();
    const response = await PATCH(patchRequest(
      {
        section: "notifications",
        notifications,
      },
      "http://localhost/api/dashboard/settings?rep=foreign-representative",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.updateOwnerNotificationSettings).toHaveBeenCalledWith({
      ownerId: "owner-1",
      notifications,
      requestId: "settings-request-1",
      idempotencyKey: "settings-idempotency-1",
    });
    expect(mocks.updateOwnerProfileSettings).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    {
      label: "a caller-supplied owner id",
      body: {
        section: "profile",
        ownerId: "owner-2",
        profile: validProfile(),
      },
    },
    {
      label: "an additional section payload",
      body: {
        section: "profile",
        profile: validProfile(),
        notifications: validNotifications(),
      },
    },
    {
      label: "an unsupported section",
      body: {
        section: "security",
        security: {},
      },
    },
  ])("strictly rejects $label with a private 400", async ({ body }) => {
    const response = await PATCH(patchRequest(body));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "owner_settings_invalid",
    });
    expect(mocks.updateOwnerProfileSettings).not.toHaveBeenCalled();
    expect(mocks.updateOwnerNotificationSettings).not.toHaveBeenCalled();
  });

  it("preserves validation details from the settings service as a private 400", async () => {
    mocks.updateOwnerProfileSettings.mockRejectedValue(
      new mocks.OwnerSettingsError(
        "owner_settings_invalid",
        "Review the highlighted settings and try again.",
        400,
        { timezone: "Select a valid IANA time zone." },
      ),
    );

    const response = await PATCH(patchRequest({
      section: "profile",
      profile: {
        ...validProfile(),
        timezone: "Not/A-Time-Zone",
      },
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Review the highlighted settings and try again.",
      code: "owner_settings_invalid",
      fieldErrors: {
        timezone: "Select a valid IANA time zone.",
      },
    });
  });

  it("maps optimistic concurrency failures to a private 409", async () => {
    mocks.updateOwnerNotificationSettings.mockRejectedValue(
      new mocks.OwnerSettingsError(
        "owner_settings_version_conflict",
        "These settings changed in another session.",
        409,
      ),
    );

    const response = await PATCH(patchRequest({
      section: "notifications",
      notifications: validNotifications(),
    }));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "owner_settings_version_conflict",
    });
  });

  it("turns an unavailable GET snapshot into a private 503", async () => {
    mocks.getOwnerSettingsSnapshot.mockResolvedValue({
      ...settingsSnapshot(),
      dataSource: "unavailable",
      persistenceAvailable: false,
      profile: null,
      notifications: null,
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "owner_settings_persistence_unavailable",
    });
  });

  it("redacts unexpected failures behind a private generic 500", async () => {
    mocks.getOwnerSettingsSnapshot.mockRejectedValue(
      new Error("postgres://owner:password@private-host/delegate"),
    );

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("owner_settings_internal_error");
    expect(body).not.toContain("password");
    expect(body).not.toContain("private-host");
  });
});

function patchRequest(
  body: unknown,
  url = "http://localhost/api/dashboard/settings",
) {
  return new Request(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "settings-idempotency-1",
      "X-Request-Id": "settings-request-1",
    },
    body: JSON.stringify(body),
  });
}

function validProfile() {
  return {
    displayName: "Delegate Owner",
    timezone: "Asia/Shanghai",
    preferredLocale: "en",
    expectedVersion: 2,
  };
}

function validNotifications() {
  return {
    rules: {
      schemaVersion: 1,
      events: {
        handoffRequested: true,
        approvalRequested: true,
        walletException: true,
        channelFailure: false,
      },
    },
    expectedVersion: 3,
  };
}

function settingsSnapshot(preferredLocale: "zh" | "en" = "zh") {
  return {
    dataSource: "database",
    persistenceAvailable: true,
    profile: {
      displayName: "Delegate Owner",
      timezone: "Asia/Shanghai",
      preferredLocale,
      version: 3,
    },
    security: {
      provider: "logto",
      connectionStatus: "connected",
      email: "owner@example.com",
      emailVerification: "verified",
      phone: null,
      phoneVerification: "unknown",
      identityVerifiedAt: "2026-07-28T08:00:00.000Z",
      managementUrl: null,
    },
    notifications: {
      delivery: "dashboard_navigation",
      rules: validNotifications().rules,
      version: 3,
    },
    recentChanges: [],
  };
}
