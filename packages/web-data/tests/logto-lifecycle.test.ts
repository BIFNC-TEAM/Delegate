import {
  AccountStatus,
  AuthIdentityStatus,
  Prisma,
} from "@prisma/client";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  LogtoWebhookError,
  processLogtoLifecycleWebhook,
  type LogtoLifecycleClient,
} from "../src/logto-lifecycle";

const signingKey = "logto-webhook-signing-key-for-tests";
const env = {
  LOGTO_ENDPOINT: "https://auth.example.com",
  LOGTO_WEBHOOK_SIGNING_KEY: signingKey,
};

describe("Logto identity lifecycle", () => {
  it("rejects a webhook whose raw-body signature is invalid", async () => {
    const rawBody = suspensionPayload(true);

    await expect(
      processLogtoLifecycleWebhook(
        { rawBody, signature: "0".repeat(64), env },
        createFixture().client,
      ),
    ).rejects.toBeInstanceOf(LogtoWebhookError);
  });

  it("rejects an oversized payload before signature or database work", async () => {
    const rawBody = "x".repeat(64 * 1024 + 1);

    await expect(
      processLogtoLifecycleWebhook(
        { rawBody, signature: sign(rawBody), env },
        createFixture().client,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
      statusCode: 400,
    });
  });

  it("accepts only Logto's exact signed Console test placeholder without mutating identity state", async () => {
    const fixture = createFixture();
    const rawBody = JSON.stringify({
      hookId: "string",
      event: "User.SuspensionStatus.Updated",
      createdAt: "string",
      data: { result: "success" },
      params: { id: "fake-id" },
    });

    await expect(processLogtoLifecycleWebhook(
      { rawBody, signature: sign(rawBody), env },
      fixture.client,
    )).resolves.toEqual({
      status: "ignored",
      effect: "TEST_EVENT_IGNORED",
      revokedSessions: 0,
    });
    expect(fixture.identity.status).toBe(AuthIdentityStatus.ACTIVE);
    expect(fixture.sessions.some((session) => session.revoked)).toBe(false);
  });

  it("suspends only an active identity, revokes every local session, and deduplicates exact replay", async () => {
    const fixture = createFixture();
    const rawBody = suspensionPayload(true);
    const input = { rawBody, signature: sign(rawBody), env };

    await expect(
      processLogtoLifecycleWebhook(input, fixture.client),
    ).resolves.toEqual({
      status: "processed",
      effect: "SUSPENDED",
      revokedSessions: 2,
    });
    expect(fixture.identity.status).toBe(AuthIdentityStatus.SUSPENDED);
    expect(fixture.sessions.every((session) => session.revoked)).toBe(true);

    await expect(
      processLogtoLifecycleWebhook(input, fixture.client),
    ).resolves.toEqual({
      status: "duplicate",
      effect: "NO_CHANGE",
      revokedSessions: 0,
    });
    expect(fixture.receipts).toHaveLength(1);
  });

  it("reactivates only a Logto-suspended identity and never restores revoked sessions", async () => {
    const fixture = createFixture({
      identityStatus: AuthIdentityStatus.SUSPENDED,
      sessionsRevoked: true,
    });
    const rawBody = suspensionPayload(false, "2026-08-26T03:00:00.000Z");

    await expect(
      processLogtoLifecycleWebhook(
        { rawBody, signature: sign(rawBody), env },
        fixture.client,
      ),
    ).resolves.toMatchObject({ effect: "REACTIVATED" });
    expect(fixture.identity.status).toBe(AuthIdentityStatus.ACTIVE);
    expect(fixture.sessions.every((session) => session.revoked)).toBe(true);
  });

  it("ignores an out-of-order suspension update", async () => {
    const fixture = createFixture();
    fixture.receipts.push({
      id: "newer-receipt",
      issuer: "https://auth.example.com/oidc",
      providerSubject: "logto-user-1",
      event: "User.SuspensionStatus.Updated",
      payloadHash: "f".repeat(64),
      providerCreatedAt: new Date("2026-08-26T04:00:00.000Z"),
      effect: "SUSPENDED",
      createdAt: new Date("2026-08-26T04:00:01.000Z"),
    });
    const rawBody = suspensionPayload(false, "2026-08-26T03:00:00.000Z");

    await expect(
      processLogtoLifecycleWebhook(
        { rawBody, signature: sign(rawBody), env },
        fixture.client,
      ),
    ).resolves.toEqual({
      status: "ignored",
      effect: "STALE_EVENT_IGNORED",
      revokedSessions: 0,
    });
    expect(fixture.identity.status).toBe(AuthIdentityStatus.ACTIVE);
  });

  it("marks a deleted Logto identity and Account unavailable without deleting business history", async () => {
    const fixture = createFixture();
    const rawBody = deletionPayload();

    await expect(
      processLogtoLifecycleWebhook(
        { rawBody, signature: sign(rawBody), env },
        fixture.client,
      ),
    ).resolves.toEqual({
      status: "processed",
      effect: "DELETION_PENDING",
      revokedSessions: 2,
    });
    expect(fixture.identity.status).toBe(AuthIdentityStatus.REVOKED);
    expect(fixture.account.status).toBe(AccountStatus.DELETION_PENDING);
    expect(fixture.sessions.every((session) => session.revoked)).toBe(true);
  });

  it("records an event for a principal Delegate has never seen without creating an Account", async () => {
    const fixture = createFixture({ missingIdentity: true });
    const rawBody = suspensionPayload(true);

    await expect(
      processLogtoLifecycleWebhook(
        { rawBody, signature: sign(rawBody), env },
        fixture.client,
      ),
    ).resolves.toEqual({
      status: "ignored",
      effect: "IDENTITY_NOT_FOUND",
      revokedSessions: 0,
    });
    expect(fixture.receipts).toHaveLength(1);
  });
});

type Receipt = {
  id: string;
  issuer: string;
  providerSubject: string;
  event: string;
  payloadHash: string;
  providerCreatedAt: Date;
  effect: string;
  createdAt: Date;
};

function createFixture(options: {
  identityStatus?: AuthIdentityStatus;
  accountStatus?: AccountStatus;
  missingIdentity?: boolean;
  sessionsRevoked?: boolean;
} = {}) {
  const account = {
    id: "account-1",
    status: options.accountStatus ?? AccountStatus.ACTIVE,
  };
  const identity = {
    id: "identity-1",
    accountId: account.id,
    status: options.identityStatus ?? AuthIdentityStatus.ACTIVE,
    account,
  };
  const sessions = [
    { id: "session-1", revoked: options.sessionsRevoked ?? false },
    { id: "session-2", revoked: options.sessionsRevoked ?? false },
  ];
  const receipts: Receipt[] = [];

  const tx = {
    logtoWebhookReceipt: {
      findUnique: async (args: any) =>
        receipts.find(
          (receipt) => receipt.payloadHash === args.where.payloadHash,
        ) ?? null,
      findFirst: async (args: any) =>
        receipts
          .filter(
            (receipt) =>
              receipt.issuer === args.where.issuer
              && receipt.providerSubject === args.where.providerSubject
              && receipt.event === args.where.event,
          )
          .sort(
            (left, right) =>
              right.providerCreatedAt.getTime()
              - left.providerCreatedAt.getTime(),
          )[0] ?? null,
      create: async (args: any) => {
        receipts.push({
          id: `receipt-${receipts.length + 1}`,
          ...args.data,
          createdAt: args.data.processedAt,
        });
        return { id: receipts.at(-1)!.id };
      },
    },
    authIdentity: {
      findUnique: async () =>
        options.missingIdentity ? null : identity,
      updateMany: async (args: any) => {
        const expectedStatus = args.where.status;
        if (expectedStatus && identity.status !== expectedStatus) {
          return { count: 0 };
        }
        identity.status = args.data.status;
        return { count: 1 };
      },
    },
    account: {
      updateMany: async (args: any) => {
        const allowed = args.where.status?.in ?? [];
        if (allowed.length > 0 && !allowed.includes(account.status)) {
          return { count: 0 };
        }
        account.status = args.data.status;
        return { count: 1 };
      },
    },
    appSession: {
      updateMany: async () => {
        const active = sessions.filter((session) => !session.revoked);
        active.forEach((session) => {
          session.revoked = true;
        });
        return { count: active.length };
      },
    },
  };
  const client = {
    $transaction: async (operation: (transaction: typeof tx) => unknown) =>
      operation(tx),
  } as unknown as LogtoLifecycleClient;
  return { client, account, identity, sessions, receipts };
}

function suspensionPayload(
  isSuspended: boolean,
  createdAt = "2026-08-26T02:30:00.000Z",
) {
  return JSON.stringify({
    hookId: "hook-1",
    event: "User.SuspensionStatus.Updated",
    createdAt,
    data: { id: "logto-user-1", isSuspended },
  });
}

function deletionPayload() {
  return JSON.stringify({
    hookId: "hook-1",
    event: "User.Deleted",
    createdAt: "2026-08-26T02:30:00.000Z",
    data: null,
    params: { userId: "logto-user-1" },
  });
}

function sign(rawBody: string) {
  return createHmac("sha256", signingKey)
    .update(rawBody, "utf8")
    .digest("hex");
}
