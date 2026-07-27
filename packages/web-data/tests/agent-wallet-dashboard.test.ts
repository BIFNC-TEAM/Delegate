import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const transactionClient = {
    representative: {
      findUnique: vi.fn(),
    },
    creatorEarning: {
      aggregate: vi.fn(),
    },
  };
  return {
    transactionClient,
    prisma: {
      $transaction: vi.fn(
        async (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mocks.prisma }));

import {
  getAgentWalletDashboardSnapshot,
  summarizeCreatorEarningBalances,
} from "../src/agent-wallet-dashboard";

describe("agent wallet dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("summarizes creator earning balances for owner wallet view", () => {
    expect(
      summarizeCreatorEarningBalances([
        {
          pendingCents: 100,
          withdrawableCents: 80,
          frozenCents: 20,
          withdrawnCents: 0,
        },
        {
          pendingCents: 50,
          withdrawableCents: 120,
          frozenCents: 0,
          withdrawnCents: 30,
        },
      ]),
    ).toEqual({
      pendingCents: 150,
      withdrawableCents: 200,
      frozenCents: 20,
      withdrawnCents: 30,
    });
  });

  it("uses an uncapped database aggregate for every creator earning balance bucket", async () => {
    mocks.transactionClient.representative.findUnique.mockResolvedValue({
      id: "rep-1",
      slug: "agent-one",
      displayName: "Agent One",
      owner: {
        id: "owner-1",
        creatorVerificationStatus: "VERIFIED",
      },
      agentWallet: {
        id: "agent-wallet-1",
        currency: "USD",
        tokenBalance: 150,
        totalPurchasedTokens: 250,
        totalConsumedTokens: 100,
        tokenUnitPriceCents: 25,
        creatorRevenueShareBps: 2000,
      },
      withdrawRequests: [],
      walletLedgerEntries: [],
    });
    mocks.transactionClient.creatorEarning.aggregate.mockResolvedValue({
      _sum: {
        pendingCents: 10_100,
        withdrawableCents: 20_200,
        frozenCents: 3_030,
        withdrawnCents: 40_400,
      },
    });

    const snapshot = await getAgentWalletDashboardSnapshot("agent-one");

    expect(mocks.transactionClient.representative.findUnique).toHaveBeenCalledWith({
      where: { slug: "agent-one" },
      include: {
        owner: {
          select: {
            id: true,
            creatorVerificationStatus: true,
          },
        },
        agentWallet: true,
        withdrawRequests: {
          orderBy: [{ requestedAt: "desc" }],
          take: 8,
        },
        walletLedgerEntries: {
          orderBy: [{ createdAt: "desc" }],
          take: 12,
        },
      },
    });
    expect(mocks.transactionClient.creatorEarning.aggregate).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        agentWalletId: "agent-wallet-1",
        currency: "USD",
      },
      _sum: {
        pendingCents: true,
        withdrawableCents: true,
        frozenCents: true,
        withdrawnCents: true,
      },
    });
    expect(snapshot?.creatorBalances).toEqual({
      pendingCents: 10_100,
      withdrawableCents: 20_200,
      frozenCents: 3_030,
      withdrawnCents: 40_400,
    });
  });

  it("returns zero creator balances without aggregating when the representative has no agent wallet", async () => {
    mocks.transactionClient.representative.findUnique.mockResolvedValue({
      id: "rep-without-wallet",
      slug: "agent-without-wallet",
      displayName: "Agent Without Wallet",
      owner: {
        id: "owner-1",
        creatorVerificationStatus: "VERIFIED",
      },
      agentWallet: null,
      withdrawRequests: [],
      walletLedgerEntries: [],
    });

    const snapshot = await getAgentWalletDashboardSnapshot(
      "agent-without-wallet",
    );

    expect(mocks.transactionClient.creatorEarning.aggregate).not.toHaveBeenCalled();
    expect(snapshot?.creatorBalances).toEqual({
      pendingCents: 0,
      withdrawableCents: 0,
      frozenCents: 0,
      withdrawnCents: 0,
    });
  });
});
