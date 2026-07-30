import {
  AmnLedgerEntryKind,
  AmnWalletAccountType,
  CreatorEarningStatus,
  CreatorPayoutProfileStatus,
  CreatorVerificationStatus,
  PaymentProvider,
  PayoutDestinationStatus,
  PayoutSubjectType,
  RepresentativeClaimStatus,
  WalletTransactionEventType,
  WalletTransactionStatus,
  WithdrawRequestStatus,
} from "@prisma/client";

import {
  recordWalletLedgerTransaction,
  type WalletLedgerClient,
  type WalletLedgerMovement,
} from "./agent-wallet-ledger";
import {
  assertWalletIdempotencyField,
  resolveWalletOperationId,
  runWalletWriteTransaction,
  type WalletWriteTransactionOptions,
} from "./agent-wallet-write";
import { prisma } from "./prisma";
import {
  assertWorkspaceWalletFundsWriteAllowed,
  type WorkspaceWalletFundsWriteScope,
  type WorkspaceWalletReconciliationClient,
} from "./wallet-reconciliation";

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
  pendingCents?: number;
  withdrawableCents: number;
  frozenCents: number;
  withdrawnCents?: number;
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
  reviewedAt?: Date | null;
  reviewedBy?: string | null;
  paidAt?: Date | null;
  provider?: PaymentProvider | null;
  providerPayoutId?: string | null;
  failureReason?: string | null;
  idempotencyKey: string;
  payoutProfileId?: string | null;
  payoutDestinationId?: string | null;
  payoutSubjectTypeSnapshot?: PayoutSubjectType | null;
  payoutSubjectIdSnapshot?: string | null;
  destinationMaskedLabelSnapshot?: string | null;
  destinationVersionSnapshot?: number | null;
};

type PayoutDestinationRecord = {
  id: string;
  profileId: string;
  currency: string;
  status: PayoutDestinationStatus;
  maskedLabel: string;
  credentialVersion: number;
  coolingOffUntil: Date | null;
  profile: {
    id: string;
    ownerId: string | null;
    organizationId: string | null;
    subjectType: PayoutSubjectType;
    status: CreatorPayoutProfileStatus;
  };
};

type WithdrawalAllocationRecord = {
  id: string;
  withdrawRequestId: string;
  creatorEarningId: string;
  amountCents: number;
  currency: string;
  releasedAt: Date | null;
  paidAt: Date | null;
  creatorEarning?: CreatorEarningRecord;
};

type WalletTransactionRecord = {
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
  metadata: unknown;
};

type WithdrawalClient = Omit<WalletLedgerClient, "$transaction"> & {
  /**
   * Test/embedded-client seam. Production Prisma clients use the authoritative
   * reconciliation reader below; custom clients must explicitly provide the
   * same fail-closed contract rather than silently bypassing it.
   */
  walletFundsWriteGate?: {
    assertAllowed(input: WorkspaceWalletFundsWriteScope): Promise<void>;
  };
  owner: {
    findUnique(args: unknown): Promise<OwnerRecord | null>;
  };
  representative: {
    findUnique(args: unknown): Promise<RepresentativeRecord | null>;
  };
  creatorEarning: {
    findMany(args: unknown): Promise<CreatorEarningRecord[]>;
    findUnique?(args: unknown): Promise<CreatorEarningRecord | null>;
    update(args: unknown): Promise<CreatorEarningRecord>;
  };
  withdrawRequest: {
    findUnique(args: unknown): Promise<WithdrawRequestRecord | null>;
    findFirst(args: unknown): Promise<WithdrawRequestRecord | null>;
    create(args: unknown): Promise<WithdrawRequestRecord>;
    update?(args: unknown): Promise<WithdrawRequestRecord>;
  };
  withdrawalAllocation?: {
    findMany(args: unknown): Promise<WithdrawalAllocationRecord[]>;
    create(args: unknown): Promise<WithdrawalAllocationRecord>;
    update(args: unknown): Promise<WithdrawalAllocationRecord>;
  };
  payoutDestination?: {
    findFirst(args: any): Promise<any>;
  };
  walletTransaction?: {
    findUnique(args: unknown): Promise<WalletTransactionRecord | null>;
    create(args: unknown): Promise<WalletTransactionRecord>;
  };
  $transaction?<T>(
    fn: (tx: WithdrawalClient) => Promise<T>,
    options?: WalletWriteTransactionOptions,
  ): Promise<T>;
};

export type CreateWithdrawRequestInput = {
  ownerId: string;
  amountCents: number;
  currency?: string;
  representativeId: string;
  idempotencyKey?: string;
};

export type ApproveWithdrawRequestInput = {
  ownerId: string;
  withdrawRequestId: string;
  reviewedBy?: string;
  idempotencyKey?: string;
};

export type RejectWithdrawRequestInput = {
  ownerId: string;
  withdrawRequestId: string;
  reviewedBy?: string;
  reason?: string;
  idempotencyKey?: string;
};

export type CancelWithdrawRequestInput = {
  ownerId: string;
  withdrawRequestId: string;
  reason?: string;
  idempotencyKey?: string;
};

export type MarkWithdrawRequestPaidInput = {
  ownerId: string;
  withdrawRequestId: string;
  provider: PaymentProvider;
  providerPayoutId: string;
  idempotencyKey?: string;
};

export type MarkWithdrawRequestFailedInput = {
  ownerId: string;
  withdrawRequestId: string;
  reason?: string;
  /**
   * Permanent failures release the frozen allocation back to withdrawable
   * earnings. Transient failures retain the allocation so the payout can be
   * retried or canceled explicitly.
   */
  permanent?: boolean;
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
  reviewedAt: string | null;
  reviewedBy: string | null;
  paidAt: string | null;
  provider: PaymentProvider | null;
  providerPayoutId: string | null;
  failureReason: string | null;
  payoutProfileId: string | null;
  payoutDestinationId: string | null;
  payoutSubjectType: "owner" | "organization" | null;
  payoutSubjectId: string | null;
  destinationMaskedLabel: string | null;
  destinationVersion: number | null;
};

const SUPPORTED_WITHDRAWAL_CURRENCIES = new Set(["CNY", "USD"]);
const WITHDRAW_REQUEST_SOURCE_TYPE = "WithdrawRequest";

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
      assertWalletIdempotencyField(
        "withdrawal request",
        "ownerId",
        existing.ownerId,
        normalized.ownerId,
      );
      assertWalletIdempotencyField(
        "withdrawal request",
        "representativeId",
        existing.representativeId,
        normalized.representativeId,
      );
      assertWalletIdempotencyField(
        "withdrawal request",
        "amountCents",
        existing.amountCents,
        normalized.amountCents,
      );
      assertWalletIdempotencyField(
        "withdrawal request",
        "currency",
        existing.currency,
        normalized.currency,
      );
      return serializeWithdrawRequest(
        existing,
        await getActiveFrozenCents(tx, existing.id, existing.amountCents),
      );
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
    const payoutDestination = await resolveVerifiedPayoutDestination(
      tx,
      owner.id,
      normalized.currency,
    );
    await assertWithdrawalFundsWriteAllowed(tx, {
      ownerId: owner.id,
      representativeId: representative.id,
      currency: normalized.currency,
    });

    const activeRequest = await tx.withdrawRequest.findFirst({
      where: {
        ownerId: owner.id,
        representativeId: normalized.representativeId,
        currency: normalized.currency,
        OR: [
          {
            status: {
              in: [
                WithdrawRequestStatus.PENDING_REVIEW,
                WithdrawRequestStatus.APPROVED,
              ],
            },
          },
          {
            status: WithdrawRequestStatus.FAILED,
            allocations: {
              some: {
                releasedAt: null,
                paidAt: null,
              },
            },
          },
        ],
      },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    });
    if (activeRequest) {
      throw new Error(
        "An active withdrawal request already exists for this representative and currency.",
      );
    }

    const withdrawableEarnings = await tx.creatorEarning.findMany({
      where: {
        ownerId: owner.id,
        representativeId: normalized.representativeId,
        status: CreatorEarningStatus.WITHDRAWABLE,
        currency: normalized.currency,
        withdrawableCents: { gt: 0 },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
        representativeId: normalized.representativeId,
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        status: WithdrawRequestStatus.PENDING_REVIEW,
        idempotencyKey: normalized.idempotencyKey,
        payoutProfileId: payoutDestination.profileId,
        payoutDestinationId: payoutDestination.id,
        payoutSubjectTypeSnapshot:
          payoutDestination.profile.subjectType,
        payoutSubjectIdSnapshot:
          payoutDestination.profile.subjectType === PayoutSubjectType.OWNER
            ? payoutDestination.profile.ownerId
            : payoutDestination.profile.organizationId,
        destinationMaskedLabelSnapshot:
          payoutDestination.maskedLabel,
        destinationVersionSnapshot:
          payoutDestination.credentialVersion,
      },
    });

    let remainingToFreeze = normalized.amountCents;
    const allocations: WithdrawalAllocationRecord[] = [];
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
      const allocation = tx.withdrawalAllocation
        ? await tx.withdrawalAllocation.create({
            data: {
              withdrawRequestId: withdrawRequest.id,
              creatorEarningId: updated.id,
              amountCents: freezeCents,
              currency: normalized.currency,
            },
            include: {
              creatorEarning: true,
            },
          })
        : {
            id: `legacy:${withdrawRequest.id}:${updated.id}`,
            withdrawRequestId: withdrawRequest.id,
            creatorEarningId: updated.id,
            amountCents: freezeCents,
            currency: normalized.currency,
            releasedAt: null,
            paidAt: null,
            creatorEarning: updated,
          };
      allocations.push(allocation);
      remainingToFreeze -= freezeCents;
    }
    if (remainingToFreeze !== 0) {
      throw new Error("Withdrawal allocation did not cover the requested amount.");
    }

    const transaction = await createWalletTransactionHeader(
      tx,
      {
        eventGroupId: `withdraw_request:${withdrawRequest.id}`,
        idempotencyKey: `withdraw_request:${normalized.idempotencyKey}`,
        sourceId: withdrawRequest.id,
        eventType: WalletTransactionEventType.WITHDRAWAL_REQUEST,
        status: WalletTransactionStatus.SUCCEEDED,
        currency: normalized.currency,
        ownerId: owner.id,
        representativeId: normalized.representativeId,
        completedAt: new Date(),
        metadata: {
          operation: "create",
          amountCents: normalized.amountCents,
        },
      },
    );
    await recordWalletLedgerTransaction(
      {
        eventGroupId: `withdraw_request:${withdrawRequest.id}`,
        idempotencyKey: `withdraw_request:${withdrawRequest.id}:freeze`,
        currency: normalized.currency,
        requireBalancedAmount: true,
        initialBalances: {
          [`${AmnWalletAccountType.CREATOR_WITHDRAWABLE}:${owner.id}:${normalized.representativeId}`]:
            {
              amountCents: availableCents,
            },
        },
        movements: allocations.flatMap((allocation, index) => [
          {
            entryKey: `allocation_${index + 1}_creator_withdrawable_debit`,
            accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
            entryKind: AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
            transactionId: transaction?.id ?? null,
            ownerId: owner.id,
            representativeId: normalized.representativeId,
            creatorEarningId: allocation.creatorEarningId,
            withdrawRequestId: withdrawRequest.id,
            amountCents: -allocation.amountCents,
            notes: "withdraw_request_freeze",
          },
          {
            entryKey: `allocation_${index + 1}_creator_frozen_credit`,
            accountType: AmnWalletAccountType.CREATOR_FROZEN,
            entryKind: AmnLedgerEntryKind.CREATOR_FROZEN_CREDIT,
            transactionId: transaction?.id ?? null,
            ownerId: owner.id,
            representativeId: normalized.representativeId,
            creatorEarningId: allocation.creatorEarningId,
            withdrawRequestId: withdrawRequest.id,
            amountCents: allocation.amountCents,
            notes: "withdraw_request_freeze",
          },
        ]),
      },
      tx,
    );

    return serializeWithdrawRequest(withdrawRequest, normalized.amountCents);
  };

  return runWalletWriteTransaction(client, run);
}

export async function approveWithdrawRequest(
  input: ApproveWithdrawRequestInput,
  client: WithdrawalClient = prisma,
): Promise<WithdrawRequestSnapshot> {
  return transitionWithdrawRequest(
    normalizeTransitionInput("approve", input, {
      reviewedBy: normalizeOptionalText(input.reviewedBy),
    }),
    client,
  );
}

export async function rejectWithdrawRequest(
  input: RejectWithdrawRequestInput,
  client: WithdrawalClient = prisma,
): Promise<WithdrawRequestSnapshot> {
  return transitionWithdrawRequest(
    normalizeTransitionInput("reject", input, {
      reviewedBy: normalizeOptionalText(input.reviewedBy),
      reason: normalizeOptionalText(input.reason),
    }),
    client,
  );
}

export async function cancelWithdrawRequest(
  input: CancelWithdrawRequestInput,
  client: WithdrawalClient = prisma,
): Promise<WithdrawRequestSnapshot> {
  return transitionWithdrawRequest(
    normalizeTransitionInput("cancel", input, {
      reason: normalizeOptionalText(input.reason),
    }),
    client,
  );
}

export async function markWithdrawRequestPaid(
  input: MarkWithdrawRequestPaidInput,
  client: WithdrawalClient = prisma,
): Promise<WithdrawRequestSnapshot> {
  const providerPayoutId = input.providerPayoutId.trim();
  if (!providerPayoutId) {
    throw new Error("providerPayoutId is required.");
  }
  return transitionWithdrawRequest(
    normalizeTransitionInput("mark_paid", input, {
      provider: input.provider,
      providerPayoutId,
    }),
    client,
  );
}

export async function markWithdrawRequestFailed(
  input: MarkWithdrawRequestFailedInput,
  client: WithdrawalClient = prisma,
): Promise<WithdrawRequestSnapshot> {
  return transitionWithdrawRequest(
    normalizeTransitionInput("mark_failed", input, {
      reason: normalizeOptionalText(input.reason),
      permanent: input.permanent ?? false,
    }),
    client,
  );
}

type WithdrawalTransitionOperation =
  | "approve"
  | "reject"
  | "cancel"
  | "mark_paid"
  | "mark_failed";

type NormalizedWithdrawalTransition = {
  operation: WithdrawalTransitionOperation;
  ownerId: string;
  withdrawRequestId: string;
  idempotencyKey: string;
  reviewedBy: string | null;
  reason: string | null;
  provider: PaymentProvider | null;
  providerPayoutId: string | null;
  permanent: boolean;
};

type WalletTransactionHeaderInput = {
  eventGroupId: string;
  idempotencyKey: string;
  sourceId: string;
  eventType: WalletTransactionEventType;
  status: WalletTransactionStatus;
  currency: string;
  ownerId: string;
  representativeId: string | null;
  completedAt?: Date;
  failedAt?: Date;
  reversedAt?: Date;
  metadata: Record<string, string | number | boolean | null>;
};

function normalizeTransitionInput(
  operation: WithdrawalTransitionOperation,
  input: {
    ownerId: string;
    withdrawRequestId: string;
    idempotencyKey?: string;
  },
  overrides: Partial<
    Pick<
      NormalizedWithdrawalTransition,
      "reviewedBy" | "reason" | "provider" | "providerPayoutId" | "permanent"
    >
  >,
): NormalizedWithdrawalTransition {
  const ownerId = input.ownerId.trim();
  const withdrawRequestId = input.withdrawRequestId.trim();
  if (!ownerId) {
    throw new Error("ownerId is required.");
  }
  if (!withdrawRequestId) {
    throw new Error("withdrawRequestId is required.");
  }
  return {
    operation,
    ownerId,
    withdrawRequestId,
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      `withdraw_request_${operation}`,
    ),
    reviewedBy: overrides.reviewedBy ?? null,
    reason: overrides.reason ?? null,
    provider: overrides.provider ?? null,
    providerPayoutId: overrides.providerPayoutId ?? null,
    permanent: overrides.permanent ?? false,
  };
}

async function transitionWithdrawRequest(
  input: NormalizedWithdrawalTransition,
  client: WithdrawalClient,
): Promise<WithdrawRequestSnapshot> {
  const run = async (tx: WithdrawalClient) => {
    const transactionClient = requireWalletTransactionClient(tx);
    const transitionIdempotencyKey = `withdraw_transition:${input.idempotencyKey}`;
    const request = await findOwnedWithdrawRequest(
      tx,
      input.withdrawRequestId,
      input.ownerId,
    );
    if (!request) {
      throw new Error("Withdrawal request not found.");
    }
    const existingTransaction = await transactionClient.findUnique({
      where: { idempotencyKey: transitionIdempotencyKey },
    });
    if (existingTransaction) {
      assertWithdrawalTransitionReplay(existingTransaction, input);
      return serializeWithdrawRequest(
        request,
        await getActiveFrozenCents(tx, request.id, request.amountCents),
      );
    }
    if (!request.representativeId) {
      throw new Error("Withdrawal request is missing a representative.");
    }
    await assertWithdrawalFundsWriteAllowed(tx, {
      ownerId: request.ownerId,
      representativeId: request.representativeId,
      currency: request.currency,
    });

    const allocations = await getRequiredWithdrawalAllocations(tx, request);
    validateWithdrawalTransition(request, allocations, input);
    const now = new Date();
    const releasesFrozenFunds =
      input.operation === "reject" ||
      input.operation === "cancel" ||
      (input.operation === "mark_failed" && input.permanent);
    const paysFrozenFunds = input.operation === "mark_paid";

    if (releasesFrozenFunds) {
      await moveWithdrawalAllocations(tx, request, allocations, "release", now);
    } else if (paysFrozenFunds) {
      await moveWithdrawalAllocations(tx, request, allocations, "pay", now);
    }

    const updatedRequest = await updateWithdrawRequestForTransition(tx, request, input, now);
    const eventGroupId = `withdraw_transition:${request.id}:${input.idempotencyKey}`;
    const transaction = await createWalletTransactionHeader(tx, {
      eventGroupId,
      idempotencyKey: transitionIdempotencyKey,
      sourceId: request.id,
      eventType: walletTransactionEventTypeFor(input),
      status: walletTransactionStatusFor(input),
      currency: request.currency,
      ownerId: request.ownerId,
      representativeId: request.representativeId,
      ...(input.operation === "mark_failed"
        ? { failedAt: now }
        : input.operation === "reject" || input.operation === "cancel"
          ? { reversedAt: now }
          : { completedAt: now }),
      metadata: withdrawalTransitionMetadata(input),
    });
    if (!transaction) {
      throw new Error("Wallet transaction storage is required for withdrawal transitions.");
    }

    if (releasesFrozenFunds || paysFrozenFunds) {
      await recordWithdrawalTransitionLedger(
        tx,
        request,
        allocations,
        transaction,
        paysFrozenFunds ? "pay" : "release",
        input.provider,
      );
    }

    return serializeWithdrawRequest(
      updatedRequest,
      releasesFrozenFunds || paysFrozenFunds ? 0 : request.amountCents,
    );
  };

  return runWalletWriteTransaction(client, run);
}

async function assertWithdrawalFundsWriteAllowed(
  client: WithdrawalClient,
  input: WorkspaceWalletFundsWriteScope,
): Promise<void> {
  if (client.walletFundsWriteGate) {
    await client.walletFundsWriteGate.assertAllowed(input);
    return;
  }
  await assertWorkspaceWalletFundsWriteAllowed(
    input,
    client as unknown as WorkspaceWalletReconciliationClient,
  );
}

async function findOwnedWithdrawRequest(
  client: WithdrawalClient,
  withdrawRequestId: string,
  ownerId: string,
): Promise<WithdrawRequestRecord | null> {
  const request = await client.withdrawRequest.findFirst({
    where: {
      id: withdrawRequestId,
      ownerId,
    },
  });
  return request?.ownerId === ownerId ? request : null;
}

async function getRequiredWithdrawalAllocations(
  client: WithdrawalClient,
  request: WithdrawRequestRecord,
): Promise<WithdrawalAllocationRecord[]> {
  if (!client.withdrawalAllocation) {
    throw new Error("Withdrawal allocation storage is required.");
  }
  const allocations = await client.withdrawalAllocation.findMany({
    where: {
      withdrawRequestId: request.id,
    },
    include: {
      creatorEarning: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const allocatedCents = allocations.reduce(
    (sum, allocation) => sum + allocation.amountCents,
    0,
  );
  if (!allocations.length || allocatedCents !== request.amountCents) {
    throw new Error("Withdrawal allocations do not match the requested amount.");
  }
  if (
    allocations.some(
      (allocation) =>
        allocation.currency !== request.currency ||
        allocation.amountCents <= 0,
    )
  ) {
    throw new Error("Withdrawal allocations are inconsistent with the request.");
  }
  return allocations;
}

function validateWithdrawalTransition(
  request: WithdrawRequestRecord,
  allocations: WithdrawalAllocationRecord[],
  input: NormalizedWithdrawalTransition,
): void {
  const allowedFrom: Record<WithdrawalTransitionOperation, WithdrawRequestStatus[]> = {
    approve: [WithdrawRequestStatus.PENDING_REVIEW, WithdrawRequestStatus.FAILED],
    reject: [WithdrawRequestStatus.PENDING_REVIEW],
    cancel: [
      WithdrawRequestStatus.PENDING_REVIEW,
      WithdrawRequestStatus.APPROVED,
      WithdrawRequestStatus.FAILED,
    ],
    mark_paid: [WithdrawRequestStatus.APPROVED, WithdrawRequestStatus.FAILED],
    mark_failed: [WithdrawRequestStatus.APPROVED, WithdrawRequestStatus.FAILED],
  };
  if (!allowedFrom[input.operation].includes(request.status)) {
    throw new Error(
      `Illegal withdrawal transition: ${request.status} -> ${targetWithdrawRequestStatus(input.operation)}.`,
    );
  }
  if (
    input.operation === "mark_failed" &&
    request.status === WithdrawRequestStatus.FAILED &&
    !input.permanent
  ) {
    throw new Error(
      "Illegal withdrawal transition: a failed payout can only be finalized as a permanent failure.",
    );
  }

  const hasTerminalAllocation = allocations.some(
    (allocation) => allocation.releasedAt !== null || allocation.paidAt !== null,
  );
  if (hasTerminalAllocation) {
    throw new Error("Withdrawal allocations have already been released or paid.");
  }
}

async function moveWithdrawalAllocations(
  client: WithdrawalClient,
  request: WithdrawRequestRecord,
  allocations: WithdrawalAllocationRecord[],
  mode: "release" | "pay",
  now: Date,
): Promise<void> {
  if (!client.withdrawalAllocation) {
    throw new Error("Withdrawal allocation storage is required.");
  }
  for (const allocation of allocations) {
    const earning =
      allocation.creatorEarning ??
      (client.creatorEarning.findUnique
        ? await client.creatorEarning.findUnique({
            where: { id: allocation.creatorEarningId },
          })
        : null);
    if (
      !earning ||
      earning.ownerId !== request.ownerId ||
      earning.representativeId !== request.representativeId ||
      earning.currency !== request.currency
    ) {
      throw new Error("Withdrawal allocation creator earning is invalid.");
    }
    if (
      allocation.releasedAt !== null ||
      allocation.paidAt !== null ||
      earning.frozenCents < allocation.amountCents
    ) {
      throw new Error("Withdrawal allocation has already been released or paid.");
    }

    const frozenAfter = earning.frozenCents - allocation.amountCents;
    if (mode === "release") {
      await client.creatorEarning.update({
        where: { id: earning.id },
        data: {
          frozenCents: { decrement: allocation.amountCents },
          withdrawableCents: { increment: allocation.amountCents },
          status: CreatorEarningStatus.WITHDRAWABLE,
        },
      });
      await client.withdrawalAllocation.update({
        where: { id: allocation.id },
        data: { releasedAt: now },
      });
      allocation.releasedAt = now;
      continue;
    }

    const withdrawableCents = earning.withdrawableCents;
    const pendingCents = earning.pendingCents ?? 0;
    const nextStatus =
      withdrawableCents > 0
        ? CreatorEarningStatus.WITHDRAWABLE
        : frozenAfter > 0
          ? CreatorEarningStatus.FROZEN
          : pendingCents > 0
            ? CreatorEarningStatus.PENDING
            : CreatorEarningStatus.WITHDRAWN;
    await client.creatorEarning.update({
      where: { id: earning.id },
      data: {
        frozenCents: { decrement: allocation.amountCents },
        withdrawnCents: { increment: allocation.amountCents },
        status: nextStatus,
      },
    });
    await client.withdrawalAllocation.update({
      where: { id: allocation.id },
      data: { paidAt: now },
    });
    allocation.paidAt = now;
  }
}

async function updateWithdrawRequestForTransition(
  client: WithdrawalClient,
  request: WithdrawRequestRecord,
  input: NormalizedWithdrawalTransition,
  now: Date,
): Promise<WithdrawRequestRecord> {
  if (!client.withdrawRequest.update) {
    throw new Error("Withdrawal request updates are required for transitions.");
  }
  const status = targetWithdrawRequestStatus(input.operation);
  const data: Record<string, unknown> = { status };
  if (input.operation === "approve" || input.operation === "reject") {
    data.reviewedAt = now;
    data.reviewedBy = input.reviewedBy;
  }
  if (
    input.operation === "reject" ||
    input.operation === "cancel" ||
    input.operation === "mark_failed"
  ) {
    data.failureReason = input.reason;
  } else if (input.operation === "approve" || input.operation === "mark_paid") {
    data.failureReason = null;
  }
  if (input.operation === "mark_paid") {
    data.paidAt = now;
    data.provider = input.provider;
    data.providerPayoutId = input.providerPayoutId;
  }
  return client.withdrawRequest.update({
    where: {
      id: request.id,
      ownerId: request.ownerId,
      status: request.status,
    },
    data,
  });
}

async function recordWithdrawalTransitionLedger(
  client: WithdrawalClient,
  request: WithdrawRequestRecord,
  allocations: WithdrawalAllocationRecord[],
  transaction: WalletTransactionRecord,
  mode: "release" | "pay",
  provider: PaymentProvider | null,
): Promise<void> {
  if (!request.representativeId) {
    throw new Error("Withdrawal request is missing a representative.");
  }
  if (mode === "pay" && !provider) {
    throw new Error("Payment provider is required for withdrawal payout.");
  }

  await recordWalletLedgerTransaction(
    {
      eventGroupId: transaction.eventGroupId,
      idempotencyKey: transaction.idempotencyKey,
      currency: request.currency,
      requireBalancedAmount: true,
      movements: allocations.flatMap(
        (allocation, index): WalletLedgerMovement[] => {
          const frozenDebit: WalletLedgerMovement = {
            entryKey: `allocation_${index + 1}_creator_frozen_debit`,
            accountType: AmnWalletAccountType.CREATOR_FROZEN,
            entryKind: AmnLedgerEntryKind.CREATOR_FROZEN_DEBIT,
            transactionId: transaction.id,
            ownerId: request.ownerId,
            representativeId: request.representativeId,
            creatorEarningId: allocation.creatorEarningId,
            withdrawRequestId: request.id,
            amountCents: -allocation.amountCents,
            balanceAfterCents: null,
            notes:
              mode === "pay"
                ? "withdraw_request_paid"
                : "withdraw_request_released",
          };
          if (mode === "release") {
            return [
              frozenDebit,
              {
                entryKey: `allocation_${index + 1}_creator_withdrawable_credit`,
                accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
                entryKind: AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
                transactionId: transaction.id,
                ownerId: request.ownerId,
                representativeId: request.representativeId,
                creatorEarningId: allocation.creatorEarningId,
                withdrawRequestId: request.id,
                amountCents: allocation.amountCents,
                notes: "withdraw_request_released",
              },
            ];
          }
          return [
            frozenDebit,
            {
              entryKey: `allocation_${index + 1}_external_settlement_credit`,
              accountType: AmnWalletAccountType.EXTERNAL_SETTLEMENT,
              entryKind: AmnLedgerEntryKind.EXTERNAL_SETTLEMENT_CREDIT,
              transactionId: transaction.id,
              ownerId: request.ownerId,
              representativeId: request.representativeId,
              creatorEarningId: allocation.creatorEarningId,
              withdrawRequestId: request.id,
              amountCents: allocation.amountCents,
              notes: "withdraw_request_paid",
              metadata: {
                provider: provider!,
              },
            },
          ];
        },
      ),
    },
    client,
  );
}

async function createWalletTransactionHeader(
  client: WithdrawalClient,
  input: WalletTransactionHeaderInput,
): Promise<WalletTransactionRecord | null> {
  if (!client.walletTransaction) {
    return null;
  }
  const existing = await client.walletTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    assertWalletIdempotencyField(
      "wallet transaction",
      "eventGroupId",
      existing.eventGroupId,
      input.eventGroupId,
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
      "currency",
      existing.currency,
      input.currency,
    );
    return existing;
  }
  return client.walletTransaction.create({
    data: {
      eventGroupId: input.eventGroupId,
      idempotencyKey: input.idempotencyKey,
      sourceType: WITHDRAW_REQUEST_SOURCE_TYPE,
      sourceId: input.sourceId,
      eventType: input.eventType,
      status: input.status,
      currency: input.currency,
      ownerId: input.ownerId,
      representativeId: input.representativeId,
      completedAt: input.completedAt,
      failedAt: input.failedAt,
      reversedAt: input.reversedAt,
      metadata: input.metadata,
    },
  });
}

function requireWalletTransactionClient(
  client: WithdrawalClient,
): NonNullable<WithdrawalClient["walletTransaction"]> {
  if (!client.walletTransaction) {
    throw new Error("Wallet transaction storage is required for withdrawal transitions.");
  }
  return client.walletTransaction;
}

function assertWithdrawalTransitionReplay(
  transaction: WalletTransactionRecord,
  input: NormalizedWithdrawalTransition,
): void {
  assertWalletIdempotencyField(
    "withdrawal transition",
    "sourceType",
    transaction.sourceType,
    WITHDRAW_REQUEST_SOURCE_TYPE,
  );
  assertWalletIdempotencyField(
    "withdrawal transition",
    "sourceId",
    transaction.sourceId,
    input.withdrawRequestId,
  );
  assertWalletIdempotencyField(
    "withdrawal transition",
    "ownerId",
    transaction.ownerId,
    input.ownerId,
  );
  assertWalletIdempotencyField(
    "withdrawal transition",
    "eventType",
    transaction.eventType,
    walletTransactionEventTypeFor(input),
  );
  const metadata = asRecord(transaction.metadata);
  const expected = withdrawalTransitionMetadata(input);
  for (const [key, value] of Object.entries(expected)) {
    assertWalletIdempotencyField(
      "withdrawal transition",
      key,
      metadata[key],
      value,
    );
  }
}

function withdrawalTransitionMetadata(
  input: NormalizedWithdrawalTransition,
): Record<string, string | number | boolean | null> {
  return {
    operation: input.operation,
    reviewedBy: input.reviewedBy,
    reason: input.reason,
    provider: input.provider,
    providerPayoutId: input.providerPayoutId,
    permanent: input.permanent,
    targetStatus: targetWithdrawRequestStatus(input.operation),
  };
}

function walletTransactionEventTypeFor(
  input: NormalizedWithdrawalTransition,
): WalletTransactionEventType {
  switch (input.operation) {
    case "mark_paid":
    case "mark_failed":
      return WalletTransactionEventType.WITHDRAWAL_PAYOUT;
    case "reject":
    case "cancel":
      return WalletTransactionEventType.REVERSAL;
    case "approve":
      return WalletTransactionEventType.ADJUSTMENT;
  }
}

function walletTransactionStatusFor(
  input: NormalizedWithdrawalTransition,
): WalletTransactionStatus {
  switch (input.operation) {
    case "mark_failed":
      return WalletTransactionStatus.FAILED;
    case "reject":
      return WalletTransactionStatus.REVERSED;
    case "cancel":
      return WalletTransactionStatus.CANCELED;
    case "approve":
    case "mark_paid":
      return WalletTransactionStatus.SUCCEEDED;
  }
}

function targetWithdrawRequestStatus(
  operation: WithdrawalTransitionOperation,
): WithdrawRequestStatus {
  switch (operation) {
    case "approve":
      return WithdrawRequestStatus.APPROVED;
    case "reject":
      return WithdrawRequestStatus.REJECTED;
    case "cancel":
      return WithdrawRequestStatus.CANCELED;
    case "mark_paid":
      return WithdrawRequestStatus.PAID;
    case "mark_failed":
      return WithdrawRequestStatus.FAILED;
  }
}

async function getActiveFrozenCents(
  client: WithdrawalClient,
  withdrawRequestId: string,
  fallback: number,
): Promise<number> {
  if (!client.withdrawalAllocation) {
    return fallback;
  }
  const allocations = await client.withdrawalAllocation.findMany({
    where: { withdrawRequestId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!allocations.length) {
    return fallback;
  }
  return allocations.reduce(
    (sum, allocation) =>
      sum +
      (allocation.releasedAt === null && allocation.paidAt === null
        ? allocation.amountCents
        : 0),
    0,
  );
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
  const representativeId = input.representativeId.trim();
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
    idempotencyKey: resolveWalletOperationId(
      input.idempotencyKey,
      "withdraw_request",
    ),
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
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewedBy: request.reviewedBy ?? null,
    paidAt: request.paidAt?.toISOString() ?? null,
    provider: request.provider ?? null,
    providerPayoutId: request.providerPayoutId ?? null,
    failureReason: request.failureReason ?? null,
    payoutProfileId: request.payoutProfileId ?? null,
    payoutDestinationId: request.payoutDestinationId ?? null,
    payoutSubjectType: request.payoutSubjectTypeSnapshot
      ? request.payoutSubjectTypeSnapshot.toLowerCase() as
        | "owner"
        | "organization"
      : null,
    payoutSubjectId: request.payoutSubjectIdSnapshot ?? null,
    destinationMaskedLabel:
      request.destinationMaskedLabelSnapshot ?? null,
    destinationVersion: request.destinationVersionSnapshot ?? null,
  };
}

async function resolveVerifiedPayoutDestination(
  client: WithdrawalClient,
  ownerId: string,
  currency: string,
): Promise<PayoutDestinationRecord> {
  if (!client.payoutDestination) {
    throw new Error(
      "A verified payout destination is required before requesting withdrawals.",
    );
  }

  const destination = await client.payoutDestination.findFirst({
    where: {
      currency,
      status: PayoutDestinationStatus.ACTIVE,
      OR: [
        { coolingOffUntil: null },
        { coolingOffUntil: { lte: new Date() } },
      ],
      profile: {
        status: CreatorPayoutProfileStatus.VERIFIED,
        OR: [
          {
            ownerId,
            subjectType: PayoutSubjectType.OWNER,
          },
          {
            subjectType: PayoutSubjectType.ORGANIZATION,
            organization: {
              members: {
                some: {
                  ownerId,
                  canManageBilling: true,
                },
              },
            },
          },
        ],
      },
    },
    include: {
      profile: {
        select: {
          id: true,
          ownerId: true,
          organizationId: true,
          subjectType: true,
          status: true,
        },
      },
    },
    orderBy: [
      { activatedAt: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ],
  }) as PayoutDestinationRecord | null;
  if (!destination) {
    throw new Error(
      "A verified payout destination is required before requesting withdrawals.",
    );
  }
  const subjectId =
    destination.profile.subjectType === PayoutSubjectType.OWNER
      ? destination.profile.ownerId
      : destination.profile.organizationId;
  if (
    !subjectId
    || (
      destination.profile.subjectType === PayoutSubjectType.OWNER
      && destination.profile.ownerId !== ownerId
    )
  ) {
    throw new Error(
      "A verified payout destination is required before requesting withdrawals.",
    );
  }
  return destination;
}

function normalizeOptionalText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
