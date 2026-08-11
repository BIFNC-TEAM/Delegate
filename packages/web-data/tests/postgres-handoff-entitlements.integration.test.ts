import {
  AudienceIdentityStatus,
  BillingHandoffAllowance,
  BillingHandoffServiceLevel,
  BillingPriceVersionStatus,
  BillingProductKind,
  BillingProductStatus,
  Channel,
  HandoffEntitlementGrantStatus,
  HandoffEntitlementLedgerKind,
  HandoffStatus,
  PaymentProvider,
  RechargeOrderStatus,
  RepresentativeHandoffAccessMode,
  type Prisma,
} from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  acceptHandoffRequestInTransaction,
  createOrReuseHandoffRequestInTransaction,
  resolveHandoffRequestInTransaction,
} from "../src/handoff-entitlements";
import { prisma } from "../src/prisma";

const describePostgres =
  process.env.DELEGATE_POSTGRES_E2E === "1" ? describe : describe.skip;

describePostgres("handoff entitlement PostgreSQL audit closure", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("closes reserve, release, consume, and accepted-close transitions", async () => {
    const fixture = await createFixture(2);

    const first = await write((tx) =>
      createOrReuseHandoffRequestInTransaction(draft(fixture), tx)
    );
    if (!first.request) throw new Error("expected first paid handoff");
    await write((tx) =>
      resolveHandoffRequestInTransaction({
        handoffRequestId: first.request!.id,
        status: HandoffStatus.DECLINED,
        reason: "postgres_release_probe",
      }, tx)
    );

    const second = await write((tx) =>
      createOrReuseHandoffRequestInTransaction({
        ...draft(fixture),
        reason: "Second owner handoff",
      }, tx)
    );
    if (!second.request) throw new Error("expected second paid handoff");
    await write((tx) =>
      acceptHandoffRequestInTransaction({
        handoffRequestId: second.request!.id,
      }, tx)
    );
    await write((tx) =>
      resolveHandoffRequestInTransaction({
        handoffRequestId: second.request!.id,
        status: HandoffStatus.CLOSED,
        reason: "operator_returned_to_ai",
      }, tx)
    );
    await write((tx) =>
      acceptHandoffRequestInTransaction({
        handoffRequestId: second.request!.id,
      }, tx)
    );

    const [grant, requests, ledger] = await Promise.all([
      prisma.handoffEntitlementGrant.findUniqueOrThrow({
        where: { id: fixture.grantId },
      }),
      prisma.handoffRequest.findMany({
        where: { representativeId: fixture.representativeId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.handoffEntitlementLedgerEntry.findMany({
        where: { grantId: fixture.grantId },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    expect(grant).toMatchObject({
      grantedUses: 2,
      remainingUses: 1,
      reservedUses: 0,
      consumedUses: 1,
      status: HandoffEntitlementGrantStatus.ACTIVE,
    });
    expect(requests.map((request) => ({
      status: request.status,
      entitlement: request.entitlementReservationState,
    }))).toEqual([
      { status: HandoffStatus.DECLINED, entitlement: "RELEASED" },
      { status: HandoffStatus.CLOSED, entitlement: "CONSUMED" },
    ]);
    expect(ledger.map((entry) => entry.kind)).toEqual([
      HandoffEntitlementLedgerKind.GRANT,
      HandoffEntitlementLedgerKind.RESERVE,
      HandoffEntitlementLedgerKind.RELEASE,
      HandoffEntitlementLedgerKind.RESERVE,
      HandoffEntitlementLedgerKind.CONSUME,
    ]);
  });

  it("serializes concurrent replay to one active request and one reservation", async () => {
    const fixture = await createFixture(1);
    const [left, right] = await Promise.all([
      write((tx) =>
        createOrReuseHandoffRequestInTransaction(draft(fixture), tx)
      ),
      write((tx) =>
        createOrReuseHandoffRequestInTransaction(draft(fixture), tx)
      ),
    ]);

    expect([left.outcome, right.outcome].sort()).toEqual([
      "created",
      "reused",
    ]);
    expect(left.request?.id).toBe(right.request?.id);
    await expect(prisma.handoffRequest.count({
      where: {
        representativeId: fixture.representativeId,
        status: { in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING] },
      },
    })).resolves.toBe(1);
    await expect(prisma.handoffEntitlementGrant.findUniqueOrThrow({
      where: { id: fixture.grantId },
      select: { remainingUses: true, reservedUses: true, consumedUses: true },
    })).resolves.toEqual({
      remainingUses: 0,
      reservedUses: 1,
      consumedUses: 0,
    });
  });

  it("checks grant expiry only when first entering RESERVED", async () => {
    const fixture = await createFixture(1);
    const reserved = await write((tx) =>
      createOrReuseHandoffRequestInTransaction(draft(fixture), tx)
    );
    if (!reserved.request) throw new Error("expected paid handoff reservation");

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "HandoffEntitlementGrant" DISABLE TRIGGER "HandoffEntitlementGrant_binding_guard"',
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE "HandoffEntitlementGrant" DISABLE TRIGGER "HandoffEntitlementGrant_audit_closure_guard"',
      );
      const expiredAt = new Date(Date.now() - 86_400_000);
      await tx.handoffEntitlementGrant.update({
        where: { id: fixture.grantId },
        data: {
          startsAt: new Date(expiredAt.getTime() - 86_400_000),
          expiresAt: expiredAt,
        },
      });
      await tx.$executeRawUnsafe(
        'ALTER TABLE "HandoffEntitlementGrant" ENABLE TRIGGER "HandoffEntitlementGrant_binding_guard"',
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE "HandoffEntitlementGrant" ENABLE TRIGGER "HandoffEntitlementGrant_audit_closure_guard"',
      );

      await expect(tx.handoffRequest.update({
        where: { id: reserved.request!.id },
        data: { summary: "Reserved request remains operable after expiry." },
      })).resolves.toMatchObject({
        id: reserved.request!.id,
        entitlementReservationState: "RESERVED",
      });
      throw new ExpectedRollback();
    })).rejects.toBeInstanceOf(ExpectedRollback);
  });
});

class ExpectedRollback extends Error {}

function write<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(operation);
}

type Fixture = {
  representativeId: string;
  contactId: string;
  conversationId: string;
  grantId: string;
};

function draft(fixture: Fixture) {
  return {
    representativeId: fixture.representativeId,
    contactId: fixture.contactId,
    conversationId: fixture.conversationId,
    reason: "Owner handoff requested",
    summary: "PostgreSQL paid handoff state-machine probe.",
    recommendedPriority: 73,
    recommendedOwnerAction: "Review and take over.",
  };
}

async function createFixture(grantedUses: number): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const paidAt = new Date();
  const owner = await prisma.owner.create({
    data: { displayName: `Handoff entitlement ${suffix}` },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `handoff-entitlement-${suffix}`,
      displayName: "Handoff entitlement probe",
      roleSummary: "PostgreSQL audit closure fixture",
      tone: "neutral",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
      handoffAccessMode: RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
    },
  });
  const audience = await prisma.audienceIdentity.create({
    data: {
      audienceKey: `postgres-handoff:${suffix}`,
      status: AudienceIdentityStatus.ANONYMOUS,
    },
  });
  const contact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      audienceIdentityId: audience.id,
      channelUserId: `postgres-handoff:${suffix}`,
      displayName: "Handoff audience",
      sourceChannel: "WEB",
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      audienceIdentityId: audience.id,
      channel: Channel.PRIVATE_CHAT,
      sourceChannel: "WEB",
      externalConversationId: `postgres-handoff:${suffix}`,
    },
  });
  const wallet = await prisma.userWallet.create({
    data: {
      audienceIdentityId: audience.id,
      externalUserId: `postgres-handoff:${suffix}`,
    },
  });
  const product = await prisma.billingProduct.create({
    data: {
      representativeId: representative.id,
      code: `handoff-${suffix}`,
      name: "Handoff package",
      kind: BillingProductKind.SERVICE_PACKAGE,
      status: BillingProductStatus.ACTIVE,
    },
  });
  const price = await prisma.billingPriceVersion.create({
    data: {
      billingProductId: product.id,
      version: 1,
      status: BillingPriceVersionStatus.ACTIVE,
      amountMinor: 100,
      unitName: "credit",
      entitlementUnits: 100,
      handoffAllowance: BillingHandoffAllowance.LIMITED,
      handoffUnits: grantedUses,
      handoffServiceLevel: BillingHandoffServiceLevel.PRIORITY,
      handoffValidityDays: 30,
      publishedAt: paidAt,
    },
  });
  const order = await prisma.rechargeOrder.create({
    data: {
      userWalletId: wallet.id,
      representativeId: representative.id,
      productCode: "agent-wallet:service-credit:v1",
      billingProductId: product.id,
      billingPriceVersionId: price.id,
      productNameSnapshot: product.name,
      productKindSnapshot: BillingProductKind.SERVICE_PACKAGE,
      unitNameSnapshot: "credit",
      entitlementUnitsSnapshot: 100,
      handoffAllowanceSnapshot: BillingHandoffAllowance.LIMITED,
      handoffUnitsSnapshot: grantedUses,
      handoffServiceLevelSnapshot: BillingHandoffServiceLevel.PRIORITY,
      handoffValidityDaysSnapshot: 30,
      creatorRevenueShareBpsSnapshot: 2000,
      platformRevenueShareBpsSnapshot: 8000,
      refundPolicySnapshot: "FULL_WHEN_UNUSED",
      expiryPolicySnapshot: "NEVER_EXPIRES",
      entitlementValidityDaysSnapshot: null,
      provider: PaymentProvider.MOCK,
      amountCents: 100,
      status: RechargeOrderStatus.PAID,
      idempotencyKey: `postgres-handoff:${suffix}`,
      paidAt,
    },
  });
  const expiresAt = new Date(paidAt.getTime() + 30 * 86_400_000);
  const grant = await write(async (tx) => {
    const created = await tx.handoffEntitlementGrant.create({
      data: {
        rechargeOrderId: order.id,
        audienceIdentityId: audience.id,
        representativeId: representative.id,
        billingPriceVersionId: price.id,
        allowance: BillingHandoffAllowance.LIMITED,
        serviceLevel: BillingHandoffServiceLevel.PRIORITY,
        grantedUses,
        remainingUses: grantedUses,
        startsAt: paidAt,
        expiresAt,
      },
    });
    await tx.handoffEntitlementLedgerEntry.create({
      data: {
        grantId: created.id,
        kind: HandoffEntitlementLedgerKind.GRANT,
        uses: grantedUses,
        remainingAfter: grantedUses,
        reservedAfter: 0,
        consumedAfter: 0,
        idempotencyKey: `handoff-grant:${order.id}`,
      },
    });
    return created;
  });
  return {
    representativeId: representative.id,
    contactId: contact.id,
    conversationId: conversation.id,
    grantId: grant.id,
  };
}
