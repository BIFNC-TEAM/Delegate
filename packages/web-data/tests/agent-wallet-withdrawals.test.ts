import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  CreatorVerificationStatus,
  RepresentativeClaimStatus,
  WithdrawRequestStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { createWithdrawRequest } from "../src/agent-wallet-withdrawals";

describe("agent wallet withdrawals", () => {
  it("creates a withdrawal request and freezes creator withdrawable balance", async () => {
    const client = new FakeWithdrawalClient();

    const request = await createWithdrawRequest(
      {
        ownerId: "owner_1",
        representativeId: "rep_1",
        amountCents: 300,
        idempotencyKey: "withdraw_owner_1_rep_1_300",
      },
      client,
    );
    const requestAgain = await createWithdrawRequest(
      {
        ownerId: "owner_1",
        representativeId: "rep_1",
        amountCents: 300,
        idempotencyKey: "withdraw_owner_1_rep_1_300",
      },
      client,
    );

    expect(request).toMatchObject({
      ownerId: "owner_1",
      representativeId: "rep_1",
      amountCents: 300,
      status: "pending_review",
      frozenCents: 300,
    });
    expect(requestAgain.id).toBe(request.id);
    expect(client.withdrawRequests).toHaveLength(1);
    expect(client.creatorEarnings[0]).toMatchObject({
      withdrawableCents: 200,
      frozenCents: 300,
      status: CreatorEarningStatus.WITHDRAWABLE,
    });
    expect(client.ledgerEntries).toHaveLength(1);
    expect(client.ledgerEntries[0]).toMatchObject({
      accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
      entryKind: AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
      amountCents: -300,
    });
  });

  it("rejects withdrawals for unverified owners", async () => {
    const client = new FakeWithdrawalClient({
      creatorVerificationStatus: CreatorVerificationStatus.UNVERIFIED,
    });

    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 300,
        },
        client,
      ),
    ).rejects.toThrow("Owner must be verified");
    expect(client.withdrawRequests).toHaveLength(0);
    expect(client.creatorEarnings[0]?.withdrawableCents).toBe(500);
  });

  it("rejects withdrawals for unclaimed representatives", async () => {
    const client = new FakeWithdrawalClient({
      claimStatus: RepresentativeClaimStatus.UNCLAIMED,
    });

    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 300,
        },
        client,
      ),
    ).rejects.toThrow("Representative must be claimed");
  });

  it("rejects withdrawals when the representative belongs to another owner", async () => {
    const client = new FakeWithdrawalClient({
      representativeOwnerId: "owner_2",
    });

    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 300,
        },
        client,
      ),
    ).rejects.toThrow("Representative does not belong");
  });

  it("rejects withdrawals above available withdrawable balance", async () => {
    const client = new FakeWithdrawalClient({
      withdrawableCents: 200,
    });

    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 300,
        },
        client,
      ),
    ).rejects.toThrow("Insufficient withdrawable");
    expect(client.creatorEarnings[0]).toMatchObject({
      withdrawableCents: 200,
      frozenCents: 0,
    });
    expect(client.ledgerEntries).toHaveLength(0);
  });
});

type OwnerRow = {
  id: string;
  creatorVerificationStatus: CreatorVerificationStatus;
};

type RepresentativeRow = {
  id: string;
  ownerId: string;
  claimStatus: RepresentativeClaimStatus;
};

type CreatorEarningRow = {
  id: string;
  ownerId: string;
  representativeId: string;
  agentWalletId: string;
  status: CreatorEarningStatus;
  withdrawableCents: number;
  frozenCents: number;
  currency: string;
};

type WithdrawRequestRow = {
  id: string;
  ownerId: string;
  representativeId: string | null;
  status: WithdrawRequestStatus;
  amountCents: number;
  currency: string;
  requestedAt: Date;
  idempotencyKey: string;
};

type LedgerRow = {
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

class FakeWithdrawalClient {
  owners: OwnerRow[];
  representatives: RepresentativeRow[];
  creatorEarnings: CreatorEarningRow[];
  withdrawRequests: WithdrawRequestRow[] = [];
  ledgerEntries: LedgerRow[] = [];

  constructor(
    options: {
      creatorVerificationStatus?: CreatorVerificationStatus;
      claimStatus?: RepresentativeClaimStatus;
      representativeOwnerId?: string;
      withdrawableCents?: number;
    } = {},
  ) {
    this.owners = [
      {
        id: "owner_1",
        creatorVerificationStatus:
          options.creatorVerificationStatus ?? CreatorVerificationStatus.VERIFIED,
      },
    ];
    this.representatives = [
      {
        id: "rep_1",
        ownerId: options.representativeOwnerId ?? "owner_1",
        claimStatus: options.claimStatus ?? RepresentativeClaimStatus.CLAIMED,
      },
    ];
    this.creatorEarnings = [
      {
        id: "earning_withdrawable_1",
        ownerId: "owner_1",
        representativeId: "rep_1",
        agentWalletId: "agent_wallet_1",
        status: CreatorEarningStatus.WITHDRAWABLE,
        withdrawableCents: options.withdrawableCents ?? 500,
        frozenCents: 0,
        currency: "CNY",
      },
    ];
  }

  owner = {
    findUnique: async (args: any) => {
      return this.owners.find((owner) => owner.id === args.where.id) ?? null;
    },
  };

  representative = {
    findUnique: async (args: any) => {
      return this.representatives.find((rep) => rep.id === args.where.id) ?? null;
    },
  };

  creatorEarning = {
    findMany: async (args: any) => {
      return this.creatorEarnings.filter((earning) => {
        if (earning.ownerId !== args.where.ownerId) {
          return false;
        }
        if (
          typeof args.where.representativeId === "string" &&
          earning.representativeId !== args.where.representativeId
        ) {
          return false;
        }
        if (earning.status !== args.where.status) {
          return false;
        }
        if (earning.currency !== args.where.currency) {
          return false;
        }
        return earning.withdrawableCents > args.where.withdrawableCents.gt;
      });
    },
    update: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (!earning) {
        throw new Error("creator earning not found");
      }
      if (typeof args.data.withdrawableCents?.decrement === "number") {
        earning.withdrawableCents -= args.data.withdrawableCents.decrement;
      }
      if (typeof args.data.frozenCents?.increment === "number") {
        earning.frozenCents += args.data.frozenCents.increment;
      }
      if (args.data.status) {
        earning.status = args.data.status;
      }
      return earning;
    },
  };

  withdrawRequest = {
    findUnique: async (args: any) => {
      return (
        this.withdrawRequests.find(
          (request) => request.idempotencyKey === args.where.idempotencyKey,
        ) ?? null
      );
    },
    create: async (args: any) => {
      const request: WithdrawRequestRow = {
        id: args.data.id ?? `withdraw_${this.withdrawRequests.length + 1}`,
        ownerId: args.data.ownerId,
        representativeId: args.data.representativeId ?? null,
        status: args.data.status,
        amountCents: args.data.amountCents,
        currency: args.data.currency,
        requestedAt: new Date(Date.UTC(2026, 6, 3)),
        idempotencyKey: args.data.idempotencyKey,
      };
      this.withdrawRequests.push(request);
      return request;
    },
  };

  walletLedgerEntry = {
    findFirst: async (args: any) => {
      return (
        this.ledgerEntries.find(
          (entry) =>
            entry.eventGroupId === args.where.eventGroupId &&
            entry.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith),
        ) ?? null
      );
    },
    findMany: async (args: any) => {
      return this.ledgerEntries.filter((entry) => entry.eventGroupId === args.where.eventGroupId);
    },
    create: async (args: { data: Prisma.WalletLedgerEntryUncheckedCreateInput }) => {
      const entry: LedgerRow = {
        id: `ledger_${this.ledgerEntries.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        accountType: args.data.accountType,
        entryKind: args.data.entryKind,
        amountCents: args.data.amountCents ?? 0,
        tokenAmount: args.data.tokenAmount ?? 0,
        currency: args.data.currency ?? "CNY",
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, this.ledgerEntries.length)),
      };
      this.ledgerEntries.push(entry);
      return entry;
    },
  };

  async $transaction<T>(fn: (tx: FakeWithdrawalClient) => Promise<T>): Promise<T> {
    const creatorEarnings = this.creatorEarnings.map((row) => ({ ...row }));
    const withdrawRequests = this.withdrawRequests.map((row) => ({ ...row }));
    const ledgerEntries = this.ledgerEntries.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (error) {
      this.creatorEarnings = creatorEarnings;
      this.withdrawRequests = withdrawRequests;
      this.ledgerEntries = ledgerEntries;
      throw error;
    }
  }
}
