import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  CreatorVerificationStatus,
  RepresentativeClaimStatus,
  WithdrawRequestStatus,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
} from "./agent-wallet-ledger";
import { prisma } from "./prisma";

type OwnerRecord = {
  id: string;
  creatorVerificationStatus: CreatorVerificationStatus;
};

type RepresentativeRecord = {
  id: string;
  ownerId: string;
  claimStatus: RepresentativeClaimStatus;
};

type CreatorEarningRecord = {
  id: string;
  ownerId: string;
  representativeId: string;
  agentWalletId: string;
  status: CreatorEarningStatus;
  withdrawableCents: number;
  frozenCents: number;
  currency: string;
};

type WithdrawRequestRecord = {
  id: string;
  ownerId: string;
  representativeId: string | null;
  status: WithdrawRequestStatus;
  amountCents: number;
  currency: string;
  requestedAt: Date;
  idempotencyKey: string;
};

type WithdrawalClient = Omit<WalletLedgerClient, "$transaction"> & {
  owner: {
    findUnique(args: unknown): Promise<OwnerRecord | null>;
  };
  representative: {
    findUnique(args: unknown): Promise<RepresentativeRecord | null>;
  };
  creatorEarning: {
    findMany(args: unknown): Promise<CreatorEarningRecord[]>;
    update(args: unknown): Promise<CreatorEarningRecord>;
  };
  withdrawRequest: {
    findUnique(args: unknown): Promise<WithdrawRequestRecord | null>;
    create(args: unknown): Promise<WithdrawRequestRecord>;
  };
  $transaction?<T>(fn: (tx: WithdrawalClient) => Promise<T>): Promise<T>;
};

export type CreateWithdrawRequestInput = {
  ownerId: string;
  amountCents: number;
  currency?: string;
  representativeId?: string;
  idempotencyKey?: string;
};

export type WithdrawRequestSnapshot = {
  id: string;
  ownerId: string;
  representativeId: string | null;
  amountCents: number;
  currency: string;
  status: "pending_review" | "approved" | "rejected" | "paid" | "failed" | "canceled";
  requestedAt: string;
  idempotencyKey: string;
  frozenCents: number;
};

const SUPPORTED_WITHDRAWAL_CURRENCIES = new Set(["CNY", "USD"]);

export async function createWithdrawRequest(
  input: CreateWithdrawRequestInput,
  client: WithdrawalClient = prisma,
): Promise<WithdrawRequestSnapshot> {
  const normalized = normalizeCreateWithdrawRequestInput(input);
  const run = async (tx: WithdrawalClient) => {
    const existing = await tx.withdrawRequest.findUnique({
      where: { idempotencyKey: normalized.idempotencyKey },
    });
    if (existing) {
      return serializeWithdrawRequest(existing, existing.amountCents);
    }

    const owner = await tx.owner.findUnique({
      where: { id: normalized.ownerId },
      select: { id: true, creatorVerificationStatus: true },
    });
    if (!owner) {
      throw new Error("Owner not found.");
    }
    if (owner.creatorVerificationStatus !== CreatorVerificationStatus.VERIFIED) {
      throw new Error("Owner must be verified before requesting withdrawals.");
    }

    if (normalized.representativeId) {
      const representative = await tx.representative.findUnique({
        where: { id: normalized.representativeId },
        select: { id: true, ownerId: true, claimStatus: true },
      });
      if (!representative || representative.ownerId !== owner.id) {
        throw new Error("Representative does not belong to owner.");
      }
      if (representative.claimStatus !== RepresentativeClaimStatus.CLAIMED) {
        throw new Error("Representative must be claimed before withdrawals.");
      }
    }

    const withdrawableEarnings = await tx.creatorEarning.findMany({
      where: {
        ownerId: owner.id,
        ...(normalized.representativeId ? { representativeId: normalized.representativeId } : {}),
        status: CreatorEarningStatus.WITHDRAWABLE,
        currency: normalized.currency,
        withdrawableCents: { gt: 0 },
      },
      orderBy: { createdAt: "asc" },
    });
    const availableCents = withdrawableEarnings.reduce(
      (sum, earning) => sum + earning.withdrawableCents,
      0,
    );
    if (availableCents < normalized.amountCents) {
      throw new Error("Insufficient withdrawable creator balance.");
    }

    const withdrawRequest = await tx.withdrawRequest.create({
      data: {
        ownerId: owner.id,
        ...(normalized.representativeId ? { representativeId: normalized.representativeId } : {}),
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        status: WithdrawRequestStatus.PENDING_REVIEW,
        idempotencyKey: normalized.idempotencyKey,
      },
    });

    let remainingToFreeze = normalized.amountCents;
    const frozenEarningUpdates: CreatorEarningRecord[] = [];
    for (const earning of withdrawableEarnings) {
      if (remainingToFreeze <= 0) {
        break;
      }
      const freezeCents = Math.min(earning.withdrawableCents, remainingToFreeze);
      const updated = await tx.creatorEarning.update({
        where: { id: earning.id },
        data: {
          withdrawableCents: {
            decrement: freezeCents,
          },
          frozenCents: {
            increment: freezeCents,
          },
          status:
            earning.withdrawableCents === freezeCents
              ? CreatorEarningStatus.FROZEN
              : CreatorEarningStatus.WITHDRAWABLE,
        },
      });
      frozenEarningUpdates.push(updated);
      remainingToFreeze -= freezeCents;
    }

    await recordWalletLedgerTransaction(
      {
        eventGroupId: `withdraw_request:${withdrawRequest.id}`,
        idempotencyKey: `withdraw_request:${withdrawRequest.id}:freeze`,
        currency: normalized.currency,
        initialBalances: {
          [`${AmnWalletAccountType.CREATOR_WITHDRAWABLE}:${owner.id}:${normalized.representativeId}`]:
            {
              amountCents: availableCents,
            },
        },
        movements: [
          {
            entryKey: "creator_withdrawable_freeze",
            accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
            entryKind: AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
            ownerId: owner.id,
            representativeId: normalized.representativeId,
            withdrawRequestId: withdrawRequest.id,
            amountCents: -normalized.amountCents,
            notes: "withdraw_request_freeze",
          },
        ],
      },
      tx,
    );

    return serializeWithdrawRequest(withdrawRequest, normalized.amountCents);
  };

  return client.$transaction ? client.$transaction(run) : run(client);
}

function normalizeCreateWithdrawRequestInput(
  input: CreateWithdrawRequestInput,
): Required<
  Pick<
    CreateWithdrawRequestInput,
    "ownerId" | "representativeId" | "amountCents" | "currency" | "idempotencyKey"
  >
> {
  const ownerId = input.ownerId.trim();
  const representativeId = input.representativeId?.trim();
  if (!ownerId) {
    throw new Error("ownerId is required.");
  }
  if (!representativeId) {
    throw new Error("representativeId is required for withdrawal requests.");
  }
  assertPositiveInteger(input.amountCents, "amountCents");
  const currency = input.currency ?? "CNY";
  if (!SUPPORTED_WITHDRAWAL_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported withdrawal currency: ${currency}`);
  }
  return {
    ownerId,
    amountCents: input.amountCents,
    currency,
    idempotencyKey:
      input.idempotencyKey ??
      `withdraw_request:${ownerId}:${representativeId}:${currency}:${input.amountCents}`,
    representativeId,
  };
}

function serializeWithdrawRequest(
  request: WithdrawRequestRecord,
  frozenCents: number,
): WithdrawRequestSnapshot {
  return {
    id: request.id,
    ownerId: request.ownerId,
    representativeId: request.representativeId,
    amountCents: request.amountCents,
    currency: request.currency,
    status: request.status.toLowerCase() as WithdrawRequestSnapshot["status"],
    requestedAt: request.requestedAt.toISOString(),
    idempotencyKey: request.idempotencyKey,
    frozenCents,
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
