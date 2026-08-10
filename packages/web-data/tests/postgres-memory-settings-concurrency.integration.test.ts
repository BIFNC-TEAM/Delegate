import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { updateRepresentativeMemorySettings } from "../src/memory-settings";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("representative memory settings PostgreSQL concurrency", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("replays one exact concurrent create after the unique race", async () => {
    const suffix = randomUUID();
    const owner = await prisma.owner.create({
      data: { displayName: `Memory settings owner ${suffix}` },
    });
    const representative = await prisma.representative.create({
      data: {
        ownerId: owner.id,
        slug: `memory-settings-concurrency-${suffix}`,
        displayName: "Memory settings concurrency",
        roleSummary: "Exercises idempotent representative settings writes.",
        tone: "clear",
        languages: ["en", "zh"],
        freeScope: [],
        paywalledIntents: [],
        handoffPrompt: "Escalate.",
        allowedSkills: [],
        actionGate: {},
      },
    });
    const barrier = createTwoPartyBarrier();
    const clients = [
      createAuditBarrierClient(barrier),
      createAuditBarrierClient(barrier),
    ];
    const request = {
      actorOwnerId: owner.id,
      representativeSlug: representative.slug,
      idempotencyKey: `settings-${suffix}`,
      update: {
        expectedRevision: 0,
        policy: {
          basic: {
            longTermMemoryEnabled: true,
            shortTermMemoryEnabled: true,
            contactMemoryEnabled: true,
            contactMemoryCrossChannelEnabled: false,
            representativeExperienceEnabled: true,
            autoExtract: true,
          },
          channels: {
            web: { recallEnabled: true, extractEnabled: true },
            matrix: { recallEnabled: false, extractEnabled: false },
            telegram: { recallEnabled: false, extractEnabled: false },
          },
          retention: { days: 30, expiryAction: "ARCHIVE" },
          advanced: {
            provider: "openviking",
            recallLimit: 6,
            recallThreshold: 0.01,
          },
        },
      },
    } as const;

    const responses = await Promise.all(clients.map((client, index) =>
      updateRepresentativeMemorySettings({
        ...request,
        requestId: `settings-request-${index}-${suffix}`,
      }, { client: client as never }),
    ));

    expect(responses.map((response) => response.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(await prisma.representativeMemoryPolicy.count({
      where: { representativeId: representative.id },
    })).toBe(1);
    expect(await prisma.representativeMemoryPolicy.findUniqueOrThrow({
      where: { representativeId: representative.id },
      select: {
        revision: true,
        shortTermMemoryEnabled: true,
        contactMemoryCrossChannelEnabled: true,
      },
    })).toEqual({
      revision: 1,
      shortTermMemoryEnabled: true,
      contactMemoryCrossChannelEnabled: false,
    });
    expect(await prisma.eventAudit.count({
      where: { ownerId: owner.id, idempotencyKey: request.idempotencyKey },
    })).toBe(1);
  });
});

type ReleaseBarrier = () => Promise<void>;

function createTwoPartyBarrier(): ReleaseBarrier {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await released;
  };
}

function createAuditBarrierClient(barrier: ReleaseBarrier) {
  let intercepted = false;
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) => target.$transaction(async (tx) => operation(new Proxy(tx, {
          get(transaction, transactionProperty, transactionReceiver) {
            if (transactionProperty !== "eventAudit") {
              return Reflect.get(
                transaction,
                transactionProperty,
                transactionReceiver,
              );
            }
            return new Proxy(transaction.eventAudit, {
              get(delegate, delegateProperty, delegateReceiver) {
                if (delegateProperty !== "findUnique") {
                  return Reflect.get(delegate, delegateProperty, delegateReceiver);
                }
                return async (...args: unknown[]) => {
                  const result = await Reflect.apply(
                    delegate.findUnique,
                    delegate,
                    args,
                  );
                  if (!intercepted) {
                    intercepted = true;
                    await barrier();
                  }
                  return result;
                };
              },
            });
          },
        })), options);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for memory settings PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(
      `Refusing memory settings PostgreSQL E2E against ${host}/${database}.`,
    );
  }
}
