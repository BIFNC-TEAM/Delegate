import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

export type CreatorEarningBalanceInput = {
  pendingCents: number;
  withdrawableCents: number;
  frozenCents: number;
  withdrawnCents: number;
};

export type CreatorEarningBalances = {
  pendingCents: number;
  withdrawableCents: number;
  frozenCents: number;
  withdrawnCents: number;
};

export type AgentWalletDashboardSnapshot = {
  representative: {
    slug: string;
    displayName: string;
    ownerId: string;
    ownerVerificationStatus: string;
  };
  agentWallet: {
    id: string | null;
    currency: string;
    tokenBalance: number;
    totalPurchasedTokens: number;
    totalConsumedTokens: number;
    tokenUnitPriceCents: number;
    creatorRevenueShareBps: number;
  };
  creatorBalances: CreatorEarningBalances;
  withdrawRequests: Array<{
    id: string;
    amountCents: number;
    currency: string;
    status: string;
    requestedAt: string;
  }>;
  recentLedgerEntries: Array<{
    id: string;
    accountType: string;
    entryKind: string;
    amountCents: number;
    tokenAmount: number;
    currency: string;
    notes: string | null;
    createdAt: string;
  }>;
};

const walletDashboardArgs = Prisma.validator<Prisma.RepresentativeDefaultArgs>()({
  include: {
    owner: {
      select: {
        id: true,
        creatorVerificationStatus: true,
      },
    },
    agentWallet: true,
    creatorEarnings: {
      orderBy: [{ createdAt: "desc" }],
      take: 100,
    },
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

type WalletDashboardRecord = Prisma.RepresentativeGetPayload<{
  include: typeof walletDashboardArgs.include;
}>;

export async function getAgentWalletDashboardSnapshot(
  representativeSlug: string,
): Promise<AgentWalletDashboardSnapshot | null> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    ...walletDashboardArgs,
  });
  if (!representative) {
    return null;
  }
  return buildAgentWalletDashboardSnapshot(representative);
}

export function summarizeCreatorEarningBalances(
  earnings: CreatorEarningBalanceInput[],
): CreatorEarningBalances {
  return earnings.reduce<CreatorEarningBalances>(
    (balances, earning) => ({
      pendingCents: balances.pendingCents + earning.pendingCents,
      withdrawableCents: balances.withdrawableCents + earning.withdrawableCents,
      frozenCents: balances.frozenCents + earning.frozenCents,
      withdrawnCents: balances.withdrawnCents + earning.withdrawnCents,
    }),
    {
      pendingCents: 0,
      withdrawableCents: 0,
      frozenCents: 0,
      withdrawnCents: 0,
    },
  );
}

function buildAgentWalletDashboardSnapshot(
  representative: WalletDashboardRecord,
): AgentWalletDashboardSnapshot {
  const agentWallet = representative.agentWallet;
  const currency = agentWallet?.currency ?? "CNY";

  return {
    representative: {
      slug: representative.slug,
      displayName: representative.displayName,
      ownerId: representative.owner.id,
      ownerVerificationStatus: representative.owner.creatorVerificationStatus.toLowerCase(),
    },
    agentWallet: {
      id: agentWallet?.id ?? null,
      currency,
      tokenBalance: agentWallet?.tokenBalance ?? 0,
      totalPurchasedTokens: agentWallet?.totalPurchasedTokens ?? 0,
      totalConsumedTokens: agentWallet?.totalConsumedTokens ?? 0,
      tokenUnitPriceCents: agentWallet?.tokenUnitPriceCents ?? 1,
      creatorRevenueShareBps: agentWallet?.creatorRevenueShareBps ?? 2000,
    },
    creatorBalances: summarizeCreatorEarningBalances(representative.creatorEarnings),
    withdrawRequests: representative.withdrawRequests.map((request) => ({
      id: request.id,
      amountCents: request.amountCents,
      currency: request.currency,
      status: request.status.toLowerCase(),
      requestedAt: request.requestedAt.toISOString(),
    })),
    recentLedgerEntries: representative.walletLedgerEntries.map((entry) => ({
      id: entry.id,
      accountType: entry.accountType.toLowerCase(),
      entryKind: entry.entryKind.toLowerCase(),
      amountCents: entry.amountCents,
      tokenAmount: entry.tokenAmount,
      currency: entry.currency,
      notes: entry.notes,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
