import { createHash, createHmac } from "node:crypto";

import { EventType } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildUnavailableOwnerOperationalAlertSummary,
  defaultOwnerNotificationRules,
  getOwnerOperationalAlertSummary,
  getOwnerSettingsSnapshot,
  isValidIanaTimeZone,
  ownerNotificationSettingsUpdateSchema,
  ownerProfileSettingsUpdateSchema,
  parseStoredOwnerNotificationRules,
  readLogtoAccountCenterUrl,
  updateOwnerNotificationSettings,
  updateOwnerProfileSettings,
  type OwnerNotificationRules,
} from "../src/owner-settings";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthSessionSecret = process.env.DELEGATE_AUTH_SESSION_SECRET;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalAuthSessionSecret === undefined) {
    delete process.env.DELEGATE_AUTH_SESSION_SECRET;
  } else {
    process.env.DELEGATE_AUTH_SESSION_SECRET = originalAuthSessionSecret;
  }
  vi.restoreAllMocks();
});

describe("owner settings validation", () => {
  it("accepts only the strict profile contract and valid IANA time zones", () => {
    expect(isValidIanaTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("UTC")).toBe(true);
    expect(isValidIanaTimeZone("UTC+08:00")).toBe(false);
    expect(isValidIanaTimeZone("Not/A-Time-Zone")).toBe(false);

    expect(ownerProfileSettingsUpdateSchema.parse({
      displayName: "  Ada Lovelace  ",
      timezone: " Asia/Shanghai ",
      preferredLocale: "zh",
      expectedVersion: 2,
    })).toEqual({
      displayName: "Ada Lovelace",
      timezone: "Asia/Shanghai",
      preferredLocale: "zh",
      expectedVersion: 2,
    });

    expect(ownerProfileSettingsUpdateSchema.safeParse({
      displayName: "Ada",
      timezone: "UTC+08:00",
      preferredLocale: "zh",
      expectedVersion: 2,
    }).success).toBe(false);
    expect(ownerProfileSettingsUpdateSchema.safeParse({
      displayName: "Ada",
      timezone: "UTC",
      preferredLocale: "fr",
      expectedVersion: 2,
    }).success).toBe(false);
    expect(ownerProfileSettingsUpdateSchema.safeParse({
      displayName: "Ada",
      timezone: "UTC",
      preferredLocale: "en",
      expectedVersion: 2,
      ownerId: "spoofed-owner",
    }).success).toBe(false);
  });

  it("keeps wallet exception alerts mandatory and rejects unknown notification fields", () => {
    expect(ownerNotificationSettingsUpdateSchema.safeParse({
      rules: notificationRules({
        handoffRequested: false,
        approvalRequested: false,
        channelFailure: false,
      }),
      expectedVersion: 0,
    }).success).toBe(true);

    expect(ownerNotificationSettingsUpdateSchema.safeParse({
      rules: {
        ...notificationRules(),
        events: {
          ...notificationRules().events,
          walletException: false,
        },
      },
      expectedVersion: 0,
    }).success).toBe(false);
    expect(ownerNotificationSettingsUpdateSchema.safeParse({
      rules: notificationRules(),
      expectedVersion: 0,
      ownerId: "spoofed-owner",
    }).success).toBe(false);
    expect(ownerNotificationSettingsUpdateSchema.safeParse({
      rules: {
        ...notificationRules(),
        events: {
          ...notificationRules().events,
          email: true,
        },
      },
      expectedVersion: 0,
    }).success).toBe(false);
  });

  it("falls back to a fresh copy of safe defaults for absent or damaged stored rules", () => {
    const damagedValues = [
      undefined,
      null,
      {},
      { schemaVersion: 2, events: {} },
      {
        schemaVersion: 1,
        events: {
          handoffRequested: false,
          approvalRequested: false,
          walletException: false,
          channelFailure: false,
        },
      },
    ];

    for (const damaged of damagedValues) {
      expect(parseStoredOwnerNotificationRules(damaged)).toEqual(
        defaultOwnerNotificationRules,
      );
    }

    const first = parseStoredOwnerNotificationRules(undefined);
    first.events.handoffRequested = false;
    expect(parseStoredOwnerNotificationRules(undefined)).toEqual(
      defaultOwnerNotificationRules,
    );
    expect(defaultOwnerNotificationRules.events.handoffRequested).toBe(true);
  });
});

describe("owner settings unavailable mode and security projection", () => {
  it("returns an honest non-persistent state without fabricated profile or identities", async () => {
    delete process.env.DATABASE_URL;

    const snapshot = await getOwnerSettingsSnapshot(
      { ownerId: "owner-local-demo" },
      { env: {} },
    );
    const alerts = await getOwnerOperationalAlertSummary({
      ownerId: "owner-local-demo",
    });

    expect(snapshot).toEqual({
      dataSource: "unavailable",
      persistenceAvailable: false,
      profile: null,
      security: {
        provider: null,
        connectionStatus: "unavailable",
        email: null,
        emailVerification: "unknown",
        phone: null,
        phoneVerification: "unknown",
        identityVerifiedAt: null,
        managementUrl: null,
      },
      notifications: null,
      recentChanges: [],
    });
    expect(alerts).toEqual(buildUnavailableOwnerOperationalAlertSummary());
    expect(alerts).toMatchObject({
      dataSource: "unavailable",
      total: 0,
      topics: {
        walletIssues: {
          count: 0,
          enabled: true,
          mandatory: true,
        },
      },
    });
  });

  it("rejects writes rather than claiming they persisted when no database is available", async () => {
    delete process.env.DATABASE_URL;

    await expect(updateOwnerProfileSettings({
      ownerId: "owner-local-demo",
      requestId: "request-profile-unavailable",
      idempotencyKey: "profile-unavailable",
      profile: validProfile(),
    })).rejects.toMatchObject({
      code: "owner_settings_persistence_unavailable",
      statusCode: 503,
    });
    await expect(updateOwnerNotificationSettings({
      ownerId: "owner-local-demo",
      requestId: "request-notifications-unavailable",
      idempotencyKey: "notifications-unavailable",
      notifications: {
        rules: notificationRules(),
        expectedVersion: 0,
      },
    })).rejects.toMatchObject({
      code: "owner_settings_persistence_unavailable",
      statusCode: 503,
    });
  });

  it("does not infer email verification from a verified phone or legacy identity timestamp", async () => {
    const client = new FakeOwnerSettingsClient([
      ownerFixture({
        identityLinks: [{
          email: "private@example.com",
          phone: "+8613800138000",
          verifiedAt: new Date("2026-07-28T03:00:00.000Z"),
          emailVerifiedAt: null,
          phoneVerifiedAt: new Date("2026-07-28T03:00:00.000Z"),
        }],
      }),
    ]);

    const snapshot = await getOwnerSettingsSnapshot(
      { ownerId: "owner-1" },
      settingsOptions(client, {
        LOGTO_ACCOUNT_CENTER_URL: "https://auth.example.com/account",
      }),
    );

    expect(snapshot.security).toEqual({
      provider: "logto",
      connectionStatus: "connected",
      email: "private@example.com",
      emailVerification: "unknown",
      phone: "+8613800138000",
      phoneVerification: "verified",
      identityVerifiedAt: "2026-07-28T03:00:00.000Z",
      managementUrl: "https://auth.example.com/account",
    });
  });

  it("accepts credential-free HTTPS account-center URLs and rejects unsafe URLs", () => {
    expect(readLogtoAccountCenterUrl({
      LOGTO_ACCOUNT_CENTER_URL: " https://auth.example.com/account ",
    })).toBe("https://auth.example.com/account");
    expect(readLogtoAccountCenterUrl({
      LOGTO_ACCOUNT_CENTER_URL: "javascript:alert(1)",
    })).toBeNull();
    expect(readLogtoAccountCenterUrl({
      LOGTO_ACCOUNT_CENTER_URL: "https://user:password@auth.example.com/account",
    })).toBeNull();
    expect(readLogtoAccountCenterUrl({
      LOGTO_ACCOUNT_CENTER_URL: "//auth.example.com/account",
    })).toBeNull();
  });

  it("rejects cleartext remote account-center URLs while permitting local development", () => {
    expect(readLogtoAccountCenterUrl({
      NODE_ENV: "production",
      LOGTO_ACCOUNT_CENTER_URL: "http://auth.example.com/account",
    })).toBeNull();
    expect(readLogtoAccountCenterUrl({
      NODE_ENV: "development",
      LOGTO_ACCOUNT_CENTER_URL: "http://localhost:3000/account",
    })).toBe("http://localhost:3000/account");
  });
});

describe("owner profile settings persistence", () => {
  it("owner-scopes a successful CAS write and emits no identity or name values in audit", async () => {
    process.env.DELEGATE_AUTH_SESSION_SECRET = "owner-settings-test-secret";
    const client = new FakeOwnerSettingsClient([
      ownerFixture({
        displayName: "Private Before Name",
        identityLinks: [{
          email: "private@example.com",
          phone: "+8613800138000",
          verifiedAt: new Date("2026-07-28T03:00:00.000Z"),
          emailVerifiedAt: new Date("2026-07-28T03:00:00.000Z"),
          phoneVerifiedAt: new Date("2026-07-28T03:00:00.000Z"),
        }],
      }),
      ownerFixture({
        id: "owner-2",
        displayName: "Foreign Owner",
      }),
    ]);

    const profile = validProfile({
      displayName: "Private After Name",
      timezone: "Asia/Shanghai",
      preferredLocale: "zh",
    });
    const snapshot = await updateOwnerProfileSettings({
      ownerId: "owner-1",
      requestId: "profile-request-1",
      idempotencyKey: "profile-key-1",
      profile,
    }, settingsOptions(client));

    expect(snapshot.profile).toEqual({
      displayName: "Private After Name",
      timezone: "Asia/Shanghai",
      preferredLocale: "zh",
      version: 1,
    });
    expect(client.owners.get("owner-1")?.displayName).toBe(
      "Private Before Name",
    );
    expect(client.owners.get("owner-1")?.accountDisplayName).toBe(
      "Private After Name",
    );
    expect(client.owners.get("owner-2")?.displayName).toBe("Foreign Owner");
    expect(client.ownerUpdateClaims).toEqual([{
      id: "owner-1",
      settingsVersion: 0,
    }]);
    expect(client.audits).toHaveLength(1);
    const audit = client.audits[0]!;
    expect(audit).toMatchObject({
      ownerId: "owner-1",
      type: EventType.OWNER_PROFILE_UPDATED,
      idempotencyKey: "profile-key-1",
    });
    expect(audit.payload).toMatchObject({
      actorId: "owner-1",
      requestId: "profile-request-1",
      changedFields: ["displayName", "timezone", "preferredLocale"],
      before: {
        timezone: "UTC",
        preferredLocale: null,
      },
      after: {
        timezone: "Asia/Shanghai",
        preferredLocale: "zh",
      },
      expectedVersion: 0,
      resultingVersion: 1,
    });
    const serializedAudit = JSON.stringify(audit.payload);
    expect(serializedAudit).not.toContain("Private Before Name");
    expect(serializedAudit).not.toContain("Private After Name");
    expect(serializedAudit).not.toContain("private@example.com");
    expect(serializedAudit).not.toContain("+8613800138000");
    expect((audit.payload as Record<string, unknown>).email).toBeUndefined();
    expect((audit.payload as Record<string, unknown>).phone).toBeUndefined();
    expect((audit.payload as Record<string, unknown>).displayName).toBeUndefined();
    const canonicalRequest = JSON.stringify({ section: "profile", payload: profile });
    expect(audit.requestHash).toBe(
      createHmac("sha256", "owner-settings-test-secret")
        .update(canonicalRequest)
        .digest("hex"),
    );
    expect(audit.requestHash).not.toBe(
      createHash("sha256").update(canonicalRequest).digest("hex"),
    );
  });

  it("rejects both a stale loaded version and a lost atomic claim", async () => {
    const staleClient = new FakeOwnerSettingsClient([
      ownerFixture({ settingsVersion: 3 }),
    ]);

    await expect(updateOwnerProfileSettings({
      ownerId: "owner-1",
      requestId: "profile-stale",
      idempotencyKey: "profile-stale",
      profile: validProfile({ expectedVersion: 2 }),
    }, settingsOptions(staleClient))).rejects.toMatchObject({
      code: "owner_settings_version_conflict",
      statusCode: 409,
    });
    expect(staleClient.ownerUpdateClaims).toEqual([]);
    expect(staleClient.audits).toEqual([]);

    const racedClient = new FakeOwnerSettingsClient([ownerFixture()]);
    racedClient.missNextOwnerUpdateClaim = true;
    await expect(updateOwnerProfileSettings({
      ownerId: "owner-1",
      requestId: "profile-race",
      idempotencyKey: "profile-race",
      profile: validProfile({ displayName: "Race winner elsewhere" }),
    }, settingsOptions(racedClient))).rejects.toMatchObject({
      code: "owner_settings_version_conflict",
      statusCode: 409,
    });
    expect(racedClient.ownerUpdateClaims).toEqual([{
      id: "owner-1",
      settingsVersion: 0,
    }]);
    expect(racedClient.audits).toEqual([]);
  });

  it("retries bounded serializable conflicts and returns a recoverable conflict when exhausted", async () => {
    const retryingClient = new FakeOwnerSettingsClient([ownerFixture()]);
    retryingClient.serializableFailuresRemaining = 2;

    await updateOwnerProfileSettings({
      ownerId: "owner-1",
      requestId: "profile-serializable-retry",
      idempotencyKey: "profile-serializable-retry",
      profile: validProfile({ displayName: "Retried safely" }),
    }, settingsOptions(retryingClient));

    expect(retryingClient.$transaction).toHaveBeenCalledTimes(3);
    expect(retryingClient.owners.get("owner-1")?.settingsVersion).toBe(1);
    expect(retryingClient.audits).toHaveLength(1);

    const exhaustedClient = new FakeOwnerSettingsClient([ownerFixture()]);
    exhaustedClient.serializableFailuresRemaining = 3;
    await expect(updateOwnerProfileSettings({
      ownerId: "owner-1",
      requestId: "profile-serializable-exhausted",
      idempotencyKey: "profile-serializable-exhausted",
      profile: validProfile({ displayName: "Never committed" }),
    }, settingsOptions(exhaustedClient))).rejects.toMatchObject({
      code: "owner_settings_version_conflict",
      statusCode: 409,
    });
    expect(exhaustedClient.owners.get("owner-1")?.settingsVersion).toBe(0);
    expect(exhaustedClient.audits).toEqual([]);
  });

  it("replays an identical request once and rejects reuse for a different payload", async () => {
    const client = new FakeOwnerSettingsClient([ownerFixture()]);
    const input = {
      ownerId: "owner-1",
      requestId: "profile-replay",
      idempotencyKey: "profile-replay",
      profile: validProfile({ displayName: "Updated once" }),
    };

    await updateOwnerProfileSettings(input, settingsOptions(client));
    await updateOwnerProfileSettings(input, settingsOptions(client));

    expect(client.owners.get("owner-1")?.settingsVersion).toBe(1);
    expect(client.audits).toHaveLength(1);
    await expect(updateOwnerProfileSettings({
      ...input,
      profile: validProfile({
        displayName: "Different request",
      }),
    }, settingsOptions(client))).rejects.toMatchObject({
      code: "owner_settings_idempotency_conflict",
      statusCode: 409,
    });
  });

  it("binds an idempotency key even when the first successful request is a no-op", async () => {
    const client = new FakeOwnerSettingsClient([
      ownerFixture({ preferredLocale: "en" }),
    ]);
    await updateOwnerProfileSettings({
      ownerId: "owner-1",
      requestId: "profile-noop",
      idempotencyKey: "profile-noop",
      profile: validProfile(),
    }, settingsOptions(client));

    await expect(updateOwnerProfileSettings({
      ownerId: "owner-1",
      requestId: "profile-noop-reused",
      idempotencyKey: "profile-noop",
      profile: validProfile({ displayName: "Must not reuse the no-op key" }),
    }, settingsOptions(client))).rejects.toMatchObject({
      code: "owner_settings_idempotency_conflict",
      statusCode: 409,
    });
  });
});

describe("owner notification settings persistence", () => {
  it("keeps wallet alerts enabled even when every optional topic is disabled", async () => {
    const client = new FakeOwnerSettingsClient([ownerFixture()]);
    client.notificationSettings.set("owner-1", {
      ownerId: "owner-1",
      rules: notificationRules({
        handoffRequested: false,
        approvalRequested: false,
        channelFailure: false,
      }),
      version: 4,
    });
    client.alertCounts = {
      handoffs: 3,
      approvals: 5,
      walletIssues: 2,
      channelIssues: 7,
    };

    const summary = await getOwnerOperationalAlertSummary(
      { ownerId: "owner-1" },
      settingsOptions(client),
    );

    expect(summary).toEqual({
      dataSource: "database",
      total: 2,
      topics: {
        handoffs: { count: 3, enabled: false },
        approvals: { count: 5, enabled: false },
        walletIssues: { count: 2, enabled: true, mandatory: true },
        channelIssues: { count: 7, enabled: false },
      },
    });
    expect(client.alertOwnerScopes).toEqual([
      ["handoff", "owner-1"],
      ["approval", "owner-1"],
      ["wallet", "owner-1"],
      ["channel", "owner-1"],
    ]);
  });

  it("owner-scopes notification CAS and rejects stale or lost claims", async () => {
    const client = new FakeOwnerSettingsClient([
      ownerFixture(),
      ownerFixture({ id: "owner-2", displayName: "Foreign Owner" }),
    ]);
    client.notificationSettings.set("owner-1", {
      ownerId: "owner-1",
      rules: notificationRules(),
      version: 2,
    });

    const snapshot = await updateOwnerNotificationSettings({
      ownerId: "owner-1",
      requestId: "notifications-request-1",
      idempotencyKey: "notifications-key-1",
      notifications: {
        rules: notificationRules({ handoffRequested: false }),
        expectedVersion: 2,
      },
    }, settingsOptions(client));

    expect(snapshot.notifications).toMatchObject({
      rules: notificationRules({ handoffRequested: false }),
      version: 3,
    });
    expect(client.notificationUpdateClaims).toEqual([{
      ownerId: "owner-1",
      version: 2,
    }]);
    expect(client.notificationSettings.has("owner-2")).toBe(false);
    expect(client.audits).toHaveLength(1);

    await expect(updateOwnerNotificationSettings({
      ownerId: "owner-1",
      requestId: "notifications-stale",
      idempotencyKey: "notifications-stale",
      notifications: {
        rules: notificationRules({ approvalRequested: false }),
        expectedVersion: 2,
      },
    }, settingsOptions(client))).rejects.toMatchObject({
      code: "owner_settings_version_conflict",
      statusCode: 409,
    });

    const racedClient = new FakeOwnerSettingsClient([ownerFixture()]);
    racedClient.notificationSettings.set("owner-1", {
      ownerId: "owner-1",
      rules: notificationRules(),
      version: 0,
    });
    racedClient.missNextNotificationUpdateClaim = true;
    await expect(updateOwnerNotificationSettings({
      ownerId: "owner-1",
      requestId: "notifications-race",
      idempotencyKey: "notifications-race",
      notifications: {
        rules: notificationRules({ channelFailure: false }),
        expectedVersion: 0,
      },
    }, settingsOptions(racedClient))).rejects.toMatchObject({
      code: "owner_settings_version_conflict",
      statusCode: 409,
    });
    expect(racedClient.audits).toEqual([]);
  });

  it("replays identical notification writes and rejects a different request using the key", async () => {
    const client = new FakeOwnerSettingsClient([ownerFixture()]);
    const input = {
      ownerId: "owner-1",
      requestId: "notifications-replay",
      idempotencyKey: "notifications-replay",
      notifications: {
        rules: notificationRules({ approvalRequested: false }),
        expectedVersion: 0,
      },
    };

    await updateOwnerNotificationSettings(input, settingsOptions(client));
    await updateOwnerNotificationSettings(input, settingsOptions(client));

    expect(client.notificationSettings.get("owner-1")?.version).toBe(1);
    expect(client.audits).toHaveLength(1);
    await expect(updateOwnerNotificationSettings({
      ...input,
      notifications: {
        rules: notificationRules({ channelFailure: false }),
        expectedVersion: 0,
      },
    }, settingsOptions(client))).rejects.toMatchObject({
      code: "owner_settings_idempotency_conflict",
      statusCode: 409,
    });
  });

  it("binds a notification idempotency key even when the first request matches defaults", async () => {
    const client = new FakeOwnerSettingsClient([ownerFixture()]);
    await updateOwnerNotificationSettings({
      ownerId: "owner-1",
      requestId: "notifications-noop",
      idempotencyKey: "notifications-noop",
      notifications: {
        rules: notificationRules(),
        expectedVersion: 0,
      },
    }, settingsOptions(client));

    await expect(updateOwnerNotificationSettings({
      ownerId: "owner-1",
      requestId: "notifications-noop-reused",
      idempotencyKey: "notifications-noop",
      notifications: {
        rules: notificationRules({ handoffRequested: false }),
        expectedVersion: 0,
      },
    }, settingsOptions(client))).rejects.toMatchObject({
      code: "owner_settings_idempotency_conflict",
      statusCode: 409,
    });
  });
});

type FakeIdentityLink = {
  email: string | null;
  phone: string | null;
  verifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
};

type FakeOwner = {
  id: string;
  displayName: string;
  accountDisplayName: string | null;
  timezone: string;
  preferredLocale: string | null;
  settingsVersion: number;
  identityLinks: FakeIdentityLink[];
};

type FakeNotificationSettings = {
  ownerId: string;
  rules: unknown;
  version: number;
};

type FakeAudit = {
  id: string;
  ownerId: string;
  type: EventType;
  idempotencyKey: string;
  requestHash: string;
  payload: unknown;
  createdAt: Date;
};

class FakeOwnerSettingsClient {
  readonly owners = new Map<string, FakeOwner>();
  readonly notificationSettings = new Map<string, FakeNotificationSettings>();
  readonly audits: FakeAudit[] = [];
  readonly ownerUpdateClaims: Array<{ id: string; settingsVersion: number }> = [];
  readonly notificationUpdateClaims: Array<{ ownerId: string; version: number }> = [];
  readonly alertOwnerScopes: Array<[string, string]> = [];
  alertCounts = {
    handoffs: 0,
    approvals: 0,
    walletIssues: 0,
    channelIssues: 0,
  };
  missNextOwnerUpdateClaim = false;
  missNextNotificationUpdateClaim = false;
  serializableFailuresRemaining = 0;

  constructor(owners: FakeOwner[]) {
    for (const owner of owners) this.owners.set(owner.id, owner);
  }

  readonly owner = {
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      const owner = this.owners.get(args.where.id);
      if (!owner) return null;
      const notificationSettings = this.notificationSettings.get(owner.id);
      return {
        ...owner,
        notificationSettings: notificationSettings
          ? {
              rules: notificationSettings.rules,
              version: notificationSettings.version,
            }
          : null,
      };
    }),
    updateMany: vi.fn(async (args: {
      where: { id: string; settingsVersion: number };
      data: {
        accountDisplayName: string;
        timezone: string;
        preferredLocale: string;
        settingsVersion: { increment: number };
      };
    }) => {
      this.ownerUpdateClaims.push({ ...args.where });
      if (this.missNextOwnerUpdateClaim) {
        this.missNextOwnerUpdateClaim = false;
        return { count: 0 };
      }
      const owner = this.owners.get(args.where.id);
      if (!owner || owner.settingsVersion !== args.where.settingsVersion) {
        return { count: 0 };
      }
      owner.accountDisplayName = args.data.accountDisplayName;
      owner.timezone = args.data.timezone;
      owner.preferredLocale = args.data.preferredLocale;
      owner.settingsVersion += args.data.settingsVersion.increment;
      return { count: 1 };
    }),
  };

  readonly ownerNotificationSettings = {
    findUnique: vi.fn(async (args: { where: { ownerId: string } }) => {
      return this.notificationSettings.get(args.where.ownerId) ?? null;
    }),
    updateMany: vi.fn(async (args: {
      where: { ownerId: string; version: number };
      data: { rules: unknown; version: { increment: number } };
    }) => {
      this.notificationUpdateClaims.push({ ...args.where });
      if (this.missNextNotificationUpdateClaim) {
        this.missNextNotificationUpdateClaim = false;
        return { count: 0 };
      }
      const current = this.notificationSettings.get(args.where.ownerId);
      if (!current || current.version !== args.where.version) {
        return { count: 0 };
      }
      current.rules = structuredClone(args.data.rules);
      current.version += args.data.version.increment;
      return { count: 1 };
    }),
    create: vi.fn(async (args: {
      data: { ownerId: string; rules: unknown; version: number };
    }) => {
      if (this.notificationSettings.has(args.data.ownerId)) {
        throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      }
      const created = {
        ownerId: args.data.ownerId,
        rules: structuredClone(args.data.rules),
        version: args.data.version,
      };
      this.notificationSettings.set(args.data.ownerId, created);
      return created;
    }),
  };

  readonly eventAudit = {
    findUnique: vi.fn(async (args: {
      where: {
        ownerId_idempotencyKey: {
          ownerId: string;
          idempotencyKey: string;
        };
      };
    }) => {
      const key = args.where.ownerId_idempotencyKey;
      return this.audits.find(
        (audit) => audit.ownerId === key.ownerId
          && audit.idempotencyKey === key.idempotencyKey,
      ) ?? null;
    }),
    findMany: vi.fn(async (args: {
      where: { ownerId: string; type: { in: EventType[] } };
    }) => {
      return this.audits
        .filter((audit) => (
          audit.ownerId === args.where.ownerId
          && args.where.type.in.includes(audit.type)
        ))
        .sort((left, right) => (
          right.createdAt.getTime() - left.createdAt.getTime()
          || right.id.localeCompare(left.id)
        ))
        .slice(0, 8);
    }),
    create: vi.fn(async (args: {
      data: Omit<FakeAudit, "id" | "createdAt">;
    }) => {
      if (this.audits.some((audit) => (
        audit.ownerId === args.data.ownerId
        && audit.idempotencyKey === args.data.idempotencyKey
      ))) {
        throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      }
      const audit: FakeAudit = {
        ...args.data,
        id: `audit-${this.audits.length + 1}`,
        createdAt: new Date(
          Date.parse("2026-07-28T04:00:00.000Z") + this.audits.length,
        ),
      };
      this.audits.push(audit);
      return audit;
    }),
  };

  readonly handoffRequest = {
    count: vi.fn(async (args: { where: { representative: { ownerId: string } } }) => {
      this.alertOwnerScopes.push(["handoff", args.where.representative.ownerId]);
      return this.alertCounts.handoffs;
    }),
  };

  readonly approvalRequest = {
    count: vi.fn(async (args: { where: { representative: { ownerId: string } } }) => {
      this.alertOwnerScopes.push(["approval", args.where.representative.ownerId]);
      return this.alertCounts.approvals;
    }),
  };

  readonly walletExceptionCase = {
    count: vi.fn(async (args: { where: { ownerId: string } }) => {
      this.alertOwnerScopes.push(["wallet", args.where.ownerId]);
      return this.alertCounts.walletIssues;
    }),
  };

  readonly representativeChannelBinding = {
    count: vi.fn(async (args: { where: { representative: { ownerId: string } } }) => {
      this.alertOwnerScopes.push(["channel", args.where.representative.ownerId]);
      return this.alertCounts.channelIssues;
    }),
  };

  readonly $transaction = vi.fn(async (
    operation: (transaction: unknown) => Promise<void>,
  ) => {
    if (this.serializableFailuresRemaining > 0) {
      this.serializableFailuresRemaining -= 1;
      throw Object.assign(new Error("Serializable write conflict"), {
        code: "P2034",
      });
    }
    await operation(this);
  });
}

function ownerFixture(overrides: Partial<FakeOwner> = {}): FakeOwner {
  return {
    id: "owner-1",
    displayName: "Owner One",
    accountDisplayName: null,
    timezone: "UTC",
    preferredLocale: null,
    settingsVersion: 0,
    identityLinks: [],
    ...overrides,
  };
}

function validProfile(overrides: Partial<{
  displayName: string;
  timezone: string;
  preferredLocale: "zh" | "en";
  expectedVersion: number;
}> = {}) {
  return {
    displayName: "Owner One",
    timezone: "UTC",
    preferredLocale: "en" as const,
    expectedVersion: 0,
    ...overrides,
  };
}

function notificationRules(
  overrides: Partial<OwnerNotificationRules["events"]> = {},
): OwnerNotificationRules {
  return {
    schemaVersion: 1,
    events: {
      handoffRequested: true,
      approvalRequested: true,
      walletException: true,
      channelFailure: true,
      ...overrides,
    },
  };
}

function settingsOptions(
  client: FakeOwnerSettingsClient,
  env: Record<string, string | undefined> = {},
) {
  return {
    client: client as never,
    env,
  };
}
