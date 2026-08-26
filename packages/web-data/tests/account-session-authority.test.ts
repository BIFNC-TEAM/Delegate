import { describe, expect, it, vi } from "vitest";

import { resolveAccountSessionAuthority } from "../src/account-session-authority";
import type { AppSessionRecord } from "../src/app-sessions";

const now = new Date("2026-08-26T02:30:00.000Z");

describe("Account/AppSession v2 authority", () => {
  it("resolves an active Dashboard session to its exact Owner persona", async () => {
    const dependencies = fixture({ application: "DASHBOARD" });

    await expect(
      resolveAccountSessionAuthority(
        { token: "token", application: "DASHBOARD", now },
        dependencies,
      ),
    ).resolves.toMatchObject({
      version: 2,
      actor: "owner",
      accountId: "account-1",
      authIdentityId: "identity-1",
      ownerId: "owner-1",
      issuer: "https://auth.example.com/oidc",
      subject: "person-1",
    });
    expect(dependencies.loadAudience).not.toHaveBeenCalled();
  });

  it("restores the proof-bound public audience from a Representatives session", async () => {
    const dependencies = fixture({
      application: "PUBLIC_REPRESENTATIVES",
      publicAudienceId: " AUD_DEVICE_1 ",
    });

    await expect(
      resolveAccountSessionAuthority(
        {
          token: "token",
          application: "PUBLIC_REPRESENTATIVES",
          now,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      actor: "audience",
      audienceIdentityId: "audience-1",
      audienceId: "aud_device_1",
      accountId: "account-1",
    });
    expect(dependencies.loadOwner).not.toHaveBeenCalled();
  });

  it.each([
    ["missing session", { missingSession: true }],
    ["revoked identity", { identityStatus: "REVOKED" as const }],
    ["suspended account", { accountStatus: "SUSPENDED" as const }],
    ["wrong Owner Account", { ownerAccountId: "account-2" }],
  ])("fails closed for %s", async (_label, options) => {
    const dependencies = fixture({ application: "DASHBOARD", ...options });

    await expect(
      resolveAccountSessionAuthority(
        { token: "token", application: "DASHBOARD", now },
        dependencies,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["missing audience binding", { publicAudienceId: null }],
    ["anonymous persona", { audienceStatus: "ANONYMOUS" as const }],
    ["merged persona", { audienceStatus: "MERGED" as const, mergedIntoId: "audience-2" }],
    ["wrong Audience Account", { audienceAccountId: "account-2" }],
  ])("fails closed for a public session with %s", async (_label, options) => {
    const dependencies = fixture({
      application: "PUBLIC_REPRESENTATIVES",
      publicAudienceId: "aud-device-1",
      ...options,
    });

    await expect(
      resolveAccountSessionAuthority(
        {
          token: "token",
          application: "PUBLIC_REPRESENTATIVES",
          now,
        },
        dependencies,
      ),
    ).resolves.toBeNull();
  });
});

type FixtureOptions = {
  application: "DASHBOARD" | "PUBLIC_REPRESENTATIVES";
  publicAudienceId?: string | null;
  missingSession?: boolean;
  identityStatus?: "ACTIVE" | "SUSPENDED" | "REVOKED";
  accountStatus?: "ACTIVE" | "SUSPENDED" | "DELETION_PENDING" | "DELETED";
  ownerAccountId?: string | null;
  audienceAccountId?: string | null;
  audienceStatus?: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
  mergedIntoId?: string | null;
};

function fixture(options: FixtureOptions) {
  const session: AppSessionRecord = {
    id: "session-1",
    accountId: "account-1",
    authIdentityId: "identity-1",
    application: options.application,
    tokenHash: new Uint8Array(32),
    publicAudienceId:
      options.publicAudienceId !== undefined
        ? options.publicAudienceId
        : options.application === "PUBLIC_REPRESENTATIVES"
          ? "aud-device-1"
          : null,
    activeOrganizationId: null,
    logtoSessionId: null,
    issuedAt: new Date("2026-08-26T02:00:00.000Z"),
    lastSeenAt: now,
    idleExpiresAt: new Date("2026-08-27T02:00:00.000Z"),
    absoluteExpiresAt: new Date("2026-09-25T02:00:00.000Z"),
    revokedAt: null,
    revokedReason: null,
    deviceLabel: null,
    userAgent: null,
    createdAt: now,
    updatedAt: now,
  };

  return {
    touchSession: vi.fn(async () =>
      options.missingSession ? null : session),
    loadIdentity: vi.fn(async () => ({
      id: "identity-1",
      accountId: "account-1",
      issuer: "https://auth.example.com/oidc",
      subject: "person-1",
      email: "person@example.com",
      status: options.identityStatus ?? "ACTIVE",
      account: {
        id: "account-1",
        status: options.accountStatus ?? "ACTIVE",
      },
    })),
    loadOwner: vi.fn(async () => ({
      id: "owner-1",
      accountId: options.ownerAccountId ?? "account-1",
    })),
    loadAudience: vi.fn(async () => ({
      id: "audience-1",
      accountId: options.audienceAccountId ?? "account-1",
      status: options.audienceStatus ?? "REGISTERED",
      mergedIntoId: options.mergedIntoId ?? null,
    })),
  };
}
