import {
  PaymentProvider,
  RechargeOrderStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { completeMockRechargeOrder } from "../src/agent-wallet-recharge";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("agent wallet PostgreSQL concurrency", () => {
  it("credits a recharge exactly once when the same provider event arrives concurrently", async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const wallet = await prisma.userWallet.create({
      data: {
        externalUserId: `postgres-wallet-concurrency-${suffix}`,
        currency: "CNY",
      },
    });
    const order = await prisma.rechargeOrder.create({
      data: {
        userWalletId: wallet.id,
        provider: PaymentProvider.MOCK,
        providerOrderId: `postgres-wallet-provider-order-${suffix}`,
        amountCents: 1_200,
        currency: "CNY",
        status: RechargeOrderStatus.REQUIRES_PAYMENT,
        idempotencyKey: `postgres-wallet-recharge-${suffix}`,
      },
    });
    const providerEventId = `postgres-wallet-paid-${suffix}`;

    try {
      const results = await Promise.all([
        completeMockRechargeOrder(order.id, { providerEventId }),
        completeMockRechargeOrder(order.id, { providerEventId }),
      ]);

      expect(results[0].cashBalanceCents).toBe(1_200);
      expect(results[1].cashBalanceCents).toBe(1_200);
      await expect(
        prisma.userWallet.findUniqueOrThrow({
          where: { id: wallet.id },
          select: { cashBalanceCents: true },
        }),
      ).resolves.toEqual({ cashBalanceCents: 1_200 });
      await expect(
        prisma.paymentProviderEvent.count({
          where: {
            provider: PaymentProvider.MOCK,
            providerEventId,
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.walletLedgerEntry.count({
          where: { rechargeOrderId: order.id },
        }),
      ).resolves.toBe(2);
      await expect(
        prisma.walletTransaction.count({
          where: {
            sourceType: "RechargeOrder",
            sourceId: order.id,
          },
        }),
      ).resolves.toBe(1);
    } finally {
      await prisma.walletLedgerEntry.deleteMany({
        where: { rechargeOrderId: order.id },
      });
      await prisma.walletTransaction.deleteMany({
        where: {
          sourceType: "RechargeOrder",
          sourceId: order.id,
        },
      });
      await prisma.paymentProviderEvent.deleteMany({
        where: { rechargeOrderId: order.id },
      });
      await prisma.rechargeOrder.delete({
        where: { id: order.id },
      }).catch(() => undefined);
      await prisma.userWallet.delete({
        where: { id: wallet.id },
      }).catch(() => undefined);
    }
  });
});

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the PostgreSQL wallet concurrency E2E.");
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "PostgreSQL wallet concurrency E2E refuses a non-local database unless "
        + "DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1 and the database name is clearly non-production.",
    );
  }
}
