import {
  PaymentProvider,
  RechargeOrderStatus,
  ReliableEventStatus,
  WalletExceptionCaseStatus,
  WalletExceptionSeverity,
  WalletExceptionSourceType,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";
import {
  actOnWalletExceptionCase,
  WalletExceptionActionError,
} from "../src/wallet-exceptions";

const describePostgres =
  process.env.DELEGATE_POSTGRES_E2E === "1"
    ? describe
    : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres(
  "WeChat Pay operations PostgreSQL concurrency",
  () => {
    it("replays concurrent identical actions and rejects a different CAS winner", async () => {
      const fixture = await createFixture();
      try {
        const sameRequest = {
          caseId: fixture.caseId,
          ownerId: fixture.ownerId,
          representativeSlug: fixture.representativeSlug,
          action: "claim" as const,
          expectedVersion: 0,
          idempotencyKey: `${fixture.suffix}:same-claim`,
        };
        const identical = await Promise.all([
          actOnWalletExceptionCase(sameRequest),
          actOnWalletExceptionCase(sameRequest),
        ]);
        expect(identical[0]).toEqual(identical[1]);
        expect(identical[0]).toMatchObject({
          status: "claimed",
          version: 1,
        });
        expect(
          await prisma.walletExceptionAction.count({
            where: { caseId: fixture.caseId },
          }),
        ).toBe(1);

        await prisma.walletExceptionCase.update({
          where: { id: fixture.caseId },
          data: {
            status: WalletExceptionCaseStatus.OPEN,
            claimedByOwnerId: null,
            claimedAt: null,
            version: 2,
          },
        });
        const competing = await Promise.allSettled([
          actOnWalletExceptionCase({
            ...sameRequest,
            expectedVersion: 2,
            idempotencyKey: `${fixture.suffix}:claim-a`,
          }),
          actOnWalletExceptionCase({
            ...sameRequest,
            expectedVersion: 2,
            idempotencyKey: `${fixture.suffix}:claim-b`,
          }),
        ]);
        expect(
          competing.filter(
            (result) => result.status === "fulfilled",
          ),
        ).toHaveLength(1);
        const rejected = competing.find(
          (result) => result.status === "rejected",
        );
        expect(rejected).toBeDefined();
        if (rejected?.status === "rejected") {
          expect(rejected.reason).toBeInstanceOf(
            WalletExceptionActionError,
          );
          expect(rejected.reason).toMatchObject({
            code: "wallet_exception_version_conflict",
            statusCode: 409,
          });
        }
      } finally {
        await cleanupFixture(fixture);
      }
    });
  },
);

async function createFixture() {
  const suffix = crypto.randomUUID();
  const owner = await prisma.owner.create({
    data: {
      displayName: `Operations ${suffix}`,
    },
  });
  const representativeSlug = `ops-${suffix}`;
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: representativeSlug,
      displayName: "Operations representative",
      roleSummary: "Operations test",
      tone: "clear",
      languages: ["zh"],
      freeScope: {},
      paywalledIntents: [],
      handoffPrompt: "handoff",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const userWallet = await prisma.userWallet.create({
    data: {
      externalUserId: `operations-${suffix}`,
    },
  });
  const rechargeOrder = await prisma.rechargeOrder.create({
    data: {
      userWalletId: userWallet.id,
      representativeId: representative.id,
      provider: PaymentProvider.WECHAT_PAY,
      amountCents: 500,
      status: RechargeOrderStatus.REQUIRES_PAYMENT,
      idempotencyKey: `${suffix}:recharge`,
    },
  });
  const outbox = await prisma.outboxEvent.create({
    data: {
      aggregateType: "recharge_order",
      aggregateId: rechargeOrder.id,
      eventType: "wechat_pay.order.reconcile",
      payload: { version: 1 },
      status: ReliableEventStatus.DEAD_LETTER,
      idempotencyKey: `${suffix}:outbox`,
      lastError: "safe_test_failure",
    },
  });
  const exceptionCase = await prisma.walletExceptionCase.create({
    data: {
      ownerId: owner.id,
      representativeId: representative.id,
      kind: "payment_reconciliation",
      reasonCode: "wechat_order_reconciliation_dead_letter",
      sourceType:
        WalletExceptionSourceType.ORDER_RECONCILIATION_OUTBOX,
      sourceId: outbox.id,
      outboxEventId: outbox.id,
      status: WalletExceptionCaseStatus.OPEN,
      severity: WalletExceptionSeverity.CRITICAL,
    },
  });
  return {
    suffix,
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug,
    userWalletId: userWallet.id,
    rechargeOrderId: rechargeOrder.id,
    outboxId: outbox.id,
    caseId: exceptionCase.id,
  };
}

async function cleanupFixture(fixture: {
  ownerId: string;
  representativeId: string;
  userWalletId: string;
  rechargeOrderId: string;
  outboxId: string;
  caseId: string;
}) {
  await prisma.walletExceptionAction.deleteMany({
    where: { caseId: fixture.caseId },
  });
  await prisma.walletExceptionCase.deleteMany({
    where: { id: fixture.caseId },
  });
  await prisma.outboxEvent.deleteMany({
    where: { id: fixture.outboxId },
  });
  await prisma.rechargeOrder.deleteMany({
    where: { id: fixture.rechargeOrderId },
  });
  await prisma.userWallet.deleteMany({
    where: { id: fixture.userWalletId },
  });
  await prisma.representative.deleteMany({
    where: { id: fixture.representativeId },
  });
  await prisma.owner.deleteMany({
    where: { id: fixture.ownerId },
  });
}

function assertSafePostgresE2eTarget() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (
    !databaseUrl.includes("delegate_wallet_concurrency_test")
    && !databaseUrl.includes("delegate_test")
  ) {
    throw new Error(
      "Refusing to run PostgreSQL wallet operations tests against a non-test database.",
    );
  }
}
