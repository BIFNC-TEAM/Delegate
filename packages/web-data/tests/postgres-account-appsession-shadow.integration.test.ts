import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  resolveAccountShadowForVerifiedPrincipal,
  type VerifiedAccountPrincipal,
} from "../src/account-shadow";
import {
  AccountSessionPersonaConflictError,
  issueAccountSessionShadow,
  type AccountSessionShadowClient,
} from "../src/account-session-shadow";
import {
  APP_SESSION_TOUCH_INTERVAL_SECONDS,
  createAppSession,
  resolveAppSession,
  revokeAppSession,
  touchAppSession,
} from "../src/app-sessions";
import { prisma } from "../src/prisma";

const describePostgres =
  process.env.DELEGATE_ACCOUNT_SESSION_POSTGRES_E2E === "1"
    ? describe
    : describe.skip;

if (process.env.DELEGATE_ACCOUNT_SESSION_POSTGRES_E2E === "1") {
  assertSafePostgresTarget();
}

describePostgres("Account/AppSession shadow PostgreSQL 16", () => {
  beforeAll(async () => {
    const [version] = await prisma.$queryRaw<
      Array<{ server_version_num: string }>
    >`SELECT current_setting('server_version_num') AS server_version_num`;
    const versionNumber = Number(version?.server_version_num);
    if (versionNumber < 160_000 || versionNumber >= 170_000) {
      throw new Error(
        `Account/AppSession E2E requires PostgreSQL 16; received ${version?.server_version_num ?? "unknown"}.`,
      );
    }
  });

  afterEach(async () => {
    await prisma.appSession.deleteMany();
    await prisma.owner.deleteMany();
    await prisma.audienceIdentity.deleteMany();
    await prisma.authIdentity.deleteMany();
    await prisma.account.deleteMany();
    await prisma.organization.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("enforces concurrent persona indexes, NOT VALID foreign keys, and session invariants", async () => {
    const indexes = await prisma.$queryRaw<Array<{
      index_name: string;
      indisunique: boolean;
      indisvalid: boolean;
      indisready: boolean;
      indislive: boolean;
    }>>`
      SELECT
        index_class.relname AS index_name,
        index_state.indisunique,
        index_state.indisvalid,
        index_state.indisready,
        index_state.indislive
      FROM pg_index AS index_state
      JOIN pg_class AS index_class
        ON index_class.oid = index_state.indexrelid
      WHERE index_class.relname IN (
        'Owner_accountId_key',
        'AudienceIdentity_accountId_key'
      )
      ORDER BY index_class.relname
    `;
    expect(indexes).toEqual([
      {
        index_name: "AudienceIdentity_accountId_key",
        indisunique: true,
        indisvalid: true,
        indisready: true,
        indislive: true,
      },
      {
        index_name: "Owner_accountId_key",
        indisunique: true,
        indisvalid: true,
        indisready: true,
        indislive: true,
      },
    ]);

    const constraints = await prisma.$queryRaw<Array<{
      conname: string;
      convalidated: boolean;
    }>>`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conname IN (
        'Owner_accountId_fkey',
        'AudienceIdentity_accountId_fkey',
        'AudienceIdentity_registered_account_check',
        'AppSession_authIdentityId_accountId_fkey',
        'AppSession_active_organization_disabled_check'
      )
      ORDER BY conname
    `;
    expect(Object.fromEntries(
      constraints.map((constraint) => [
        constraint.conname,
        constraint.convalidated,
      ]),
    )).toEqual({
      AppSession_active_organization_disabled_check: true,
      AppSession_authIdentityId_accountId_fkey: true,
      AudienceIdentity_accountId_fkey: false,
      AudienceIdentity_registered_account_check: false,
      Owner_accountId_fkey: false,
    });

    await seedDatabasePrincipals();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Organization" ("id") VALUES ('organization_a')`,
    );
    await prisma.$executeRawUnsafe(
      appSessionInsertSql({
        id: "session_valid",
        tokenHexByte: "ab",
      }),
    );
    await expectDatabaseRejection(
      appSessionInsertSql({
        id: "session_duplicate_token",
        tokenHexByte: "ab",
      }),
    );

    await expectDatabaseRejection(
      `INSERT INTO "AuthIdentity" (
        "id", "accountId", "provider", "issuer", "subject",
        "verifiedAt", "lastAuthenticatedAt", "updatedAt"
      ) VALUES (
        'identity_blank_issuer', 'account_a', 'LOGTO', '  ', 'blank-issuer',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )`,
      "AuthIdentity_issuer_nonblank_check",
    );
    await expectDatabaseRejection(
      `INSERT INTO "AuthIdentity" (
        "id", "accountId", "provider", "issuer", "subject",
        "verifiedAt", "lastAuthenticatedAt", "updatedAt"
      ) VALUES (
        'identity_duplicate_principal', 'account_b', 'LOGTO',
        'https://auth-a.example.test/oidc', 'subject-a',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )`,
    );
    await expectDatabaseRejection(
      appSessionInsertSql({
        id: "session_cross_account",
        accountId: "account_a",
        authIdentityId: "identity_b",
        tokenHexByte: "bc",
      }),
      "AppSession_authIdentityId_accountId_fkey",
    );
    await expectDatabaseRejection(
      appSessionInsertSql({
        id: "session_short_hash",
        tokenExpression: "decode('abcd', 'hex')",
      }),
      "AppSession_token_hash_length_check",
    );
    await expectDatabaseRejection(
      appSessionInsertSql({
        id: "session_invalid_expiry",
        tokenHexByte: "ce",
        idleExpiresExpression: "CURRENT_TIMESTAMP - INTERVAL '1 second'",
      }),
      "AppSession_expiry_order_check",
    );
    await expectDatabaseRejection(
      appSessionInsertSql({
        id: "session_active_organization",
        tokenHexByte: "cd",
        activeOrganizationId: "organization_a",
      }),
      "AppSession_active_organization_disabled_check",
    );
    await expectDatabaseRejection(
      appSessionInsertSql({
        id: "session_revoked_without_reason",
        tokenHexByte: "de",
        revokedAtExpression: "CURRENT_TIMESTAMP",
      }),
      "AppSession_revocation_reason_check",
    );
    await expectDatabaseRejection(
      appSessionInsertSql({
        id: "session_reason_without_revoke",
        tokenHexByte: "df",
        revokedReason: "SECURITY_RESET",
      }),
      "AppSession_revocation_reason_check",
    );

    await expectDatabaseRejection(
      `INSERT INTO "Owner" ("id", "accountId")
       VALUES ('owner_missing_account', 'missing_account')`,
      "Owner_accountId_fkey",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Owner" ("id", "accountId")
       VALUES ('owner_a', 'account_a')`,
    );
    await expectDatabaseRejection(
      `INSERT INTO "Owner" ("id", "accountId")
       VALUES ('owner_duplicate_account', 'account_a')`,
    );

    await expectDatabaseRejection(
      `INSERT INTO "AudienceIdentity" ("id", "status", "accountId")
       VALUES ('audience_missing_account', 'REGISTERED', 'missing_account')`,
      "AudienceIdentity_accountId_fkey",
    );
    await expectDatabaseRejection(
      `INSERT INTO "AudienceIdentity" ("id", "status", "accountId")
       VALUES ('audience_anonymous', 'ANONYMOUS', 'account_b')`,
      "AudienceIdentity_registered_account_check",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AudienceIdentity" ("id", "status", "accountId")
       VALUES ('audience_registered', 'REGISTERED', 'account_b')`,
    );
    await expectDatabaseRejection(
      `INSERT INTO "AudienceIdentity" ("id", "status", "accountId")
       VALUES ('audience_duplicate_account', 'REGISTERED', 'account_b')`,
    );
  });

  it("converges concurrent first callbacks on one exact Account/AuthIdentity", async () => {
    const principal = verifiedPrincipal("concurrent-user");
    const [first, second] = await Promise.all([
      resolveAccountShadowForVerifiedPrincipal(principal),
      resolveAccountShadowForVerifiedPrincipal(principal),
    ]);

    expect(first.account.id).toBe(second.account.id);
    expect(first.authIdentity.id).toBe(second.authIdentity.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    await expect(prisma.account.count()).resolves.toBe(1);
    await expect(prisma.authIdentity.count({
      where: {
        provider: "LOGTO",
        issuer: principal.issuer,
        subject: principal.subject,
      },
    })).resolves.toBe(1);
  });

  it("CAS-attaches real Owner and Audience personas through shadow issuance", async () => {
    await insertOwnerPersona("shadow_owner");
    await insertAudiencePersona("shadow_audience");
    const now = new Date("2026-07-29T09:00:00.000Z");

    const ownerIssued = await issueAccountSessionShadow({
      principal: verifiedPrincipal("shadow-owner", now),
      persona: { kind: "owner", ownerId: "shadow_owner" },
      application: "DASHBOARD",
      now,
    });
    const audienceIssued = await issueAccountSessionShadow({
      principal: verifiedPrincipal("shadow-audience", now),
      persona: {
        kind: "audience",
        audienceIdentityId: "shadow_audience",
      },
      application: "PUBLIC_REPRESENTATIVES",
      now,
    });

    await expect(prisma.owner.findUniqueOrThrow({
      where: { id: "shadow_owner" },
      select: { accountId: true },
    })).resolves.toEqual({ accountId: ownerIssued.account.id });
    await expect(prisma.audienceIdentity.findUniqueOrThrow({
      where: { id: "shadow_audience" },
      select: { accountId: true, status: true, mergedIntoId: true },
    })).resolves.toEqual({
      accountId: audienceIssued.account.id,
      status: "REGISTERED",
      mergedIntoId: null,
    });
    expect(ownerIssued.account.id).not.toBe(audienceIssued.account.id);
    expect(ownerIssued.session.application).toBe("DASHBOARD");
    expect(audienceIssued.session.application).toBe(
      "PUBLIC_REPRESENTATIVES",
    );
  });

  it("revokes a possessed old token and creates a replacement in one shadow transaction", async () => {
    await insertOwnerPersona("rotation_owner");
    const firstAt = new Date("2026-07-29T09:30:00.000Z");
    const principal = verifiedPrincipal("rotation-owner", firstAt);
    const first = await issueAccountSessionShadow({
      principal,
      persona: { kind: "owner", ownerId: "rotation_owner" },
      application: "DASHBOARD",
      now: firstAt,
    });
    const secondAt = new Date(firstAt.getTime() + 1_000);
    const second = await issueAccountSessionShadow({
      principal: verifiedPrincipal("rotation-owner", secondAt),
      persona: { kind: "owner", ownerId: "rotation_owner" },
      application: "DASHBOARD",
      previousToken: first.token,
      now: secondAt,
    });

    expect(second.account.id).toBe(first.account.id);
    expect(second.authIdentity.id).toBe(first.authIdentity.id);
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.token).not.toBe(first.token);
    expect(second.previousSessionRevoked).toBe(true);
    await expect(prisma.appSession.findUniqueOrThrow({
      where: { id: first.session.id },
      select: { revokedAt: true, revokedReason: true },
    })).resolves.toEqual({
      revokedAt: secondAt,
      revokedReason: "REPLACED_BY_LOGIN",
    });
    await expect(resolveAppSession({
      token: first.token,
      application: "DASHBOARD",
      now: secondAt,
    })).resolves.toBeNull();
    await expect(resolveAppSession({
      token: second.token,
      application: "DASHBOARD",
      now: secondAt,
    })).resolves.toMatchObject({ id: second.session.id });
    await expect(prisma.appSession.count()).resolves.toBe(2);
  });

  it("rolls back principal creation, persona CAS, and old-token revoke when session creation throws", async () => {
    await insertOwnerPersona("rollback_existing_owner");
    await insertOwnerPersona("rollback_new_owner");
    const firstAt = new Date("2026-07-29T10:00:00.000Z");
    const existing = await issueAccountSessionShadow({
      principal: verifiedPrincipal("rollback-existing", firstAt),
      persona: {
        kind: "owner",
        ownerId: "rollback_existing_owner",
      },
      application: "DASHBOARD",
      now: firstAt,
    });
    await installAppSessionFailureTrigger();

    const newPrincipal = verifiedPrincipal(
      "rollback-new",
      new Date(firstAt.getTime() + 1_000),
    );
    try {
      await expect(issueAccountSessionShadow({
        principal: newPrincipal,
        persona: { kind: "owner", ownerId: "rollback_new_owner" },
        application: "DASHBOARD",
        previousToken: existing.token,
        deviceLabel: "rollback-probe",
        now: newPrincipal.verifiedAt,
      })).rejects.toThrow("forced AppSession transaction rollback");
    } finally {
      await removeAppSessionFailureTrigger();
    }

    await expect(prisma.owner.findUniqueOrThrow({
      where: { id: "rollback_new_owner" },
      select: { accountId: true },
    })).resolves.toEqual({ accountId: null });
    await expect(prisma.authIdentity.count({
      where: {
        provider: "LOGTO",
        issuer: newPrincipal.issuer,
        subject: newPrincipal.subject,
      },
    })).resolves.toBe(0);
    await expect(prisma.account.count()).resolves.toBe(1);
    await expect(prisma.appSession.count()).resolves.toBe(1);
    await expect(prisma.appSession.findUniqueOrThrow({
      where: { id: existing.session.id },
      select: { revokedAt: true, revokedReason: true },
    })).resolves.toEqual({ revokedAt: null, revokedReason: null });
    await expect(resolveAppSession({
      token: existing.token,
      application: "DASHBOARD",
      now: newPrincipal.verifiedAt,
    })).resolves.toMatchObject({ id: existing.session.id });
  });

  it("keeps both independently verified concurrent callbacks as active sessions", async () => {
    await insertOwnerPersona("concurrent_shadow_owner");
    const principal = verifiedPrincipal(
      "concurrent-shadow-owner",
      new Date("2026-07-29T10:30:00.000Z"),
    );
    const [first, second] = await Promise.all([
      issueAccountSessionShadow({
        principal,
        persona: {
          kind: "owner",
          ownerId: "concurrent_shadow_owner",
        },
        application: "DASHBOARD",
        now: principal.verifiedAt,
      }),
      issueAccountSessionShadow({
        principal,
        persona: {
          kind: "owner",
          ownerId: "concurrent_shadow_owner",
        },
        application: "DASHBOARD",
        now: principal.verifiedAt,
      }),
    ]);

    expect(first.account.id).toBe(second.account.id);
    expect(first.authIdentity.id).toBe(second.authIdentity.id);
    expect(first.session.id).not.toBe(second.session.id);
    expect(first.token).not.toBe(second.token);
    expect(first.previousSessionRevoked).toBe(false);
    expect(second.previousSessionRevoked).toBe(false);
    await expect(prisma.owner.findUniqueOrThrow({
      where: { id: "concurrent_shadow_owner" },
      select: { accountId: true },
    })).resolves.toEqual({ accountId: first.account.id });
    await expect(prisma.account.count()).resolves.toBe(1);
    await expect(prisma.authIdentity.count()).resolves.toBe(1);
    await expect(prisma.appSession.count({
      where: { revokedAt: null },
    })).resolves.toBe(2);
  });

  it("retries a real cross-table write skew so one Account cannot auto-claim both persona kinds", async () => {
    await insertOwnerPersona("write_skew_owner");
    await insertAudiencePersona("write_skew_audience");
    const ownerPrincipal = {
      ...verifiedPrincipal(
        "cross-persona-owner",
        new Date("2026-07-29T10:45:00.000Z"),
      ),
      issuer: "https://owner.auth.pg16.delegate.test/oidc",
    };
    const audiencePrincipal = {
      ...verifiedPrincipal(
        "cross-persona-audience",
        new Date("2026-07-29T10:45:00.000Z"),
      ),
      issuer: "https://audience.auth.pg16.delegate.test/oidc",
    };
    const account = await prisma.account.create({
      data: {
        authIdentities: {
          create: [
            {
              provider: "LOGTO",
              issuer: ownerPrincipal.issuer,
              subject: ownerPrincipal.subject,
              verifiedAt: ownerPrincipal.verifiedAt,
              lastAuthenticatedAt: ownerPrincipal.verifiedAt,
            },
            {
              provider: "LOGTO",
              issuer: audiencePrincipal.issuer,
              subject: audiencePrincipal.subject,
              verifiedAt: audiencePrincipal.verifiedAt,
              lastAuthenticatedAt: audiencePrincipal.verifiedAt,
            },
          ],
        },
      },
    });
    const barrier = createPostgresTransactionBarrierClient(2);

    const results = await Promise.allSettled([
      issueAccountSessionShadow(
        {
          principal: ownerPrincipal,
          persona: {
            kind: "owner",
            ownerId: "write_skew_owner",
          },
          application: "DASHBOARD",
          now: ownerPrincipal.verifiedAt,
        },
        barrier.client,
      ),
      issueAccountSessionShadow(
        {
          principal: audiencePrincipal,
          persona: {
            kind: "audience",
            audienceIdentityId: "write_skew_audience",
          },
          application: "PUBLIC_REPRESENTATIVES",
          now: audiencePrincipal.verifiedAt,
        },
        barrier.client,
      ),
    ]);
    const successes = results.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof issueAccountSessionShadow>>
      > => result.status === "fulfilled",
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(
      AccountSessionPersonaConflictError,
    );
    expect(failures[0]?.reason).toMatchObject({
      code: "ACCOUNT_SESSION_PERSONA_CONFLICT",
      reason: "CROSS_PERSONA_REVIEW_REQUIRED",
    });
    expect(barrier.transactionAttempts()).toBe(3);
    expect(barrier.transactionErrorCodes()).toEqual(["P2034"]);

    const [owner, audience] = await Promise.all([
      prisma.owner.findUniqueOrThrow({
        where: { id: "write_skew_owner" },
        select: { accountId: true },
      }),
      prisma.audienceIdentity.findUniqueOrThrow({
        where: { id: "write_skew_audience" },
        select: { accountId: true },
      }),
    ]);
    const personaAccountIds = [
      owner.accountId,
      audience.accountId,
    ].filter((accountId): accountId is string => accountId !== null);

    expect(successes[0]!.value.account.id).toBe(account.id);
    expect(personaAccountIds).toEqual([account.id]);
    await expect(prisma.account.count()).resolves.toBe(1);
    await expect(prisma.authIdentity.count({
      where: { accountId: account.id },
    })).resolves.toBe(2);
    await expect(prisma.appSession.count({
      where: { revokedAt: null },
    })).resolves.toBe(1);
    expect(successes[0]!.value.session.application).toBe(
      owner.accountId ? "DASHBOARD" : "PUBLIC_REPRESENTATIVES",
    );
  });

  it("runs opaque AppSession create, resolve, throttled touch, and revoke against Prisma", async () => {
    const verifiedAt = new Date("2026-07-29T08:00:00.000Z");
    const resolved = await resolveAccountShadowForVerifiedPrincipal(
      verifiedPrincipal("session-user", verifiedAt),
    );
    const created = await createAppSession({
      accountId: resolved.account.id,
      authIdentityId: resolved.authIdentity.id,
      application: "DASHBOARD",
      now: verifiedAt,
    });

    const persisted = await prisma.appSession.findUniqueOrThrow({
      where: { id: created.session.id },
    });
    expect(persisted.tokenHash).toHaveLength(32);
    expect(persisted.authIdentityId).toBe(resolved.authIdentity.id);
    await expect(resolveAppSession({
      token: created.token,
      application: "PUBLIC_REPRESENTATIVES",
      now: verifiedAt,
    })).resolves.toBeNull();
    await expect(resolveAppSession({
      token: created.token,
      application: "DASHBOARD",
      now: verifiedAt,
    })).resolves.toMatchObject({ id: created.session.id });

    const beforeWriteInterval = new Date(
      verifiedAt.getTime()
      + (APP_SESSION_TOUCH_INTERVAL_SECONDS - 1) * 1_000,
    );
    await touchAppSession({
      token: created.token,
      application: "DASHBOARD",
      now: beforeWriteInterval,
    });
    await expect(prisma.appSession.findUniqueOrThrow({
      where: { id: created.session.id },
      select: { lastSeenAt: true },
    })).resolves.toEqual({ lastSeenAt: verifiedAt });

    const atWriteInterval = new Date(
      verifiedAt.getTime() + APP_SESSION_TOUCH_INTERVAL_SECONDS * 1_000,
    );
    await expect(touchAppSession({
      token: created.token,
      application: "DASHBOARD",
      now: atWriteInterval,
    })).resolves.toMatchObject({ lastSeenAt: atWriteInterval });

    await expect(revokeAppSession({
      token: created.token,
      application: "DASHBOARD",
      reason: "   ",
      now: new Date(atWriteInterval.getTime() + 1_000),
    })).resolves.toBe(true);
    await expect(prisma.appSession.findUniqueOrThrow({
      where: { id: created.session.id },
      select: { revokedReason: true },
    })).resolves.toEqual({ revokedReason: "LOCAL_SESSION_REVOKED" });
    await expect(resolveAppSession({
      token: created.token,
      application: "DASHBOARD",
      now: atWriteInterval,
    })).resolves.toBeNull();
  });

  it("invalidates an existing session as soon as its AuthIdentity is revoked", async () => {
    const verifiedAt = new Date("2026-07-29T08:00:00.000Z");
    const resolved = await resolveAccountShadowForVerifiedPrincipal(
      verifiedPrincipal("revoked-identity", verifiedAt),
    );
    const created = await createAppSession({
      accountId: resolved.account.id,
      authIdentityId: resolved.authIdentity.id,
      application: "DASHBOARD",
      now: verifiedAt,
    });

    await prisma.authIdentity.update({
      where: { id: resolved.authIdentity.id },
      data: { status: "REVOKED" },
    });

    await expect(resolveAppSession({
      token: created.token,
      application: "DASHBOARD",
      now: verifiedAt,
    })).resolves.toBeNull();
    await expect(touchAppSession({
      token: created.token,
      application: "DASHBOARD",
      now: new Date(verifiedAt.getTime() + 10 * 60 * 1_000),
    })).resolves.toBeNull();
  });
});

function verifiedPrincipal(
  subject: string,
  verifiedAt = new Date("2026-07-29T08:00:00.000Z"),
): VerifiedAccountPrincipal {
  return {
    provider: "logto",
    issuer: "https://auth.pg16.delegate.test/oidc",
    subject,
    verifiedAt,
    email: "shared-profile-claim@example.test",
    emailVerified: true,
  };
}

function assertSafePostgresTarget(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error("DATABASE_URL is required for Account/AppSession E2E.");
  }
  const url = new URL(raw);
  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname)
    || databaseName !== "delegate_account_session_fixture"
  ) {
    throw new Error(
      "Account/AppSession E2E refuses any non-loopback or non-fixture database.",
    );
  }
}

async function seedDatabasePrincipals(): Promise<void> {
  await prisma.account.createMany({
    data: [
      { id: "account_a" },
      { id: "account_b" },
    ],
  });
  await prisma.authIdentity.createMany({
    data: [
      {
        id: "identity_a",
        accountId: "account_a",
        provider: "LOGTO",
        issuer: "https://auth-a.example.test/oidc",
        subject: "subject-a",
        verifiedAt: new Date(),
        lastAuthenticatedAt: new Date(),
      },
      {
        id: "identity_b",
        accountId: "account_b",
        provider: "LOGTO",
        issuer: "https://auth-b.example.test/oidc",
        subject: "subject-b",
        verifiedAt: new Date(),
        lastAuthenticatedAt: new Date(),
      },
    ],
  });
}

async function insertOwnerPersona(id: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "Owner" ("id")
    VALUES (${id})
  `;
}

async function insertAudiencePersona(id: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "AudienceIdentity" ("id", "status", "mergedIntoId")
    VALUES (${id}, 'REGISTERED', NULL)
  `;
}

async function installAppSessionFailureTrigger(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION force_app_session_transaction_rollback()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."deviceLabel" = 'rollback-probe' THEN
        RAISE EXCEPTION 'forced AppSession transaction rollback';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER force_app_session_transaction_rollback
    BEFORE INSERT ON "AppSession"
    FOR EACH ROW
    EXECUTE FUNCTION force_app_session_transaction_rollback()
  `);
}

async function removeAppSessionFailureTrigger(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS force_app_session_transaction_rollback
    ON "AppSession"
  `);
  await prisma.$executeRawUnsafe(`
    DROP FUNCTION IF EXISTS force_app_session_transaction_rollback()
  `);
}

function createPostgresTransactionBarrierClient(
  participantCount: number,
): {
  client: AccountSessionShadowClient;
  transactionAttempts(): number;
  transactionErrorCodes(): string[];
} {
  let arrived = 0;
  const transactionErrorCodes: string[] = [];
  let releaseAll!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });

  return {
    client: {
      $transaction: async (operation, options) => {
        try {
          return await prisma.$transaction(async (tx) => {
            // Establish both real PostgreSQL Serializable snapshots on a table
            // untouched by issuance before either callback reads a persona.
            await tx.$queryRaw`SELECT count(*) FROM "Organization"`;
            arrived += 1;
            if (arrived === participantCount) {
              releaseAll();
            }
            await allArrived;
            return operation(tx);
          }, options);
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            transactionErrorCodes.push(error.code);
          }
          throw error;
        }
      },
    } as AccountSessionShadowClient,
    transactionAttempts: () => arrived,
    transactionErrorCodes: () => [...transactionErrorCodes],
  };
}

async function expectDatabaseRejection(
  sql: string,
  expectedConstraint?: string,
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(sql);
  } catch (error) {
    if (
      expectedConstraint
      && (
        !(error instanceof Error)
        || !error.message.includes(expectedConstraint)
      )
    ) {
      throw new Error(
        `Expected database rejection from ${expectedConstraint}, received: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return;
  }
  throw new Error("Expected the database to reject an invalid shadow write.");
}

function appSessionInsertSql(input: {
  id: string;
  accountId?: string;
  authIdentityId?: string;
  tokenHexByte?: string;
  tokenExpression?: string;
  idleExpiresExpression?: string;
  activeOrganizationId?: string;
  revokedAtExpression?: string;
  revokedReason?: string;
}): string {
  const tokenExpression = input.tokenExpression
    ?? `decode(repeat('${input.tokenHexByte ?? "ab"}', 32), 'hex')`;
  const activeOrganization = input.activeOrganizationId
    ? `'${input.activeOrganizationId}'`
    : "NULL";
  const revokedAt = input.revokedAtExpression ?? "NULL";
  const revokedReason = input.revokedReason
    ? `'${input.revokedReason}'`
    : "NULL";
  return `INSERT INTO "AppSession" (
    "id", "accountId", "authIdentityId", "application", "tokenHash",
    "activeOrganizationId", "issuedAt", "lastSeenAt", "idleExpiresAt",
    "absoluteExpiresAt", "revokedAt", "revokedReason", "updatedAt"
  ) VALUES (
    '${input.id}',
    '${input.accountId ?? "account_a"}',
    '${input.authIdentityId ?? "identity_a"}',
    'DASHBOARD',
    ${tokenExpression},
    ${activeOrganization},
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    ${input.idleExpiresExpression ?? "CURRENT_TIMESTAMP + INTERVAL '1 day'"},
    CURRENT_TIMESTAMP + INTERVAL '30 days',
    ${revokedAt},
    ${revokedReason},
    CURRENT_TIMESTAMP
  )`;
}
