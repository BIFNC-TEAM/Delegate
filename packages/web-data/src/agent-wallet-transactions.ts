import {
  WalletTransactionEventType,
  WalletTransactionStatus,
  type Prisma,
} from "@prisma/client";

import { assertWalletIdempotencyField } from "./agent-wallet-write";

export type WalletTransactionRecord = {
  id: string;
  eventGroupId: string;
  idempotencyKey: string;
  sourceType: string;
  sourceId: string | null;
  eventType: WalletTransactionEventType;
  status: WalletTransactionStatus;
  currency: string;
  ownerId: string | null;
  representativeId: string | null;
  userWalletId: string | null;
  metadata?: Prisma.JsonValue | null;
};

export type WalletTransactionClient = {
  /**
   * Optional only so focused in-memory test clients written before the
   * transaction header was introduced remain usable. Prisma always supplies
   * this delegate, so every production wallet write records a header.
   */
  walletTransaction?: {
    findUnique(
      args: Prisma.WalletTransactionFindUniqueArgs,
    ): Promise<WalletTransactionRecord | null>;
    create(
      args: Prisma.WalletTransactionCreateArgs,
    ): Promise<WalletTransactionRecord>;
  };
};

export type RecordWalletTransactionInput = {
  eventGroupId: string;
  idempotencyKey: string;
  sourceType: string;
  sourceId?: string | null;
  eventType: WalletTransactionEventType;
  status?: WalletTransactionStatus;
  currency: string;
  ownerId?: string | null;
  representativeId?: string | null;
  userWalletId?: string | null;
  metadata?: Prisma.InputJsonValue;
  occurredAt?: Date;
  completedAt?: Date | null;
  failedAt?: Date | null;
  reversedAt?: Date | null;
};

export async function recordWalletTransaction(
  input: RecordWalletTransactionInput,
  client: WalletTransactionClient,
): Promise<WalletTransactionRecord | null> {
  if (!input.eventGroupId.trim()) {
    throw new Error("Wallet transaction eventGroupId is required.");
  }
  if (!input.idempotencyKey.trim()) {
    throw new Error("Wallet transaction idempotencyKey is required.");
  }

  const delegate = client.walletTransaction;
  if (!delegate) {
    return null;
  }

  const existing = await delegate.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    assertWalletTransactionReplay(existing, input);
    return existing;
  }

  const status = input.status ?? WalletTransactionStatus.SUCCEEDED;
  return delegate.create({
    data: {
      eventGroupId: input.eventGroupId,
      idempotencyKey: input.idempotencyKey,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      eventType: input.eventType,
      status,
      currency: input.currency,
      ownerId: input.ownerId ?? null,
      representativeId: input.representativeId ?? null,
      userWalletId: input.userWalletId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      completedAt:
        typeof input.completedAt === "undefined"
          ? status === WalletTransactionStatus.SUCCEEDED
            ? new Date()
            : null
          : input.completedAt,
      failedAt: input.failedAt ?? null,
      reversedAt: input.reversedAt ?? null,
      ...(typeof input.metadata === "undefined" ? {} : { metadata: input.metadata }),
    },
  });
}

export async function findWalletTransactionByIdempotencyKey(
  idempotencyKey: string,
  client: WalletTransactionClient,
): Promise<WalletTransactionRecord | null> {
  return (
    (await client.walletTransaction?.findUnique({
      where: { idempotencyKey },
    })) ?? null
  );
}

function assertWalletTransactionReplay(
  existing: WalletTransactionRecord,
  input: RecordWalletTransactionInput,
): void {
  assertWalletIdempotencyField(
    "wallet transaction",
    "eventGroupId",
    existing.eventGroupId,
    input.eventGroupId,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "sourceType",
    existing.sourceType,
    input.sourceType,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "sourceId",
    existing.sourceId,
    input.sourceId,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "eventType",
    existing.eventType,
    input.eventType,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "status",
    existing.status,
    input.status ?? WalletTransactionStatus.SUCCEEDED,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "currency",
    existing.currency,
    input.currency,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "ownerId",
    existing.ownerId,
    input.ownerId,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "representativeId",
    existing.representativeId,
    input.representativeId,
  );
  assertWalletIdempotencyField(
    "wallet transaction",
    "userWalletId",
    existing.userWalletId,
    input.userWalletId,
  );
  if (Object.prototype.hasOwnProperty.call(existing, "metadata")) {
    assertWalletIdempotencyField(
      "wallet transaction",
      "metadata",
      stableJson(existing.metadata),
      stableJson(input.metadata),
    );
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value ?? null));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}
