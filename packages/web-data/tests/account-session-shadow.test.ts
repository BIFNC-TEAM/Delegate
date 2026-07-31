import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  AccountSessionPersonaConflictError,
  issueAccountSessionShadow,
  type AccountSessionShadowClient,
} from "../src/account-session-shadow";
import {
  hashAppSessionToken,
  type AppSessionRecord,
} from "../src/app-sessions";

const now = new Date("2026-07-29T08:00:00.000Z");
const previousToken =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("atomic Account/AppSession shadow issuance", () => {
  it("resolves the exact principal, CAS-attaches an Owner, and rotates the old token in one Serializable transaction", async () => {
    const fixture = createFixture();
    fixture.addOwner("owner-1");
    fixture.addSession(previousToken);

    const issued = await issueAccountSessionShadow(
      {
        principal: principal(),
        persona: { kind: "owner", ownerId: "owner-1" },
        application: "DASHBOARD",
        previousToken,
        userAgent: "Browser/1.0",
        now,
      },
      fixture.client,
    );

    expect(fixture.transactionOptions).toEqual([
      { isolationLevel: "Serializable" },
    ]);
    expect(fixture.identityLookups[0]).toEqual({
      provider_issuer_subject: {
        provider: "LOGTO",
        issuer: "https://auth.example.com/oidc",
        subject: "person-1",
      },
    });
    expect(fixture.owners[0]?.accountId).toBe("account-1");
    expect(issued.previousSessionRevoked).toBe(true);
    expect(fixture.sessions[0]).toMatchObject({
      application: "DASHBOARD",
      revokedReason: "REPLACED_BY_LOGIN",
    });
    expect(fixture.sessions[0]?.revokedAt).toEqual(now);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.session.tokenHash).toEqual(
      hashAppSessionToken(issued.token),
    );
    expect(Buffer.from(issued.session.tokenHash).toString("utf8")).not.toBe(
      issued.token,
    );
    expect(fixture.operationOrder).toEqual([
      "resolve-identity",
      "refresh-identity",
      "find-owner",
      "find-audience-claim",
      "find-owner-claim",
      "cas-owner",
      "revoke-session",
      "check-session-identity",
      "create-session",
    ]);
  });

  it("attaches only a canonical REGISTERED AudienceIdentity", async () => {
    const fixture = createFixture();
    fixture.addAudience("audience-1", "REGISTERED");

    const issued = await issueAccountSessionShadow(
      {
        principal: principal(),
        persona: {
          kind: "audience",
          audienceIdentityId: "audience-1",
        },
        application: "PUBLIC_REPRESENTATIVES",
        now,
      },
      fixture.client,
    );

    expect(fixture.audiences[0]?.accountId).toBe("account-1");
    expect(issued.session.application).toBe(
      "PUBLIC_REPRESENTATIVES",
    );
    expect(issued.session.activeOrganizationId).toBeNull();
  });

  it.each(["ANONYMOUS", "MERGED", "DISABLED"] as const)(
    "fails closed for an AudienceIdentity in %s state",
    async (status) => {
      const fixture = createFixture();
      fixture.addAudience(
        "audience-1",
        status,
        status === "MERGED" ? "audience-canonical" : null,
      );

      await expect(
        issueAccountSessionShadow(
          {
            principal: principal(),
            persona: {
              kind: "audience",
              audienceIdentityId: "audience-1",
            },
            application: "PUBLIC_REPRESENTATIVES",
            now,
          },
          fixture.client,
        ),
      ).rejects.toMatchObject({
        code: "ACCOUNT_SESSION_PERSONA_CONFLICT",
        reason: "NOT_REGISTERED",
      });
      expect(fixture.sessions).toHaveLength(0);
    },
  );

  it("never moves a persona that is already attached to another Account", async () => {
    const fixture = createFixture();
    fixture.addOwner("owner-1", "other-account");

    await expect(
      issueAccountSessionShadow(
        {
          principal: principal(),
          persona: { kind: "owner", ownerId: "owner-1" },
          application: "DASHBOARD",
          now,
        },
        fixture.client,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_SESSION_PERSONA_CONFLICT",
      reason: "ACCOUNT_CONFLICT",
    });
    expect(fixture.sessions).toHaveLength(0);
  });

  it("does not let a second persona claim the same Account", async () => {
    const fixture = createFixture();
    fixture.addOwner("owner-existing", "account-1");
    fixture.addOwner("owner-new");

    await expect(
      issueAccountSessionShadow(
        {
          principal: principal(),
          persona: { kind: "owner", ownerId: "owner-new" },
          application: "DASHBOARD",
          now,
        },
        fixture.client,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_SESSION_PERSONA_CONFLICT",
      reason: "ACCOUNT_ALREADY_CLAIMED",
    });
    expect(fixture.sessions).toHaveLength(0);
  });

  it.each([
    {
      target: "owner",
      configure(fixture: ReturnType<typeof createFixture>) {
        fixture.addOwner("owner-1");
        fixture.addAudience(
          "audience-existing",
          "REGISTERED",
          null,
          "account-1",
        );
      },
      persona: { kind: "owner" as const, ownerId: "owner-1" },
      application: "DASHBOARD" as const,
    },
    {
      target: "audience",
      configure(fixture: ReturnType<typeof createFixture>) {
        fixture.addOwner("owner-existing", "account-1");
        fixture.addAudience("audience-1", "REGISTERED");
      },
      persona: {
        kind: "audience" as const,
        audienceIdentityId: "audience-1",
      },
      application: "PUBLIC_REPRESENTATIVES" as const,
    },
  ])(
    "requires explicit review before adding an unlinked $target cross-persona mapping",
    async ({ configure, persona, application }) => {
      const fixture = createFixture();
      configure(fixture);

      await expect(
        issueAccountSessionShadow(
          {
            principal: principal(),
            persona,
            application,
            now,
          },
          fixture.client,
        ),
      ).rejects.toMatchObject({
        code: "ACCOUNT_SESSION_PERSONA_CONFLICT",
        reason: "CROSS_PERSONA_REVIEW_REQUIRED",
      });
      expect(fixture.sessions).toHaveLength(0);
    },
  );

  it.each([
    {
      persona: { kind: "owner" as const, ownerId: "owner-1" },
      application: "PUBLIC_REPRESENTATIVES" as const,
    },
    {
      persona: {
        kind: "audience" as const,
        audienceIdentityId: "audience-1",
      },
      application: "DASHBOARD" as const,
    },
  ])(
    "rejects a $persona.kind persona for the wrong application before opening a transaction",
    async ({ persona, application }) => {
      const fixture = createFixture();

      await expect(
        issueAccountSessionShadow(
          {
            principal: principal(),
            persona,
            application,
            now,
          },
          fixture.client,
        ),
      ).rejects.toMatchObject({
        code: "ACCOUNT_SESSION_PERSONA_CONFLICT",
        reason: "APPLICATION_MISMATCH",
      });
      expect(fixture.transactionAttempts).toBe(0);
    },
  );

  it.each(["P2002", "P2034"])(
    "retries a transient %s race and returns only the committed session",
    async (code) => {
      const fixture = createFixture();
      fixture.addOwner("owner-1");
      fixture.transactionFailures.push(prismaError(code));

      const issued = await issueAccountSessionShadow(
        {
          principal: principal(),
          persona: { kind: "owner", ownerId: "owner-1" },
          application: "DASHBOARD",
          now,
        },
        fixture.client,
      );

      expect(issued.session.accountId).toBe("account-1");
      expect(fixture.transactionAttempts).toBe(2);
      expect(fixture.sessions).toHaveLength(1);
    },
  );

  it("ignores a malformed previous token without querying sessions", async () => {
    const fixture = createFixture();
    fixture.addOwner("owner-1");

    const issued = await issueAccountSessionShadow(
      {
        principal: principal(),
        persona: { kind: "owner", ownerId: "owner-1" },
        application: "DASHBOARD",
        previousToken: " malformed ",
        now,
      },
      fixture.client,
    );

    expect(issued.previousSessionRevoked).toBe(false);
    expect(fixture.operationOrder).not.toContain("revoke-session");
    expect(fixture.sessions).toHaveLength(1);
  });

  it("reports a stable domain conflict after an unrecoverable persona unique race", async () => {
    const fixture = createFixture();
    fixture.addOwner("owner-1");
    fixture.transactionFailures.push(
      prismaError("P2002"),
      prismaError("P2002"),
      prismaError("P2002"),
    );

    await expect(
      issueAccountSessionShadow(
        {
          principal: principal(),
          persona: { kind: "owner", ownerId: "owner-1" },
          application: "DASHBOARD",
          now,
        },
        fixture.client,
      ),
    ).rejects.toBeInstanceOf(AccountSessionPersonaConflictError);
    expect(fixture.sessions).toHaveLength(0);
  });
});

function principal() {
  return {
    provider: "logto" as const,
    issuer: "https://auth.example.com/oidc",
    subject: "person-1",
    verifiedAt: now,
    email: "person@example.com",
    emailVerified: true,
  };
}

function createFixture() {
  const account = {
    id: "account-1",
    status: "ACTIVE" as const,
    createdAt: now,
    updatedAt: now,
  };
  const identity = {
    id: "identity-1",
    accountId: account.id,
    provider: "LOGTO" as const,
    issuer: "https://auth.example.com/oidc",
    subject: "person-1",
    status: "ACTIVE" as const,
    email: "person@example.com",
    emailVerifiedAt: now,
    phone: null,
    phoneVerifiedAt: null,
    displayName: null,
    verifiedAt: now,
    lastAuthenticatedAt: now,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
  const owners: Array<{ id: string; accountId: string | null }> = [];
  const audiences: Array<{
    id: string;
    accountId: string | null;
    status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
    mergedIntoId: string | null;
  }> = [];
  const sessions: AppSessionRecord[] = [];
  const identityLookups: Array<Record<string, unknown>> = [];
  const operationOrder: string[] = [];
  const transactionOptions: Array<Record<string, unknown>> = [];
  const transactionFailures: Error[] = [];
  let transactionAttempts = 0;
  let nextSession = 1;

  const tx = {
    authIdentity: {
      findUnique: vi.fn(async (args: {
        where: Record<string, unknown>;
      }) => {
        if ("provider_issuer_subject" in args.where) {
          operationOrder.push("resolve-identity");
          identityLookups.push(args.where);
          return { ...identity, account };
        }
        operationOrder.push("check-session-identity");
        return args.where.id === identity.id
          ? { ...identity, account }
          : null;
      }),
      update: vi.fn(async (args: {
        data: Record<string, unknown>;
      }) => {
        operationOrder.push("refresh-identity");
        Object.assign(identity, args.data, { updatedAt: now });
        return { ...identity };
      }),
    },
    account: {
      create: vi.fn(),
    },
    owner: {
      findUnique: vi.fn(async (args: {
        where: { id?: string; accountId?: string };
      }) => {
        if (args.where.id) {
          operationOrder.push("find-owner");
          return owners.find((row) => row.id === args.where.id) ?? null;
        }
        operationOrder.push("find-owner-claim");
        return owners.find(
          (row) => row.accountId === args.where.accountId,
        ) ?? null;
      }),
      updateMany: vi.fn(async (args: {
        where: { id: string };
        data: { accountId: string };
      }) => {
        operationOrder.push("cas-owner");
        const row = owners.find((owner) => owner.id === args.where.id);
        if (
          !row
          || (row.accountId !== null
            && row.accountId !== args.data.accountId)
        ) {
          return { count: 0 };
        }
        row.accountId = args.data.accountId;
        return { count: 1 };
      }),
    },
    audienceIdentity: {
      findUnique: vi.fn(async (args: {
        where: { id?: string; accountId?: string };
      }) => {
        if (args.where.id) {
          return audiences.find(
            (row) => row.id === args.where.id,
          ) ?? null;
        }
        operationOrder.push("find-audience-claim");
        return audiences.find(
          (row) => row.accountId === args.where.accountId,
        ) ?? null;
      }),
      updateMany: vi.fn(async (args: {
        where: { id: string };
        data: { accountId: string };
      }) => {
        const row = audiences.find(
          (audience) => audience.id === args.where.id,
        );
        if (
          !row
          || row.status !== "REGISTERED"
          || row.mergedIntoId !== null
          || (row.accountId !== null
            && row.accountId !== args.data.accountId)
        ) {
          return { count: 0 };
        }
        row.accountId = args.data.accountId;
        return { count: 1 };
      }),
    },
    appSession: {
      create: vi.fn(async (args: {
        data: Omit<
          AppSessionRecord,
          "id" | "revokedAt" | "revokedReason" | "createdAt" | "updatedAt"
        >;
      }) => {
        operationOrder.push("create-session");
        const session: AppSessionRecord = {
          id: `session-${nextSession++}`,
          ...args.data,
          revokedAt: null,
          revokedReason: null,
          createdAt: now,
          updatedAt: now,
        };
        sessions.push(session);
        return session;
      }),
      findFirst: vi.fn(),
      updateMany: vi.fn(async (args: {
        where: {
          tokenHash?: Uint8Array;
          application?: string;
          revokedAt?: null;
        };
        data: {
          revokedAt?: Date;
          revokedReason?: string;
        };
      }) => {
        operationOrder.push("revoke-session");
        const tokenHash = args.where.tokenHash;
        if (!tokenHash) return { count: 0 };
        const session = sessions.find(
          (candidate) =>
            Buffer.from(candidate.tokenHash).equals(
              Buffer.from(tokenHash),
            )
            && candidate.application === args.where.application
            && candidate.revokedAt === null,
        );
        if (!session) return { count: 0 };
        session.revokedAt = args.data.revokedAt ?? now;
        session.revokedReason =
          args.data.revokedReason ?? "LOCAL_SESSION_REVOKED";
        return { count: 1 };
      }),
    },
  };

  const client = {
    ...tx,
    $transaction: vi.fn(
      async <T>(
        operation: (transaction: typeof tx) => Promise<T>,
        options: Record<string, unknown>,
      ) => {
        transactionAttempts += 1;
        transactionOptions.push(options);
        const failure = transactionFailures.shift();
        if (failure) throw failure;
        return operation(tx);
      },
    ),
  } as unknown as AccountSessionShadowClient;

  return {
    client,
    owners,
    audiences,
    sessions,
    identityLookups,
    operationOrder,
    transactionOptions,
    transactionFailures,
    get transactionAttempts() {
      return transactionAttempts;
    },
    addOwner(id: string, accountId: string | null = null) {
      owners.push({ id, accountId });
    },
    addAudience(
      id: string,
      status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED",
      mergedIntoId: string | null = null,
      accountId: string | null = null,
    ) {
      audiences.push({
        id,
        accountId,
        status,
        mergedIntoId,
      });
    },
    addSession(token: string) {
      sessions.push({
        id: `session-${nextSession++}`,
        accountId: account.id,
        authIdentityId: identity.id,
        application: "DASHBOARD",
        tokenHash: hashAppSessionToken(token),
        activeOrganizationId: null,
        logtoSessionId: null,
        issuedAt: new Date("2026-07-28T08:00:00.000Z"),
        lastSeenAt: new Date("2026-07-28T08:00:00.000Z"),
        idleExpiresAt: new Date("2026-07-30T08:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-27T08:00:00.000Z"),
        revokedAt: null,
        revokedReason: null,
        deviceLabel: null,
        userAgent: null,
        createdAt: now,
        updatedAt: now,
      });
    },
  };
}

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Injected ${code}`,
    {
      code,
      clientVersion: "test",
    },
  );
}
