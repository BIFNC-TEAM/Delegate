import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  APP_SESSION_TOUCH_INTERVAL_SECONDS,
  AppSessionAccountUnavailableError,
  AppSessionIdentityUnavailableError,
  createAppSession,
  hashAppSessionToken,
  resolveAppSession,
  revokeAllAppSessions,
  revokeAppSession,
  touchAppSession,
  type AppSessionClient,
  type AppSessionRecord,
} from "../src/app-sessions";

const now = new Date("2026-07-29T08:00:00.000Z");

describe("AppSession v2", () => {
  it("creates an opaque token, persists only its 32-byte digest, and uses bounded defaults", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");

    const created = await createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      now,
      deviceLabel: "  Neo's Mac ",
      userAgent: "  Delegate Test ",
    }, client);

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.session.tokenHash).toEqual(hashAppSessionToken(created.token));
    expect(created.session.tokenHash).toHaveLength(32);
    expect(Buffer.from(created.session.tokenHash).toString("utf8"))
      .not.toContain(created.token);
    expect(created.session).toMatchObject({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      issuedAt: now,
      lastSeenAt: now,
      deviceLabel: "Neo's Mac",
      userAgent: "Delegate Test",
    });
    expect(created.session.idleExpiresAt).toEqual(
      new Date("2026-07-30T08:00:00.000Z"),
    );
    expect(created.session.absoluteExpiresAt).toEqual(
      new Date("2026-08-28T08:00:00.000Z"),
    );
    expect(client.transactionIsolationLevels).toEqual(["Serializable"]);
  });

  it("requires an active identity belonging to the same active Account", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");
    client.addPrincipal("account-2", "identity-2");

    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-2",
      application: "DASHBOARD",
      now,
    }, client)).rejects.toMatchObject({
      code: "APP_SESSION_IDENTITY_UNAVAILABLE",
      identityStatus: "MISMATCH",
    });

    client.identities.find((identity) => identity.id === "identity-1")!.status =
      "REVOKED";
    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      now,
    }, client)).rejects.toBeInstanceOf(AppSessionIdentityUnavailableError);

    client.identities.find((identity) => identity.id === "identity-1")!.status =
      "ACTIVE";
    client.accounts.find((account) => account.id === "account-1")!.status =
      "SUSPENDED";
    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      now,
    }, client)).rejects.toBeInstanceOf(AppSessionAccountUnavailableError);
  });

  it("rejects Workspace selection until Account membership exists and fails closed on direct writes", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");
    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      activeOrganizationId: "organization-without-membership",
      now,
    }, client)).rejects.toMatchObject({
      code: "APP_SESSION_WORKSPACE_SELECTION_UNAVAILABLE",
    });

    const created = await createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      now,
    }, client);
    client.sessions[0]!.activeOrganizationId =
      "organization-written-outside-service";

    await expect(resolveAppSession({
      token: created.token,
      application: "DASHBOARD",
      now,
    }, client)).resolves.toBeNull();
    await expect(touchAppSession({
      token: created.token,
      application: "DASHBOARD",
      now: new Date(now.getTime() + 10 * 60 * 1_000),
    }, client)).resolves.toBeNull();
    expect(client.updateManyCalls).toBe(0);
  });

  it("requires an audience binding only for Public Representatives sessions", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");

    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "PUBLIC_REPRESENTATIVES",
      now,
    }, client)).rejects.toMatchObject({
      code: "APP_SESSION_AUDIENCE_BINDING_UNAVAILABLE",
      reason: "MISSING",
    });
    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      publicAudienceId: "unexpected-audience",
      now,
    }, client)).rejects.toMatchObject({
      code: "APP_SESSION_AUDIENCE_BINDING_UNAVAILABLE",
      reason: "UNEXPECTED",
    });
  });

  it("isolates resolution by application and invalidates sessions when identity or Account is disabled", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");
    const created = await createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      now,
    }, client);

    await expect(resolveAppSession({
      token: created.token,
      application: "DASHBOARD",
      now,
    }, client)).resolves.toMatchObject({ id: created.session.id });
    await expect(resolveAppSession({
      token: created.token,
      application: "PUBLIC_REPRESENTATIVES",
      now,
    }, client)).resolves.toBeNull();

    client.identities[0]!.status = "REVOKED";
    await expect(resolveAppSession({
      token: created.token,
      application: "DASHBOARD",
      now,
    }, client)).resolves.toBeNull();

    client.identities[0]!.status = "ACTIVE";
    client.accounts[0]!.status = "DELETION_PENDING";
    await expect(resolveAppSession({
      token: created.token,
      application: "DASHBOARD",
      now,
    }, client)).resolves.toBeNull();
  });

  it("does not write touches inside five minutes, then extends idle expiry with an absolute cap", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");
    const created = await createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      idleTtlSeconds: 10 * 60,
      absoluteTtlSeconds: 10 * 60,
      now,
    }, client);

    const insideInterval = new Date(
      now.getTime() + (APP_SESSION_TOUCH_INTERVAL_SECONDS - 1) * 1_000,
    );
    await expect(touchAppSession({
      token: created.token,
      application: "DASHBOARD",
      idleTtlSeconds: 10 * 60,
      now: insideInterval,
    }, client)).resolves.toMatchObject({ lastSeenAt: now });
    expect(client.updateManyCalls).toBe(0);

    const atInterval = new Date(
      now.getTime() + APP_SESSION_TOUCH_INTERVAL_SECONDS * 1_000,
    );
    const touched = await touchAppSession({
      token: created.token,
      application: "DASHBOARD",
      idleTtlSeconds: 10 * 60,
      now: atInterval,
    }, client);

    expect(client.updateManyCalls).toBe(1);
    expect(touched?.lastSeenAt).toEqual(atInterval);
    expect(touched?.idleExpiresAt).toEqual(created.session.absoluteExpiresAt);
    expect(touched!.lastSeenAt.getTime())
      .toBeLessThan(touched!.idleExpiresAt.getTime());
  });

  it("revokes one token only inside its application", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");
    const created = await createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      now,
    }, client);

    await expect(revokeAppSession({
      token: created.token,
      application: "PUBLIC_REPRESENTATIVES",
      now,
    }, client)).resolves.toBe(false);
    expect(client.sessions[0]!.revokedAt).toBeNull();

    await expect(revokeAppSession({
      token: created.token,
      application: "DASHBOARD",
      reason: "   ",
      now,
    }, client)).resolves.toBe(true);
    expect(client.sessions[0]).toMatchObject({
      revokedAt: now,
      revokedReason: "LOCAL_SESSION_REVOKED",
    });
  });

  it("revokes all sessions only for the requested Account and application", async () => {
    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");
    client.addPrincipal("account-2", "identity-2");
    await createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      now,
    }, client);
    await createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "PUBLIC_REPRESENTATIVES",
      publicAudienceId: "audience-device-1",
      now,
    }, client);
    await createAppSession({
      accountId: "account-2",
      authIdentityId: "identity-2",
      application: "DASHBOARD",
      now,
    }, client);

    await expect(revokeAllAppSessions({
      accountId: "account-1",
      application: "DASHBOARD",
      reason: "SECURITY_RESET",
      now,
    }, client)).resolves.toBe(1);

    expect(client.sessions.map((session) => ({
      accountId: session.accountId,
      application: session.application,
      revoked: Boolean(session.revokedAt),
    }))).toEqual([
      {
        accountId: "account-1",
        application: "DASHBOARD",
        revoked: true,
      },
      {
        accountId: "account-1",
        application: "PUBLIC_REPRESENTATIVES",
        revoked: false,
      },
      {
        accountId: "account-2",
        application: "DASHBOARD",
        revoked: false,
      },
    ]);
  });

  it("rejects malformed tokens, invalid TTLs, and oversized metadata", async () => {
    expect(() => hashAppSessionToken("not-a-token")).toThrow("32-byte");
    expect(() =>
      hashAppSessionToken(` ${"A".repeat(43)}`),
    ).toThrow("32-byte");

    const client = new FakeAppSessionClient();
    client.addPrincipal("account-1", "identity-1");
    await expect(resolveAppSession({
      token: "malformed-cookie",
      application: "DASHBOARD",
      now,
    }, client)).resolves.toBeNull();
    await expect(touchAppSession({
      token: "malformed-cookie",
      application: "DASHBOARD",
      now,
    }, client)).resolves.toBeNull();
    await expect(revokeAppSession({
      token: "malformed-cookie",
      application: "DASHBOARD",
      now,
    }, client)).resolves.toBe(false);
    expect(client.updateManyCalls).toBe(0);

    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      idleTtlSeconds: 61,
      absoluteTtlSeconds: 60,
      now,
    }, client)).rejects.toThrow("must not exceed");
    await expect(createAppSession({
      accountId: "account-1",
      authIdentityId: "identity-1",
      application: "DASHBOARD",
      userAgent: "x".repeat(513),
      now,
    }, client)).rejects.toThrow("userAgent must not exceed 512");
  });
});

type FakeAccount = {
  id: string;
  status: "ACTIVE" | "SUSPENDED" | "DELETION_PENDING" | "DELETED";
};
type FakeIdentity = {
  id: string;
  accountId: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
};

class FakeAppSessionClient implements AppSessionClient {
  readonly accounts: FakeAccount[] = [];
  readonly identities: FakeIdentity[] = [];
  readonly sessions: AppSessionRecord[] = [];
  readonly transactionIsolationLevels: string[] = [];
  updateManyCalls = 0;
  private nextSession = 1;

  readonly authIdentity = {
    findUnique: (async () => {
      throw new Error("replaced in constructor");
    }) as AppSessionClient["authIdentity"]["findUnique"],
  };

  readonly appSession = {
    create: (async () => {
      throw new Error("replaced in constructor");
    }) as AppSessionClient["appSession"]["create"],
    findFirst: (async () => {
      throw new Error("replaced in constructor");
    }) as AppSessionClient["appSession"]["findFirst"],
    updateMany: (async () => {
      throw new Error("replaced in constructor");
    }) as AppSessionClient["appSession"]["updateMany"],
  };

  constructor() {
    this.authIdentity.findUnique = async (args) => {
      const identity = this.identities.find(
        (candidate) => candidate.id === args.where.id,
      );
      if (!identity) return null;
      const account = this.accounts.find(
        (candidate) => candidate.id === identity.accountId,
      );
      if (!account) throw new Error("Fake account is missing.");
      return { ...identity, account };
    };
    this.appSession.create = async (args) => {
      const record: AppSessionRecord = {
        id: `session-${this.nextSession++}`,
        revokedAt: null,
        revokedReason: null,
        createdAt: args.data.issuedAt,
        updatedAt: args.data.issuedAt,
        ...args.data,
      };
      this.sessions.push(record);
      return { ...record };
    };
    this.appSession.findFirst = async (args) => {
      const session = this.sessions.find(
        (candidate) =>
          candidate.application === args.where.application
          && bytesEqual(candidate.tokenHash, args.where.tokenHash),
      );
      if (!session) return null;
      const account = this.accounts.find(
        (candidate) => candidate.id === session.accountId,
      );
      const authIdentity = this.identities.find(
        (candidate) => candidate.id === session.authIdentityId,
      );
      if (!account || !authIdentity) {
        throw new Error("Fake session relation is missing.");
      }
      return { ...session, account, authIdentity };
    };
    this.appSession.updateMany = async (args) => {
      this.updateManyCalls += 1;
      const matches = this.sessions.filter((session) =>
        matchesSessionWhere(
          session,
          args.where,
          this.accounts,
          this.identities,
        ),
      );
      for (const session of matches) {
        Object.assign(session, args.data);
        const updateTime = args.data.lastSeenAt ?? args.data.revokedAt;
        if (updateTime instanceof Date) {
          session.updatedAt = updateTime;
        }
      }
      return { count: matches.length };
    };
  }

  addPrincipal(accountId: string, identityId: string): void {
    this.accounts.push({ id: accountId, status: "ACTIVE" });
    this.identities.push({
      id: identityId,
      accountId,
      status: "ACTIVE",
    });
  }

  async $transaction<T>(
    operation: (tx: AppSessionClient) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    this.transactionIsolationLevels.push(options.isolationLevel);
    return operation(this);
  }
}

function matchesSessionWhere(
  session: AppSessionRecord,
  where: Record<string, unknown>,
  accounts: FakeAccount[],
  identities: FakeIdentity[],
): boolean {
  if (typeof where.id === "string" && session.id !== where.id) return false;
  if (
    typeof where.accountId === "string"
    && session.accountId !== where.accountId
  ) return false;
  if (
    typeof where.application === "string"
    && session.application !== where.application
  ) return false;
  if (
    where.tokenHash instanceof Uint8Array
    && !bytesEqual(session.tokenHash, where.tokenHash)
  ) return false;
  if (where.revokedAt === null && session.revokedAt !== null) return false;
  if (!matchesGreaterThan(session.idleExpiresAt, where.idleExpiresAt)) {
    return false;
  }
  if (!matchesGreaterThan(session.absoluteExpiresAt, where.absoluteExpiresAt)) {
    return false;
  }
  const accountStatus = readNestedStatus(where.account);
  if (
    accountStatus
    && accounts.find((account) => account.id === session.accountId)?.status
      !== accountStatus
  ) return false;
  const identityStatus = readNestedStatus(where.authIdentity);
  if (
    identityStatus
    && identities.find((identity) => identity.id === session.authIdentityId)
      ?.status !== identityStatus
  ) return false;
  return true;
}

function matchesGreaterThan(actual: Date, filter: unknown): boolean {
  if (
    typeof filter !== "object"
    || filter === null
    || !("gt" in filter)
    || !(filter.gt instanceof Date)
  ) {
    return true;
  }
  return actual.getTime() > filter.gt.getTime();
}

function readNestedStatus(value: unknown): string | undefined {
  if (
    typeof value === "object"
    && value !== null
    && "status" in value
    && typeof value.status === "string"
  ) {
    return value.status;
  }
  return undefined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
