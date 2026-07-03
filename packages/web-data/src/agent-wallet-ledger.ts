import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  type Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";

export type WalletBalanceSnapshot = {
  amountCents?: number;
  tokenAmount?: number;
};

export type WalletLedgerMovement = {
  entryKey: string;
  accountType: AmnWalletAccountType;
  entryKind: AmnLedgerEntryKind;
  amountCents?: number;
  tokenAmount?: number;
  userWalletId?: string | null;
  agentWalletId?: string | null;
  representativeId?: string | null;
  ownerId?: string | null;
  creatorEarningId?: string | null;
  rechargeOrderId?: string | null;
  paymentProviderEventId?: string | null;
  tokenPurchaseId?: string | null;
  usageChargeId?: string | null;
  withdrawRequestId?: string | null;
  balanceAfterCents?: number | null;
  tokenBalanceAfter?: number | null;
  notes?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export type WalletLedgerTransactionInput = {
  eventGroupId: string;
  idempotencyKey: string;
  currency: string;
  movements: WalletLedgerMovement[];
  initialBalances?: Record<string, WalletBalanceSnapshot>;
  requireBalancedAmount?: boolean;
};

export type WalletLedgerProjection = Record<string, Required<WalletBalanceSnapshot>>;

export type WalletLedgerEntryRecord = {
  id: string;
  eventGroupId: string;
  idempotencyKey: string;
  accountType: AmnWalletAccountType;
  entryKind: AmnLedgerEntryKind;
  amountCents: number;
  tokenAmount: number;
  currency: string;
};

export type WalletLedgerEntryDelegate = {
  findFirst(args: {
    where: { eventGroupId?: string; idempotencyKey?: { startsWith: string } };
  }): Promise<WalletLedgerEntryRecord | null>;
  findMany(args: {
    where: { eventGroupId: string };
    orderBy: { createdAt: "asc" };
  }): Promise<WalletLedgerEntryRecord[]>;
  create(args: {
    data: Prisma.WalletLedgerEntryUncheckedCreateInput;
  }): Promise<WalletLedgerEntryRecord>;
};

export type WalletLedgerClient = {
  walletLedgerEntry: WalletLedgerEntryDelegate;
  $transaction?<T>(fn: (tx: WalletLedgerClient) => Promise<T>): Promise<T>;
};

const SUPPORTED_CURRENCIES = new Set(["CNY", "USD"]);

export function walletLedgerAccountKey(movement: Pick<
  WalletLedgerMovement,
  "accountType" | "userWalletId" | "agentWalletId" | "ownerId" | "representativeId"
>): string {
  switch (movement.accountType) {
    case AmnWalletAccountType.USER_CASH:
      return `${movement.accountType}:${requiredId(movement.userWalletId, "userWalletId")}`;
    case AmnWalletAccountType.AGENT_TOKEN:
      return `${movement.accountType}:${requiredId(movement.agentWalletId, "agentWalletId")}`;
    case AmnWalletAccountType.CREATOR_PENDING:
    case AmnWalletAccountType.CREATOR_WITHDRAWABLE:
      return [
        movement.accountType,
        requiredId(movement.ownerId, "ownerId"),
        requiredId(movement.representativeId, "representativeId"),
      ].join(":");
    case AmnWalletAccountType.PLATFORM_REVENUE:
    case AmnWalletAccountType.PROVIDER_COST:
      return movement.accountType;
  }
}

export function validateWalletLedgerTransaction(input: WalletLedgerTransactionInput): void {
  if (!input.eventGroupId.trim()) {
    throw new Error("Wallet ledger eventGroupId is required.");
  }
  if (!input.idempotencyKey.trim()) {
    throw new Error("Wallet ledger idempotencyKey is required.");
  }
  if (!SUPPORTED_CURRENCIES.has(input.currency)) {
    throw new Error(`Unsupported wallet currency: ${input.currency}`);
  }
  if (!input.movements.length) {
    throw new Error("Wallet ledger transaction must include at least one movement.");
  }

  const entryKeys = new Set<string>();
  let amountTotal = 0;

  for (const movement of input.movements) {
    if (!movement.entryKey.trim()) {
      throw new Error("Wallet ledger movement entryKey is required.");
    }
    if (entryKeys.has(movement.entryKey)) {
      throw new Error(`Duplicate wallet ledger movement entryKey: ${movement.entryKey}`);
    }
    entryKeys.add(movement.entryKey);
    assertInteger(movement.amountCents ?? 0, "amountCents");
    assertInteger(movement.tokenAmount ?? 0, "tokenAmount");
    walletLedgerAccountKey(movement);
    amountTotal += movement.amountCents ?? 0;
  }

  if (input.requireBalancedAmount && amountTotal !== 0) {
    throw new Error("Wallet ledger amount movements must balance to zero.");
  }

  assertNoNegativeProjectedBalances(input);
}

export function projectWalletLedgerBalances(
  movements: WalletLedgerMovement[],
  initialBalances: Record<string, WalletBalanceSnapshot> = {},
): WalletLedgerProjection {
  const projection: WalletLedgerProjection = {};

  for (const movement of movements) {
    const key = walletLedgerAccountKey(movement);
    const current =
      projection[key] ??
      ({
        amountCents: initialBalances[key]?.amountCents ?? 0,
        tokenAmount: initialBalances[key]?.tokenAmount ?? 0,
      } satisfies Required<WalletBalanceSnapshot>);

    projection[key] = {
      amountCents: current.amountCents + (movement.amountCents ?? 0),
      tokenAmount: current.tokenAmount + (movement.tokenAmount ?? 0),
    };
  }

  return projection;
}

export function buildWalletLedgerCreateInputs(
  input: WalletLedgerTransactionInput,
): Prisma.WalletLedgerEntryUncheckedCreateInput[] {
  validateWalletLedgerTransaction(input);
  const projection = projectWalletLedgerBalances(input.movements, input.initialBalances);

  return input.movements.map((movement) => {
    const key = walletLedgerAccountKey(movement);
    const balance = projection[key];
    if (!balance) {
      throw new Error(`Wallet ledger projection missing for ${key}.`);
    }

    const entry: Prisma.WalletLedgerEntryUncheckedCreateInput = {
      eventGroupId: input.eventGroupId,
      idempotencyKey: `${input.idempotencyKey}:${movement.entryKey}`,
      accountType: movement.accountType,
      entryKind: movement.entryKind,
      userWalletId: movement.userWalletId ?? null,
      agentWalletId: movement.agentWalletId ?? null,
      representativeId: movement.representativeId ?? null,
      ownerId: movement.ownerId ?? null,
      creatorEarningId: movement.creatorEarningId ?? null,
      rechargeOrderId: movement.rechargeOrderId ?? null,
      paymentProviderEventId: movement.paymentProviderEventId ?? null,
      tokenPurchaseId: movement.tokenPurchaseId ?? null,
      usageChargeId: movement.usageChargeId ?? null,
      withdrawRequestId: movement.withdrawRequestId ?? null,
      amountCents: movement.amountCents ?? 0,
      tokenAmount: movement.tokenAmount ?? 0,
      currency: input.currency,
      balanceAfterCents: movement.balanceAfterCents ?? balance.amountCents,
      tokenBalanceAfter: movement.tokenBalanceAfter ?? balance.tokenAmount,
      notes: movement.notes ?? null,
    };
    if (typeof movement.metadata !== "undefined") {
      entry.metadata = movement.metadata;
    }
    return entry;
  });
}

export async function recordWalletLedgerTransaction(
  input: WalletLedgerTransactionInput,
  client: WalletLedgerClient = prisma,
): Promise<WalletLedgerEntryRecord[]> {
  const run = async (tx: WalletLedgerClient) => {
    validateWalletLedgerTransaction(input);
    const existing = await tx.walletLedgerEntry.findFirst({
      where: {
        eventGroupId: input.eventGroupId,
        idempotencyKey: {
          startsWith: `${input.idempotencyKey}:`,
        },
      },
    });

    if (existing) {
      return tx.walletLedgerEntry.findMany({
        where: { eventGroupId: input.eventGroupId },
        orderBy: { createdAt: "asc" },
      });
    }

    const data = buildWalletLedgerCreateInputs(input);
    const created: WalletLedgerEntryRecord[] = [];
    for (const entry of data) {
      created.push(await tx.walletLedgerEntry.create({ data: entry }));
    }
    return created;
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

function assertNoNegativeProjectedBalances(input: WalletLedgerTransactionInput): void {
  const projection = projectWalletLedgerBalances(input.movements, input.initialBalances);

  for (const [key, balance] of Object.entries(projection)) {
    if (key.startsWith(AmnWalletAccountType.USER_CASH) && balance.amountCents < 0) {
      throw new Error(`Wallet ledger would make ${key} negative.`);
    }
    if (
      key.startsWith(AmnWalletAccountType.CREATOR_WITHDRAWABLE) &&
      balance.amountCents < 0
    ) {
      throw new Error(`Wallet ledger would make ${key} negative.`);
    }
    if (key.startsWith(AmnWalletAccountType.AGENT_TOKEN) && balance.tokenAmount < 0) {
      throw new Error(`Wallet ledger would make ${key} negative.`);
    }
  }
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`Wallet ledger ${label} must be an integer.`);
  }
}

function requiredId(value: string | null | undefined, label: string): string {
  if (!value) {
    throw new Error(`Wallet ledger movement requires ${label}.`);
  }
  return value;
}
