import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  buildWalletLedgerCreateInputs,
  projectWalletLedgerBalances,
  recordWalletLedgerTransaction,
  walletLedgerAccountKey,
  type WalletLedgerTransactionInput,
} from "../src/agent-wallet-ledger";

type StoredLedgerEntry = {
  id: string;
  eventGroupId: string;
  idempotencyKey: string;
  accountType: AmnWalletAccountType;
  entryKind: AmnLedgerEntryKind;
  amountCents: number;
  tokenAmount: number;
  currency: string;
  createdAt: Date;
};

function purchaseInput(overrides: Partial<WalletLedgerTransactionInput> = {}): WalletLedgerTransactionInput {
  return {
    eventGroupId: "purchase_1",
    idempotencyKey: "purchase_1",
    currency: "CNY",
    requireBalancedAmount: true,
    initialBalances: {
      [`${AmnWalletAccountType.USER_CASH}:user_wallet_1`]: {
        amountCents: 5000,
      },
    },
    movements: [
      {
        entryKey: "user_cash_debit",
        accountType: AmnWalletAccountType.USER_CASH,
        entryKind: AmnLedgerEntryKind.USER_CASH_DEBIT,
        userWalletId: "user_wallet_1",
        amountCents: -1000,
      },
      {
        entryKey: "platform_revenue_credit",
        accountType: AmnWalletAccountType.PLATFORM_REVENUE,
        entryKind: AmnLedgerEntryKind.PLATFORM_REVENUE_CREDIT,
        amountCents: 800,
      },
      {
        entryKey: "agent_token_credit",
        accountType: AmnWalletAccountType.AGENT_TOKEN,
        entryKind: AmnLedgerEntryKind.AGENT_TOKEN_CREDIT,
        agentWalletId: "agent_wallet_1",
        representativeId: "rep_1",
        tokenAmount: 1000,
      },
      {
        entryKey: "creator_pending_credit",
        accountType: AmnWalletAccountType.CREATOR_PENDING,
        entryKind: AmnLedgerEntryKind.CREATOR_PENDING_CREDIT,
        ownerId: "owner_1",
        representativeId: "rep_1",
        amountCents: 200,
      },
    ],
    ...overrides,
  };
}

describe("agent wallet ledger", () => {
  it("builds deterministic idempotency keys and projections", () => {
    const input = purchaseInput();
    const entries = buildWalletLedgerCreateInputs(input);

    expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
      "purchase_1:user_cash_debit",
      "purchase_1:platform_revenue_credit",
      "purchase_1:agent_token_credit",
      "purchase_1:creator_pending_credit",
    ]);
    expect(entries.find((entry) => entry.entryKind === "USER_CASH_DEBIT")).toMatchObject({
      amountCents: -1000,
      balanceAfterCents: 4000,
    });
    expect(entries.find((entry) => entry.entryKind === "AGENT_TOKEN_CREDIT")).toMatchObject({
      tokenAmount: 1000,
      tokenBalanceAfter: 1000,
    });
  });

  it("projects balances by wallet account key", () => {
    const input = purchaseInput();
    const projection = projectWalletLedgerBalances(input.movements, input.initialBalances);

    expect(projection[walletLedgerAccountKey(input.movements[0]!)]).toMatchObject({
      amountCents: 4000,
      tokenAmount: 0,
    });
    expect(projection[walletLedgerAccountKey(input.movements[2]!)]).toMatchObject({
      amountCents: 0,
      tokenAmount: 1000,
    });
  });

  it("rejects unbalanced internal cash transfers", () => {
    expect(() =>
      buildWalletLedgerCreateInputs(
        purchaseInput({
          movements: purchaseInput().movements.slice(0, 1),
        }),
      ),
    ).toThrow("balance to zero");
  });

  it("rejects negative user cash and agent token balances", () => {
    expect(() =>
      buildWalletLedgerCreateInputs(
        purchaseInput({
          initialBalances: {
            [`${AmnWalletAccountType.USER_CASH}:user_wallet_1`]: {
              amountCents: 100,
            },
          },
        }),
      ),
    ).toThrow("negative");

    expect(() =>
      buildWalletLedgerCreateInputs({
        eventGroupId: "usage_1",
        idempotencyKey: "usage_1",
        currency: "CNY",
        initialBalances: {
          [`${AmnWalletAccountType.AGENT_TOKEN}:agent_wallet_1`]: {
            tokenAmount: 5,
          },
        },
        movements: [
          {
            entryKey: "agent_token_debit",
            accountType: AmnWalletAccountType.AGENT_TOKEN,
            entryKind: AmnLedgerEntryKind.AGENT_TOKEN_DEBIT,
            agentWalletId: "agent_wallet_1",
            representativeId: "rep_1",
            tokenAmount: -10,
          },
        ],
      }),
    ).toThrow("negative");
  });

  it("records idempotently", async () => {
    const client = new FakeLedgerClient();
    const first = await recordWalletLedgerTransaction(purchaseInput(), client);
    const second = await recordWalletLedgerTransaction(purchaseInput(), client);

    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(client.entries).toHaveLength(4);
  });

  it("rolls back all entries when a transaction fails", async () => {
    const client = new FakeLedgerClient({ failOnCreateNumber: 2 });

    await expect(recordWalletLedgerTransaction(purchaseInput(), client)).rejects.toThrow(
      "simulated create failure",
    );
    expect(client.entries).toHaveLength(0);
  });
});

class FakeLedgerClient {
  entries: StoredLedgerEntry[] = [];
  private createCount = 0;

  constructor(private readonly options: { failOnCreateNumber?: number } = {}) {}

  walletLedgerEntry = {
    findFirst: async (args: {
      where: { eventGroupId?: string; idempotencyKey?: { startsWith: string } };
    }) => {
      return (
        this.entries.find((entry) => {
          const eventMatches = args.where.eventGroupId
            ? entry.eventGroupId === args.where.eventGroupId
            : true;
          const keyMatches = args.where.idempotencyKey
            ? entry.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith)
            : true;
          return eventMatches && keyMatches;
        }) ?? null
      );
    },
    findMany: async (args: { where: { eventGroupId: string }; orderBy: { createdAt: "asc" } }) => {
      return this.entries
        .filter((entry) => entry.eventGroupId === args.where.eventGroupId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    },
    create: async (args: { data: Prisma.WalletLedgerEntryUncheckedCreateInput }) => {
      this.createCount += 1;
      if (this.options.failOnCreateNumber === this.createCount) {
        throw new Error("simulated create failure");
      }
      const entry: StoredLedgerEntry = {
        id: `ledger_${this.entries.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        accountType: args.data.accountType,
        entryKind: args.data.entryKind,
        amountCents: args.data.amountCents ?? 0,
        tokenAmount: args.data.tokenAmount ?? 0,
        currency: args.data.currency ?? "CNY",
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, this.entries.length)),
      };
      this.entries.push(entry);
      return entry;
    },
  };

  async $transaction<T>(fn: (tx: FakeLedgerClient) => Promise<T>): Promise<T> {
    const snapshot = [...this.entries];
    const createCount = this.createCount;
    try {
      return await fn(this);
    } catch (error) {
      this.entries = snapshot;
      this.createCount = createCount;
      throw error;
    }
  }
}
