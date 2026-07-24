import {
  AudienceIdentityStatus,
  Channel,
  MessageSenderType,
  PaymentProvider,
  RechargeOrderStatus,
  ServiceEntitlementLedgerKind,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";
import {
  consumeConversationEntitlement,
  createServicePaymentOrder,
  fulfillServicePaymentOrder,
  grantServiceEntitlement,
  refundServiceEntitlement,
  releaseConversationEntitlement,
  releaseConversationEntitlementByGenerationRunId,
  reserveConversationEntitlement,
  type ConversationEntitlementReservation,
  type ServicePaymentEvidenceInput,
} from "../src/service-entitlements";
import { mergeAudienceIdentity } from "../src/web-audience";

const describePostgres =
  process.env.DELEGATE_POSTGRES_E2E === "1" ? describe : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("service entitlement PostgreSQL 16 concurrency", () => {
  beforeAll(async () => {
    const [version] = await prisma.$queryRaw<Array<{ server_version_num: string }>>`
      SELECT current_setting('server_version_num') AS server_version_num
    `;
    const versionNumber = Number(version?.server_version_num);
    if (versionNumber < 160_000 || versionNumber >= 170_000) {
      throw new Error(
        `Service entitlement concurrency E2E requires PostgreSQL 16; received ${version?.server_version_num ?? "unknown"}.`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("does not overspend when two generation runs reserve the same final unit", async () => {
    const fixture = await createFixture();
    try {
      const firstRunId = await createGenerationRun(fixture, "reserve-a");
      const secondRunId = await createGenerationRun(fixture, "reserve-b");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:one`,
      });

      const reservations = await Promise.all([
        reserveConversationEntitlement({
          ...fixture.coordinates,
          generationRunId: firstRunId,
          productCodes: [fixture.coordinates.productCode],
        }),
        reserveConversationEntitlement({
          ...fixture.coordinates,
          generationRunId: secondRunId,
          productCodes: [fixture.coordinates.productCode],
        }),
      ]);

      expect(reservations.filter(Boolean)).toHaveLength(1);
      expect(reservations.filter((reservation) => reservation === null)).toHaveLength(1);

      const account = await loadAccount(fixture);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 1,
      });
      const reserveEntries = await prisma.serviceEntitlementLedgerEntry.count({
        where: {
          entitlementAccountId: account.id,
          kind: ServiceEntitlementLedgerKind.RESERVE,
        },
      });
      expect(reserveEntries).toBe(1);
      expectConserved(account, { consumedUnits: 0 });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("keeps payment and entitlement facts conserved when consume races refund", async () => {
    const fixture = await createFixture();
    try {
      const generationRunId = await createGenerationRun(fixture, "consume-refund");
      const payment = paymentFixture(fixture);
      await createServicePaymentOrder(payment.order);
      await fulfillServicePaymentOrder(payment.paidEvidence);
      const reservation = await requireReservation(
        fixture,
        generationRunId,
      );

      const [consumeResult, refundResult] = await Promise.allSettled([
        consumeConversationEntitlement(reservation),
        refundServiceEntitlement(payment.refundEvidence),
      ]);

      expect(consumeResult.status).toBe("fulfilled");
      expect(refundResult.status).toBe("rejected");
      if (refundResult.status === "rejected") {
        expect(String(refundResult.reason)).toContain(
          "requires all granted units to remain available",
        );
      }

      const [account, order, events, ledger] = await Promise.all([
        loadAccount(fixture),
        prisma.servicePaymentOrder.findUniqueOrThrow({
          where: { id: payment.order.id },
        }),
        prisma.servicePaymentEvent.findMany({
          where: { paymentOrderId: payment.order.id },
        }),
        prisma.serviceEntitlementLedgerEntry.findMany({
          where: {
            entitlementAccount: {
              audienceIdentityId: fixture.sourceAudienceIdentityId,
              representativeId: fixture.representativeId,
              productCode: fixture.coordinates.productCode,
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      expect(order.status).toBe(RechargeOrderStatus.PAID);
      expect(order.refundedAt).toBeNull();
      expect(events).toHaveLength(1);
      expect(ledger.map((entry) => entry.kind)).toEqual([
        ServiceEntitlementLedgerKind.GRANT,
        ServiceEntitlementLedgerKind.RESERVE,
        ServiceEntitlementLedgerKind.CONSUME,
      ]);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 0,
      });
      expectConserved(account, { consumedUnits: 1 });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("serializes consume against reservation void so only one terminal ledger fact wins", async () => {
    const fixture = await createFixture();
    try {
      const generationRunId = await createGenerationRun(fixture, "consume-void");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:void-race`,
      });
      const reservation = await requireReservation(fixture, generationRunId);

      const terminalResults = await Promise.allSettled([
        consumeConversationEntitlement(reservation),
        releaseConversationEntitlement(reservation),
      ]);
      expect(terminalResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(terminalResults.filter((result) => result.status === "rejected")).toHaveLength(1);

      const account = await loadAccount(fixture);
      const terminalEntries = await prisma.serviceEntitlementLedgerEntry.findMany({
        where: {
          entitlementAccountId: account.id,
          kind: {
            in: [
              ServiceEntitlementLedgerKind.CONSUME,
              ServiceEntitlementLedgerKind.RELEASE,
            ],
          },
        },
      });
      expect(terminalEntries).toHaveLength(1);
      expect(account.reservedUnits).toBe(0);
      const consumedUnits =
        terminalEntries[0]?.kind === ServiceEntitlementLedgerKind.CONSUME ? 1 : 0;
      expectConserved(account, { consumedUnits });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("either rejects a concurrent identity merge or transfers the active reservation atomically", async () => {
    const fixture = await createFixture({ withRegisteredTarget: true });
    try {
      const generationRunId = await createGenerationRun(fixture, "merge");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:merge`,
      });
      const reservation = await requireReservation(fixture, generationRunId);

      const [mergeResult, consumeResult] = await Promise.allSettled([
        mergeAudienceIdentity({
          sourceAudienceIdentityId: fixture.sourceAudienceIdentityId,
          targetAudienceIdentityId: fixture.targetAudienceIdentityId!,
          transferVerifiedProvisionalAssets: true,
        }),
        consumeConversationEntitlement(reservation),
      ]);

      expect(consumeResult.status).toBe("fulfilled");
      const [sourceIdentity, account] = await Promise.all([
        prisma.audienceIdentity.findUniqueOrThrow({
          where: { id: fixture.sourceAudienceIdentityId },
        }),
        prisma.serviceEntitlementAccount.findUniqueOrThrow({
          where: { id: reservation.accountId },
        }),
      ]);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 0,
      });
      expectConserved(account, { consumedUnits: 1 });

      if (mergeResult.status === "fulfilled") {
        expect(sourceIdentity).toMatchObject({
          status: AudienceIdentityStatus.MERGED,
          mergedIntoId: fixture.targetAudienceIdentityId,
        });
        expect(account.audienceIdentityId).toBe(fixture.targetAudienceIdentityId);
      } else {
        expect(sourceIdentity).toMatchObject({
          status: AudienceIdentityStatus.ANONYMOUS,
          mergedIntoId: null,
        });
        expect(account.audienceIdentityId).toBe(fixture.sourceAudienceIdentityId);
        expect(isExpectedSerializableMergeRejection(mergeResult.reason)).toBe(true);
      }
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("releases by generation run idempotently and permits the next reservation attempt", async () => {
    const fixture = await createFixture();
    try {
      const generationRunId = await createGenerationRun(fixture, "release-retry");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:release-retry`,
      });
      const firstReservation = await requireReservation(fixture, generationRunId);
      expect(firstReservation.attempt).toBe(1);

      const releaseResults = await Promise.all([
        releaseConversationEntitlementByGenerationRunId({
          generationRunId,
          reason: "postgres-concurrency-probe-a",
        }),
        releaseConversationEntitlementByGenerationRunId({
          generationRunId,
          reason: "postgres-concurrency-probe-b",
        }),
      ]);
      expect(releaseResults.filter(Boolean)).toHaveLength(1);
      await expect(
        releaseConversationEntitlementByGenerationRunId({ generationRunId }),
      ).resolves.toBeNull();

      const secondReservation = await requireReservation(fixture, generationRunId);
      expect(secondReservation).toMatchObject({
        accountId: firstReservation.accountId,
        attempt: 2,
      });
      const account = await loadAccount(fixture);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 1,
      });
      const entries = await prisma.serviceEntitlementLedgerEntry.findMany({
        where: { generationRunId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(entries.map((entry) => entry.kind)).toEqual([
        ServiceEntitlementLedgerKind.RESERVE,
        ServiceEntitlementLedgerKind.RELEASE,
        ServiceEntitlementLedgerKind.RESERVE,
      ]);
      expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
        `conversation-entitlement:${generationRunId}:1:reserve`,
        `conversation-entitlement:${generationRunId}:1:release`,
        `conversation-entitlement:${generationRunId}:2:reserve`,
      ]);
      expectConserved(account, { consumedUnits: 0 });
    } finally {
      await deleteFixture(fixture);
    }
  });
});

type EntitlementFixture = {
  suffix: string;
  ownerId: string;
  representativeId: string;
  sourceAudienceIdentityId: string;
  targetAudienceIdentityId: string | null;
  contactId: string;
  conversationId: string;
  coordinates: {
    audienceIdentityId: string;
    representativeId: string;
    productCode: string;
  };
};

async function createFixture(
  options: { withRegisteredTarget?: boolean } = {},
): Promise<EntitlementFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const owner = await prisma.owner.create({
    data: {
      displayName: `Entitlement concurrency ${suffix}`,
    },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `entitlement-concurrency-${suffix}`,
      displayName: "Entitlement concurrency probe",
      roleSummary: "PostgreSQL concurrency fixture",
      tone: "neutral",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const sourceIdentity = await prisma.audienceIdentity.create({
    data: {
      audienceKey: `postgres-entitlement:${suffix}:source`,
      status: AudienceIdentityStatus.ANONYMOUS,
    },
  });
  const targetIdentity = options.withRegisteredTarget
    ? await prisma.audienceIdentity.create({
        data: {
          audienceKey: `postgres-entitlement:${suffix}:target`,
          status: AudienceIdentityStatus.REGISTERED,
        },
      })
    : null;
  const contact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      audienceIdentityId: sourceIdentity.id,
      displayName: "PostgreSQL concurrency audience",
      source: "postgres-e2e",
      sourceChannel: "WEB",
      channelUserId: `postgres-entitlement:${suffix}`,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      audienceIdentityId: sourceIdentity.id,
      channel: Channel.PRIVATE_CHAT,
      sourceChannel: "WEB",
      externalConversationId: `postgres-entitlement:${suffix}`,
    },
  });

  return {
    suffix,
    ownerId: owner.id,
    representativeId: representative.id,
    sourceAudienceIdentityId: sourceIdentity.id,
    targetAudienceIdentityId: targetIdentity?.id ?? null,
    contactId: contact.id,
    conversationId: conversation.id,
    coordinates: {
      audienceIdentityId: sourceIdentity.id,
      representativeId: representative.id,
      productCode: "plan:pass",
    },
  };
}

async function createGenerationRun(
  fixture: EntitlementFixture,
  label: string,
) {
  const inputMessage = await prisma.message.create({
    data: {
      conversationId: fixture.conversationId,
      senderType: MessageSenderType.AUDIENCE,
      text: `PostgreSQL entitlement input ${label}`,
      clientMessageId: `${fixture.suffix}:${label}:input`,
    },
  });
  const run = await prisma.generationRun.create({
    data: {
      conversationId: fixture.conversationId,
      inputMessageId: inputMessage.id,
      idempotencyKey: `${fixture.suffix}:${label}:run`,
    },
  });
  return run.id;
}

async function requireReservation(
  fixture: EntitlementFixture,
  generationRunId: string,
): Promise<ConversationEntitlementReservation> {
  const reservation = await reserveConversationEntitlement({
    ...fixture.coordinates,
    generationRunId,
    productCodes: [fixture.coordinates.productCode],
  });
  if (!reservation) {
    throw new Error("Expected a service entitlement reservation.");
  }
  return reservation;
}

function paymentFixture(fixture: EntitlementFixture) {
  const order = {
    id: `service-payment-${fixture.suffix}`,
    payerAudienceIdentityId: fixture.sourceAudienceIdentityId,
    representativeId: fixture.representativeId,
    provider: PaymentProvider.STRIPE,
    providerAccountId: `stripe-account-${fixture.suffix}`,
    providerOrderId: `stripe-order-${fixture.suffix}`,
    productCode: fixture.coordinates.productCode,
    amountMinor: 100,
    currency: "CNY",
    entitlementUnits: 1,
    priceSnapshot: {
      amountMinor: 100,
      currency: "CNY",
      entitlementUnits: 1,
    },
    status: "REQUIRES_PAYMENT" as const,
  };
  const paidEvidence = {
    paymentOrderId: order.id,
    provider: order.provider,
    providerAccountId: order.providerAccountId,
    providerOrderId: order.providerOrderId,
    providerEventId: `stripe-paid-${fixture.suffix}`,
    payerAudienceIdentityId: order.payerAudienceIdentityId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    verifiedAt: new Date(),
    rawPayload: { signatureVerified: true },
  } satisfies ServicePaymentEvidenceInput;
  return {
    order,
    paidEvidence,
    refundEvidence: {
      ...paidEvidence,
      providerEventId: `stripe-refund-${fixture.suffix}`,
      verifiedAt: new Date(Date.now() + 1_000),
    } satisfies ServicePaymentEvidenceInput,
  };
}

async function loadAccount(fixture: EntitlementFixture) {
  return prisma.serviceEntitlementAccount.findFirstOrThrow({
    where: {
      representativeId: fixture.representativeId,
      productCode: fixture.coordinates.productCode,
    },
  });
}

function expectConserved(
  account: {
    grantedUnits: number;
    remainingUnits: number;
    reservedUnits: number;
  },
  input: { consumedUnits: number },
) {
  expect(account.remainingUnits).toBeGreaterThanOrEqual(0);
  expect(account.reservedUnits).toBeGreaterThanOrEqual(0);
  expect(
    account.remainingUnits + account.reservedUnits + input.consumedUnits,
  ).toBe(account.grantedUnits);
}

function isExpectedSerializableMergeRejection(error: unknown) {
  const message = String(error);
  return (
    message.includes("P2034") ||
    message.toLowerCase().includes("write conflict") ||
    message.toLowerCase().includes("deadlock") ||
    message.includes("Audience identity merge conflict")
  );
}

async function deleteFixture(fixture: EntitlementFixture) {
  await prisma.$transaction(async (tx) => {
    await tx.servicePaymentEvent.deleteMany({
      where: {
        paymentOrder: {
          representativeId: fixture.representativeId,
        },
      },
    });
    await tx.serviceEntitlementLedgerEntry.deleteMany({
      where: {
        entitlementAccount: {
          representativeId: fixture.representativeId,
        },
      },
    });
    await tx.servicePaymentOrder.deleteMany({
      where: { representativeId: fixture.representativeId },
    });
    await tx.serviceEntitlementAccount.deleteMany({
      where: { representativeId: fixture.representativeId },
    });
    await tx.generationRun.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.message.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.conversation.delete({
      where: { id: fixture.conversationId },
    });
    await tx.contact.delete({
      where: { id: fixture.contactId },
    });
    await tx.audienceIdentity.deleteMany({
      where: {
        id: {
          in: [
            fixture.sourceAudienceIdentityId,
            ...(fixture.targetAudienceIdentityId
              ? [fixture.targetAudienceIdentityId]
              : []),
          ],
        },
      },
    });
    await tx.representative.delete({
      where: { id: fixture.representativeId },
    });
    await tx.owner.delete({
      where: { id: fixture.ownerId },
    });
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for the service entitlement PostgreSQL E2E.",
    );
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1" ||
    !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
