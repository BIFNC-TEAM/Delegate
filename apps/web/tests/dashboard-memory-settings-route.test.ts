import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepresentativeAccessError } from "@delegate/web-data";

const mocks = vi.hoisted(() => ({
  getRepresentativeMemorySettings: vi.fn(),
  requireDashboardApiOwnerSession: vi.fn(),
  resolveDashboardRequestMetadata: vi.fn(),
  updateRepresentativeMemorySettings: vi.fn(),
}));

vi.mock("@delegate/web-data/memory-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@delegate/web-data/memory-settings")>(),
  getRepresentativeMemorySettings: mocks.getRepresentativeMemorySettings,
  updateRepresentativeMemorySettings: mocks.updateRepresentativeMemorySettings,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardApiOwnerSession: mocks.requireDashboardApiOwnerSession,
}));

vi.mock("../app/api/dashboard/request-metadata", () => ({
  resolveDashboardRequestMetadata: mocks.resolveDashboardRequestMetadata,
}));

import {
  GET as getSettings,
  PATCH as patchSettings,
} from "../app/api/dashboard/memory/settings/route";

const representative = {
  id: "rep-1",
  slug: "delegate",
  displayName: "Delegate",
};

describe("representative memory settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardApiOwnerSession.mockResolvedValue({ ownerId: "owner-1" });
    mocks.resolveDashboardRequestMetadata.mockReturnValue({
      requestId: "request-1",
      idempotencyKey: "ignored-fallback",
    });
    mocks.getRepresentativeMemorySettings.mockResolvedValue(settingsResponse());
    mocks.updateRepresentativeMemorySettings.mockResolvedValue({
      replayed: false,
      requestId: "request-1",
      settings: { ...settingsResponse(), revision: 1 },
    });
  });

  it("serves the only Owner memory surface as private no-store", async () => {
    const response = await getSettings(new Request(
      "http://localhost/api/dashboard/memory/settings?rep=delegate",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getRepresentativeMemorySettings).toHaveBeenCalledWith({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
    });
    await expect(response.json()).resolves.toMatchObject({
      basic: { automaticPolicyEnabled: true },
      advanced: {
        namespaceManagedByServer: true,
        targetManagedByServer: true,
      },
    });
  });

  it("rejects unknown and repeated query parameters", async () => {
    const unknown = await getSettings(new Request(
      "http://localhost/api/dashboard/memory/settings?rep=delegate&rawQuery=secret",
    ));
    expect(unknown.status).toBe(422);
    await expect(unknown.json()).resolves.toMatchObject({
      code: "memory_dashboard_invalid_request",
    });

    const repeated = await getSettings(new Request(
      "http://localhost/api/dashboard/memory/settings?rep=delegate&rep=other",
    ));
    expect(repeated.status).toBe(422);
    await expect(repeated.json()).resolves.toMatchObject({
      code: "memory_dashboard_invalid_query",
    });
    expect(mocks.getRepresentativeMemorySettings).not.toHaveBeenCalled();
  });

  it("requires an authenticated persisted Owner identity", async () => {
    mocks.requireDashboardApiOwnerSession.mockRejectedValueOnce(
      new RepresentativeAccessError("Authentication required.", 401),
    );
    const response = await getSettings(new Request(
      "http://localhost/api/dashboard/memory/settings?rep=delegate",
    ));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
      code: "memory_dashboard_unauthorized",
    });
  });

  it("requires idempotency and forwards optimistic concurrency metadata", async () => {
    const missingKey = await patchSettings(jsonRequest(validUpdate()));
    expect(missingKey.status).toBe(422);
    await expect(missingKey.json()).resolves.toMatchObject({
      code: "memory_dashboard_idempotency_required",
    });

    const response = await patchSettings(jsonRequest(
      validUpdate(),
      "memory-settings-1",
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.updateRepresentativeMemorySettings).toHaveBeenCalledWith({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-1",
      idempotencyKey: "memory-settings-1",
      update: validUpdate(),
    });
  });

  it("rejects editable coordinates while accepting channel-local and cross-channel policy", async () => {
    const withTarget = {
      ...validUpdate(),
      policy: { ...validPolicy(), targetUri: "viking://unsafe" },
    };
    const invalidTarget = await patchSettings(jsonRequest(
      withTarget,
      "memory-settings-target",
    ));
    expect(invalidTarget.status).toBe(422);

    const policy = validPolicy();
    const channelLocal = await patchSettings(jsonRequest({
      expectedRevision: 0,
      policy: {
        ...policy,
        channels: {
          ...policy.channels,
          matrix: { recallEnabled: true, extractEnabled: true },
          telegram: { recallEnabled: true, extractEnabled: true },
        },
      },
    }, "memory-settings-matrix"));
    expect(channelLocal.status).toBe(200);
    expect(mocks.updateRepresentativeMemorySettings).toHaveBeenCalledTimes(1);

    const sharing = await patchSettings(jsonRequest({
      expectedRevision: 0,
      policy: {
        ...policy,
        basic: {
          ...policy.basic,
          contactMemoryCrossChannelEnabled: true,
        },
      },
    }, "memory-settings-sharing"));
    expect(sharing.status).toBe(200);
    expect(mocks.updateRepresentativeMemorySettings).toHaveBeenLastCalledWith({
      actorOwnerId: "owner-1",
      representativeSlug: "delegate",
      requestId: "request-1",
      idempotencyKey: "memory-settings-sharing",
      update: {
        expectedRevision: 0,
        policy: expect.objectContaining({
          basic: expect.objectContaining({
            contactMemoryCrossChannelEnabled: true,
          }),
        }),
      },
    });
    expect(mocks.updateRepresentativeMemorySettings).toHaveBeenCalledTimes(2);
  });
});

function validUpdate() {
  return { expectedRevision: 0, policy: validPolicy() };
}

function validPolicy() {
  return {
    basic: {
      longTermMemoryEnabled: true,
      shortTermMemoryEnabled: true,
      contactMemoryEnabled: true,
      contactMemoryCrossChannelEnabled: false,
      representativeExperienceEnabled: true,
      autoExtract: true,
    },
    channels: {
      web: { recallEnabled: true, extractEnabled: true },
      matrix: { recallEnabled: false, extractEnabled: false },
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

function settingsResponse() {
  return {
    representative,
    configured: true,
    revision: 0,
    basic: {
      ...validPolicy().basic,
      automaticPolicyEnabled: true,
      contactMemoryCrossChannelSupported: true,
    },
    channels: {
      web: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: true,
        extractEnabled: true,
      },
      matrix: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: false,
        extractEnabled: false,
      },
      telegram: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: false,
        extractEnabled: false,
      },
    },
    retention: validPolicy().retention,
    advanced: {
      ...validPolicy().advanced,
      namespaceManagedByServer: true,
      targetManagedByServer: true,
      managedAgentId: null,
      managedNamespace: "mem_rep_1",
      managedTargetUri: null,
      managedUserId: "delegate-memory-mem_rep_1",
      managedUriStrategy: "PER_MEMORY_VERSION",
      sync: null,
    },
    updatedAt: null,
    settingsHref: "/dashboard?view=representatives&rep=delegate&repSection=setup&setupSection=memory",
  };
}

function jsonRequest(body: unknown, idempotencyKey?: string) {
  return new Request(
    "http://localhost/api/dashboard/memory/settings?rep=delegate",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}
