import { Prisma } from "@prisma/client";

import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

export type WalletWriteTransactionOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

type WalletTransactionRunner<TClient> = {
  $transaction?<T>(
    operation: (tx: TClient) => Promise<T>,
    options?: WalletWriteTransactionOptions,
  ): Promise<T>;
};

export class WalletIdempotencyConflictError extends Error {
  readonly code = "WALLET_IDEMPOTENCY_CONFLICT";

  constructor(operation: string, field: string) {
    super(
      `Idempotency key was already used for a different ${operation} (${field} does not match).`,
    );
    this.name = "WalletIdempotencyConflictError";
  }
}

export async function runWalletWriteTransaction<TClient, T>(
  client: TClient,
  operation: (tx: TClient) => Promise<T>,
): Promise<T> {
  const transactionalClient = client as TClient & WalletTransactionRunner<TClient>;
  if (!transactionalClient.$transaction) {
    return operation(client);
  }

  return runWithPrismaWriteConflictRetry(
    () =>
      transactionalClient.$transaction!(
        operation,
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    {
      // A concurrent request with the same idempotency key can race on the
      // unique constraint before its first transaction observes the winner.
      // Retrying lets the read path validate and return that committed result.
      additionalRetryableCodes: ["P2002"],
    },
  );
}

export function resolveWalletOperationId(
  idempotencyKey: string | undefined,
  operation: string,
): string {
  if (typeof idempotencyKey === "undefined") {
    return `${operation}:operation:${crypto.randomUUID()}`;
  }

  const normalized = idempotencyKey.trim();
  if (!normalized) {
    throw new Error(`${operation} idempotencyKey must not be empty.`);
  }
  return normalized;
}

export function assertWalletIdempotencyField(
  operation: string,
  field: string,
  actual: unknown,
  expected: unknown,
): void {
  if (!Object.is(actual ?? null, expected ?? null)) {
    throw new WalletIdempotencyConflictError(operation, field);
  }
}
