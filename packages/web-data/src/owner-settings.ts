import { createHmac } from "node:crypto";

import { EventType, Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "./prisma";
import { readDelegateAuthSessionSecret } from "./auth-session";

export type OwnerPreferredLocale = "zh" | "en";

export type OwnerNotificationRules = {
  schemaVersion: 1;
  events: {
    handoffRequested: boolean;
    approvalRequested: boolean;
    walletException: true;
    channelFailure: boolean;
  };
};

export type OwnerSettingsSnapshot = {
  dataSource: "database" | "unavailable";
  persistenceAvailable: boolean;
  profile: {
    displayName: string;
    timezone: string;
    preferredLocale: OwnerPreferredLocale | null;
    version: number;
  } | null;
  security: {
    provider: "logto" | null;
    connectionStatus: "connected" | "unavailable";
    email: string | null;
    emailVerification: "verified" | "unknown";
    phone: string | null;
    phoneVerification: "verified" | "unknown";
    identityVerifiedAt: string | null;
    managementUrl: string | null;
  };
  notifications: {
    delivery: "dashboard_navigation";
    rules: OwnerNotificationRules;
    version: number;
  } | null;
  recentChanges: Array<{
    id: string;
    type: "owner_profile_updated" | "owner_notification_preferences_updated";
    changedFields: string[];
    actorId: string | null;
    createdAt: string;
  }>;
};

export type OwnerOperationalAlertSummary = {
  dataSource: "database" | "unavailable";
  total: number;
  topics: {
    handoffs: OwnerOperationalAlertTopic;
    approvals: OwnerOperationalAlertTopic;
    walletIssues: OwnerOperationalAlertTopic & { mandatory: true };
    channelIssues: OwnerOperationalAlertTopic;
  };
};

type OwnerOperationalAlertTopic = {
  count: number;
  enabled: boolean;
};

export class OwnerSettingsError extends Error {
  constructor(
    readonly code:
      | "owner_settings_invalid"
      | "owner_settings_not_found"
      | "owner_settings_version_conflict"
      | "owner_settings_idempotency_conflict"
      | "owner_settings_persistence_unavailable",
    message: string,
    readonly statusCode: 400 | 404 | 409 | 503,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "OwnerSettingsError";
  }
}

export const defaultOwnerNotificationRules: OwnerNotificationRules = {
  schemaVersion: 1,
  events: {
    handoffRequested: true,
    approvalRequested: true,
    walletException: true,
    channelFailure: true,
  },
};

const preferredLocaleSchema = z.enum(["zh", "en"]);
const expectedVersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const maximumSerializableAttempts = 3;

export const ownerProfileSettingsUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  timezone: z.string().trim().min(1).max(100).refine(
    isValidIanaTimeZone,
    "Select a valid IANA time zone.",
  ),
  preferredLocale: preferredLocaleSchema,
  expectedVersion: expectedVersionSchema,
}).strict();

export const ownerNotificationRulesSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.object({
    handoffRequested: z.boolean(),
    approvalRequested: z.boolean(),
    walletException: z.literal(true),
    channelFailure: z.boolean(),
  }).strict(),
}).strict();

export const ownerNotificationSettingsUpdateSchema = z.object({
  rules: ownerNotificationRulesSchema,
  expectedVersion: expectedVersionSchema,
}).strict();

type OwnerSettingsClient = typeof prisma;
type OwnerSettingsClientOptions = {
  client?: OwnerSettingsClient;
  env?: Record<string, string | undefined>;
};

type OwnerSettingsMutationMetadata = {
  requestId: string;
  idempotencyKey: string;
};

export async function getOwnerSettingsSnapshot(
  input: { ownerId: string },
  options: OwnerSettingsClientOptions = {},
): Promise<OwnerSettingsSnapshot> {
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  if (!isPersistenceAvailable(options)) {
    return buildUnavailableOwnerSettingsSnapshot(options.env);
  }
  const client = options.client ?? prisma;
  const owner = await client.owner.findUnique({
    where: { id: ownerId },
    select: {
      id: true,
      displayName: true,
      accountDisplayName: true,
      timezone: true,
      preferredLocale: true,
      settingsVersion: true,
      identityLinks: {
        where: { provider: "LOGTO" },
        orderBy: [{ updatedAt: "desc" }],
        take: 1,
        select: {
          email: true,
          phone: true,
          verifiedAt: true,
          emailVerifiedAt: true,
          phoneVerifiedAt: true,
        },
      },
      notificationSettings: {
        select: {
          rules: true,
          version: true,
        },
      },
    },
  });
  if (!owner) {
    throw new OwnerSettingsError(
      "owner_settings_not_found",
      "Owner settings were not found.",
      404,
    );
  }

  const recentAudits = await client.eventAudit.findMany({
    where: {
      ownerId,
      type: {
        in: [
          EventType.OWNER_PROFILE_UPDATED,
          EventType.OWNER_NOTIFICATION_PREFERENCES_UPDATED,
        ],
      },
    },
    select: {
      id: true,
      type: true,
      payload: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 8,
  });
  const identity = owner.identityLinks[0] ?? null;

  return {
    dataSource: "database",
    persistenceAvailable: true,
    profile: {
      displayName: owner.accountDisplayName ?? owner.displayName,
      timezone: owner.timezone,
      preferredLocale: normalizeStoredLocale(owner.preferredLocale),
      version: owner.settingsVersion,
    },
    security: {
      provider: identity ? "logto" : null,
      connectionStatus: identity ? "connected" : "unavailable",
      email: identity?.email ?? null,
      emailVerification: identity?.emailVerifiedAt ? "verified" : "unknown",
      phone: identity?.phone ?? null,
      phoneVerification: identity?.phoneVerifiedAt ? "verified" : "unknown",
      identityVerifiedAt: identity?.verifiedAt?.toISOString() ?? null,
      managementUrl: readLogtoAccountCenterUrl(options.env),
    },
    notifications: {
      delivery: "dashboard_navigation",
      rules: parseStoredOwnerNotificationRules(owner.notificationSettings?.rules),
      version: owner.notificationSettings?.version ?? 0,
    },
    recentChanges: recentAudits.map(serializeSettingsAudit),
  };
}

export async function getOwnerDashboardPreferences(
  input: { ownerId: string },
  options: Pick<OwnerSettingsClientOptions, "client"> = {},
): Promise<{
  displayName: string;
  preferredLocale: OwnerPreferredLocale | null;
} | null> {
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  if (!isPersistenceAvailable(options)) return null;
  const client = options.client ?? prisma;
  const owner = await client.owner.findUnique({
    where: { id: ownerId },
    select: {
      displayName: true,
      accountDisplayName: true,
      preferredLocale: true,
    },
  });
  return owner
    ? {
        displayName: owner.accountDisplayName ?? owner.displayName,
        preferredLocale: normalizeStoredLocale(owner.preferredLocale),
      }
    : null;
}

export async function getOwnerOperationalAlertSummary(
  input: { ownerId: string },
  options: Pick<OwnerSettingsClientOptions, "client"> = {},
): Promise<OwnerOperationalAlertSummary> {
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  if (!isPersistenceAvailable(options)) {
    return buildUnavailableOwnerOperationalAlertSummary();
  }
  const client = options.client ?? prisma;
  const [notificationSettings, handoffs, approvals, walletIssues, channelIssues] =
    await Promise.all([
      client.ownerNotificationSettings.findUnique({
        where: { ownerId },
        select: { rules: true },
      }),
      client.handoffRequest.count({
        where: {
          representative: { ownerId },
          status: { in: ["OPEN", "REVIEWING"] },
        },
      }),
      client.approvalRequest.count({
        where: {
          representative: { ownerId },
          status: "PENDING",
        },
      }),
      client.walletExceptionCase.count({
        where: {
          ownerId,
          status: { not: "RESOLVED" },
        },
      }),
      client.representativeChannelBinding.count({
        where: {
          representative: { ownerId },
          desiredState: "ACTIVE",
          healthStatus: { in: ["DEGRADED", "UNHEALTHY"] },
        },
      }),
    ]);
  const rules = parseStoredOwnerNotificationRules(notificationSettings?.rules);
  const topics = {
    handoffs: {
      count: handoffs,
      enabled: rules.events.handoffRequested,
    },
    approvals: {
      count: approvals,
      enabled: rules.events.approvalRequested,
    },
    walletIssues: {
      count: walletIssues,
      enabled: true,
      mandatory: true as const,
    },
    channelIssues: {
      count: channelIssues,
      enabled: rules.events.channelFailure,
    },
  };
  return {
    dataSource: "database",
    total: Object.values(topics).reduce(
      (total, topic) => total + (topic.enabled ? topic.count : 0),
      0,
    ),
    topics,
  };
}

export async function updateOwnerProfileSettings(
  input: {
    ownerId: string;
    profile: unknown;
  } & OwnerSettingsMutationMetadata,
  options: Pick<OwnerSettingsClientOptions, "client"> = {},
): Promise<OwnerSettingsSnapshot> {
  assertPersistenceAvailable(options);
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const requestId = requiredText(input.requestId, "requestId", 191);
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    "idempotencyKey",
    191,
  );
  const profile = parseMutation(
    ownerProfileSettingsUpdateSchema,
    input.profile,
  );
  const requestHash = hashSettingsRequest("profile", profile);
  const client = options.client ?? prisma;

  try {
    await runSettingsTransaction(client, async (tx) => {
      const replay = await findSettingsReplay(tx, ownerId, idempotencyKey);
      if (replay) {
        assertMatchingReplay(
          replay,
          EventType.OWNER_PROFILE_UPDATED,
          requestHash,
        );
        return;
      }
      const owner = await tx.owner.findUnique({
        where: { id: ownerId },
        select: {
          displayName: true,
          accountDisplayName: true,
          timezone: true,
          preferredLocale: true,
          settingsVersion: true,
        },
      });
      if (!owner) throw ownerSettingsNotFound();
      if (owner.settingsVersion !== profile.expectedVersion) {
        throw ownerSettingsVersionConflict();
      }
      const before = {
        displayName: owner.accountDisplayName ?? owner.displayName,
        timezone: owner.timezone,
        preferredLocale: normalizeStoredLocale(owner.preferredLocale),
      };
      const after = {
        displayName: profile.displayName,
        timezone: profile.timezone,
        preferredLocale: profile.preferredLocale,
      };
      const changedFields = changedSettingFields(before, after);
      if (!changedFields.length) {
        await tx.eventAudit.create({
          data: {
            ownerId,
            type: EventType.OWNER_PROFILE_UPDATED,
            idempotencyKey,
            requestHash,
            payload: {
              actorId: ownerId,
              requestId,
              changedFields,
              outcome: "no_change",
              expectedVersion: profile.expectedVersion,
              resultingVersion: profile.expectedVersion,
            },
          },
        });
        return;
      }

      const updated = await tx.owner.updateMany({
        where: {
          id: ownerId,
          settingsVersion: profile.expectedVersion,
        },
        data: {
          accountDisplayName: profile.displayName,
          timezone: profile.timezone,
          preferredLocale: profile.preferredLocale,
          settingsVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw ownerSettingsVersionConflict();
      await tx.eventAudit.create({
        data: {
          ownerId,
          type: EventType.OWNER_PROFILE_UPDATED,
          idempotencyKey,
          requestHash,
          payload: {
            actorId: ownerId,
            requestId,
            changedFields,
            before: {
              timezone: before.timezone,
              preferredLocale: before.preferredLocale,
            },
            after: {
              timezone: after.timezone,
              preferredLocale: after.preferredLocale,
            },
            expectedVersion: profile.expectedVersion,
            resultingVersion: profile.expectedVersion + 1,
          },
        },
      });
    });
  } catch (error) {
    await resolveMutationFailure(client, {
      error,
      ownerId,
      idempotencyKey,
      requestHash,
      type: EventType.OWNER_PROFILE_UPDATED,
    });
  }

  return getOwnerSettingsSnapshot(
    { ownerId },
    { client, env: process.env },
  );
}

export async function updateOwnerNotificationSettings(
  input: {
    ownerId: string;
    notifications: unknown;
  } & OwnerSettingsMutationMetadata,
  options: Pick<OwnerSettingsClientOptions, "client"> = {},
): Promise<OwnerSettingsSnapshot> {
  assertPersistenceAvailable(options);
  const ownerId = requiredText(input.ownerId, "ownerId", 191);
  const requestId = requiredText(input.requestId, "requestId", 191);
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    "idempotencyKey",
    191,
  );
  const notifications = parseMutation(
    ownerNotificationSettingsUpdateSchema,
    input.notifications,
  );
  const requestHash = hashSettingsRequest("notifications", notifications);
  const client = options.client ?? prisma;

  try {
    await runSettingsTransaction(client, async (tx) => {
      const replay = await findSettingsReplay(tx, ownerId, idempotencyKey);
      if (replay) {
        assertMatchingReplay(
          replay,
          EventType.OWNER_NOTIFICATION_PREFERENCES_UPDATED,
          requestHash,
        );
        return;
      }
      const [owner, current] = await Promise.all([
        tx.owner.findUnique({
          where: { id: ownerId },
          select: { id: true },
        }),
        tx.ownerNotificationSettings.findUnique({
          where: { ownerId },
          select: { rules: true, version: true },
        }),
      ]);
      if (!owner) throw ownerSettingsNotFound();
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== notifications.expectedVersion) {
        throw ownerSettingsVersionConflict();
      }
      const currentRules = parseStoredOwnerNotificationRules(current?.rules);
      const changedFields = changedNotificationRuleFields(
        currentRules,
        notifications.rules,
      );
      if (!changedFields.length) {
        await tx.eventAudit.create({
          data: {
            ownerId,
            type: EventType.OWNER_NOTIFICATION_PREFERENCES_UPDATED,
            idempotencyKey,
            requestHash,
            payload: {
              actorId: ownerId,
              requestId,
              changedFields,
              outcome: "no_change",
              expectedVersion: notifications.expectedVersion,
              resultingVersion: notifications.expectedVersion,
            },
          },
        });
        return;
      }

      if (current) {
        const updated = await tx.ownerNotificationSettings.updateMany({
          where: {
            ownerId,
            version: notifications.expectedVersion,
          },
          data: {
            rules: notifications.rules,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw ownerSettingsVersionConflict();
      } else {
        await tx.ownerNotificationSettings.create({
          data: {
            ownerId,
            rules: notifications.rules,
            version: 1,
          },
        });
      }
      await tx.eventAudit.create({
        data: {
          ownerId,
          type: EventType.OWNER_NOTIFICATION_PREFERENCES_UPDATED,
          idempotencyKey,
          requestHash,
          payload: {
            actorId: ownerId,
            requestId,
            changedFields,
            before: currentRules,
            after: notifications.rules,
            expectedVersion: notifications.expectedVersion,
            resultingVersion: notifications.expectedVersion + 1,
          },
        },
      });
    });
  } catch (error) {
    await resolveMutationFailure(client, {
      error,
      ownerId,
      idempotencyKey,
      requestHash,
      type: EventType.OWNER_NOTIFICATION_PREFERENCES_UPDATED,
    });
  }

  return getOwnerSettingsSnapshot(
    { ownerId },
    { client, env: process.env },
  );
}

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function parseStoredOwnerNotificationRules(
  value: unknown,
): OwnerNotificationRules {
  const parsed = ownerNotificationRulesSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : structuredClone(defaultOwnerNotificationRules);
}

export function readLogtoAccountCenterUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.LOGTO_ACCOUNT_CENTER_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username
      || url.password
    ) {
      return null;
    }
    if (
      url.protocol === "http:"
      && (
        env.NODE_ENV === "production"
        || !isLoopbackHostname(url.hostname)
      )
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function buildUnavailableOwnerSettingsSnapshot(
  env: Record<string, string | undefined> = process.env,
): OwnerSettingsSnapshot {
  return {
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
      managementUrl: readLogtoAccountCenterUrl(env),
    },
    notifications: null,
    recentChanges: [],
  };
}

export function buildUnavailableOwnerOperationalAlertSummary(): OwnerOperationalAlertSummary {
  return {
    dataSource: "unavailable",
    total: 0,
    topics: {
      handoffs: { count: 0, enabled: false },
      approvals: { count: 0, enabled: false },
      walletIssues: { count: 0, enabled: true, mandatory: true },
      channelIssues: { count: 0, enabled: false },
    },
  };
}

function normalizeStoredLocale(value: string | null): OwnerPreferredLocale | null {
  const parsed = preferredLocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMutation<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fieldErrors = Object.fromEntries(
    parsed.error.issues.map((issue) => [
      String(issue.path[0] ?? "request"),
      issue.message,
    ]),
  );
  throw new OwnerSettingsError(
    "owner_settings_invalid",
    "Review the highlighted settings and try again.",
    400,
    fieldErrors,
  );
}

function requiredText(value: string, field: string, maximumLength: number) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new OwnerSettingsError(
      "owner_settings_invalid",
      `${field} is invalid.`,
      400,
      { [field]: `${field} is invalid.` },
    );
  }
  return normalized;
}

function isPersistenceAvailable(
  options: Pick<OwnerSettingsClientOptions, "client">,
) {
  return Boolean(options.client || process.env.DATABASE_URL?.trim());
}

function assertPersistenceAvailable(
  options: Pick<OwnerSettingsClientOptions, "client">,
) {
  if (isPersistenceAvailable(options)) return;
  throw new OwnerSettingsError(
    "owner_settings_persistence_unavailable",
    "Settings persistence is unavailable.",
    503,
  );
}

function ownerSettingsNotFound() {
  return new OwnerSettingsError(
    "owner_settings_not_found",
    "Owner settings were not found.",
    404,
  );
}

function ownerSettingsVersionConflict() {
  return new OwnerSettingsError(
    "owner_settings_version_conflict",
    "These settings changed in another session. Reload the latest values before saving.",
    409,
  );
}

function hashSettingsRequest(section: string, payload: unknown) {
  return createHmac("sha256", readDelegateAuthSessionSecret())
    .update(JSON.stringify({ section, payload }))
    .digest("hex");
}

function changedSettingFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

function changedNotificationRuleFields(
  before: OwnerNotificationRules,
  after: OwnerNotificationRules,
) {
  return Object.keys(after.events)
    .filter((key) => (
      before.events[key as keyof OwnerNotificationRules["events"]]
      !== after.events[key as keyof OwnerNotificationRules["events"]]
    ))
    .map((key) => `events.${key}`);
}

async function runSettingsTransaction(
  client: OwnerSettingsClient,
  operation: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  for (let attempt = 1; attempt <= maximumSerializableAttempts; attempt += 1) {
    try {
      await client.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      return;
    } catch (error) {
      if (prismaErrorCode(error) !== "P2034") throw error;
      if (attempt === maximumSerializableAttempts) {
        throw ownerSettingsVersionConflict();
      }
    }
  }
}

async function findSettingsReplay(
  tx: Prisma.TransactionClient,
  ownerId: string,
  idempotencyKey: string,
) {
  return tx.eventAudit.findUnique({
    where: {
      ownerId_idempotencyKey: {
        ownerId,
        idempotencyKey,
      },
    },
    select: {
      type: true,
      requestHash: true,
    },
  });
}

function assertMatchingReplay(
  replay: { type: EventType; requestHash: string | null },
  type: EventType,
  requestHash: string,
) {
  if (replay.type === type && replay.requestHash === requestHash) return;
  throw new OwnerSettingsError(
    "owner_settings_idempotency_conflict",
    "This idempotency key belongs to a different settings request.",
    409,
  );
}

async function resolveMutationFailure(
  client: OwnerSettingsClient,
  input: {
    error: unknown;
    ownerId: string;
    idempotencyKey: string;
    requestHash: string;
    type: EventType;
  },
) {
  if (input.error instanceof OwnerSettingsError) throw input.error;
  if (prismaErrorCode(input.error) !== "P2002") throw input.error;
  const replay = await client.eventAudit.findUnique({
    where: {
      ownerId_idempotencyKey: {
        ownerId: input.ownerId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: {
      type: true,
      requestHash: true,
    },
  });
  if (!replay) throw ownerSettingsVersionConflict();
  assertMatchingReplay(replay, input.type, input.requestHash);
}

function prismaErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function serializeSettingsAudit(record: {
  id: string;
  type: EventType;
  payload: Prisma.JsonValue;
  createdAt: Date;
}): OwnerSettingsSnapshot["recentChanges"][number] {
  const payload = asRecord(record.payload);
  const changedFields = Array.isArray(payload?.changedFields)
    ? payload.changedFields.filter(
        (field): field is string => typeof field === "string",
      )
    : [];
  return {
    id: record.id,
    type: record.type === EventType.OWNER_PROFILE_UPDATED
      ? "owner_profile_updated"
      : "owner_notification_preferences_updated",
    changedFields,
    actorId: typeof payload?.actorId === "string" ? payload.actorId : null,
    createdAt: record.createdAt.toISOString(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
