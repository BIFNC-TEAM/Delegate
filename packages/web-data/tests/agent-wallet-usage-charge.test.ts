import {
  AgentTokenPurchaseStatus,
  AgentUsageChargeKind,
  AgentUsageChargeStatus,
  AmnWalletAccountType,
  CreatorEarningStatus,
  WalletTransactionStatus,
  type Prisma,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  AgentWalletReconciliationError,
  applyAgentUsageCharge,
  getUserAgentWalletBalance,
  InsufficientAgentUsageCreditsError,
  releaseConversationWalletUsage,
  releaseAgentUsageCredits,
  reserveConversationWalletUsage,
  reserveAgentUsageCredits,
  settleConversationWalletUsage,
  settleAgentUsageCredits,
  transferAgentUsageEntitlementReservation,
  verifyAgentUsageEntitlementReservation,
} from "../src/agent-wallet-usage-charge";
import {
  AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
} from "../src/service-entitlements";

describe("user-scoped service-credit usage", () => {
  it("rolls back the reservation when the compatibility settlement fails", async () => {
    const client = new FakeServiceCreditUsageClient();
    client.failNextAllocation = true;

    await expect(
      applyAgentUsageCharge(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          tokenAmount: 200,
          providerCostCents: 20,
          idempotencyKey: "atomic_apply_failure",
        },
        client,
      ),
    ).rejects.toThrow("allocation write failed");

    expect(client.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
      totalConsumedTokenAmount: 0,
    });
    expect(client.usageCharges).toHaveLength(0);
    expect(client.usageAllocations).toHaveLength(0);
    expect(client.walletTransactions).toHaveLength(0);
    expect(client.ledgerEntries).toHaveLength(0);
  });

  it("reserves, settles FIFO lots, and returns the unused reservation", async () => {
    const client = new FakeServiceCreditUsageClient();

    const reservation = await reserveAgentUsageCredits(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        tokenAmount: 700,
        idempotencyKey: "usage_1",
      },
      client,
    );

    expect(reservation).toMatchObject({
      status: "reserved",
      availableTokenAmount: 300,
      walletReservedTokenAmount: 700,
      creatorWithdrawableCents: 0,
    });
    expect(client.creatorEarnings).toHaveLength(3);

    const settled = await settleAgentUsageCredits(
      {
        usageChargeId: reservation.id,
        settledTokenAmount: 650,
        providerCostCents: 30,
        provider: "model-provider",
        idempotencyKey: "usage_1_settle",
      },
      client,
    );

    expect(settled).toMatchObject({
      status: "settled",
      settledTokenAmount: 650,
      releasedTokenAmount: 50,
      tokenValueCents: 650,
      creatorWithdrawableCents: 130,
      platformRevenueCents: 520,
      providerCostCents: 30,
      availableTokenAmount: 350,
      walletReservedTokenAmount: 0,
      agentTokenBalance: 850,
    });
    expect(settled.allocations).toEqual([
      {
        tokenPurchaseId: "purchase_1",
        tokenAmount: 600,
        valueCents: 600,
        creatorReleaseCents: 120,
      },
      {
        tokenPurchaseId: "purchase_2",
        tokenAmount: 50,
        valueCents: 50,
        creatorReleaseCents: 10,
      },
    ]);
    expect(client.tokenPurchases.find((lot) => lot.id === "purchase_1"))
      .toMatchObject({ remainingTokenAmount: 0 });
    expect(client.tokenPurchases.find((lot) => lot.id === "purchase_2"))
      .toMatchObject({ remainingTokenAmount: 350 });
    expect(
      sumLedgerAmount(
        client.ledgerEntries.filter(
          (entry) => entry.eventGroupId === `usage_settlement:${reservation.id}`,
        ),
      ),
    ).toBe(0);
    const settlementTransaction = client.walletTransactions.find(
      (transaction) =>
        transaction.eventGroupId === `usage_settlement:${reservation.id}`,
    );
    expect(settlementTransaction).toBeTruthy();
    expect(
      client.ledgerEntries
        .filter(
          (entry) => entry.eventGroupId === `usage_settlement:${reservation.id}`,
        )
        .every((entry) => entry.transactionId === settlementTransaction?.id),
    ).toBe(true);
  });

  it("releases a failed reservation without releasing creator earnings", async () => {
    const client = new FakeServiceCreditUsageClient();
    const reservation = await reserveAgentUsageCredits(
      {
        externalUserId: "user_1",
        representativeId: "rep_1",
        tokenAmount: 200,
        idempotencyKey: "usage_failed",
      },
      client,
    );

    const released = await releaseAgentUsageCredits(
      {
        usageChargeId: reservation.id,
        failed: true,
        reason: "provider_timeout",
        idempotencyKey: "usage_failed_release",
      },
      client,
    );

    expect(released).toMatchObject({
      status: "failed",
      releasedTokenAmount: 200,
      availableTokenAmount: 1000,
      walletReservedTokenAmount: 0,
      creatorWithdrawableCents: 0,
    });
    expect(client.creatorEarnings).toHaveLength(3);
    expect(client.usageAllocations).toHaveLength(0);
  });

  it("never resolves a token purchase to another user", async () => {
    const client = new FakeServiceCreditUsageClient();

    await expect(
      reserveAgentUsageCredits(
        {
          externalUserId: "user_2",
          tokenPurchaseId: "purchase_1",
          representativeId: "rep_1",
          tokenAmount: 100,
          idempotencyKey: "cross_user",
        },
        client,
      ),
    ).rejects.toThrow("does not belong to this external user");

    expect(client.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
    });
    expect(client.userAgentWallets[1]).toMatchObject({
      availableTokenAmount: 500,
      reservedTokenAmount: 0,
    });
  });

  it("fails closed without an unambiguous user-scoped selector", async () => {
    const client = new FakeServiceCreditUsageClient();

    await expect(
      reserveAgentUsageCredits(
        {
          representativeId: "rep_1",
          tokenAmount: 100,
          idempotencyKey: "ambiguous",
        },
        client,
      ),
    ).rejects.toThrow("user-scoped wallet selector");
  });

  it("treats a missing user wallet or scoped wallet as zero available credits", async () => {
    const missingUserClient = new FakeServiceCreditUsageClient();
    await expect(
      reserveAgentUsageCredits(
        {
          externalUserId: "user_without_wallet",
          representativeId: "rep_1",
          tokenAmount: 1,
          idempotencyKey: "missing_user_wallet",
        },
        missingUserClient,
      ),
    ).rejects.toBeInstanceOf(InsufficientAgentUsageCreditsError);

    const missingScopedWalletClient = new FakeServiceCreditUsageClient();
    missingScopedWalletClient.userAgentWallets =
      missingScopedWalletClient.userAgentWallets.filter(
        (wallet) => wallet.userWalletId !== "user_wallet_1",
      );
    await expect(
      reserveAgentUsageCredits(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          tokenAmount: 1,
          idempotencyKey: "missing_scoped_wallet",
        },
        missingScopedWalletClient,
      ),
    ).rejects.toBeInstanceOf(InsufficientAgentUsageCreditsError);
  });

  it("replays matching keys, rejects mismatches, and rolls back partial settlement", async () => {
    const client = new FakeServiceCreditUsageClient();
    const input = {
      externalUserId: "user_1",
      representativeId: "rep_1",
      tokenAmount: 200,
      idempotencyKey: "usage_retry",
    };
    const first = await reserveAgentUsageCredits(input, client);
    const replay = await reserveAgentUsageCredits(input, client);
    expect(replay.id).toBe(first.id);

    await expect(
      reserveAgentUsageCredits(
        { ...input, tokenAmount: 201 },
        client,
      ),
    ).rejects.toThrow("Idempotency key was already used");

    client.failNextAllocation = true;
    await expect(
      settleAgentUsageCredits(
        {
          usageChargeId: first.id,
          settledTokenAmount: 100,
          idempotencyKey: "usage_retry_settle",
        },
        client,
      ),
    ).rejects.toThrow("allocation write failed");

    expect(client.usageCharges[0]).toMatchObject({
      status: AgentUsageChargeStatus.RESERVED,
      settledTokenAmount: 0,
    });
    expect(client.tokenPurchases[0]).toMatchObject({
      remainingTokenAmount: 600,
    });
    expect(client.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 800,
      reservedTokenAmount: 200,
    });
  });

  it("reads scoped available and reserved balances by external user and representative", async () => {
    const client = new FakeServiceCreditUsageClient();
    const balance = await getUserAgentWalletBalance(
      {
        externalUserId: "user_2",
        representativeId: "rep_1",
      },
      client,
    );

    expect(balance).toMatchObject({
      userWalletId: "user_wallet_2",
      availableTokenAmount: 500,
      reservedTokenAmount: 0,
    });
  });

  it("reserves and verifies wallet and entitlement credits as one idempotent unit", async () => {
    const client = new FakeServiceCreditUsageClient();
    const input = {
      externalUserId: "user_1",
      audienceIdentityId: "audience_1",
      representativeId: "rep_1",
      conversationId: "conversation_1",
      generationRunId: "generation_run_1",
      tokenAmount: 200,
      idempotencyKey: "dual_reservation_1",
    };

    const first = await reserveConversationWalletUsage(input, client);
    const replay = await reserveConversationWalletUsage(input, client);

    expect(replay.usageCharge.id).toBe(first.usageCharge.id);
    expect(first.usageCharge).toMatchObject({
      status: "reserved",
      audienceIdentityId: "audience_1",
      entitlementAccountId: "entitlement_account_1",
      conversationId: "conversation_1",
      generationRunId: "generation_run_1",
      availableTokenAmount: 800,
      walletReservedTokenAmount: 200,
    });
    expect(client.serviceEntitlementAccounts[0]).toMatchObject({
      remainingUnits: 800,
      reservedUnits: 200,
    });
    expect(
      client.serviceEntitlementLedgerEntries.filter(
        (entry) => entry.kind === "RESERVE",
      ),
    ).toHaveLength(1);
    expect(client.usageCharges).toHaveLength(1);

    await expect(
      verifyAgentUsageEntitlementReservation(
        {
          usageChargeId: first.usageCharge.id,
          representativeId: "rep_1",
          generationRunId: "generation_run_1",
          audienceIdentityId: "audience_1",
          tokenAmount: 200,
        },
        client,
      ),
    ).resolves.toMatchObject({
      usageChargeId: first.usageCharge.id,
      entitlementAccountId: "entitlement_account_1",
      generationRunId: "generation_run_1",
      reserveGenerationRunId: "generation_run_1",
      tokenAmount: 200,
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
    });
  });

  it("canonicalizes the audience and rejects cross-user dual-ledger reservations", async () => {
    const mergedClient = new FakeServiceCreditUsageClient();
    mergedClient.identities.push({
      id: "audience_merged",
      status: "MERGED",
      mergedIntoId: "audience_1",
    });
    const mergedReservation = await reserveConversationWalletUsage(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_merged",
        representativeId: "rep_1",
        conversationId: "conversation_1",
        generationRunId: "generation_run_1",
        tokenAmount: 200,
        idempotencyKey: "dual_merged_audience",
      },
      mergedClient,
    );
    expect(mergedReservation.usageCharge).toMatchObject({
      audienceIdentityId: "audience_1",
      entitlementAccountId: "entitlement_account_1",
    });

    const crossUserClient = new FakeServiceCreditUsageClient();
    crossUserClient.serviceEntitlementAccounts[1]!.remainingUnits = 1000;
    await expect(
      reserveConversationWalletUsage(
        {
          externalUserId: "user_1",
          audienceIdentityId: "audience_2",
          representativeId: "rep_1",
          conversationId: "conversation_1",
          generationRunId: "generation_run_1",
          tokenAmount: 200,
          idempotencyKey: "dual_cross_user",
        },
        crossUserClient,
      ),
    ).rejects.toThrow(
      "User-agent wallet does not belong to the service entitlement audience.",
    );
    expect(crossUserClient.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
    });
    expect(crossUserClient.serviceEntitlementAccounts[1]).toMatchObject({
      remainingUnits: 1000,
      reservedUnits: 0,
    });
    expect(crossUserClient.usageCharges).toHaveLength(0);
    expect(crossUserClient.serviceEntitlementLedgerEntries).toHaveLength(0);
  });

  it("settles used units and releases unused units on both ledgers idempotently", async () => {
    const client = new FakeServiceCreditUsageClient();
    const reservation = await reserveConversationWalletUsage(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_1",
        representativeId: "rep_1",
        conversationId: "conversation_settle",
        generationRunId: "generation_run_settle",
        tokenAmount: 200,
        idempotencyKey: "dual_settle_reserve",
      },
      client,
    );
    const input = {
      usageChargeId: reservation.usageCharge.id,
      settledTokenAmount: 150,
      providerCostCents: 10,
      provider: "model-provider",
      idempotencyKey: "dual_settle",
    };

    const first = await settleConversationWalletUsage(input, client);
    const replay = await settleConversationWalletUsage(input, client);

    expect(replay.usageCharge.id).toBe(first.usageCharge.id);
    expect(first.usageCharge).toMatchObject({
      status: "settled",
      settledTokenAmount: 150,
      releasedTokenAmount: 50,
      availableTokenAmount: 850,
      walletReservedTokenAmount: 0,
    });
    expect(client.serviceEntitlementAccounts[0]).toMatchObject({
      remainingUnits: 850,
      reservedUnits: 0,
    });
    expect(
      client.serviceEntitlementLedgerEntries.map((entry) => [
        entry.kind,
        entry.units,
      ]),
    ).toEqual([
      ["RESERVE", 200],
      ["CONSUME", 150],
      ["RELEASE", 50],
    ]);
    await expect(
      verifyAgentUsageEntitlementReservation(
        {
          usageChargeId: reservation.usageCharge.id,
          representativeId: "rep_1",
          generationRunId: "generation_run_settle",
        },
        client,
      ),
    ).rejects.toThrow("requires RESERVED status");
  });

  it("releases failed reservations on both ledgers idempotently", async () => {
    const client = new FakeServiceCreditUsageClient();
    const reservation = await reserveConversationWalletUsage(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_1",
        representativeId: "rep_1",
        conversationId: "conversation_release",
        generationRunId: "generation_run_release",
        tokenAmount: 200,
        idempotencyKey: "dual_release_reserve",
      },
      client,
    );
    const input = {
      usageChargeId: reservation.usageCharge.id,
      failed: true,
      reason: "provider_timeout",
      idempotencyKey: "dual_release",
    };

    const first = await releaseConversationWalletUsage(input, client);
    const replay = await releaseConversationWalletUsage(input, client);

    expect(replay.usageCharge.id).toBe(first.usageCharge.id);
    expect(first.usageCharge).toMatchObject({
      status: "failed",
      availableTokenAmount: 1000,
      walletReservedTokenAmount: 0,
      releasedTokenAmount: 200,
    });
    expect(client.serviceEntitlementAccounts[0]).toMatchObject({
      remainingUnits: 1000,
      reservedUnits: 0,
    });
    expect(
      client.serviceEntitlementLedgerEntries.map((entry) => entry.kind),
    ).toEqual(["RESERVE", "RELEASE"]);
  });

  it("rolls back either ledger when reserve or settlement fails", async () => {
    const emptyWalletClient = new FakeServiceCreditUsageClient();
    emptyWalletClient.identities.push({
      id: "audience_without_wallet",
      status: "REGISTERED",
      mergedIntoId: null,
    });
    await expect(
      reserveConversationWalletUsage(
        {
          externalUserId: "user_without_wallet",
          audienceIdentityId: "audience_without_wallet",
          representativeId: "rep_1",
          conversationId: "conversation_empty_wallet",
          generationRunId: "generation_run_empty_wallet",
          tokenAmount: 1,
          idempotencyKey: "dual_empty_wallet",
        },
        emptyWalletClient,
      ),
    ).rejects.toBeInstanceOf(InsufficientAgentUsageCreditsError);
    expect(emptyWalletClient.serviceEntitlementLedgerEntries).toHaveLength(0);

    const missingEntitlementClient = new FakeServiceCreditUsageClient();
    missingEntitlementClient.serviceEntitlementAccounts =
      missingEntitlementClient.serviceEntitlementAccounts.filter(
        (account) => account.audienceIdentityId !== "audience_1",
      );
    await expect(
      reserveConversationWalletUsage(
        {
          externalUserId: "user_1",
          audienceIdentityId: "audience_1",
          representativeId: "rep_1",
          conversationId: "conversation_missing_entitlement",
          generationRunId: "generation_run_missing_entitlement",
          tokenAmount: 200,
          idempotencyKey: "dual_missing_entitlement",
        },
        missingEntitlementClient,
      ),
    ).rejects.toThrow(
      "User-agent wallet has service credits but its entitlement account is missing.",
    );
    expect(missingEntitlementClient.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
    });
    expect(missingEntitlementClient.usageCharges).toHaveLength(0);

    const reserveFailureClient = new FakeServiceCreditUsageClient();
    reserveFailureClient.failNextEntitlementLedger = true;
    await expect(
      reserveConversationWalletUsage(
        {
          externalUserId: "user_1",
          audienceIdentityId: "audience_1",
          representativeId: "rep_1",
          conversationId: "conversation_reserve_failure",
          generationRunId: "generation_run_reserve_failure",
          tokenAmount: 200,
          idempotencyKey: "dual_reserve_failure",
        },
        reserveFailureClient,
      ),
    ).rejects.toThrow("entitlement ledger write failed");
    expect(reserveFailureClient.serviceEntitlementAccounts[0]).toMatchObject({
      remainingUnits: 1000,
      reservedUnits: 0,
    });
    expect(reserveFailureClient.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
    });
    expect(reserveFailureClient.usageCharges).toHaveLength(0);

    const settlementFailureClient = new FakeServiceCreditUsageClient();
    const reservation = await reserveConversationWalletUsage(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_1",
        representativeId: "rep_1",
        conversationId: "conversation_settle_failure",
        generationRunId: "generation_run_settle_failure",
        tokenAmount: 200,
        idempotencyKey: "dual_settle_failure_reserve",
      },
      settlementFailureClient,
    );
    settlementFailureClient.failNextAllocation = true;
    await expect(
      settleConversationWalletUsage(
        {
          usageChargeId: reservation.usageCharge.id,
          settledTokenAmount: 100,
          idempotencyKey: "dual_settle_failure",
        },
        settlementFailureClient,
      ),
    ).rejects.toThrow("allocation write failed");
    expect(settlementFailureClient.serviceEntitlementAccounts[0]).toMatchObject({
      remainingUnits: 800,
      reservedUnits: 200,
    });
    expect(
      settlementFailureClient.serviceEntitlementLedgerEntries.map(
        (entry) => entry.kind,
      ),
    ).toEqual(["RESERVE"]);
    expect(settlementFailureClient.usageCharges[0]).toMatchObject({
      status: AgentUsageChargeStatus.RESERVED,
      settledTokenAmount: 0,
    });
  });

  it("fails verification closed on binding mismatch or a missing reserve fact", async () => {
    const client = new FakeServiceCreditUsageClient();
    const reservation = await reserveConversationWalletUsage(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_1",
        representativeId: "rep_1",
        conversationId: "conversation_verify",
        generationRunId: "generation_run_verify",
        tokenAmount: 200,
        idempotencyKey: "dual_verify_reserve",
      },
      client,
    );
    const verify = (
      overrides: Partial<{
        representativeId: string;
        generationRunId: string;
        audienceIdentityId: string;
        tokenAmount: number;
      }> = {},
    ) =>
      verifyAgentUsageEntitlementReservation(
        {
          usageChargeId: reservation.usageCharge.id,
          representativeId: "rep_1",
          generationRunId: "generation_run_verify",
          audienceIdentityId: "audience_1",
          tokenAmount: 200,
          ...overrides,
        },
        client,
      );

    await expect(
      verify({ generationRunId: "another_run" }),
    ).rejects.toThrow("Idempotency key was already used");
    await expect(
      verify({ audienceIdentityId: "another_audience" }),
    ).rejects.toThrow("Idempotency key was already used");
    await expect(verify({ tokenAmount: 201 })).rejects.toThrow(
      "Idempotency key was already used",
    );

    client.serviceEntitlementLedgerEntries = [];
    await expect(verify()).rejects.toThrow("missing its matching");
    await expect(
      settleConversationWalletUsage(
        {
          usageChargeId: reservation.usageCharge.id,
          settledTokenAmount: 100,
        },
        client,
      ),
    ).rejects.toThrow("missing its matching");
    expect(client.usageCharges[0]).toMatchObject({
      status: AgentUsageChargeStatus.RESERVED,
    });
  });

  it("transfers the current run owner without rewriting the reserve ledger", async () => {
    const client = new FakeServiceCreditUsageClient();
    const reservation = await reserveConversationWalletUsage(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_1",
        representativeId: "rep_1",
        conversationId: "conversation_transfer",
        generationRunId: "generation_run_step_1",
        tokenAmount: 200,
        idempotencyKey: "dual_transfer_reserve",
      },
      client,
    );
    const reserveFact = structuredClone(
      client.serviceEntitlementLedgerEntries[0],
    );
    const input = {
      usageChargeId: reservation.usageCharge.id,
      fromGenerationRunId: "generation_run_step_1",
      toGenerationRunId: "generation_run_step_2",
      conversationId: "conversation_transfer",
    };

    client.generationRuns.push({
      id: "generation_run_other_conversation",
      conversationId: "another_conversation",
    });
    await expect(
      transferAgentUsageEntitlementReservation(
        {
          ...input,
          toGenerationRunId: "generation_run_other_conversation",
        },
        client,
      ),
    ).rejects.toThrow("does not belong to the wallet usage conversation");
    expect(client.usageCharges[0]?.generationRunId).toBe(
      "generation_run_step_1",
    );

    const transferred =
      await transferAgentUsageEntitlementReservation(input, client);
    const replay =
      await transferAgentUsageEntitlementReservation(input, client);

    expect(transferred.generationRunId).toBe("generation_run_step_2");
    expect(replay.generationRunId).toBe("generation_run_step_2");
    expect(client.serviceEntitlementLedgerEntries).toEqual([reserveFact]);
    await expect(
      transferAgentUsageEntitlementReservation(
        {
          ...input,
          fromGenerationRunId: "wrong_replay_owner",
        },
        client,
      ),
    ).rejects.toThrow("no matching transfer audit");
    await expect(
      transferAgentUsageEntitlementReservation(
        {
          ...input,
          fromGenerationRunId: "generation_run_step_2",
        },
        client,
      ),
    ).rejects.toThrow("requires a different target owner");
    await expect(
      verifyAgentUsageEntitlementReservation(
        {
          usageChargeId: reservation.usageCharge.id,
          representativeId: "rep_1",
          generationRunId: "generation_run_step_2",
          tokenAmount: 200,
        },
        client,
      ),
    ).resolves.toMatchObject({
      generationRunId: "generation_run_step_2",
      reserveGenerationRunId: "generation_run_step_1",
    });
    await expect(
      transferAgentUsageEntitlementReservation(
        {
          ...input,
          fromGenerationRunId: "wrong_owner",
          toGenerationRunId: "generation_run_step_3",
        },
        client,
      ),
    ).rejects.toThrow("owned by a different generation run");
    await expect(
      transferAgentUsageEntitlementReservation(
        { ...input, conversationId: "another_conversation" },
        client,
      ),
    ).rejects.toThrow("does not belong to this conversation");
  });

  it("rejects cross-conversation run bindings and standalone terminal bypasses", async () => {
    const crossConversationClient = new FakeServiceCreditUsageClient();
    crossConversationClient.generationRuns.push({
      id: "generation_run_cross_conversation",
      conversationId: "another_conversation",
    });
    await expect(
      reserveConversationWalletUsage(
        {
          externalUserId: "user_1",
          audienceIdentityId: "audience_1",
          representativeId: "rep_1",
          conversationId: "conversation_expected",
          generationRunId: "generation_run_cross_conversation",
          tokenAmount: 200,
          idempotencyKey: "dual_cross_conversation",
        },
        crossConversationClient,
      ),
    ).rejects.toThrow("does not belong to the wallet usage conversation");
    expect(crossConversationClient.userAgentWallets[0]).toMatchObject({
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
    });
    expect(crossConversationClient.usageCharges).toHaveLength(0);
    expect(
      crossConversationClient.serviceEntitlementLedgerEntries,
    ).toHaveLength(0);

    const bypassClient = new FakeServiceCreditUsageClient();
    const reservation = await reserveConversationWalletUsage(
      {
        externalUserId: "user_1",
        audienceIdentityId: "audience_1",
        representativeId: "rep_1",
        conversationId: "conversation_1",
        generationRunId: "generation_run_1",
        tokenAmount: 200,
        idempotencyKey: "dual_bypass_reserve",
      },
      bypassClient,
    );
    await expect(
      settleAgentUsageCredits(
        {
          usageChargeId: reservation.usageCharge.id,
          settledTokenAmount: 100,
        },
        bypassClient,
      ),
    ).rejects.toThrow("must use the atomic conversation wallet lifecycle");
    await expect(
      releaseAgentUsageCredits(
        { usageChargeId: reservation.usageCharge.id },
        bypassClient,
      ),
    ).rejects.toThrow("must use the atomic conversation wallet lifecycle");
  });

  it("fails balance reads closed on reconciliation errors but permits empty legacy state", async () => {
    const mismatchClient = new FakeServiceCreditUsageClient();
    mismatchClient.serviceEntitlementAccounts[1]!.remainingUnits = 499;
    await expect(
      getUserAgentWalletBalance(
        {
          externalUserId: "user_2",
          representativeId: "rep_1",
        },
        mismatchClient,
      ),
    ).rejects.toBeInstanceOf(AgentWalletReconciliationError);

    const missingAccountClient = new FakeServiceCreditUsageClient();
    missingAccountClient.serviceEntitlementAccounts =
      missingAccountClient.serviceEntitlementAccounts.filter(
        (account) => account.audienceIdentityId !== "audience_2",
      );
    await expect(
      getUserAgentWalletBalance(
        {
          externalUserId: "user_2",
          representativeId: "rep_1",
        },
        missingAccountClient,
      ),
    ).rejects.toThrow("non-zero balance");

    const emptyLegacyClient = new FakeServiceCreditUsageClient();
    emptyLegacyClient.userAgentWallets[1]!.availableTokenAmount = 0;
    emptyLegacyClient.userAgentWallets[1]!.totalPurchasedTokenAmount = 0;
    emptyLegacyClient.serviceEntitlementAccounts =
      emptyLegacyClient.serviceEntitlementAccounts.filter(
        (account) => account.audienceIdentityId !== "audience_2",
      );
    await expect(
      getUserAgentWalletBalance(
        {
          externalUserId: "user_2",
          representativeId: "rep_1",
        },
        emptyLegacyClient,
      ),
    ).resolves.toMatchObject({
      availableTokenAmount: 0,
      reservedTokenAmount: 0,
    });

    const missingAudienceClient = new FakeServiceCreditUsageClient();
    missingAudienceClient.users[1]!.audienceIdentityId = null as unknown as string;
    await expect(
      getUserAgentWalletBalance(
        {
          externalUserId: "user_2",
          representativeId: "rep_1",
        },
        missingAudienceClient,
      ),
    ).rejects.toThrow("missing audienceIdentityId");
  });

  it("releases the exact sale-time creator share across rounding boundaries", async () => {
    const client = new FakeServiceCreditUsageClient();
    client.agentWallets[0]!.tokenBalance = 3;
    client.agentWallets[0]!.totalPurchasedTokens = 3;
    client.userAgentWallets[0]!.availableTokenAmount = 3;
    client.userAgentWallets[0]!.totalPurchasedTokenAmount = 3;
    client.tokenPurchases = [
      {
        ...client.tokenPurchases[0]!,
        id: "rounding_purchase",
        amountCents: 3,
        tokenAmount: 3,
        remainingTokenAmount: 3,
        creatorPendingCents: 1,
      },
    ];
    client.creatorEarnings = [
      {
        ...client.creatorEarnings[0]!,
        id: "rounding_pending",
        tokenPurchaseId: "rounding_purchase",
        pendingCents: 1,
      },
    ];

    const released: number[] = [];
    const platform: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const reservation = await reserveAgentUsageCredits(
        {
          externalUserId: "user_1",
          representativeId: "rep_1",
          tokenAmount: 1,
          idempotencyKey: `rounding_reserve_${index}`,
        },
        client,
      );
      const settlement = await settleAgentUsageCredits(
        {
          usageChargeId: reservation.id,
          settledTokenAmount: 1,
          idempotencyKey: `rounding_settle_${index}`,
        },
        client,
      );
      released.push(settlement.creatorWithdrawableCents);
      platform.push(settlement.platformRevenueCents);
    }

    expect(released).toEqual([0, 0, 1]);
    expect(released.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(platform.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(client.tokenPurchases[0]?.remainingTokenAmount).toBe(0);
  });
});

class FakeServiceCreditUsageClient {
  identities: Array<{
    id: string;
    status: "ANONYMOUS" | "REGISTERED" | "MERGED" | "DISABLED";
    mergedIntoId: string | null;
  }> = [
    {
      id: "audience_1",
      status: "REGISTERED",
      mergedIntoId: null,
    },
    {
      id: "audience_2",
      status: "REGISTERED",
      mergedIntoId: null,
    },
  ];
  users = [
    {
      id: "user_wallet_1",
      audienceIdentityId: "audience_1",
      externalUserId: "user_1",
      currency: "CNY",
    },
    {
      id: "user_wallet_2",
      audienceIdentityId: "audience_2",
      externalUserId: "user_2",
      currency: "CNY",
    },
  ];
  representatives = [{ id: "rep_1", ownerId: "owner_1" }];
  generationRuns = [
    ["generation_run_1", "conversation_1"],
    ["generation_run_settle", "conversation_settle"],
    ["generation_run_release", "conversation_release"],
    ["generation_run_empty_wallet", "conversation_empty_wallet"],
    [
      "generation_run_missing_entitlement",
      "conversation_missing_entitlement",
    ],
    ["generation_run_reserve_failure", "conversation_reserve_failure"],
    ["generation_run_settle_failure", "conversation_settle_failure"],
    ["generation_run_verify", "conversation_verify"],
    ["generation_run_step_1", "conversation_transfer"],
    ["generation_run_step_2", "conversation_transfer"],
  ].map(([id, conversationId]) => ({ id: id!, conversationId: conversationId! }));
  agentWallets = [
    {
      id: "agent_wallet_1",
      representativeId: "rep_1",
      currency: "CNY",
      tokenBalance: 1500,
      totalPurchasedTokens: 1500,
      totalConsumedTokens: 0,
      tokenUnitPriceCents: 1,
      creatorRevenueShareBps: 2000,
    },
  ];
  userAgentWallets = [
    {
      id: "user_agent_wallet_1",
      userWalletId: "user_wallet_1",
      agentWalletId: "agent_wallet_1",
      currency: "CNY",
      availableTokenAmount: 1000,
      reservedTokenAmount: 0,
      totalPurchasedTokenAmount: 1000,
      totalConsumedTokenAmount: 0,
    },
    {
      id: "user_agent_wallet_2",
      userWalletId: "user_wallet_2",
      agentWalletId: "agent_wallet_1",
      currency: "CNY",
      availableTokenAmount: 500,
      reservedTokenAmount: 0,
      totalPurchasedTokenAmount: 500,
      totalConsumedTokenAmount: 0,
    },
  ];
  tokenPurchases = [
    this.purchase("purchase_1", "user_wallet_1", "user_agent_wallet_1", 600, 0),
    this.purchase("purchase_2", "user_wallet_1", "user_agent_wallet_1", 400, 1),
    this.purchase("purchase_3", "user_wallet_2", "user_agent_wallet_2", 500, 2),
  ];
  usageCharges: any[] = [];
  usageAllocations: any[] = [];
  creatorEarnings: any[] = [
    this.pendingEarning("earning_1", "purchase_1", 120),
    this.pendingEarning("earning_2", "purchase_2", 80),
    this.pendingEarning("earning_3", "purchase_3", 100),
  ];
  ledgerEntries: any[] = [];
  walletTransactions: any[] = [];
  serviceEntitlementAccounts: any[] = [
    this.entitlementAccount(
      "entitlement_account_1",
      "audience_1",
      1000,
    ),
    this.entitlementAccount(
      "entitlement_account_2",
      "audience_2",
      500,
    ),
  ];
  serviceEntitlementLedgerEntries: any[] = [];
  failNextAllocation = false;
  failNextEntitlementLedger = false;

  audienceIdentity = {
    findUnique: async (args: any) =>
      this.identities.find((identity) => identity.id === args.where.id) ?? null,
  };

  userWallet = {
    findUnique: async (args: any) =>
      this.users.find(
        (user) =>
          user.id === args.where.id ||
          user.externalUserId === args.where.externalUserId,
      ) ?? null,
  };

  agentWallet = {
    findUnique: async (args: any) => {
      const wallet = this.agentWallets.find(
        (row) =>
          row.id === args.where.id ||
          row.representativeId === args.where.representativeId,
      );
      return wallet ? this.withAgentRelations(wallet) : null;
    },
    update: async (args: any) => {
      const wallet = this.agentWallets.find((row) => row.id === args.where.id);
      if (!wallet) throw new Error("agent wallet not found");
      applyDelta(wallet, "tokenBalance", args.data.tokenBalance);
      applyDelta(wallet, "totalConsumedTokens", args.data.totalConsumedTokens);
      return wallet;
    },
  };

  generationRun = {
    findUnique: async (args: any) =>
      this.generationRuns.find((run) => run.id === args.where.id) ?? null,
  };

  userAgentWallet = {
    findUnique: async (args: any) => {
      const compound = args.where.userWalletId_agentWalletId_currency;
      const wallet = this.userAgentWallets.find((row) =>
        typeof args.where.id === "string"
          ? row.id === args.where.id
          : row.userWalletId === compound?.userWalletId &&
            row.agentWalletId === compound?.agentWalletId &&
            row.currency === compound?.currency,
      );
      return wallet ? this.withScopedWalletRelations(wallet) : null;
    },
    update: async (args: any) => {
      const wallet = this.userAgentWallets.find((row) => row.id === args.where.id);
      if (!wallet) throw new Error("user-agent wallet not found");
      applyDelta(wallet, "availableTokenAmount", args.data.availableTokenAmount);
      applyDelta(wallet, "reservedTokenAmount", args.data.reservedTokenAmount);
      applyDelta(
        wallet,
        "totalConsumedTokenAmount",
        args.data.totalConsumedTokenAmount,
      );
      return wallet;
    },
  };

  agentTokenPurchase = {
    findUnique: async (args: any) => {
      const purchase = this.tokenPurchases.find((row) => row.id === args.where.id);
      return purchase ? this.withPurchaseRelations(purchase) : null;
    },
    findMany: async (args: any) =>
      this.tokenPurchases
        .filter(
          (row) =>
            row.userAgentWalletId === args.where.userAgentWalletId &&
            row.status === args.where.status &&
            (row.remainingTokenAmount ?? 0) > args.where.remainingTokenAmount.gt,
        )
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        )
        .map((row) => ({ ...row })),
    update: async (args: any) => {
      const purchase = this.tokenPurchases.find((row) => row.id === args.where.id);
      if (!purchase) throw new Error("purchase not found");
      applyDelta(
        purchase,
        "remainingTokenAmount",
        args.data.remainingTokenAmount,
      );
      return purchase;
    },
  };

  agentUsageCharge = {
    findUnique: async (args: any) => {
      const row = this.usageCharges.find(
        (usage) =>
          usage.id === args.where.id ||
          usage.idempotencyKey === args.where.idempotencyKey,
      );
      return row ? this.withUsageRelations(row) : null;
    },
    create: async (args: any) => {
      const row = {
        id: `usage_${this.usageCharges.length + 1}`,
        userAgentWalletId: args.data.userAgentWalletId ?? null,
        agentWalletId: args.data.agentWalletId,
        representativeId: args.data.representativeId,
        audienceIdentityId: args.data.audienceIdentityId ?? null,
        entitlementAccountId: args.data.entitlementAccountId ?? null,
        conversationId: args.data.conversationId ?? null,
        generationRunId: args.data.generationRunId ?? null,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        kind: args.data.kind as AgentUsageChargeKind,
        status: args.data.status as AgentUsageChargeStatus,
        quantity: args.data.quantity,
        tokenAmount: args.data.tokenAmount,
        reservedTokenAmount: args.data.reservedTokenAmount ?? 0,
        settledTokenAmount: args.data.settledTokenAmount ?? 0,
        releasedTokenAmount: args.data.releasedTokenAmount ?? 0,
        providerCostCents: args.data.providerCostCents ?? 0,
        platformRevenueCents: args.data.platformRevenueCents ?? 0,
        currency: args.data.currency,
        idempotencyKey: args.data.idempotencyKey,
        reservedAt: args.data.reservedAt ?? null,
        settledAt: args.data.settledAt ?? null,
        releasedAt: args.data.releasedAt ?? null,
      };
      this.usageCharges.push(row);
      return row;
    },
    update: async (args: any) => {
      const row = this.usageCharges.find((usage) => usage.id === args.where.id);
      if (!row) throw new Error("usage not found");
      Object.assign(row, args.data);
      return row;
    },
    updateMany: async (args: any) => {
      const row = this.usageCharges.find(
        (usage) =>
          usage.id === args.where.id &&
          usage.status === args.where.status &&
          usage.generationRunId === args.where.generationRunId &&
          usage.conversationId === args.where.conversationId,
      );
      if (!row) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
  };

  serviceEntitlementAccount = {
    findUnique: async (args: any) => {
      const coordinates =
        args.where.audienceIdentityId_representativeId_productCode;
      return this.serviceEntitlementAccounts.find((account) =>
        typeof args.where.id === "string"
          ? account.id === args.where.id
          : account.audienceIdentityId === coordinates?.audienceIdentityId &&
            account.representativeId === coordinates?.representativeId &&
            account.productCode === coordinates?.productCode,
      ) ?? null;
    },
    updateMany: async (args: any) => {
      const account = this.serviceEntitlementAccounts.find(
        (row) => row.id === args.where.id,
      );
      if (
        !account ||
        (args.where.status && account.status !== args.where.status) ||
        (args.where.remainingUnits?.gte !== undefined &&
          account.remainingUnits < args.where.remainingUnits.gte) ||
        (args.where.reservedUnits?.gte !== undefined &&
          account.reservedUnits < args.where.reservedUnits.gte)
      ) {
        return { count: 0 };
      }
      applyDelta(account, "remainingUnits", args.data.remainingUnits);
      applyDelta(account, "reservedUnits", args.data.reservedUnits);
      return { count: 1 };
    },
    update: async (args: any) => {
      const account = this.serviceEntitlementAccounts.find(
        (row) => row.id === args.where.id,
      );
      if (!account) throw new Error("entitlement account not found");
      Object.assign(account, args.data);
      return account;
    },
  };

  serviceEntitlementLedgerEntry = {
    findUnique: async (args: any) =>
      this.serviceEntitlementLedgerEntries.find(
        (entry) => entry.idempotencyKey === args.where.idempotencyKey,
      ) ?? null,
    findMany: async (args: any) =>
      this.serviceEntitlementLedgerEntries.filter((entry) => {
        const where = args.where ?? {};
        if (
          where.idempotencyKey?.in &&
          !where.idempotencyKey.in.includes(entry.idempotencyKey)
        ) {
          return false;
        }
        if (
          where.entitlementAccountId &&
          entry.entitlementAccountId !== where.entitlementAccountId
        ) {
          return false;
        }
        if (
          where.generationRunId &&
          entry.generationRunId !== where.generationRunId
        ) {
          return false;
        }
        if (where.kind?.in && !where.kind.in.includes(entry.kind)) {
          return false;
        }
        return true;
      }),
    create: async (args: any) => {
      if (this.failNextEntitlementLedger) {
        this.failNextEntitlementLedger = false;
        throw new Error("entitlement ledger write failed");
      }
      const row = {
        id: `service_entitlement_ledger_${
          this.serviceEntitlementLedgerEntries.length + 1
        }`,
        entitlementAccountId: args.data.entitlementAccountId,
        paymentOrderId: args.data.paymentOrderId ?? null,
        generationRunId: args.data.generationRunId ?? null,
        kind: args.data.kind,
        units: args.data.units,
        balanceAfter: args.data.balanceAfter,
        reservedAfter: args.data.reservedAfter ?? 0,
        idempotencyKey: args.data.idempotencyKey,
        notes: args.data.notes ?? null,
        metadata: args.data.metadata ?? null,
        createdAt: new Date(),
      };
      this.serviceEntitlementLedgerEntries.push(row);
      return row;
    },
  };

  agentUsageAllocation = {
    create: async (args: any) => {
      if (this.failNextAllocation) {
        this.failNextAllocation = false;
        throw new Error("allocation write failed");
      }
      const row = {
        id: `allocation_${this.usageAllocations.length + 1}`,
        usageChargeId: args.data.usageChargeId,
        tokenPurchaseId: args.data.tokenPurchaseId,
        creatorEarningId: args.data.creatorEarningId ?? null,
        tokenAmount: args.data.tokenAmount,
        valueCents: args.data.valueCents,
        creatorReleaseCents: args.data.creatorReleaseCents,
        currency: args.data.currency,
        releasedAt: args.data.releasedAt ?? null,
        reversedAt: null,
      };
      this.usageAllocations.push(row);
      return row;
    },
    findMany: async (args: any) =>
      this.usageAllocations.filter(
        (row) => row.usageChargeId === args.where.usageChargeId,
      ),
  };

  creatorEarning = {
    findFirst: async (args: any) =>
      this.creatorEarnings.find(
        (earning) =>
          earning.tokenPurchaseId === args.where.tokenPurchaseId &&
          earning.status === args.where.status &&
          earning.pendingCents > args.where.pendingCents.gt,
      ) ?? null,
    update: async (args: any) => {
      const earning = this.creatorEarnings.find((row) => row.id === args.where.id);
      if (!earning) throw new Error("earning not found");
      applyDelta(earning, "pendingCents", args.data.pendingCents);
      if (args.data.status) earning.status = args.data.status;
      return earning;
    },
    create: async (args: any) => {
      const earning = {
        id: `earning_${this.creatorEarnings.length + 1}`,
        ownerId: args.data.ownerId,
        representativeId: args.data.representativeId,
        agentWalletId: args.data.agentWalletId,
        tokenPurchaseId: args.data.tokenPurchaseId ?? null,
        usageChargeId: args.data.usageChargeId ?? null,
        status: args.data.status as CreatorEarningStatus,
        pendingCents: args.data.pendingCents ?? 0,
        withdrawableCents: args.data.withdrawableCents ?? 0,
        frozenCents: 0,
        withdrawnCents: 0,
        currency: args.data.currency,
        revenueShareBps: args.data.revenueShareBps,
        idempotencyKey: args.data.idempotencyKey,
      };
      this.creatorEarnings.push(earning);
      return earning;
    },
  };

  walletTransaction = {
    findUnique: async (args: any) =>
      this.walletTransactions.find(
        (row) => row.idempotencyKey === args.where.idempotencyKey,
      ) ?? null,
    create: async (args: any) => {
      const row = {
        id: `wallet_transaction_${this.walletTransactions.length + 1}`,
        eventGroupId: args.data.eventGroupId,
        idempotencyKey: args.data.idempotencyKey,
        sourceType: args.data.sourceType,
        sourceId: args.data.sourceId ?? null,
        eventType: args.data.eventType,
        status: args.data.status ?? WalletTransactionStatus.SUCCEEDED,
        currency: args.data.currency,
        ownerId: args.data.ownerId ?? null,
        representativeId: args.data.representativeId ?? null,
        userWalletId: args.data.userWalletId ?? null,
        metadata: args.data.metadata ?? null,
      };
      this.walletTransactions.push(row);
      return row;
    },
  };

  walletLedgerEntry = {
    findFirst: async (args: any) =>
      this.ledgerEntries.find(
        (entry) =>
          entry.eventGroupId === args.where.eventGroupId &&
          entry.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith),
      ) ?? null,
    findMany: async (args: any) =>
      this.ledgerEntries.filter(
        (entry) => entry.eventGroupId === args.where.eventGroupId,
      ),
    create: async (args: {
      data: Prisma.WalletLedgerEntryUncheckedCreateInput;
    }) => {
      const row = {
        id: `ledger_${this.ledgerEntries.length + 1}`,
        ...args.data,
        amountCents: args.data.amountCents ?? 0,
        tokenAmount: args.data.tokenAmount ?? 0,
        currency: args.data.currency ?? "CNY",
        transactionId: args.data.transactionId ?? null,
        createdAt: new Date(),
      };
      this.ledgerEntries.push(row);
      return row;
    },
  };

  async $transaction<T>(
    fn: (tx: FakeServiceCreditUsageClient) => Promise<T>,
  ): Promise<T> {
    const snapshot = structuredClone({
      users: this.users,
      agentWallets: this.agentWallets,
      userAgentWallets: this.userAgentWallets,
      tokenPurchases: this.tokenPurchases,
      usageCharges: this.usageCharges,
      usageAllocations: this.usageAllocations,
      creatorEarnings: this.creatorEarnings,
      ledgerEntries: this.ledgerEntries,
      walletTransactions: this.walletTransactions,
      serviceEntitlementAccounts: this.serviceEntitlementAccounts,
      serviceEntitlementLedgerEntries: this.serviceEntitlementLedgerEntries,
    });
    try {
      return await fn(this);
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  private purchase(
    id: string,
    userWalletId: string,
    userAgentWalletId: string,
    tokenAmount: number,
    seconds: number,
  ) {
    return {
      id,
      userWalletId,
      userAgentWalletId,
      agentWalletId: "agent_wallet_1",
      representativeId: "rep_1",
      amountCents: tokenAmount,
      currency: "CNY",
      tokenAmount,
      remainingTokenAmount: tokenAmount as number | null,
      tokenUnitPriceCents: 1,
      creatorRevenueShareBps: 2000,
      creatorPendingCents: tokenAmount / 5,
      status: AgentTokenPurchaseStatus.COMPLETED,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
    };
  }

  private entitlementAccount(
    id: string,
    audienceIdentityId: string,
    units: number,
  ) {
    return {
      id,
      audienceIdentityId,
      representativeId: "rep_1",
      productCode: AGENT_WALLET_SERVICE_CREDIT_PRODUCT_CODE,
      unitName: "credit",
      status: "ACTIVE",
      grantedUnits: units,
      remainingUnits: units,
      reservedUnits: 0,
      expiresAt: null as Date | null,
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      updatedAt: new Date(Date.UTC(2026, 0, 1)),
    };
  }

  private pendingEarning(
    id: string,
    tokenPurchaseId: string,
    pendingCents: number,
  ) {
    return {
      id,
      ownerId: "owner_1",
      representativeId: "rep_1",
      agentWalletId: "agent_wallet_1",
      tokenPurchaseId,
      usageChargeId: null as string | null,
      status: CreatorEarningStatus.PENDING,
      pendingCents,
      withdrawableCents: 0,
      frozenCents: 0,
      withdrawnCents: 0,
      currency: "CNY",
      revenueShareBps: 2000,
      idempotencyKey: `pending:${tokenPurchaseId}`,
    };
  }

  private withAgentRelations(wallet: any) {
    return {
      ...wallet,
      representative: this.representatives.find(
        (row) => row.id === wallet.representativeId,
      ),
    };
  }

  private withScopedWalletRelations(wallet: any) {
    const agentWallet = this.agentWallets.find(
      (row) => row.id === wallet.agentWalletId,
    );
    return {
      ...wallet,
      userWallet: this.users.find((row) => row.id === wallet.userWalletId),
      agentWallet: agentWallet
        ? this.withAgentRelations(agentWallet)
        : undefined,
    };
  }

  private withPurchaseRelations(purchase: any) {
    const scopedWallet = this.userAgentWallets.find(
      (row) => row.id === purchase.userAgentWalletId,
    );
    return {
      ...purchase,
      userAgentWallet: scopedWallet
        ? this.withScopedWalletRelations(scopedWallet)
        : undefined,
    };
  }

  private withUsageRelations(usage: any) {
    const scopedWallet = this.userAgentWallets.find(
      (row) => row.id === usage.userAgentWalletId,
    );
    const agentWallet = this.agentWallets.find(
      (row) => row.id === usage.agentWalletId,
    );
    return {
      ...usage,
      userAgentWallet: scopedWallet
        ? this.withScopedWalletRelations(scopedWallet)
        : undefined,
      agentWallet: agentWallet
        ? this.withAgentRelations(agentWallet)
        : undefined,
      creatorEarnings: this.creatorEarnings.filter(
        (earning) => earning.usageChargeId === usage.id,
      ),
      allocations: this.usageAllocations.filter(
        (allocation) => allocation.usageChargeId === usage.id,
      ),
    };
  }
}

function applyDelta<T extends Record<K, number | null>, K extends keyof T>(
  row: T,
  key: K,
  value: { increment?: number; decrement?: number } | number | undefined,
) {
  if (typeof value === "number") {
    row[key] = value as T[K];
  } else if (value) {
    const current = row[key] ?? 0;
    row[key] = (
      current +
      (value.increment ?? 0) -
      (value.decrement ?? 0)
    ) as T[K];
  }
}

function sumLedgerAmount(entries: Array<{ amountCents: number }>): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
