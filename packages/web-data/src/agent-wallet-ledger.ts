import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  type Prisma,
} from "@prisma/client";

import {
  assertWalletIdempotencyField,
  runWalletWriteTransaction,
  type WalletWriteTransactionOptions,
} from "./agent-wallet-write";
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
  transactionId?: string | null;
  userWalletId?: string | null;
  userAgentWalletId?: string | null;
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
  transactionId?: string | null;
  userWalletId?: string | null;
  userAgentWalletId?: string | null;
  agentWalletId?: string | null;
  representativeId?: string | null;
  ownerId?: string | null;
  creatorEarningId?: string | null;
  rechargeOrderId?: string | null;
  paymentProviderEventId?: string | null;
  tokenPurchaseId?: string | null;
  usageChargeId?: string | null;
  withdrawRequestId?: string | null;
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
  $transaction?<T>(
    fn: (tx: WalletLedgerClient) => Promise<T>,
    options?: WalletWriteTransactionOptions,
  ): Promise<T>;
};

const SUPPORTED_CURRENCIES = new Set(["CNY", "USD"]);

export function walletLedgerAccountKey(movement: Pick<
  WalletLedgerMovement,
  | "accountType"
  | "userWalletId"
  | "userAgentWalletId"
  | "agentWalletId"
  | "ownerId"
  | "representativeId"
  | "metadata"
>): string {
  switch (movement.accountType) {
    case AmnWalletAccountType.USER_CASH:
      return `${movement.accountType}:${requiredId(movement.userWalletId, "userWalletId")}`;
    case AmnWalletAccountType.AGENT_TOKEN:
      return `${movement.accountType}:${requiredId(movement.agentWalletId, "agentWalletId")}`;
    case AmnWalletAccountType.SERVICE_CREDIT_DEFERRED:
      return [
        movement.accountType,
        requiredId(movement.userAgentWalletId, "userAgentWalletId"),
      ].join(":");
    case AmnWalletAccountType.CREATOR_PENDING:
    case AmnWalletAccountType.CREATOR_WITHDRAWABLE:
    case AmnWalletAccountType.CREATOR_FROZEN:
      return [
        movement.accountType,
        requiredId(movement.ownerId, "ownerId"),
        requiredId(movement.representativeId, "representativeId"),
      ].join(":");
    case AmnWalletAccountType.PLATFORM_REVENUE:
    case AmnWalletAccountType.PLATFORM_DEFERRED_REVENUE:
    case AmnWalletAccountType.PLATFORM_EARNED_REVENUE:
    case AmnWalletAccountType.PROVIDER_COST:
      return [
        movement.accountType,
        requiredId(movement.representativeId, "representativeId"),
      ].join(":");
    case AmnWalletAccountType.EXTERNAL_SETTLEMENT:
      return [
        movement.accountType,
        requiredMetadataString(movement.metadata, "provider"),
      ].join(":");
    case AmnWalletAccountType.PAYOUT_CLEARING:
      return [
        movement.accountType,
        requiredId(movement.ownerId, "ownerId"),
      ].join(":");
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
  const running = new Map<string, {
    amountCents: number;
    tokenAmount: number;
    amountKnown: boolean;
    tokenKnown: boolean;
  }>();

  return input.movements.map((movement) => {
    const key = walletLedgerAccountKey(movement);
    const initialBalance = input.initialBalances?.[key];
    const balance = running.get(key) ?? {
      amountCents: initialBalance?.amountCents ?? 0,
      tokenAmount: initialBalance?.tokenAmount ?? 0,
      amountKnown: initialBalance?.amountCents !== undefined,
      tokenKnown: initialBalance?.tokenAmount !== undefined,
    };
    balance.amountCents += movement.amountCents ?? 0;
    balance.tokenAmount += movement.tokenAmount ?? 0;

    const balanceAfterCents = movement.balanceAfterCents !== undefined
      ? movement.balanceAfterCents
      : balance.amountKnown
        ? balance.amountCents
        : null;
    const tokenBalanceAfter = movement.tokenBalanceAfter !== undefined
      ? movement.tokenBalanceAfter
      : balance.tokenKnown
        ? balance.tokenAmount
        : null;
    if (movement.balanceAfterCents !== undefined) {
      balance.amountKnown = movement.balanceAfterCents !== null;
      if (movement.balanceAfterCents !== null) {
        balance.amountCents = movement.balanceAfterCents;
      }
    }
    if (movement.tokenBalanceAfter !== undefined) {
      balance.tokenKnown = movement.tokenBalanceAfter !== null;
      if (movement.tokenBalanceAfter !== null) {
        balance.tokenAmount = movement.tokenBalanceAfter;
      }
    }
    running.set(key, balance);

    const entry: Prisma.WalletLedgerEntryUncheckedCreateInput = {
      eventGroupId: input.eventGroupId,
      idempotencyKey: `${input.idempotencyKey}:${movement.entryKey}`,
      accountType: movement.accountType,
      entryKind: movement.entryKind,
      transactionId: movement.transactionId ?? null,
      userWalletId: movement.userWalletId ?? null,
      userAgentWalletId: movement.userAgentWalletId ?? null,
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
      balanceAfterCents,
      tokenBalanceAfter,
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
  const expectedEntries = buildWalletLedgerCreateInputs(input);
  const run = async (tx: WalletLedgerClient) => {
    const existing = await tx.walletLedgerEntry.findFirst({
      where: {
        eventGroupId: input.eventGroupId,
        idempotencyKey: {
          startsWith: `${input.idempotencyKey}:`,
        },
      },
    });

    if (existing) {
      assertWalletIdempotencyField(
        "wallet ledger transaction",
        "eventGroupId",
        existing.eventGroupId,
        input.eventGroupId,
      );
      const existingEntries = await tx.walletLedgerEntry.findMany({
        where: { eventGroupId: existing.eventGroupId },
        orderBy: { createdAt: "asc" },
      });
      assertWalletLedgerReplayMatches(existingEntries, expectedEntries);
      return existingEntries;
    }

    const created: WalletLedgerEntryRecord[] = [];
    for (const entry of expectedEntries) {
      created.push(await tx.walletLedgerEntry.create({ data: entry }));
    }
    return created;
  };

  return runWalletWriteTransaction(client, run);
}

function assertWalletLedgerReplayMatches(
  existingEntries: WalletLedgerEntryRecord[],
  expectedEntries: Prisma.WalletLedgerEntryUncheckedCreateInput[],
): void {
  assertWalletIdempotencyField(
    "wallet ledger transaction",
    "movement count",
    existingEntries.length,
    expectedEntries.length,
  );

  const existingByKey = new Map(
    existingEntries.map((entry) => [entry.idempotencyKey, entry]),
  );
  for (const expected of expectedEntries) {
    const existing = existingByKey.get(expected.idempotencyKey);
    if (!existing) {
      assertWalletIdempotencyField(
        "wallet ledger transaction",
        "movement keys",
        null,
        expected.idempotencyKey,
      );
      continue;
    }
    assertWalletIdempotencyField(
      "wallet ledger transaction",
      "accountType",
      existing.accountType,
      expected.accountType,
    );
    assertWalletIdempotencyField(
      "wallet ledger transaction",
      "entryKind",
      existing.entryKind,
      expected.entryKind,
    );
    assertWalletIdempotencyField(
      "wallet ledger transaction",
      "amountCents",
      existing.amountCents,
      expected.amountCents ?? 0,
    );
    assertWalletIdempotencyField(
      "wallet ledger transaction",
      "tokenAmount",
      existing.tokenAmount,
      expected.tokenAmount ?? 0,
    );
    assertWalletIdempotencyField(
      "wallet ledger transaction",
      "currency",
      existing.currency,
      expected.currency,
    );

    assertOptionalLedgerIdentity(existing, expected, "userWalletId");
    assertOptionalLedgerIdentity(existing, expected, "userAgentWalletId");
    assertOptionalLedgerIdentity(existing, expected, "agentWalletId");
    assertOptionalLedgerIdentity(existing, expected, "representativeId");
    assertOptionalLedgerIdentity(existing, expected, "ownerId");
    assertOptionalLedgerIdentity(existing, expected, "creatorEarningId");
    assertOptionalLedgerIdentity(existing, expected, "rechargeOrderId");
    assertOptionalLedgerIdentity(existing, expected, "paymentProviderEventId");
    assertOptionalLedgerIdentity(existing, expected, "tokenPurchaseId");
    assertOptionalLedgerIdentity(existing, expected, "usageChargeId");
    assertOptionalLedgerIdentity(existing, expected, "withdrawRequestId");
    assertOptionalLedgerIdentity(existing, expected, "transactionId");
  }
}

type OptionalLedgerIdentity = Exclude<
  keyof WalletLedgerEntryRecord,
  | "id"
  | "eventGroupId"
  | "idempotencyKey"
  | "accountType"
  | "entryKind"
  | "amountCents"
  | "tokenAmount"
  | "currency"
>;

function assertOptionalLedgerIdentity(
  existing: WalletLedgerEntryRecord,
  expected: Prisma.WalletLedgerEntryUncheckedCreateInput,
  field: OptionalLedgerIdentity,
): void {
  if (Object.prototype.hasOwnProperty.call(existing, field)) {
    assertWalletIdempotencyField(
      "wallet ledger transaction",
      field,
      existing[field],
      expected[field],
    );
  }
}

function assertNoNegativeProjectedBalances(input: WalletLedgerTransactionInput): void {
  const running = new Map<string, {
    amountCents: number;
    tokenAmount: number;
    amountKnown: boolean;
    tokenKnown: boolean;
  }>();

  for (const movement of input.movements) {
    const key = walletLedgerAccountKey(movement);
    const initial = input.initialBalances?.[key];
    const balance = running.get(key) ?? {
      amountCents: initial?.amountCents ?? 0,
      tokenAmount: initial?.tokenAmount ?? 0,
      amountKnown: initial?.amountCents !== undefined,
      tokenKnown: initial?.tokenAmount !== undefined,
    };
    balance.amountCents += movement.amountCents ?? 0;
    balance.tokenAmount += movement.tokenAmount ?? 0;

    if (
      balance.amountKnown
      && isNonnegativeAmountAccount(movement.accountType)
      && balance.amountCents < 0
    ) {
      throw new Error(`Wallet ledger would make ${key} negative.`);
    }
    if (
      balance.tokenKnown
      && isNonnegativeTokenAccount(movement.accountType)
      && balance.tokenAmount < 0
    ) {
      throw new Error(`Wallet ledger would make ${key} negative.`);
    }

    if (movement.balanceAfterCents !== undefined) {
      balance.amountKnown = movement.balanceAfterCents !== null;
      if (movement.balanceAfterCents !== null) {
        balance.amountCents = movement.balanceAfterCents;
      }
    }
    if (movement.tokenBalanceAfter !== undefined) {
      balance.tokenKnown = movement.tokenBalanceAfter !== null;
      if (movement.tokenBalanceAfter !== null) {
        balance.tokenAmount = movement.tokenBalanceAfter;
      }
    }
    if (
      balance.amountKnown
      && isNonnegativeAmountAccount(movement.accountType)
      && balance.amountCents < 0
    ) {
      throw new Error(`Wallet ledger would make ${key} negative.`);
    }
    if (
      balance.tokenKnown
      && isNonnegativeTokenAccount(movement.accountType)
      && balance.tokenAmount < 0
    ) {
      throw new Error(`Wallet ledger would make ${key} negative.`);
    }
    running.set(key, balance);
  }
}

function isNonnegativeAmountAccount(accountType: AmnWalletAccountType): boolean {
  return accountType === AmnWalletAccountType.USER_CASH
    || accountType === AmnWalletAccountType.CREATOR_WITHDRAWABLE
    || accountType === AmnWalletAccountType.CREATOR_FROZEN;
}

function isNonnegativeTokenAccount(accountType: AmnWalletAccountType): boolean {
  return accountType === AmnWalletAccountType.AGENT_TOKEN
    || accountType === AmnWalletAccountType.SERVICE_CREDIT_DEFERRED;
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

function requiredMetadataString(
  metadata: Prisma.InputJsonValue | undefined,
  label: string,
): string {
  const record =
    metadata && !Array.isArray(metadata) && typeof metadata === "object"
      ? metadata as Record<string, unknown>
      : null;
  const value = record?.[label];
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(`Wallet ledger movement metadata requires ${label}.`);
  }
  return value.trim();
}
