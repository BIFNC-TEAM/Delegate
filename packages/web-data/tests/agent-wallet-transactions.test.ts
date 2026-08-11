import {
  WalletTransactionEventType,
  WalletTransactionStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  recordWalletTransaction,
  type WalletTransactionClient,
  type WalletTransactionRecord,
} from "../src/agent-wallet-transactions";
import { WalletIdempotencyConflictError } from "../src/agent-wallet-write";

const input = {
  eventGroupId: "recharge:order-1",
  idempotencyKey: "recharge:order-1:paid",
  sourceType: "RechargeOrder",
  sourceId: "order-1",
  eventType: WalletTransactionEventType.USER_RECHARGE,
  currency: "CNY",
  userWalletId: "wallet-1",
} as const;

describe("wallet transaction headers", () => {
  it("looks up and replays a transaction by its unique idempotency key", async () => {
    const existing = transactionRecord();
    const findUnique = vi.fn(
      async (_args: Prisma.WalletTransactionFindUniqueArgs) => existing,
    );
    const create = vi.fn(
      async (_args: Prisma.WalletTransactionCreateArgs) => existing,
    );
    const client = {
      walletTransaction: { findUnique, create },
    } satisfies WalletTransactionClient;

    await expect(recordWalletTransaction(input, client)).resolves.toEqual(
      existing,
    );
    expect(findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for another event group", async () => {
    const existing = transactionRecord();
    const client = {
      walletTransaction: {
        findUnique: vi.fn(
          async (_args: Prisma.WalletTransactionFindUniqueArgs) => existing,
        ),
        create: vi.fn(
          async (_args: Prisma.WalletTransactionCreateArgs) => existing,
        ),
      },
    } satisfies WalletTransactionClient;

    await expect(
      recordWalletTransaction(
        { ...input, eventGroupId: "recharge:order-2" },
        client,
      ),
    ).rejects.toBeInstanceOf(WalletIdempotencyConflictError);
    expect(client.walletTransaction.create).not.toHaveBeenCalled();
  });
});

function transactionRecord(): WalletTransactionRecord {
  return {
    id: "transaction-1",
    eventGroupId: input.eventGroupId,
    idempotencyKey: input.idempotencyKey,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    eventType: input.eventType,
    status: WalletTransactionStatus.SUCCEEDED,
    currency: input.currency,
    ownerId: null,
    representativeId: null,
    userWalletId: input.userWalletId,
  };
}
