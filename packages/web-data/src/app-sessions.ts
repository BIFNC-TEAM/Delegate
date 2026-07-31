import { createHash, randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

export const DEFAULT_APP_SESSION_IDLE_TTL_SECONDS = 60 * 60 * 24;
export const DEFAULT_APP_SESSION_ABSOLUTE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const MAX_APP_SESSION_IDLE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const MAX_APP_SESSION_ABSOLUTE_TTL_SECONDS = 60 * 60 * 24 * 365;
export const APP_SESSION_TOUCH_INTERVAL_SECONDS = 60 * 5;

export type AppSessionApplicationValue =
  | "DASHBOARD"
  | "PUBLIC_REPRESENTATIVES";
type AccountStatusValue =
  | "ACTIVE"
  | "SUSPENDED"
  | "DELETION_PENDING"
  | "DELETED";

type AppSessionAccountRecord = {
  id: string;
  status: AccountStatusValue;
};

type AppSessionAuthIdentityRecord = {
  id: string;
  accountId: string;
  status: "ACTIVE" | "REVOKED";
};

export type AppSessionRecord = {
  id: string;
  accountId: string;
  authIdentityId: string;
  application: AppSessionApplicationValue;
  tokenHash: Uint8Array;
  activeOrganizationId: string | null;
  logtoSessionId: string | null;
  issuedAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AppSessionWithAccount = AppSessionRecord & {
  account: AppSessionAccountRecord;
  authIdentity: AppSessionAuthIdentityRecord;
};

type AppSessionWhere = {
  tokenHash: Uint8Array;
  application: AppSessionApplicationValue;
};

export type AppSessionClient = {
  authIdentity: {
    findUnique(args: {
      where: { id: string };
      include: { account: true };
    }): Promise<(AppSessionAuthIdentityRecord & {
      account: AppSessionAccountRecord;
    }) | null>;
  };
  appSession: {
    create(args: {
      data: {
        accountId: string;
        authIdentityId: string;
        application: AppSessionApplicationValue;
        tokenHash: Uint8Array;
        activeOrganizationId: string | null;
        logtoSessionId: string | null;
        issuedAt: Date;
        lastSeenAt: Date;
        idleExpiresAt: Date;
        absoluteExpiresAt: Date;
        deviceLabel: string | null;
        userAgent: string | null;
      };
    }): Promise<AppSessionRecord>;
    findFirst(args: {
      where: AppSessionWhere;
      include: { account: true; authIdentity: true };
    }): Promise<AppSessionWithAccount | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  $transaction?<T>(
    operation: (tx: AppSessionClient) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

export type CreateAppSessionInput = {
  accountId: string;
  authIdentityId: string;
  application: AppSessionApplicationValue;
  activeOrganizationId?: string | null | undefined;
  logtoSessionId?: string | null | undefined;
  idleTtlSeconds?: number | undefined;
  absoluteTtlSeconds?: number | undefined;
  deviceLabel?: string | null | undefined;
  userAgent?: string | null | undefined;
  now?: Date | undefined;
};

export type CreatedAppSession = {
  /**
   * Returned exactly once. Persist only in a secure, HttpOnly application
   * cookie; the database stores only its SHA-256 digest.
   */
  token: string;
  session: AppSessionRecord;
};

export class AppSessionAccountUnavailableError extends Error {
  readonly code = "APP_SESSION_ACCOUNT_UNAVAILABLE";

  constructor(readonly accountStatus: AccountStatusValue | "MISSING") {
    super(`Cannot create an AppSession for account status ${accountStatus}.`);
    this.name = "AppSessionAccountUnavailableError";
  }
}

export class AppSessionIdentityUnavailableError extends Error {
  readonly code = "APP_SESSION_IDENTITY_UNAVAILABLE";

  constructor(readonly identityStatus: "REVOKED" | "MISSING" | "MISMATCH") {
    super(`Cannot create an AppSession for identity status ${identityStatus}.`);
    this.name = "AppSessionIdentityUnavailableError";
  }
}

export class AppSessionWorkspaceSelectionUnavailableError extends Error {
  readonly code = "APP_SESSION_WORKSPACE_SELECTION_UNAVAILABLE";

  constructor() {
    super(
      "AppSession activeOrganizationId is disabled until Account membership authorization is available.",
    );
    this.name = "AppSessionWorkspaceSelectionUnavailableError";
  }
}

export class InvalidAppSessionTokenError extends Error {
  readonly code = "INVALID_APP_SESSION_TOKEN";

  constructor() {
    super("AppSession token must be an opaque 32-byte base64url value.");
    this.name = "InvalidAppSessionTokenError";
  }
}

export async function createAppSession(
  input: CreateAppSessionInput,
  client: AppSessionClient = prisma as unknown as AppSessionClient,
): Promise<CreatedAppSession> {
  const accountId = normalizeRequired(input.accountId, "accountId");
  const authIdentityId = normalizeRequired(
    input.authIdentityId,
    "authIdentityId",
  );
  const application = normalizeApplication(input.application);
  const now = normalizeDate(input.now ?? new Date(), "now");
  const idleTtlSeconds = normalizeTtl(
    input.idleTtlSeconds,
    DEFAULT_APP_SESSION_IDLE_TTL_SECONDS,
    MAX_APP_SESSION_IDLE_TTL_SECONDS,
    "idleTtlSeconds",
  );
  const absoluteTtlSeconds = normalizeTtl(
    input.absoluteTtlSeconds,
    DEFAULT_APP_SESSION_ABSOLUTE_TTL_SECONDS,
    MAX_APP_SESSION_ABSOLUTE_TTL_SECONDS,
    "absoluteTtlSeconds",
  );
  if (idleTtlSeconds > absoluteTtlSeconds) {
    throw new Error("idleTtlSeconds must not exceed absoluteTtlSeconds.");
  }
  const activeOrganizationId = normalizeOptionalIdentifier(
    input.activeOrganizationId,
    "activeOrganizationId",
  );
  if (activeOrganizationId !== null) {
    throw new AppSessionWorkspaceSelectionUnavailableError();
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashAppSessionToken(token);
  const idleExpiresAt = addSeconds(now, idleTtlSeconds);
  const absoluteExpiresAt = addSeconds(now, absoluteTtlSeconds);
  const data = {
    accountId,
    authIdentityId,
    application,
    tokenHash,
    activeOrganizationId: null,
    logtoSessionId: normalizeOptionalBounded(
      input.logtoSessionId,
      255,
      "logtoSessionId",
    ),
    issuedAt: now,
    lastSeenAt: now,
    idleExpiresAt,
    absoluteExpiresAt,
    deviceLabel: normalizeOptionalBounded(
      input.deviceLabel,
      120,
      "deviceLabel",
    ),
    userAgent: normalizeOptionalBounded(input.userAgent, 512, "userAgent"),
  };

  const session = await runAppSessionTransaction(client, async (tx) => {
    const authIdentity = await tx.authIdentity.findUnique({
      where: { id: authIdentityId },
      include: { account: true },
    });
    if (!authIdentity) {
      throw new AppSessionIdentityUnavailableError("MISSING");
    }
    if (authIdentity.accountId !== accountId) {
      throw new AppSessionIdentityUnavailableError("MISMATCH");
    }
    if (authIdentity.account.id !== accountId) {
      throw new AppSessionIdentityUnavailableError("MISMATCH");
    }
    if (authIdentity.status !== "ACTIVE") {
      throw new AppSessionIdentityUnavailableError("REVOKED");
    }
    if (authIdentity.account.status !== "ACTIVE") {
      throw new AppSessionAccountUnavailableError(
        authIdentity.account.status,
      );
    }
    return tx.appSession.create({ data });
  });

  return { token, session };
}

/**
 * Resolves an application-scoped local session without extending it.
 * Invalid, expired, revoked, cross-application, and inactive-account tokens
 * all fail closed as null. A non-null activeOrganizationId also fails closed
 * until Account membership authorization replaces the temporary DB guard.
 */
export async function resolveAppSession(
  input: {
    token: string;
    application: AppSessionApplicationValue;
    now?: Date | undefined;
  },
  client: AppSessionClient = prisma as unknown as AppSessionClient,
): Promise<AppSessionRecord | null> {
  const application = normalizeApplication(input.application);
  const now = normalizeDate(input.now ?? new Date(), "now");
  const tokenHash = tryHashAppSessionToken(input.token);
  if (!tokenHash) {
    return null;
  }
  const session = await findAppSession(client, tokenHash, application);
  return isUsableAppSession(session, now) ? stripAccount(session) : null;
}

/**
 * Extends the idle window, capped by the immutable absolute expiry. The
 * conditional update keeps a concurrent revoke or expiry authoritative.
 */
export async function touchAppSession(
  input: {
    token: string;
    application: AppSessionApplicationValue;
    idleTtlSeconds?: number | undefined;
    now?: Date | undefined;
  },
  client: AppSessionClient = prisma as unknown as AppSessionClient,
): Promise<AppSessionRecord | null> {
  const application = normalizeApplication(input.application);
  const now = normalizeDate(input.now ?? new Date(), "now");
  const idleTtlSeconds = normalizeTtl(
    input.idleTtlSeconds,
    DEFAULT_APP_SESSION_IDLE_TTL_SECONDS,
    MAX_APP_SESSION_IDLE_TTL_SECONDS,
    "idleTtlSeconds",
  );
  const tokenHash = tryHashAppSessionToken(input.token);
  if (!tokenHash) {
    return null;
  }

  return runAppSessionTransaction(client, async (tx) => {
    const current = await tx.appSession.findFirst({
      where: { tokenHash, application },
      include: { account: true, authIdentity: true },
    });
    if (!isUsableAppSession(current, now)) {
      return null;
    }
    if (
      now.getTime() - current.lastSeenAt.getTime()
      < APP_SESSION_TOUCH_INTERVAL_SECONDS * 1_000
    ) {
      return stripAccount(current);
    }
    const lastSeenAt =
      now.getTime() > current.lastSeenAt.getTime() ? now : current.lastSeenAt;
    const proposedIdleExpiry = addSeconds(lastSeenAt, idleTtlSeconds);
    const idleExpiresAt = new Date(
      Math.min(
        current.absoluteExpiresAt.getTime(),
        Math.max(
          current.idleExpiresAt.getTime(),
          proposedIdleExpiry.getTime(),
        ),
      ),
    );
    const updated = await tx.appSession.updateMany({
      where: {
        id: current.id,
        application,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
        account: { status: "ACTIVE" },
        authIdentity: { status: "ACTIVE" },
      },
      data: { lastSeenAt, idleExpiresAt },
    });
    if (updated.count !== 1) {
      return null;
    }
    const refreshed = await tx.appSession.findFirst({
      where: { tokenHash, application },
      include: { account: true, authIdentity: true },
    });
    return isUsableAppSession(refreshed, now)
      ? stripAccount(refreshed)
      : null;
  });
}

export async function revokeAppSession(
  input: {
    token: string;
    application: AppSessionApplicationValue;
    reason?: string | undefined;
    now?: Date | undefined;
  },
  client: AppSessionClient = prisma as unknown as AppSessionClient,
): Promise<boolean> {
  const application = normalizeApplication(input.application);
  const revokedAt = normalizeDate(input.now ?? new Date(), "now");
  const tokenHash = tryHashAppSessionToken(input.token);
  if (!tokenHash) {
    return false;
  }
  const result = await client.appSession.updateMany({
    where: {
      tokenHash,
      application,
      revokedAt: null,
    },
    data: {
      revokedAt,
      revokedReason: normalizeRevocationReason(input.reason),
    },
  });
  return result.count === 1;
}

/**
 * Revokes every local session for one Account in one application. Callers must
 * invoke this explicitly for each application if product intent is a
 * cross-application sign-out.
 */
export async function revokeAllAppSessions(
  input: {
    accountId: string;
    application: AppSessionApplicationValue;
    reason?: string | undefined;
    now?: Date | undefined;
  },
  client: AppSessionClient = prisma as unknown as AppSessionClient,
): Promise<number> {
  const result = await client.appSession.updateMany({
    where: {
      accountId: normalizeRequired(input.accountId, "accountId"),
      application: normalizeApplication(input.application),
      revokedAt: null,
    },
    data: {
      revokedAt: normalizeDate(input.now ?? new Date(), "now"),
      revokedReason: normalizeRevocationReason(input.reason),
    },
  });
  return result.count;
}

export function hashAppSessionToken(token: string): Uint8Array {
  const normalized = token;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(normalized)) {
    throw new InvalidAppSessionTokenError();
  }
  const decoded = Buffer.from(normalized, "base64url");
  if (
    decoded.byteLength !== 32
    || decoded.toString("base64url") !== normalized
  ) {
    throw new InvalidAppSessionTokenError();
  }
  return createHash("sha256").update(decoded).digest();
}

async function findAppSession(
  client: AppSessionClient,
  tokenHash: Uint8Array,
  application: AppSessionApplicationValue,
) {
  return client.appSession.findFirst({
    where: {
      tokenHash,
      application,
    },
    include: { account: true, authIdentity: true },
  });
}

function tryHashAppSessionToken(token: string): Uint8Array | null {
  try {
    return hashAppSessionToken(token);
  } catch (error) {
    if (error instanceof InvalidAppSessionTokenError) {
      return null;
    }
    throw error;
  }
}

function isUsableAppSession(
  session: AppSessionWithAccount | null,
  now: Date,
): session is AppSessionWithAccount {
  return Boolean(
    session
    && session.account.id === session.accountId
    && session.authIdentity.id === session.authIdentityId
    && session.authIdentity.accountId === session.accountId
    && session.account.status === "ACTIVE"
    && session.authIdentity.status === "ACTIVE"
    && session.activeOrganizationId === null
    && session.revokedAt === null
    && session.idleExpiresAt.getTime() > now.getTime()
    && session.absoluteExpiresAt.getTime() > now.getTime(),
  );
}

function stripAccount(session: AppSessionWithAccount): AppSessionRecord {
  const {
    account: _account,
    authIdentity: _authIdentity,
    ...record
  } = session;
  return record;
}

function runAppSessionTransaction<T>(
  client: AppSessionClient,
  operation: (tx: AppSessionClient) => Promise<T>,
): Promise<T> {
  if (!client.$transaction) {
    return operation(client);
  }
  return runWithPrismaWriteConflictRetry(
    () =>
      client.$transaction!(
        operation,
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
  );
}

function normalizeApplication(
  application: AppSessionApplicationValue,
): AppSessionApplicationValue {
  if (
    application !== "DASHBOARD"
    && application !== "PUBLIC_REPRESENTATIVES"
  ) {
    throw new Error("Unsupported AppSession application.");
  }
  return application;
}

function normalizeTtl(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized)
    || normalized <= 0
    || normalized > maximum
  ) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return normalized;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalIdentifier(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeRequired(value, label);
}

function normalizeOptionalBounded(
  value: string | null | undefined,
  maximumLength: number,
  label: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length > maximumLength) {
    throw new Error(`${label} must not exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function normalizeRevocationReason(reason: string | undefined): string {
  return normalizeOptionalBounded(
    reason,
    200,
    "reason",
  ) ?? "LOCAL_SESSION_REVOKED";
}

function normalizeDate(value: Date, label: string): Date {
  if (
    !(value instanceof Date)
    || !Number.isFinite(value.getTime())
  ) {
    throw new Error(`AppSession ${label} must be a valid Date.`);
  }
  return value;
}
