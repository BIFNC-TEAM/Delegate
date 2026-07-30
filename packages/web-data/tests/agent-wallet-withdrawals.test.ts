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
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  approveWithdrawRequest,
  cancelWithdrawRequest,
  createWithdrawRequest,
  markWithdrawRequestFailed,
  markWithdrawRequestPaid,
  rejectWithdrawRequest,
} from "../src/agent-wallet-withdrawals";
import {
  WalletReconciliationRequiredError,
  type WorkspaceWalletFundsWriteScope,
  type WorkspaceWalletReconciliationStatus,
} from "../src/wallet-reconciliation";

describe("agent wallet withdrawals", () => {
  it("fails closed before freezing funds when no verified active payout destination exists", async () => {
    const client = new FakeWithdrawalClient({
      hasVerifiedPayoutDestination: false,
    });

    await expect(createDefaultRequest(client)).rejects.toThrow(
      "A verified payout destination is required before requesting withdrawals.",
    );

    expect(client.withdrawRequests).toHaveLength(0);
    expect(client.withdrawalAllocations).toHaveLength(0);
    expect(client.walletTransactions).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
    expect(client.creatorEarnings[0]).toMatchObject({
      withdrawableCents: 500,
      frozenCents: 0,
    });
  });

  it("copies the complete masked payout destination snapshot onto a withdrawal", async () => {
    const client = new FakeWithdrawalClient();

    const request = await createDefaultRequest(client);

    expect(request).toMatchObject({
      payoutProfileId: "payout_profile_owner_1",
      payoutDestinationId: "payout_destination_owner_1_v3",
      payoutSubjectType: "owner",
      payoutSubjectId: "owner_1",
      destinationMaskedLabel: "WeChat Pay ···· 2048",
      destinationVersion: 3,
    });
    expect(client.withdrawRequests[0]).toMatchObject({
      payoutProfileId: "payout_profile_owner_1",
      payoutDestinationId: "payout_destination_owner_1_v3",
      payoutSubjectTypeSnapshot: PayoutSubjectType.OWNER,
      payoutSubjectIdSnapshot: "owner_1",
      destinationMaskedLabelSnapshot: "WeChat Pay ···· 2048",
      destinationVersionSnapshot: 3,
    });

    client.payoutDestinations[0]!.maskedLabel = "WeChat Pay ···· 9999";
    client.payoutDestinations[0]!.credentialVersion = 4;
    expect(client.withdrawRequests[0]).toMatchObject({
      destinationMaskedLabelSnapshot: "WeChat Pay ···· 2048",
      destinationVersionSnapshot: 3,
    });
  });

  it("allocates multiple earnings deterministically and records a balanced freeze", async () => {
    const client = new FakeWithdrawalClient({
      withdrawableAmounts: [200, 400],
    });

    const request = await createWithdrawRequest(
      {
        ownerId: "owner_1",
        representativeId: "rep_1",
        amountCents: 450,
        idempotencyKey: "withdraw_owner_1_rep_1_450",
      },
      client,
    );
    const requestAgain = await createWithdrawRequest(
      {
        ownerId: "owner_1",
        representativeId: "rep_1",
        amountCents: 450,
        idempotencyKey: "withdraw_owner_1_rep_1_450",
      },
      client,
    );

    expect(request).toMatchObject({
      ownerId: "owner_1",
      representativeId: "rep_1",
      amountCents: 450,
      status: "pending_review",
      frozenCents: 450,
    });
    expect(requestAgain.id).toBe(request.id);
    expect(client.withdrawRequests).toHaveLength(1);
    expect(client.withdrawalAllocations.map((row) => row.amountCents)).toEqual([200, 250]);
    expect(client.creatorEarnings).toEqual([
      expect.objectContaining({
        id: "earning_1",
        withdrawableCents: 0,
        frozenCents: 200,
        status: CreatorEarningStatus.FROZEN,
      }),
      expect.objectContaining({
        id: "earning_2",
        withdrawableCents: 150,
        frozenCents: 250,
        status: CreatorEarningStatus.WITHDRAWABLE,
      }),
    ]);
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(4);
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
    expect(client.ledgerEntries.every((row) => row.transactionId === client.walletTransactions[0]?.id))
      .toBe(true);
    expect(client.ledgerEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
          entryKind: AmnLedgerEntryKind.WITHDRAWAL_FREEZE,
          amountCents: -200,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_FROZEN,
          entryKind: AmnLedgerEntryKind.CREATOR_FROZEN_CREDIT,
          amountCents: 250,
        }),
      ]),
    );
  });

  it("rejects reuse of a withdrawal idempotency key with different parameters", async () => {
    const client = new FakeWithdrawalClient();
    await createWithdrawRequest(
      {
        ownerId: "owner_1",
        representativeId: "rep_1",
        amountCents: 200,
        idempotencyKey: "withdraw_conflict",
      },
      client,
    );

    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 300,
          idempotencyKey: "withdraw_conflict",
        },
        client,
      ),
    ).rejects.toThrow("Idempotency key was already used");
    expect(client.withdrawRequests).toHaveLength(1);
  });

  it("allows warning reconciliation scopes to create withdrawals", async () => {
    const client = new FakeWithdrawalClient({
      reconciliationStatus: "warning",
    });

    await expect(createDefaultRequest(client)).resolves.toMatchObject({
      status: "pending_review",
    });
    expect(client.reconciliationChecks).toEqual([
      {
        ownerId: "owner_1",
        representativeId: "rep_1",
        currency: "CNY",
      },
    ]);
  });

  it("blocks new withdrawal writes when reconciliation has errors", async () => {
    const client = new FakeWithdrawalClient({
      reconciliationStatus: "blocked",
    });

    const error = await createDefaultRequest(client).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(WalletReconciliationRequiredError);
    expect(error).toMatchObject({
      code: "wallet_reconciliation_required",
    });
    expect(client.withdrawRequests).toHaveLength(0);
    expect(client.withdrawalAllocations).toHaveLength(0);
    expect(client.walletTransactions).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
    expect(client.creatorEarnings[0]).toMatchObject({
      withdrawableCents: 500,
      frozenCents: 0,
    });
  });

  it("blocks withdrawal progression and cancellation but permits exact replay", async () => {
    const client = new FakeWithdrawalClient();
    const request = await createDefaultRequest(client);

    client.reconciliationStatus = "blocked";
    await expect(
      approveWithdrawRequest(
        {
          ownerId: "owner_1",
          withdrawRequestId: request.id,
          idempotencyKey: "approve_while_blocked",
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "wallet_reconciliation_required",
    });
    await expect(
      cancelWithdrawRequest(
        {
          ownerId: "owner_1",
          withdrawRequestId: request.id,
          idempotencyKey: "cancel_while_blocked",
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "wallet_reconciliation_required",
    });
    expect(client.withdrawRequests[0]).toMatchObject({
      status: WithdrawRequestStatus.PENDING_REVIEW,
    });
    expect(client.walletTransactions).toHaveLength(1);
    expect(client.ledgerEntries).toHaveLength(2);

    client.reconciliationStatus = "healthy";
    const approved = await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        reviewedBy: "reviewer_1",
        idempotencyKey: "approve_replay_during_block",
      },
      client,
    );
    const checksBeforeReplay = client.reconciliationChecks.length;
    client.reconciliationStatus = "blocked";
    await expect(
      approveWithdrawRequest(
        {
          ownerId: "owner_1",
          withdrawRequestId: request.id,
          reviewedBy: "reviewer_1",
          idempotencyKey: "approve_replay_during_block",
        },
        client,
      ),
    ).resolves.toEqual(approved);
    expect(client.reconciliationChecks).toHaveLength(checksBeforeReplay);
  });

  it("allows only one active request per representative and currency", async () => {
    const client = new FakeWithdrawalClient();
    const first = await createDefaultRequest(client, 300);

    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 100,
          idempotencyKey: "withdraw_while_active",
        },
        client,
      ),
    ).rejects.toThrow(
      "An active withdrawal request already exists for this representative and currency.",
    );

    await cancelWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: first.id,
        idempotencyKey: "cancel_before_recreate",
      },
      client,
    );
    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 100,
          idempotencyKey: "withdraw_after_cancel",
        },
        client,
      ),
    ).resolves.toMatchObject({
      amountCents: 100,
      status: "pending_review",
    });
  });

  it("approves idempotently, rejects payload mismatch, and validates legal transitions", async () => {
    const client = new FakeWithdrawalClient();
    const request = await createDefaultRequest(client);

    const approved = await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        reviewedBy: "reviewer_1",
        idempotencyKey: "approve_1",
      },
      client,
    );
    const replay = await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        reviewedBy: "reviewer_1",
        idempotencyKey: "approve_1",
      },
      client,
    );

    expect(approved).toMatchObject({
      status: "approved",
      frozenCents: 300,
      reviewedBy: "reviewer_1",
    });
    expect(replay).toMatchObject({ id: request.id, status: "approved" });
    expect(client.walletTransactions).toHaveLength(2);
    expect(client.ledgerEntries).toHaveLength(2);

    await expect(
      approveWithdrawRequest(
        {
          ownerId: "owner_1",
          withdrawRequestId: request.id,
          reviewedBy: "reviewer_2",
          idempotencyKey: "approve_1",
        },
        client,
      ),
    ).rejects.toThrow("Idempotency key was already used");
    await expect(
      rejectWithdrawRequest(
        {
          ownerId: "owner_1",
          withdrawRequestId: request.id,
          idempotencyKey: "reject_after_approve",
        },
        client,
      ),
    ).rejects.toThrow("Illegal withdrawal transition");
  });

  it("releases every allocation on rejection and conserves the ledger", async () => {
    const client = new FakeWithdrawalClient({
      withdrawableAmounts: [200, 400],
    });
    const request = await createDefaultRequest(client, 450);

    const rejected = await rejectWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        reviewedBy: "reviewer_1",
        reason: "identity mismatch",
        idempotencyKey: "reject_1",
      },
      client,
    );

    expect(rejected).toMatchObject({
      status: "rejected",
      frozenCents: 0,
      failureReason: "identity mismatch",
    });
    expect(client.creatorEarnings.map((row) => row.withdrawableCents)).toEqual([200, 400]);
    expect(client.creatorEarnings.map((row) => row.frozenCents)).toEqual([0, 0]);
    expect(client.withdrawalAllocations.every((row) => row.releasedAt !== null)).toBe(true);
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
    expect(client.ledgerEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_FROZEN,
          entryKind: AmnLedgerEntryKind.CREATOR_FROZEN_DEBIT,
          amountCents: -200,
        }),
        expect.objectContaining({
          accountType: AmnWalletAccountType.CREATOR_WITHDRAWABLE,
          entryKind: AmnLedgerEntryKind.CREATOR_WITHDRAWABLE_CREDIT,
          amountCents: 250,
        }),
      ]),
    );
  });

  it("moves approved frozen earnings to withdrawn exactly once when paid", async () => {
    const client = new FakeWithdrawalClient({
      withdrawableAmounts: [200, 400],
    });
    const request = await createDefaultRequest(client, 450);
    await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        idempotencyKey: "approve_for_pay",
      },
      client,
    );

    const paid = await markWithdrawRequestPaid(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        provider: PaymentProvider.MOCK,
        providerPayoutId: "payout_1",
        idempotencyKey: "pay_1",
      },
      client,
    );
    const replay = await markWithdrawRequestPaid(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        provider: PaymentProvider.MOCK,
        providerPayoutId: "payout_1",
        idempotencyKey: "pay_1",
      },
      client,
    );

    expect(paid).toMatchObject({
      status: "paid",
      frozenCents: 0,
      provider: PaymentProvider.MOCK,
      providerPayoutId: "payout_1",
    });
    expect(replay.status).toBe("paid");
    expect(client.creatorEarnings.map((row) => row.frozenCents)).toEqual([0, 0]);
    expect(client.creatorEarnings.map((row) => row.withdrawnCents)).toEqual([200, 250]);
    expect(client.creatorEarnings.map((row) => row.withdrawableCents)).toEqual([0, 150]);
    expect(client.withdrawalAllocations.every((row) => row.paidAt !== null)).toBe(true);
    expect(sumLedgerAmount(client.ledgerEntries)).toBe(0);
    expect(client.ledgerEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: AmnWalletAccountType.EXTERNAL_SETTLEMENT,
          entryKind: AmnLedgerEntryKind.EXTERNAL_SETTLEMENT_CREDIT,
        }),
      ]),
    );
    await expect(
      markWithdrawRequestPaid(
        {
          ownerId: "owner_1",
          withdrawRequestId: request.id,
          provider: PaymentProvider.MOCK,
          providerPayoutId: "payout_2",
          idempotencyKey: "pay_2",
        },
        client,
      ),
    ).rejects.toThrow("Illegal withdrawal transition");
  });

  it("defaults payout failures to transient, blocks another request, then releases on permanent failure", async () => {
    const failedClient = new FakeWithdrawalClient();
    const failedRequest = await createDefaultRequest(failedClient);
    await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: failedRequest.id,
        idempotencyKey: "approve_failed",
      },
      failedClient,
    );
    const transientFailure = await markWithdrawRequestFailed(
      {
        ownerId: "owner_1",
        withdrawRequestId: failedRequest.id,
        reason: "provider timeout",
        idempotencyKey: "failed_transient",
      },
      failedClient,
    );
    expect(transientFailure).toMatchObject({ status: "failed", frozenCents: 300 });
    expect(failedClient.creatorEarnings[0]).toMatchObject({
      withdrawableCents: 200,
      frozenCents: 300,
    });

    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 100,
          idempotencyKey: "withdraw_during_transient_failure",
        },
        failedClient,
      ),
    ).rejects.toThrow("An active withdrawal request already exists");

    const failed = await markWithdrawRequestFailed(
      {
        ownerId: "owner_1",
        withdrawRequestId: failedRequest.id,
        reason: "beneficiary account closed",
        permanent: true,
        idempotencyKey: "failed_permanent",
      },
      failedClient,
    );
    expect(failed).toMatchObject({ status: "failed", frozenCents: 0 });
    expect(failedClient.creatorEarnings[0]).toMatchObject({
      withdrawableCents: 500,
      frozenCents: 0,
    });
    await expect(
      createWithdrawRequest(
        {
          ownerId: "owner_1",
          representativeId: "rep_1",
          amountCents: 100,
          idempotencyKey: "withdraw_after_permanent_failure",
        },
        failedClient,
      ),
    ).resolves.toMatchObject({
      amountCents: 100,
      status: "pending_review",
    });
  });

  it("clears a stale payout failure when the request is approved or paid", async () => {
    const approveClient = new FakeWithdrawalClient();
    const approveRequest = await createDefaultRequest(approveClient);
    await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: approveRequest.id,
        idempotencyKey: "approve_before_retry",
      },
      approveClient,
    );
    await markWithdrawRequestFailed(
      {
        ownerId: "owner_1",
        withdrawRequestId: approveRequest.id,
        reason: "provider timeout",
        permanent: false,
        idempotencyKey: "failure_before_reapproval",
      },
      approveClient,
    );

    const reapproved = await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: approveRequest.id,
        idempotencyKey: "approve_retry",
      },
      approveClient,
    );
    expect(reapproved).toMatchObject({
      status: "approved",
      failureReason: null,
    });

    const paidClient = new FakeWithdrawalClient();
    const paidRequest = await createDefaultRequest(paidClient);
    await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: paidRequest.id,
        idempotencyKey: "approve_before_pay_retry",
      },
      paidClient,
    );
    await markWithdrawRequestFailed(
      {
        ownerId: "owner_1",
        withdrawRequestId: paidRequest.id,
        reason: "temporary payout failure",
        permanent: false,
        idempotencyKey: "failure_before_payment",
      },
      paidClient,
    );

    const paid = await markWithdrawRequestPaid(
      {
        ownerId: "owner_1",
        withdrawRequestId: paidRequest.id,
        provider: PaymentProvider.MOCK,
        providerPayoutId: "payout_after_retry",
        idempotencyKey: "pay_retry",
      },
      paidClient,
    );
    expect(paid).toMatchObject({
      status: "paid",
      failureReason: null,
    });
  });

  it("releases funds when a pending request is canceled", async () => {
    const canceledClient = new FakeWithdrawalClient();
    const canceledRequest = await createDefaultRequest(canceledClient);
    const canceled = await cancelWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: canceledRequest.id,
        reason: "owner canceled",
        idempotencyKey: "cancel_1",
      },
      canceledClient,
    );
    expect(canceled).toMatchObject({ status: "canceled", frozenCents: 0 });
    expect(canceledClient.withdrawalAllocations[0]?.releasedAt).not.toBeNull();
  });

  it("keeps balances and state unchanged when payout ledger recording fails", async () => {
    const client = new FakeWithdrawalClient();
    const request = await createDefaultRequest(client);
    await approveWithdrawRequest(
      {
        ownerId: "owner_1",
        withdrawRequestId: request.id,
        idempotencyKey: "approve_rollback",
      },
      client,
    );
    const transactionCount = client.walletTransactions.length;
    const ledgerCount = client.ledgerEntries.length;
    client.failNextLedgerCreate = true;

    await expect(
      markWithdrawRequestPaid(
        {
          ownerId: "owner_1",
          withdrawRequestId: request.id,
          provider: PaymentProvider.MOCK,
          providerPayoutId: "payout_rollback",
          idempotencyKey: "pay_rollback",
        },
        client,
      ),
    ).rejects.toThrow("injected ledger failure");

    expect(client.withdrawRequests[0]?.status).toBe(WithdrawRequestStatus.APPROVED);
    expect(client.creatorEarnings[0]).toMatchObject({
      frozenCents: 300,
      withdrawnCents: 0,
    });
    expect(client.withdrawalAllocations[0]).toMatchObject({
      releasedAt: null,
      paidAt: null,
    });
    expect(client.walletTransactions).toHaveLength(transactionCount);
    expect(client.ledgerEntries).toHaveLength(ledgerCount);
  });

  it("scopes transitions to the owning owner", async () => {
    const client = new FakeWithdrawalClient();
    const request = await createDefaultRequest(client);
    await expect(
      approveWithdrawRequest(
        {
          ownerId: "owner_2",
          withdrawRequestId: request.id,
          idempotencyKey: "wrong_owner",
        },
        client,
      ),
    ).rejects.toThrow("Withdrawal request not found");
    expect(client.withdrawRequests[0]?.status).toBe(WithdrawRequestStatus.PENDING_REVIEW);
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
      withdrawableAmounts: [200],
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
  pendingCents: number;
  withdrawableCents: number;
  frozenCents: number;
  withdrawnCents: number;
  currency: string;
  createdAt: Date;
};

type WithdrawRequestRow = {
  id: string;
  ownerId: string;
  representativeId: string | null;
  status: WithdrawRequestStatus;
  amountCents: number;
  currency: string;
  requestedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  paidAt: Date | null;
  provider: PaymentProvider | null;
  providerPayoutId: string | null;
  failureReason: string | null;
  idempotencyKey: string;
  payoutProfileId: string | null;
  payoutDestinationId: string | null;
  payoutSubjectTypeSnapshot: PayoutSubjectType | null;
  payoutSubjectIdSnapshot: string | null;
  destinationMaskedLabelSnapshot: string | null;
  destinationVersionSnapshot: number | null;
};

type PayoutDestinationRow = {
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

type WithdrawalAllocationRow = {
  id: string;
  withdrawRequestId: string;
  creatorEarningId: string;
  amountCents: number;
  currency: string;
  releasedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  creatorEarning?: CreatorEarningRow;
};

type WalletTransactionRow = {
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

type LedgerRow = {
  id: string;
  eventGroupId: string;
  idempotencyKey: string;
  accountType: AmnWalletAccountType;
  entryKind: AmnLedgerEntryKind;
  amountCents: number;
  tokenAmount: number;
  currency: string;
  transactionId: string | null;
  createdAt: Date;
};

class FakeWithdrawalClient {
  owners: OwnerRow[];
  representatives: RepresentativeRow[];
  creatorEarnings: CreatorEarningRow[];
  withdrawRequests: WithdrawRequestRow[] = [];
  withdrawalAllocations: WithdrawalAllocationRow[] = [];
  walletTransactions: WalletTransactionRow[] = [];
  ledgerEntries: LedgerRow[] = [];
  payoutDestinations: PayoutDestinationRow[];
  failNextLedgerCreate = false;
  reconciliationStatus: WorkspaceWalletReconciliationStatus = "healthy";
  reconciliationChecks: WorkspaceWalletFundsWriteScope[] = [];

  constructor(
    options: {
      creatorVerificationStatus?: CreatorVerificationStatus;
      claimStatus?: RepresentativeClaimStatus;
      representativeOwnerId?: string;
      withdrawableAmounts?: number[];
      reconciliationStatus?: WorkspaceWalletReconciliationStatus;
      hasVerifiedPayoutDestination?: boolean;
    } = {},
  ) {
    this.reconciliationStatus = options.reconciliationStatus ?? "healthy";
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
    this.creatorEarnings = (options.withdrawableAmounts ?? [500]).map(
      (withdrawableCents, index) => ({
        id: `earning_${index + 1}`,
        ownerId: "owner_1",
        representativeId: "rep_1",
        agentWalletId: "agent_wallet_1",
        status: CreatorEarningStatus.WITHDRAWABLE,
        pendingCents: 0,
        withdrawableCents,
        frozenCents: 0,
        withdrawnCents: 0,
        currency: "CNY",
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 0, index)),
      }),
    );
    this.payoutDestinations = options.hasVerifiedPayoutDestination === false
      ? []
      : [{
          id: "payout_destination_owner_1_v3",
          profileId: "payout_profile_owner_1",
          currency: "CNY",
          status: PayoutDestinationStatus.ACTIVE,
          maskedLabel: "WeChat Pay ···· 2048",
          credentialVersion: 3,
          coolingOffUntil: null,
          profile: {
            id: "payout_profile_owner_1",
            ownerId: "owner_1",
            organizationId: null,
            subjectType: PayoutSubjectType.OWNER,
            status: CreatorPayoutProfileStatus.VERIFIED,
          },
        }];
  }

  walletFundsWriteGate = {
    assertAllowed: async (input: WorkspaceWalletFundsWriteScope) => {
      this.reconciliationChecks.push({ ...input });
      if (this.reconciliationStatus === "blocked") {
        throw new WalletReconciliationRequiredError();
      }
    },
  };

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

  payoutDestination = {
    findFirst: async () => this.payoutDestinations[0] ?? null,
  };

  creatorEarning = {
    findMany: async (args: any) => {
      return this.creatorEarnings
        .filter((earning) => {
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
        })
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );
    },
    findUnique: async (args: any) => {
      return this.creatorEarnings.find((row) => row.id === args.where.id) ?? null;
    },
    update: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (!earning) {
        throw new Error("creator earning not found");
      }
      applyIncrementDecrement(earning, "pendingCents", args.data.pendingCents);
      applyIncrementDecrement(earning, "withdrawableCents", args.data.withdrawableCents);
      applyIncrementDecrement(earning, "frozenCents", args.data.frozenCents);
      applyIncrementDecrement(earning, "withdrawnCents", args.data.withdrawnCents);
      if (args.data.status) {
        earning.status = args.data.status;
      }
      return earning;
    },
  };

  withdrawRequest = {
    findUnique: async (args: any) => {
      if (typeof args.where.id === "string") {
        return this.withdrawRequests.find((request) => request.id === args.where.id) ?? null;
      }
      return (
        this.withdrawRequests.find(
          (request) => request.idempotencyKey === args.where.idempotencyKey,
        ) ?? null
      );
    },
    findFirst: async (args: any) => {
      if (typeof args.where.id !== "string") {
        return (
          this.withdrawRequests.find((request) => {
            if (
              request.ownerId !== args.where.ownerId ||
              request.representativeId !== args.where.representativeId ||
              request.currency !== args.where.currency
            ) {
              return false;
            }
            if (
              request.status === WithdrawRequestStatus.PENDING_REVIEW ||
              request.status === WithdrawRequestStatus.APPROVED
            ) {
              return true;
            }
            if (request.status !== WithdrawRequestStatus.FAILED) {
              return false;
            }
            return this.withdrawalAllocations.some(
              (allocation) =>
                allocation.withdrawRequestId === request.id &&
                allocation.releasedAt === null &&
                allocation.paidAt === null,
            );
          }) ?? null
        );
      }
      return (
        this.withdrawRequests.find(
          (request) =>
            request.id === args.where.id &&
            request.ownerId === args.where.ownerId,
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
        reviewedAt: null,
        reviewedBy: null,
        paidAt: null,
        provider: null,
        providerPayoutId: null,
        failureReason: null,
        idempotencyKey: args.data.idempotencyKey,
        payoutProfileId: args.data.payoutProfileId ?? null,
        payoutDestinationId: args.data.payoutDestinationId ?? null,
        payoutSubjectTypeSnapshot:
          args.data.payoutSubjectTypeSnapshot ?? null,
        payoutSubjectIdSnapshot: args.data.payoutSubjectIdSnapshot ?? null,
        destinationMaskedLabelSnapshot:
          args.data.destinationMaskedLabelSnapshot ?? null,
        destinationVersionSnapshot:
          args.data.destinationVersionSnapshot ?? null,
      };
      this.withdrawRequests.push(request);
      return request;
    },
    update: async (args: any) => {
      const request = this.withdrawRequests.find(
        (row) =>
          row.id === args.where.id &&
          (!args.where.ownerId || row.ownerId === args.where.ownerId) &&
          (!args.where.status || row.status === args.where.status),
      );
      if (!request) {
        throw new Error("withdraw request update conflict");
      }
      Object.assign(request, args.data);
      return request;
    },
  };

  withdrawalAllocation = {
    findMany: async (args: any) => {
      return this.withdrawalAllocations
        .filter((row) => row.withdrawRequestId === args.where.withdrawRequestId)
        .map((row) => {
          const earning = this.creatorEarnings.find(
            (candidate) => candidate.id === row.creatorEarningId,
          );
          return args.include?.creatorEarning && earning
            ? { ...row, creatorEarning: earning }
            : row;
        });
    },
    create: async (args: any) => {
      const row: WithdrawalAllocationRow = {
        id: `allocation_${this.withdrawalAllocations.length + 1}`,
        withdrawRequestId: args.data.withdrawRequestId,
        creatorEarningId: args.data.creatorEarningId,
        amountCents: args.data.amountCents,
        currency: args.data.currency,
        releasedAt: null,
        paidAt: null,
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 1, this.withdrawalAllocations.length)),
      };
      this.withdrawalAllocations.push(row);
      const earning = this.creatorEarnings.find(
        (candidate) => candidate.id === row.creatorEarningId,
      );
      return args.include?.creatorEarning && earning
        ? { ...row, creatorEarning: earning }
        : row;
    },
    update: async (args: any) => {
      const row = this.withdrawalAllocations.find(
        (allocation) => allocation.id === args.where.id,
      );
      if (!row) {
        throw new Error("withdrawal allocation not found");
      }
      Object.assign(row, args.data);
      return row;
    },
  };

  walletTransaction = {
    findUnique: async (args: any) => {
      return (
        this.walletTransactions.find(
          (transaction) =>
            transaction.idempotencyKey === args.where.idempotencyKey,
        ) ?? null
      );
    },
    create: async (args: any) => {
      const transaction: WalletTransactionRow = {
        id: `wallet_transaction_${this.walletTransactions.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        sourceType: args.data.sourceType,
        sourceId: args.data.sourceId ?? null,
        eventType: args.data.eventType,
        status: args.data.status,
        currency: args.data.currency,
        ownerId: args.data.ownerId ?? null,
        representativeId: args.data.representativeId ?? null,
        metadata: args.data.metadata,
      };
      this.walletTransactions.push(transaction);
      return transaction;
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
      return this.ledgerEntries.filter(
        (entry) => entry.eventGroupId === args.where.eventGroupId,
      );
    },
    create: async (args: { data: Prisma.WalletLedgerEntryUncheckedCreateInput }) => {
      if (this.failNextLedgerCreate) {
        this.failNextLedgerCreate = false;
        throw new Error("injected ledger failure");
      }
      const entry: LedgerRow = {
        id: `ledger_${this.ledgerEntries.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        accountType: args.data.accountType,
        entryKind: args.data.entryKind,
        amountCents: args.data.amountCents ?? 0,
        tokenAmount: args.data.tokenAmount ?? 0,
        currency: args.data.currency ?? "CNY",
        transactionId: args.data.transactionId ?? null,
        createdAt: new Date(Date.UTC(2026, 6, 3, 0, 2, this.ledgerEntries.length)),
      };
      this.ledgerEntries.push(entry);
      return entry;
    },
  };

  async $transaction<T>(fn: (tx: FakeWithdrawalClient) => Promise<T>): Promise<T> {
    const snapshot = this.clone();
    try {
      return await fn(this);
    } catch (error) {
      this.creatorEarnings = snapshot.creatorEarnings;
      this.withdrawRequests = snapshot.withdrawRequests;
      this.withdrawalAllocations = snapshot.withdrawalAllocations;
      this.walletTransactions = snapshot.walletTransactions;
      this.ledgerEntries = snapshot.ledgerEntries;
      this.failNextLedgerCreate = snapshot.failNextLedgerCreate;
      throw error;
    }
  }

  private clone() {
    return {
      creatorEarnings: this.creatorEarnings.map((row) => ({ ...row })),
      withdrawRequests: this.withdrawRequests.map((row) => ({ ...row })),
      withdrawalAllocations: this.withdrawalAllocations.map((row) => ({ ...row })),
      walletTransactions: this.walletTransactions.map((row) => ({
        ...row,
        metadata:
          row.metadata && typeof row.metadata === "object"
            ? { ...(row.metadata as Record<string, unknown>) }
            : row.metadata,
      })),
      ledgerEntries: this.ledgerEntries.map((row) => ({ ...row })),
      payoutDestinations: this.payoutDestinations.map((row) => ({
        ...row,
        profile: { ...row.profile },
      })),
      failNextLedgerCreate: this.failNextLedgerCreate,
    };
  }
}

async function createDefaultRequest(
  client: FakeWithdrawalClient,
  amountCents = 300,
) {
  return createWithdrawRequest(
    {
      ownerId: "owner_1",
      representativeId: "rep_1",
      amountCents,
      idempotencyKey: `withdraw_${amountCents}`,
    },
    client,
  );
}

function applyIncrementDecrement<T extends Record<K, number>, K extends keyof T>(
  row: T,
  key: K,
  value: { increment?: number; decrement?: number } | number | undefined,
) {
  if (typeof value === "number") {
    row[key] = value as T[K];
    return;
  }
  if (typeof value?.increment === "number") {
    row[key] = (row[key] + value.increment) as T[K];
  }
  if (typeof value?.decrement === "number") {
    row[key] = (row[key] - value.decrement) as T[K];
  }
}

function sumLedgerAmount(entries: LedgerRow[]): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
