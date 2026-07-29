import { EventType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  getOwnerSettingsSnapshot,
  updateOwnerNotificationSettings,
  updateOwnerProfileSettings,
  type OwnerNotificationRules,
} from "../src/owner-settings";
import { prisma } from "../src/prisma";
import { getWorkspaceAuditSnapshot } from "../src/workspace-audit";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("owner settings PostgreSQL concurrency", () => {
  it("replays the same payload concurrently for one idempotency key", async () => {
    const owner = await prisma.owner.create({
      data: {
        displayName: `Concurrent replay owner ${Date.now()}`,
      },
      select: {
        id: true,
      },
    });
    const request = {
      ownerId: owner.id,
      requestId: "postgres-profile-concurrent-replay",
      idempotencyKey: "postgres-profile-concurrent-replay",
      profile: {
        displayName: "Concurrent replay account",
        timezone: "Asia/Shanghai",
        preferredLocale: "zh" as const,
        expectedVersion: 0,
      },
    };

    try {
      const results = await Promise.allSettled([
        updateOwnerProfileSettings(request),
        updateOwnerProfileSettings(request),
      ]);

      expect(results.filter(
        (result) => result.status === "fulfilled",
      )).toHaveLength(2);
      expect(results.filter(
        (result) => result.status === "rejected",
      )).toHaveLength(0);
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        expect(result.value.profile).toMatchObject({
          displayName: request.profile.displayName,
          version: 1,
        });
      }
      expect(await prisma.owner.findUniqueOrThrow({
        where: { id: owner.id },
        select: { settingsVersion: true },
      })).toEqual({ settingsVersion: 1 });
      expect(await prisma.eventAudit.count({
        where: {
          ownerId: owner.id,
          idempotencyKey: request.idempotencyKey,
          type: EventType.OWNER_PROFILE_UPDATED,
        },
      })).toBe(1);
    } finally {
      await prisma.eventAudit.deleteMany({ where: { ownerId: owner.id } });
      await prisma.owner.delete({ where: { id: owner.id } });
    }
  });

  it("replays the same notification payload while creating the first row", async () => {
    const owner = await prisma.owner.create({
      data: {
        displayName: `Concurrent notification owner ${Date.now()}`,
      },
      select: {
        id: true,
      },
    });
    const request = notificationRequest(
      owner.id,
      "postgres-notifications-concurrent-replay",
      { handoffRequested: false },
    );

    try {
      const results = await Promise.allSettled([
        updateOwnerNotificationSettings(request),
        updateOwnerNotificationSettings(request),
      ]);

      expect(results.filter(
        (result) => result.status === "fulfilled",
      )).toHaveLength(2);
      expect(results.filter(
        (result) => result.status === "rejected",
      )).toHaveLength(0);
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        expect(result.value.notifications).toMatchObject({
          version: 1,
          rules: {
            events: {
              handoffRequested: false,
              walletException: true,
            },
          },
        });
      }
      expect(await prisma.ownerNotificationSettings.findUniqueOrThrow({
        where: { ownerId: owner.id },
        select: { version: true },
      })).toEqual({ version: 1 });
      expect(await prisma.eventAudit.count({
        where: {
          ownerId: owner.id,
          idempotencyKey: request.idempotencyKey,
          type: EventType.OWNER_NOTIFICATION_PREFERENCES_UPDATED,
        },
      })).toBe(1);
    } finally {
      await prisma.eventAudit.deleteMany({ where: { ownerId: owner.id } });
      await prisma.owner.delete({ where: { id: owner.id } });
    }
  });

  it("rejects a different payload racing on the same idempotency key", async () => {
    const owner = await prisma.owner.create({
      data: {
        displayName: `Concurrent conflict owner ${Date.now()}`,
      },
      select: {
        id: true,
      },
    });
    const sharedIdempotencyKey = "postgres-profile-concurrent-conflict";
    const requests = [
      {
        ownerId: owner.id,
        requestId: "postgres-profile-concurrent-conflict-a",
        idempotencyKey: sharedIdempotencyKey,
        profile: {
          displayName: "Concurrent conflict account A",
          timezone: "Asia/Shanghai",
          preferredLocale: "zh" as const,
          expectedVersion: 0,
        },
      },
      {
        ownerId: owner.id,
        requestId: "postgres-profile-concurrent-conflict-b",
        idempotencyKey: sharedIdempotencyKey,
        profile: {
          displayName: "Concurrent conflict account B",
          timezone: "America/New_York",
          preferredLocale: "en" as const,
          expectedVersion: 0,
        },
      },
    ] as const;

    try {
      const results = await Promise.allSettled(
        requests.map((request) => updateOwnerProfileSettings(request)),
      );
      const winnerIndex = results.findIndex(
        (result) => result.status === "fulfilled",
      );

      expect(results.filter(
        (result) => result.status === "fulfilled",
      )).toHaveLength(1);
      expect(results.filter(
        (result) =>
          result.status === "rejected"
          && isIdempotencyConflict(result.reason),
      )).toHaveLength(1);
      expect(winnerIndex).toBeGreaterThanOrEqual(0);

      const winner = requests[winnerIndex]!;
      expect(await prisma.owner.findUniqueOrThrow({
        where: { id: owner.id },
        select: {
          accountDisplayName: true,
          timezone: true,
          preferredLocale: true,
          settingsVersion: true,
        },
      })).toEqual({
        accountDisplayName: winner.profile.displayName,
        timezone: winner.profile.timezone,
        preferredLocale: winner.profile.preferredLocale,
        settingsVersion: 1,
      });
      expect(await prisma.eventAudit.count({
        where: {
          ownerId: owner.id,
          idempotencyKey: sharedIdempotencyKey,
          type: EventType.OWNER_PROFILE_UPDATED,
        },
      })).toBe(1);
    } finally {
      await prisma.eventAudit.deleteMany({ where: { ownerId: owner.id } });
      await prisma.owner.delete({ where: { id: owner.id } });
    }
  });

  it("keeps account identity private, enforces CAS, replays idempotently, and exposes owner-only audit", async () => {
    const owner = await prisma.owner.create({
      data: {
        displayName: `Public attribution ${Date.now()}`,
      },
      select: {
        id: true,
        displayName: true,
      },
    });

    try {
      const profileRequests = [
        {
          ownerId: owner.id,
          requestId: "postgres-profile-a",
          idempotencyKey: "postgres-profile-a",
          profile: {
            displayName: "Private account A",
            timezone: "Asia/Shanghai",
            preferredLocale: "zh" as const,
            expectedVersion: 0,
          },
        },
        {
          ownerId: owner.id,
          requestId: "postgres-profile-b",
          idempotencyKey: "postgres-profile-b",
          profile: {
            displayName: "Private account B",
            timezone: "America/New_York",
            preferredLocale: "en" as const,
            expectedVersion: 0,
          },
        },
      ] as const;
      const profileResults = await Promise.allSettled(
        profileRequests.map((request) => updateOwnerProfileSettings(request)),
      );
      const profileWinnerIndex = profileResults.findIndex(
        (result) => result.status === "fulfilled",
      );
      expect(profileResults.filter(
        (result) => result.status === "fulfilled",
      )).toHaveLength(1);
      expect(profileResults.filter(
        (result) =>
          result.status === "rejected"
          && isVersionConflict(result.reason),
      )).toHaveLength(1);
      expect(profileWinnerIndex).toBeGreaterThanOrEqual(0);

      const winningProfileRequest = profileRequests[profileWinnerIndex]!;
      await expect(
        updateOwnerProfileSettings(winningProfileRequest),
      ).resolves.toMatchObject({
        profile: {
          displayName: winningProfileRequest.profile.displayName,
          version: 1,
        },
      });

      const storedOwner = await prisma.owner.findUniqueOrThrow({
        where: { id: owner.id },
        select: {
          displayName: true,
          accountDisplayName: true,
          settingsVersion: true,
        },
      });
      expect(storedOwner).toEqual({
        displayName: owner.displayName,
        accountDisplayName: winningProfileRequest.profile.displayName,
        settingsVersion: 1,
      });

      const notificationRequests = [
        notificationRequest(owner.id, "postgres-notifications-a", {
          handoffRequested: false,
        }),
        notificationRequest(owner.id, "postgres-notifications-b", {
          approvalRequested: false,
        }),
      ] as const;
      const notificationResults = await Promise.allSettled(
        notificationRequests.map((request) =>
          updateOwnerNotificationSettings(request)
        ),
      );
      expect(notificationResults.filter(
        (result) => result.status === "fulfilled",
      )).toHaveLength(1);
      expect(notificationResults.filter(
        (result) =>
          result.status === "rejected"
          && isVersionConflict(result.reason),
      )).toHaveLength(1);

      const snapshot = await getOwnerSettingsSnapshot({ ownerId: owner.id });
      expect(snapshot).toMatchObject({
        dataSource: "database",
        persistenceAvailable: true,
        profile: {
          displayName: winningProfileRequest.profile.displayName,
          version: 1,
        },
        notifications: {
          version: 1,
          rules: {
            events: {
              walletException: true,
            },
          },
        },
      });

      const settingsAudit = await getWorkspaceAuditSnapshot({
        ownerId: owner.id,
        activeRepresentativeSlug: "",
        category: "settings",
      });
      expect(settingsAudit?.workspace.representativeCount).toBe(0);
      expect(settingsAudit?.events).toHaveLength(2);
      expect(new Set(settingsAudit?.events.map((event) => event.type))).toEqual(
        new Set([
          "owner_profile_updated",
          "owner_notification_preferences_updated",
        ]),
      );
      expect(settingsAudit?.events.every(
        (event) =>
          event.representativeName === null
          && !JSON.stringify(event.metadata).includes("Private account"),
      )).toBe(true);

      expect(await prisma.eventAudit.count({
        where: {
          ownerId: owner.id,
          type: EventType.OWNER_PROFILE_UPDATED,
        },
      })).toBe(1);
      expect(await prisma.eventAudit.count({
        where: {
          ownerId: owner.id,
          type: EventType.OWNER_NOTIFICATION_PREFERENCES_UPDATED,
        },
      })).toBe(1);
    } finally {
      await prisma.eventAudit.deleteMany({ where: { ownerId: owner.id } });
      await prisma.owner.delete({ where: { id: owner.id } });
    }
  });
});

function notificationRequest(
  ownerId: string,
  requestId: string,
  overrides: Partial<OwnerNotificationRules["events"]>,
) {
  return {
    ownerId,
    requestId,
    idempotencyKey: requestId,
    notifications: {
      rules: {
        schemaVersion: 1 as const,
        events: {
          handoffRequested: true,
          approvalRequested: true,
          walletException: true as const,
          channelFailure: true,
          ...overrides,
        },
      },
      expectedVersion: 0,
    },
  };
}

function isVersionConflict(value: unknown) {
  return (
    value instanceof Error
    && "code" in value
    && value.code === "owner_settings_version_conflict"
  );
}

function isIdempotencyConflict(value: unknown) {
  return (
    value instanceof Error
    && "code" in value
    && value.code === "owner_settings_idempotency_conflict"
  );
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for the owner settings PostgreSQL E2E.",
    );
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
  ) {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
