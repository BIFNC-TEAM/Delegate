import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  AccountShadowUnavailableError,
  readAccountSessionMode,
  resolveAccountShadowForVerifiedPrincipal,
  usesAccountSessionV2,
  usesLegacyAccountSessionAuthority,
  type AccountShadowClient,
  type AccountShadowRecord,
  type AuthIdentityShadowRecord,
  type VerifiedAccountPrincipal,
} from "../src/account-shadow";

const verifiedAt = new Date("2026-07-29T08:00:00.000Z");

describe("Account/AuthIdentity shadow resolution", () => {
  it("creates one Account from the exact verified principal and normalizes mutable claims", async () => {
    const client = new FakeAccountShadowClient();

    const resolved = await resolveAccountShadowForVerifiedPrincipal(
      principal({
        email: "  Person@Example.COM ",
        emailVerified: true,
        displayName: "  Person ",
      }),
      client,
    );

    expect(resolved.created).toBe(true);
    expect(resolved.account.status).toBe("ACTIVE");
    expect(resolved.authIdentity).toMatchObject({
      accountId: resolved.account.id,
      provider: "LOGTO",
      issuer: "https://auth.delegate.test/oidc",
      subject: "user-1",
      email: "person@example.com",
      emailVerifiedAt: verifiedAt,
      displayName: "Person",
      verifiedAt,
      lastAuthenticatedAt: verifiedAt,
    });
    expect(client.transactionIsolationLevels).toEqual(["Serializable"]);
  });

  it("resolves only by provider, issuer, and subject and refreshes profile claims", async () => {
    const client = new FakeAccountShadowClient();
    const first = await resolveAccountShadowForVerifiedPrincipal(
      principal({ email: "old@example.com" }),
      client,
    );

    const refreshedAt = new Date("2026-07-29T09:00:00.000Z");
    const second = await resolveAccountShadowForVerifiedPrincipal(
      principal({
        verifiedAt: refreshedAt,
        email: "new@example.com",
        emailVerified: true,
      }),
      client,
    );

    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(second.authIdentity.email).toBe("new@example.com");
    expect(second.authIdentity.emailVerifiedAt).toEqual(refreshedAt);
    expect(client.accounts).toHaveLength(1);
    expect(client.identityLookups).toEqual([
      {
        provider: "LOGTO",
        issuer: "https://auth.delegate.test/oidc",
        subject: "user-1",
      },
      {
        provider: "LOGTO",
        issuer: "https://auth.delegate.test/oidc",
        subject: "user-1",
      },
    ]);
  });

  it("never merges two exact principals that happen to share an email", async () => {
    const client = new FakeAccountShadowClient();
    const first = await resolveAccountShadowForVerifiedPrincipal(
      principal({ email: "shared@example.com" }),
      client,
    );
    const second = await resolveAccountShadowForVerifiedPrincipal(
      principal({
        issuer: "https://replacement-issuer.delegate.test/oidc",
        subject: "user-1",
        email: "shared@example.com",
      }),
      client,
    );
    const third = await resolveAccountShadowForVerifiedPrincipal(
      principal({
        subject: "user-2",
        email: "shared@example.com",
      }),
      client,
    );

    expect(new Set([
      first.account.id,
      second.account.id,
      third.account.id,
    ]).size).toBe(3);
    expect(client.accounts).toHaveLength(3);
  });

  it("retries a concurrent exact-principal unique race and returns the winner", async () => {
    const client = new FakeAccountShadowClient();
    client.injectConcurrentWinnerOnNextCreate = true;

    const resolved = await resolveAccountShadowForVerifiedPrincipal(
      principal(),
      client,
    );

    expect(resolved.created).toBe(false);
    expect(resolved.account.id).toBe("account-concurrent-winner");
    expect(client.transactionAttempts).toBe(2);
    expect(client.accounts).toHaveLength(1);
  });

  it("fails closed for a revoked identity or inactive account", async () => {
    const client = new FakeAccountShadowClient();
    const active = await resolveAccountShadowForVerifiedPrincipal(
      principal(),
      client,
    );
    client.identities[0]!.status = "REVOKED";

    await expect(
      resolveAccountShadowForVerifiedPrincipal(principal(), client),
    ).rejects.toBeInstanceOf(AccountShadowUnavailableError);

    client.identities[0]!.status = "ACTIVE";
    client.accounts.find((account) => account.id === active.account.id)!.status =
      "SUSPENDED";
    await expect(
      resolveAccountShadowForVerifiedPrincipal(principal(), client),
    ).rejects.toMatchObject({
      code: "ACCOUNT_SHADOW_UNAVAILABLE",
      accountStatus: "SUSPENDED",
    });
  });

  it("rejects blank identity keys and invalid verification times", async () => {
    const client = new FakeAccountShadowClient();
    await expect(
      resolveAccountShadowForVerifiedPrincipal(
        principal({ issuer: "  " }),
        client,
      ),
    ).rejects.toThrow("issuer is required");
    await expect(
      resolveAccountShadowForVerifiedPrincipal(
        principal({ verifiedAt: new Date(Number.NaN) }),
        client,
      ),
    ).rejects.toThrow("verifiedAt must be a valid Date");
  });
});

describe("account session finite mode", () => {
  it("defaults to legacy and accepts each finite rollout state", () => {
    expect(readAccountSessionMode({})).toBe("legacy");
    for (const mode of ["legacy", "shadow", "enforce", "contract"] as const) {
      expect(
        readAccountSessionMode({ DELEGATE_ACCOUNT_SESSION_MODE: mode }),
      ).toBe(mode);
    }
  });

  it("rejects booleans and unknown rollout states", () => {
    expect(() =>
      readAccountSessionMode({ DELEGATE_ACCOUNT_SESSION_MODE: "true" }),
    ).toThrow("must be legacy, shadow, enforce, or contract");
  });

  it("keeps legacy authority only in the two pre-enforcement modes", () => {
    expect(usesLegacyAccountSessionAuthority("legacy")).toBe(true);
    expect(usesLegacyAccountSessionAuthority("shadow")).toBe(true);
    expect(usesLegacyAccountSessionAuthority("enforce")).toBe(false);
    expect(usesLegacyAccountSessionAuthority("contract")).toBe(false);
    expect(usesAccountSessionV2("legacy")).toBe(false);
    expect(usesAccountSessionV2("shadow")).toBe(true);
    expect(usesAccountSessionV2("enforce")).toBe(true);
    expect(usesAccountSessionV2("contract")).toBe(true);
  });
});

function principal(
  overrides: Partial<VerifiedAccountPrincipal> = {},
): VerifiedAccountPrincipal {
  return {
    provider: "logto",
    issuer: "https://auth.delegate.test/oidc",
    subject: "user-1",
    verifiedAt,
    ...overrides,
  };
}

type StoredIdentity = AuthIdentityShadowRecord;

class FakeAccountShadowClient implements AccountShadowClient {
  readonly accounts: AccountShadowRecord[] = [];
  readonly identities: StoredIdentity[] = [];
  readonly identityLookups: Array<{
    provider: "LOGTO";
    issuer: string;
    subject: string;
  }> = [];
  readonly transactionIsolationLevels: string[] = [];
  transactionAttempts = 0;
  injectConcurrentWinnerOnNextCreate = false;
  private nextAccount = 1;
  private nextIdentity = 1;

  readonly authIdentity = {
    findUnique: (async () => {
      throw new Error("replaced in constructor");
    }) as AccountShadowClient["authIdentity"]["findUnique"],
    update: (async () => {
      throw new Error("replaced in constructor");
    }) as AccountShadowClient["authIdentity"]["update"],
  };

  readonly account = {
    create: (async () => {
      throw new Error("replaced in constructor");
    }) as AccountShadowClient["account"]["create"],
  };

  constructor() {
    this.authIdentity.findUnique = async (args) => {
      const key = args.where.provider_issuer_subject;
      this.identityLookups.push(key);
      const identity = this.identities.find(
        (candidate) =>
          candidate.provider === key.provider
          && candidate.issuer === key.issuer
          && candidate.subject === key.subject,
      );
      if (!identity) return null;
      const account = this.accounts.find(
        (candidate) => candidate.id === identity.accountId,
      );
      if (!account) {
        throw new Error("Fake identity points to a missing account.");
      }
      return { ...identity, account };
    };
    this.authIdentity.update = async (args) => {
      const identity = this.identities.find(
        (candidate) => candidate.id === args.where.id,
      );
      if (!identity) throw new Error("Identity was not found.");
      Object.assign(identity, args.data, { updatedAt: args.data.verifiedAt });
      return { ...identity };
    };
    this.account.create = async (args) => {
      if (this.injectConcurrentWinnerOnNextCreate) {
        this.injectConcurrentWinnerOnNextCreate = false;
        this.persistAccount(
          args.data.authIdentities.create,
          "account-concurrent-winner",
        );
        throw new Prisma.PrismaClientKnownRequestError(
          "synthetic exact-principal race",
          { code: "P2002", clientVersion: "test" },
        );
      }
      return this.persistAccount(args.data.authIdentities.create);
    };
  }

  async $transaction<T>(
    operation: (tx: AccountShadowClient) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    this.transactionAttempts += 1;
    this.transactionIsolationLevels.push(options.isolationLevel);
    return operation(this);
  }

  private persistAccount(
    input: Parameters<
      AccountShadowClient["account"]["create"]
    >[0]["data"]["authIdentities"]["create"],
    accountId = `account-${this.nextAccount++}`,
  ) {
    const now = input.verifiedAt;
    const account: AccountShadowRecord = {
      id: accountId,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    };
    const identity: StoredIdentity = {
      id: `identity-${this.nextIdentity++}`,
      accountId,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.accounts.push(account);
    this.identities.push(identity);
    return { ...account, authIdentities: [{ ...identity }] };
  }
}
