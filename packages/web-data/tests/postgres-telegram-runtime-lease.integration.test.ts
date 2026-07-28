import {
  ChannelDesiredState,
  ChannelHealthStatus,
  ChannelSourceProvider,
  ChannelTransport,
  PrismaClient,
  RepresentativeChannelKind,
  TelegramBotConnectionScope,
  TelegramBotConnectionStatus,
  TelegramBotCredentialStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquireTelegramBotRuntimeLease,
  releaseTelegramBotRuntimeLease,
  renewTelegramBotRuntimeLease,
} from "../src/telegram-bot-runtime-leases";
import { prisma } from "../src/prisma";

const enabled =
  process.env.DELEGATE_TELEGRAM_LEASE_POSTGRES_E2E === "1";
const describePostgres = enabled ? describe : describe.skip;

if (enabled) {
  assertSafePostgresE2eTarget();
}

describePostgres("Telegram runtime lease PostgreSQL race", () => {
  beforeAll(async () => {
    const [version] = await prisma.$queryRaw<
      Array<{ server_version_num: string }>
    >`SELECT current_setting('server_version_num') AS server_version_num`;
    const versionNumber = Number(version?.server_version_num);
    if (versionNumber < 160_000 || versionNumber >= 170_000) {
      throw new Error(
        `Telegram lease E2E requires PostgreSQL 16; received ${version?.server_version_num ?? "unknown"}.`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("elects one holder, renews exact ownership, and fences a stale process after expiry takeover", async () => {
    const fixture = await createFixture();
    const clientA = new PrismaClient();
    const clientB = new PrismaClient();
    const leaseDurationMs = 120_000;

    try {
      const [attemptA, attemptB] = await Promise.all([
        acquireTelegramBotRuntimeLease(
          {
            telegramBotConnectionId: fixture.connectionId,
            holderId: "supervisor-a",
            leaseDurationMs,
          },
          {
            client: clientA as never,
            tokenFactory: () => "lease-token-a",
          },
        ),
        acquireTelegramBotRuntimeLease(
          {
            telegramBotConnectionId: fixture.connectionId,
            holderId: "supervisor-b",
            leaseDurationMs,
          },
          {
            client: clientB as never,
            tokenFactory: () => "lease-token-b",
          },
        ),
      ]);
      const winners = [attemptA, attemptB].filter(
        (lease): lease is NonNullable<typeof lease> => lease !== null,
      );
      expect(winners).toHaveLength(1);
      expect([attemptA, attemptB].filter((lease) => lease === null))
        .toHaveLength(1);

      const winner = winners[0]!;
      await expect(
        renewTelegramBotRuntimeLease(
          {
            ...winner,
            leaseToken: "stale-token",
            leaseDurationMs,
          },
          { client: clientA as never },
        ),
      ).resolves.toBeNull();
      await expect(
        renewTelegramBotRuntimeLease(
          { ...winner, leaseDurationMs },
          { client: clientA as never },
        ),
      ).resolves.toMatchObject({
        telegramBotConnectionId: fixture.connectionId,
        holderId: winner.holderId,
        leaseToken: winner.leaseToken,
      });
      await expect(
        releaseTelegramBotRuntimeLease(
          { ...winner, leaseToken: "stale-token" },
          { client: clientA as never },
        ),
      ).resolves.toBe(false);
      await expect(
        releaseTelegramBotRuntimeLease(winner, {
          client: clientA as never,
        }),
      ).resolves.toBe(true);

      const crashed = await acquireTelegramBotRuntimeLease(
        {
          telegramBotConnectionId: fixture.connectionId,
          holderId: "crashed-supervisor",
          leaseDurationMs,
        },
        {
          client: clientA as never,
          tokenFactory: () => "crashed-lease-token",
        },
      );
      expect(crashed).not.toBeNull();
      await prisma.$executeRaw`
        UPDATE "TelegramBotRuntimeLease"
        SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "telegramBotConnectionId" = ${fixture.connectionId}
      `;

      const successor = await acquireTelegramBotRuntimeLease(
        {
          telegramBotConnectionId: fixture.connectionId,
          holderId: "successor-supervisor",
          leaseDurationMs,
        },
        {
          client: clientB as never,
          tokenFactory: () => "successor-lease-token",
        },
      );
      expect(successor).toMatchObject({
        telegramBotConnectionId: fixture.connectionId,
        holderId: "successor-supervisor",
        leaseToken: "successor-lease-token",
      });

      await expect(
        releaseTelegramBotRuntimeLease(crashed!, {
          client: clientA as never,
        }),
      ).resolves.toBe(false);
      await expect(
        prisma.telegramBotRuntimeLease.findUnique({
          where: {
            telegramBotConnectionId: fixture.connectionId,
          },
          select: {
            holderId: true,
            leaseToken: true,
          },
        }),
      ).resolves.toEqual({
        holderId: "successor-supervisor",
        leaseToken: "successor-lease-token",
      });
      await expect(
        releaseTelegramBotRuntimeLease(successor!, {
          client: clientB as never,
        }),
      ).resolves.toBe(true);
    } finally {
      await Promise.allSettled([
        clientA.$disconnect(),
        clientB.$disconnect(),
      ]);
      await deleteFixture(fixture);
    }
  });
});

async function createFixture() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const owner = await prisma.owner.create({
    data: {
      displayName: `Telegram lease fixture ${suffix}`,
    },
    select: { id: true },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `telegram-lease-${suffix}`,
      displayName: "Telegram lease fixture",
      roleSummary: "PostgreSQL lease race fixture",
      tone: "concise",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
    select: { id: true },
  });
  const connection = await prisma.telegramBotConnection.create({
    data: {
      ownerId: owner.id,
      scope: TelegramBotConnectionScope.OWNER_MANAGED,
      botId: `700${Date.now()}${Math.floor(Math.random() * 1000)}`,
      username: `telegram_lease_${suffix.replaceAll("-", "_")}`,
      displayName: "Telegram lease fixture",
      status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
      healthStatus: ChannelHealthStatus.HEALTHY,
      credentialRevision: 1,
    },
    select: { id: true, botId: true },
  });
  const credential = await prisma.telegramBotCredential.create({
    data: {
      telegramBotConnectionId: connection.id,
      version: 1,
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array(12).fill(2),
      authTag: new Uint8Array(16).fill(3),
      keyVersion: "postgres-e2e",
      fingerprint: `fixture-${suffix}`,
      status: TelegramBotCredentialStatus.ACTIVE,
      createdBy: owner.id,
      requestId: `telegram-lease:${suffix}`,
      idempotencyKey: `telegram-lease:${suffix}`,
      activatedAt: new Date(),
    },
    select: { id: true },
  });
  await prisma.telegramBotConnection.update({
    where: { id: connection.id },
    data: {
      activeCredentialId: credential.id,
      status: TelegramBotConnectionStatus.ACTIVE,
    },
  });
  await prisma.representativeChannelBinding.create({
    data: {
      representativeId: representative.id,
      kind: RepresentativeChannelKind.TELEGRAM,
      transport: ChannelTransport.TELEGRAM,
      sourceProvider: ChannelSourceProvider.TELEGRAM,
      connectionId: connection.botId,
      telegramBotConnectionId: connection.id,
      desiredState: ChannelDesiredState.ACTIVE,
      healthStatus: ChannelHealthStatus.HEALTHY,
      status: "CONNECTED",
    },
  });

  return {
    ownerId: owner.id,
    representativeId: representative.id,
    connectionId: connection.id,
  };
}

async function deleteFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  await prisma.representativeChannelBinding.deleteMany({
    where: { representativeId: fixture.representativeId },
  });
  await prisma.telegramBotConnection.deleteMany({
    where: { id: fixture.connectionId },
  });
  await prisma.representative.deleteMany({
    where: { id: fixture.representativeId },
  });
  await prisma.owner.deleteMany({
    where: { id: fixture.ownerId },
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for the Telegram lease PostgreSQL E2E.",
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
