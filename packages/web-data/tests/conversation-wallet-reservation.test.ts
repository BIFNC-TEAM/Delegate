import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    conversation: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationEpisode: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    generationRun: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    memoryUseRun: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    message: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    messageRevision: {
      create: vi.fn(),
    },
    messageDeliveryAttempt: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    planExecutionFence: {
      findUnique: vi.fn(),
    },
    outboxEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    approvalRequest: {
      updateMany: vi.fn(),
    },
    eventAudit: {
      upsert: vi.fn(),
    },
    serviceEntitlementLedgerEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    serviceEntitlementAccount: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    agentWallet: {
      findUnique: vi.fn(),
    },
    userAgentWallet: {
      findMany: vi.fn(),
    },
    audienceIdentity: {
      findUnique: vi.fn(),
    },
  };
  return {
    tx,
    reserveConversationWalletUsage: vi.fn(),
    settleConversationWalletUsage: vi.fn(),
    releaseConversationWalletUsage: vi.fn(),
    transferAgentUsageEntitlementReservation: vi.fn(),
    prisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => unknown) => callback(tx),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../src/agent-wallet-usage-charge", () => ({
  InsufficientAgentUsageCreditsError: class InsufficientAgentUsageCreditsError
    extends Error {},
  reserveConversationWalletUsage: mocks.reserveConversationWalletUsage,
  settleConversationWalletUsage: mocks.settleConversationWalletUsage,
  releaseConversationWalletUsage: mocks.releaseConversationWalletUsage,
  transferAgentUsageEntitlementReservation:
    mocks.transferAgentUsageEntitlementReservation,
}));

import {
  acceptInboundConversationMessage,
  authorizeGenerationRunFreeUsage,
  completeInlineGenerationRun,
  deferGenerationRunForHuman,
  editConversationMessage,
  failGenerationRun,
  markGenerationDeliveryComplete,
  redactConversationMessage,
  reserveGenerationConversationWalletUsage,
  ServiceCreditRequiredError,
} from "../src/conversation-platform";
import { InsufficientAgentUsageCreditsError } from "../src/agent-wallet-usage-charge";

const reservedRun = {
  id: "run-paid",
  status: "QUEUED",
  outputMessage: null,
  outputMessageId: null,
  conversationId: "conversation-1",
  episodeId: "episode-1",
  inputMessageId: "message-in",
  delegationTaskId: null,
  delegationTaskStep: null,
  startedAt: null,
  conversation: {
    id: "conversation-1",
    state: "PROCESSING",
    audienceIdentityId: "audience-1",
    representativeId: "representative-1",
  },
  runtimePolicySnapshot: {
    walletReservation: {
      usageChargeId: "usage-reserved",
      tokenAmount: 1,
    },
  },
};

const availableRepresentative = {
  id: "representative-1",
  accessMode: "TRIAL_THEN_CREDITS",
  freeReplyLimit: 3,
  activeVersionId: "version-1",
  lifecycleState: "PUBLISHED",
  publicMode: true,
  runtimePolicyOverlays: [],
};

const connectedWebChannelBindings = [{
  id: "web-binding-1",
  kind: "WEB",
  representativeBinding: {
    status: "CONNECTED",
    desiredState: "ACTIVE",
    healthStatus: "HEALTHY",
  },
}];

const activeServiceEntitlementReservation = {
  audienceIdentityId: "audience-1",
  representativeId: "representative-1",
  productCode: "plan:pass",
  generationRunId: reservedRun.id,
  operationKey: `generation:${reservedRun.id}:attempt:1`,
  accountId: "entitlement-account-1",
  attempt: 1,
};

describe("generation wallet reservation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (client: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
    );
    mocks.tx.generationRun.findUnique.mockResolvedValue(reservedRun);
    mocks.tx.generationRun.count.mockResolvedValue(0);
    mocks.tx.generationRun.upsert.mockResolvedValue({ id: "run-new" });
    mocks.tx.generationRun.create.mockResolvedValue({ id: "run-replacement" });
    mocks.tx.generationRun.update.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => ({
        ...reservedRun,
        id: where.id,
        ...data,
      }),
    );
    mocks.tx.generationRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.message.create.mockResolvedValue({ id: "message-out" });
    mocks.tx.message.upsert.mockResolvedValue({ id: "message-in" });
    mocks.tx.message.update.mockResolvedValue({ id: "message-in" });
    mocks.tx.message.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.message.findUnique.mockResolvedValue({
      conversationId: "conversation-1",
    });
    mocks.tx.messageDeliveryAttempt.upsert.mockResolvedValue({ id: "attempt-1" });
    mocks.tx.messageDeliveryAttempt.findUnique.mockResolvedValue({
      status: "PROCESSING",
      attemptPhase: "RESPONSE_RECEIVED",
      leaseToken: "delivery-lease-1",
      deliveryOutboxId: "outbox-paid-delivery",
      deliveryLeaseAttempt: 1,
      planId: null,
      planRevision: null,
      executionEpoch: null,
      planActionId: null,
      plan: null,
    });
    mocks.tx.messageDeliveryAttempt.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.messageRevision.create.mockResolvedValue({
      id: "revision-1",
      version: 1,
    });
    mocks.tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
    mocks.tx.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.conversationEpisode.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.outboxEvent.create.mockResolvedValue({ id: "outbox-replacement" });
    mocks.tx.outboxEvent.upsert.mockResolvedValue({ id: "outbox-new" });
    mocks.tx.outboxEvent.findMany.mockResolvedValue([]);
    mocks.tx.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([]);
    mocks.tx.serviceEntitlementLedgerEntry.findUnique.mockResolvedValue(null);
    mocks.tx.serviceEntitlementLedgerEntry.create.mockResolvedValue({
      id: "entitlement-ledger-1",
    });
    mocks.tx.serviceEntitlementAccount.findUnique.mockResolvedValue(null);
    mocks.tx.serviceEntitlementAccount.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.agentWallet.findUnique.mockResolvedValue(null);
    mocks.tx.userAgentWallet.findMany.mockResolvedValue([]);
    mocks.tx.audienceIdentity.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        status: "VERIFIED",
        mergedIntoId: null,
      }),
    );
    mocks.reserveConversationWalletUsage.mockResolvedValue({
      usageCharge: {
        id: "usage-reserved",
        reservedTokenAmount: 1,
      },
      entitlement: {
        consumed: null,
        released: null,
        current: { accountId: "wallet-entitlement-account-1" },
      },
    });
    mocks.settleConversationWalletUsage.mockResolvedValue({
      usageCharge: { id: "usage-reserved", status: "settled" },
      entitlement: {
        consumed: { accountId: "wallet-entitlement-account-1" },
        released: null,
        current: { accountId: "wallet-entitlement-account-1" },
      },
    });
    mocks.releaseConversationWalletUsage.mockResolvedValue({
      usageCharge: { id: "usage-reserved", status: "released" },
      entitlement: {
        consumed: null,
        released: { accountId: "wallet-entitlement-account-1" },
        current: { accountId: "wallet-entitlement-account-1" },
      },
    });
    mocks.transferAgentUsageEntitlementReservation.mockResolvedValue({
      id: "usage-reserved",
      status: "reserved",
      generationRunId: "run-replacement",
    });
  });

  it("settles a paid reservation atomically with generation completion", async () => {
    await completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "Paid answer",
      senderDisplayName: "Representative",
      countUsage: true,
      provider: "openai",
      costCents: 2,
    });

    expect(mocks.settleConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-paid",
        settledTokenAmount: 1,
        providerCostCents: 2,
        provider: "openai",
        idempotencyKey: "generation:run-paid:settle",
      },
      mocks.tx,
    );
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: { state: "WAITING_USER" },
    });
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { lastMessageAt: expect.any(Date) },
    });
  });

  it("merges a sanitized fallback outcome into the existing context snapshot", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      contextSnapshot: {
        source: "public_web_conversation",
        request: {
          safeField: "preserved",
        },
      },
    });

    await completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "Deterministic fallback answer",
      senderDisplayName: "Representative",
      countUsage: false,
      runtimeOutcome: {
        mode: "fallback",
        fallbackStrategy: "deterministic_preview",
        modelRuntimeState: "missing_credentials",
        fallbackReason: "model_unavailable",
      },
    });

    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: reservedRun.id },
      data: expect.objectContaining({
        status: "COMPLETED",
        errorCode: null,
        errorMessage: null,
        contextSnapshot: {
          source: "public_web_conversation",
          request: {
            safeField: "preserved",
          },
          runtimeOutcome: {
            version: 1,
            mode: "fallback",
            fallbackStrategy: "deterministic_preview",
            modelRuntimeState: "missing_credentials",
            fallbackReason: "model_unavailable",
          },
        },
      }),
    });
  });

  it("claims a free slot under the generation lease and refuses an over-limit concurrent run", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      id: "run-free",
      conversationId: "conversation-1",
      runtimePolicySnapshot: null,
      conversation: { freeRepliesUsed: 2 },
    });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.generationRun.count.mockResolvedValueOnce(0);

    await expect(
      authorizeGenerationRunFreeUsage({
        runId: "run-free",
        outboxId: "outbox-free",
        leaseAttempt: 1,
        freeReplyLimit: 3,
      }),
    ).resolves.toBe(true);
    expect(mocks.tx.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      "conversation-1",
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-free" },
      data: {
        runtimePolicySnapshot: {
          billingMode: "free",
        },
      },
    });

    mocks.tx.generationRun.update.mockClear();
    mocks.tx.generationRun.count.mockResolvedValueOnce(1);
    await expect(
      authorizeGenerationRunFreeUsage({
        runId: "run-free",
        outboxId: "outbox-free",
        leaseAttempt: 1,
        freeReplyLimit: 3,
      }),
    ).resolves.toBe(false);
    expect(mocks.tx.generationRun.update).not.toHaveBeenCalled();
  });

  it("skips an earlier empty identity wallet, reserves the funded scoped wallet, and replays once", async () => {
    let runtimePolicySnapshot: Record<string, unknown> = {
      accessMode: "CREDITS_ONLY",
      effectiveFreeReplyLimit: 0,
    };
    mocks.tx.generationRun.findUnique.mockImplementation(async () => ({
      ...reservedRun,
      conversation: {
        ...reservedRun.conversation,
        audienceIdentityId: "audience-alias",
      },
      runtimePolicySnapshot,
    }));
    mocks.tx.audienceIdentity.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "audience-alias"
          ? {
              id: "audience-alias",
              status: "MERGED",
              mergedIntoId: "audience-1",
            }
          : {
              id: where.id,
              status: "VERIFIED",
              mergedIntoId: null,
            },
    );
    mocks.tx.generationRun.update.mockImplementation(async ({ data }) => {
      if (data.runtimePolicySnapshot) {
        runtimePolicySnapshot = data.runtimePolicySnapshot as Record<string, unknown>;
      }
      return { ...reservedRun, ...data };
    });
    mocks.tx.agentWallet.findUnique.mockResolvedValue({
      id: "agent-wallet-1",
      currency: "CNY",
    });
    // The canonical identity's first UserWallet has no usable scoped wallet;
    // the relation-filtered query returns only the second funded wallet.
    mocks.tx.userAgentWallet.findMany.mockResolvedValue([{
      id: "user-agent-wallet-second-funded",
    }]);

    const input = {
      runId: reservedRun.id,
      outboxId: "outbox-private-channel-paid",
      leaseAttempt: 1,
      audienceIdentityId: "audience-alias",
      representativeId: "representative-1",
      tokenAmount: 1,
    };
    const first = await reserveGenerationConversationWalletUsage(input);
    const replay = await reserveGenerationConversationWalletUsage(input);

    expect(first).toEqual({
      usageChargeId: "usage-reserved",
      tokenAmount: 1,
    });
    expect(replay).toEqual(first);
    expect(mocks.reserveConversationWalletUsage).toHaveBeenCalledTimes(1);
    expect(mocks.reserveConversationWalletUsage).toHaveBeenCalledWith(
      {
        userAgentWalletId: "user-agent-wallet-second-funded",
        audienceIdentityId: "audience-1",
        representativeId: "representative-1",
        conversationId: "conversation-1",
        generationRunId: "run-paid",
        tokenAmount: 1,
        currency: "CNY",
        idempotencyKey: "generation:run-paid:wallet-reserve",
      },
      mocks.tx,
    );
    expect(mocks.tx.userAgentWallet.findMany).toHaveBeenCalledWith({
      where: {
        agentWalletId: "agent-wallet-1",
        currency: "CNY",
        availableTokenAmount: { gte: 1 },
        userWallet: {
          audienceIdentityId: "audience-1",
          currency: "CNY",
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(mocks.tx.generationRun.update).toHaveBeenCalledTimes(1);
    expect(runtimePolicySnapshot).toEqual({
      accessMode: "CREDITS_ONLY",
      effectiveFreeReplyLimit: 0,
      billingMode: "service_credit",
      walletReservation: {
        usageChargeId: "usage-reserved",
        tokenAmount: 1,
      },
    });
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenCalledTimes(2);
  });

  it("returns no worker wallet reservation when the canonical audience has no balance", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      runtimePolicySnapshot: {
        accessMode: "CREDITS_ONLY",
        effectiveFreeReplyLimit: 0,
      },
    });
    mocks.tx.agentWallet.findUnique.mockResolvedValue({
      id: "agent-wallet-1",
      currency: "CNY",
    });
    mocks.tx.userAgentWallet.findMany.mockResolvedValue([]);

    await expect(reserveGenerationConversationWalletUsage({
      runId: reservedRun.id,
      outboxId: "outbox-private-channel-empty",
      leaseAttempt: 1,
      audienceIdentityId: "audience-1",
      representativeId: "representative-1",
    })).resolves.toBeNull();

    expect(mocks.tx.generationRun.update).not.toHaveBeenCalled();
    expect(mocks.reserveConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("tries the next canonical wallet when a selected candidate is concurrently exhausted", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      runtimePolicySnapshot: {
        accessMode: "CREDITS_ONLY",
        effectiveFreeReplyLimit: 0,
      },
    });
    mocks.tx.agentWallet.findUnique.mockResolvedValue({
      id: "agent-wallet-1",
      currency: "CNY",
    });
    mocks.tx.userAgentWallet.findMany.mockResolvedValue([
      { id: "user-agent-wallet-depleted" },
      { id: "user-agent-wallet-still-funded" },
    ]);
    mocks.reserveConversationWalletUsage
      .mockRejectedValueOnce(new InsufficientAgentUsageCreditsError())
      .mockResolvedValueOnce({
        usageCharge: {
          id: "usage-second-candidate",
          reservedTokenAmount: 1,
        },
        entitlement: {
          consumed: null,
          released: null,
          current: { accountId: "wallet-entitlement-account-1" },
        },
      });

    await expect(reserveGenerationConversationWalletUsage({
      runId: reservedRun.id,
      outboxId: "outbox-private-channel-race",
      leaseAttempt: 1,
      audienceIdentityId: "audience-1",
      representativeId: "representative-1",
    })).resolves.toEqual({
      usageChargeId: "usage-second-candidate",
      tokenAmount: 1,
    });

    expect(mocks.reserveConversationWalletUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userAgentWalletId: "user-agent-wallet-depleted",
        audienceIdentityId: "audience-1",
      }),
      mocks.tx,
    );
    expect(mocks.reserveConversationWalletUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userAgentWalletId: "user-agent-wallet-still-funded",
        audienceIdentityId: "audience-1",
      }),
      mocks.tx,
    );
  });

  it("does not resolve or reserve a private-channel wallet after the run lease is lost", async () => {
    mocks.tx.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(reserveGenerationConversationWalletUsage({
      runId: reservedRun.id,
      outboxId: "outbox-stale-private-channel",
      leaseAttempt: 2,
      audienceIdentityId: "audience-1",
      representativeId: "representative-1",
    })).rejects.toMatchObject({
      code: "generation_work_lease_lost",
    });

    expect(mocks.tx.generationRun.findUnique).not.toHaveBeenCalled();
    expect(mocks.reserveConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("transfers a paid reservation when editing replaces an active run", async () => {
    const paidRun = {
      ...reservedRun,
      status: "PROCESSING",
      runtimePolicySnapshot: {
        billingMode: "service_credit",
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      },
    };
    mocks.tx.message.findFirst.mockResolvedValue({
      id: "message-in",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      redactedAt: null,
      revisions: [],
      conversation: { state: "PROCESSING" },
      inputForGenerationRuns: [paidRun],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(paidRun);
    mocks.tx.generationRun.create.mockResolvedValue({
      id: "run-replacement",
    });

    await expect(
      editConversationMessage({
        representativeSlug: "representative",
        conversationId: "conversation-1",
        messageId: "message-in",
        text: "edited paid request",
        editedBy: "audience-1",
      }),
    ).resolves.toMatchObject({ action: "cancel_and_requeue" });

    expect(
      mocks.transferAgentUsageEntitlementReservation,
    ).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        fromGenerationRunId: "run-paid",
        toGenerationRunId: "run-replacement",
        conversationId: "conversation-1",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: "run-paid", status: { in: ["PROCESSING"] } },
      data: {
        status: "CANCELED",
        canceledAt: expect.any(Date),
        runtimePolicySnapshot: {
          billingMode: "service_credit_transferred",
          billingTransferredToGenerationRunId: "run-replacement",
          walletReservationTransferredTo: "run-replacement",
        },
      },
    });
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ aggregateId: "run-paid" }),
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    );
    expect(mocks.tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: "run-replacement",
        idempotencyKey: "generation.requested:run-replacement",
      }),
    });
  });

  it("releases a paid reservation when redaction cancels its run", async () => {
    mocks.tx.message.findFirst.mockResolvedValue({
      id: "message-in",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-paid" }],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      id: "run-paid",
      status: "QUEUED",
      runtimePolicySnapshot: {
        billingMode: "service_credit",
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      },
    });

    await redactConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      messageId: "message-in",
      reason: "audience request",
    });

    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-paid",
        reason: "input_message_redacted",
        idempotencyKey:
          "message:message-in:redaction:usage-reserved:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-paid" }),
        data: expect.objectContaining({ status: "CANCELED" }),
      }),
    );
  });

  it("cancels and releases a failed paid run only while its outbox remains active", async () => {
    mocks.tx.message.findFirst.mockResolvedValue({
      id: "message-in",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-paid" }],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      id: "run-paid",
      status: "FAILED",
      runtimePolicySnapshot: {
        billingMode: "service_credit",
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      },
    });
    mocks.tx.outboxEvent.findFirst.mockResolvedValueOnce({
      id: "outbox-retryable",
    });

    await redactConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      messageId: "message-in",
    });

    expect(mocks.tx.outboxEvent.findFirst).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: "run-paid",
        eventType: "generation.requested",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      select: {
        id: true,
        status: true,
        availableAt: true,
        attemptCount: true,
      },
    });
    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledTimes(1);
    expect(mocks.tx.generationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "run-paid",
          status: {
            in: ["FAILED"],
          },
        },
      }),
    );

    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (client: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
    );
    mocks.tx.message.findFirst.mockResolvedValue({
      id: "message-in",
      conversationId: "conversation-1",
      episodeId: null,
      inputForGenerationRuns: [{ id: "run-paid" }],
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      id: "run-paid",
      status: "FAILED",
      runtimePolicySnapshot: {
        billingMode: "service_credit",
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      },
    });
    mocks.tx.outboxEvent.findFirst.mockResolvedValue(null);
    mocks.tx.message.update.mockResolvedValue({ id: "message-in" });

    await redactConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      messageId: "message-in",
    });

    expect(mocks.tx.generationRun.updateMany).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("does not settle or consume free allowance for an intermediate delegation step", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      id: "run-task-step-1",
      delegationTaskId: "task-1",
      delegationTaskStepId: "step-1",
      delegationTaskStep: { kind: "COMPUTE" },
      runtimePolicySnapshot: {
        billingMode: "free",
      },
    });

    await completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: "run-task-step-1",
      outboxId: "outbox-task-step-1",
      leaseAttempt: 1,
      replyText: "Step one completed",
      senderDisplayName: "Representative",
      countUsage: true,
      keepConversationQueued: true,
    });

    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: { state: "AI_QUEUED" },
    });
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { lastMessageAt: expect.any(Date) },
    });
  });

  it("settles ordinary conversation usage only after channel delivery succeeds", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValueOnce(reservedRun);

    await completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid-delivery",
      leaseAttempt: 1,
      replyText: "Persisted but not delivered yet",
      senderDisplayName: "Representative",
      countUsage: true,
      completeOutbox: false,
    });

    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ freeRepliesUsed: expect.anything() }),
      }),
    );

    mocks.tx.generationRun.findUnique.mockResolvedValue({
      id: reservedRun.id,
      conversationId: reservedRun.conversationId,
      outputMessageId: "message-output",
      contextSnapshot: {
        deliveryBilling: { version: 1, status: "pending" },
      },
      runtimePolicySnapshot: reservedRun.runtimePolicySnapshot,
      provider: "openai",
      costCents: 2,
      delegationTaskId: null,
      delegationTaskStep: null,
      conversation: {
        representativeId: "representative-1",
        contactId: "contact-1",
      },
    });
    mocks.tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValueOnce([]);

    await markGenerationDeliveryComplete({
      runId: reservedRun.id,
      outboxId: "outbox-paid-delivery",
      leaseAttempt: 1,
      outputMessageId: "message-output",
      deliveryAdmission: {
        attemptNumber: 1,
        leaseToken: "delivery-lease-1",
      },
      externalMessageId: "provider-message-1",
    });

    expect(mocks.settleConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: reservedRun.id,
        settledTokenAmount: 1,
        providerCostCents: 2,
        provider: "openai",
        idempotencyKey: `generation:${reservedRun.id}:settle`,
      },
      mocks.tx,
    );
    expect(mocks.tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message-output",
        deliveryStatus: "PROCESSING",
      },
      data: {
        deliveryStatus: "SENT",
        externalMessageId: "provider-message-1",
        failureCode: null,
        failureReason: null,
      },
    });
  });

  it("claims the last free slot under the conversation lock", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 2,
      representative: availableRepresentative,
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.generationRun.count.mockResolvedValue(0);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "last free request",
      clientMessageId: "client-free",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-free",
      },
    });

    expect(mocks.reserveConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "free",
            accessMode: "TRIAL_THEN_CREDITS",
            effectiveFreeReplyLimit: 3,
          },
        }),
      }),
    );
  });

  it("pins FREE access and never reserves service credits", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 99,
      representative: {
        ...availableRepresentative,
        accessMode: "FREE",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "always free request",
      clientMessageId: "client-always-free",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        accessMode: "TRIAL_THEN_CREDITS",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-always-free",
      },
    });

    expect(mocks.tx.outboxEvent.findMany).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.count).not.toHaveBeenCalled();
    expect(mocks.reserveConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "free",
            accessMode: "FREE",
            effectiveFreeReplyLimit: null,
          },
        }),
      }),
    );
  });

  it("marks an inbound message sent when the human queue already owns the episode", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 0,
      representative: availableRepresentative,
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "NEEDS_HUMAN",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);

    const accepted = await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "additional context for the operator",
      clientMessageId: "client-human-queue",
    });

    expect(accepted).toMatchObject({
      heldForOperator: true,
      run: null,
    });
    expect(mocks.tx.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          deliveryStatus: "SENT",
        }),
      }),
    );
    expect(mocks.tx.generationRun.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.upsert).not.toHaveBeenCalled();
  });

  it("pins CREDITS_ONLY and reserves from the first reply", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 0,
      representative: {
        ...availableRepresentative,
        accessMode: "CREDITS_ONLY",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "paid from reply one",
      clientMessageId: "client-credits-only",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        accessMode: "FREE",
        freeReplyLimit: 100,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-credits-only",
      },
    });

    expect(mocks.tx.outboxEvent.findMany).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.count).not.toHaveBeenCalled();
    expect(mocks.reserveConversationWalletUsage).toHaveBeenCalledTimes(1);
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "service_credit",
            accessMode: "CREDITS_ONLY",
            effectiveFreeReplyLimit: 0,
          },
        }),
      }),
    );
  });

  it("pins FREE for an ingress channel without web-wallet coordinates", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 99,
      representative: {
        ...availableRepresentative,
        accessMode: "FREE",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "transport-neutral free request",
      clientMessageId: "client-no-wallet-free",
    });

    expect(mocks.reserveConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            accessMode: "FREE",
            effectiveFreeReplyLimit: null,
          },
        }),
      }),
    );
  });

  it("pins CREDITS_ONLY for worker entitlement authorization without wallet coordinates", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 0,
      representative: {
        ...availableRepresentative,
        accessMode: "CREDITS_ONLY",
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "transport-neutral paid request",
      clientMessageId: "client-no-wallet-paid",
    });

    expect(mocks.reserveConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            accessMode: "CREDITS_ONLY",
            effectiveFreeReplyLimit: 0,
          },
        }),
      }),
    );
  });

  it("uses the pinned trial limit instead of a later mutable limit", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      id: "run-pinned-trial",
      conversationId: "conversation-1",
      runtimePolicySnapshot: {
        accessMode: "TRIAL_THEN_CREDITS",
        effectiveFreeReplyLimit: 1,
      },
      conversation: { freeRepliesUsed: 1 },
    });
    mocks.tx.generationRun.count.mockResolvedValue(0);

    await expect(
      authorizeGenerationRunFreeUsage({
        runId: "run-pinned-trial",
        outboxId: "outbox-pinned-trial",
        leaseAttempt: 1,
        freeReplyLimit: 100,
      }),
    ).resolves.toBe(false);

    expect(mocks.tx.generationRun.update).not.toHaveBeenCalled();
  });

  it("reserves paid credit atomically when an earlier free run is in flight", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 2,
      representative: availableRepresentative,
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.generationRun.count.mockResolvedValue(1);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "paid request",
      clientMessageId: "client-paid",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-paid",
      },
    });

    expect(mocks.reserveConversationWalletUsage).toHaveBeenCalledWith(
      {
        externalUserId: "web:representative:audience",
        audienceIdentityId: "audience-1",
        representativeId: "representative-1",
        conversationId: "conversation-1",
        generationRunId: "run-new",
        tokenAmount: 1,
        idempotencyKey: "reserve:client-paid",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "service_credit",
            accessMode: "TRIAL_THEN_CREDITS",
            effectiveFreeReplyLimit: 3,
          },
        }),
      }),
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-new" },
      data: {
        runtimePolicySnapshot: {
          billingMode: "service_credit",
          accessMode: "TRIAL_THEN_CREDITS",
          effectiveFreeReplyLimit: 3,
          walletReservation: {
            usageChargeId: "usage-reserved",
            tokenAmount: 1,
          },
        },
      },
    });
    expect(
      mocks.tx.generationRun.upsert.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      mocks.reserveConversationWalletUsage.mock.invocationCallOrder[0]!,
    );
    expect(
      mocks.reserveConversationWalletUsage.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      mocks.tx.generationRun.update.mock.invocationCallOrder[0]!,
    );
    expect(
      mocks.tx.generationRun.update.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      mocks.tx.outboxEvent.upsert.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps a retryable failed free run occupying its quota slot during backoff", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 2,
      representative: availableRepresentative,
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.outboxEvent.findMany.mockResolvedValue([
      { aggregateId: "run-retrying-free" },
    ]);
    mocks.tx.generationRun.count.mockResolvedValue(1);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "request during retry backoff",
      clientMessageId: "client-during-retry",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-during-retry",
      },
    });

    expect(mocks.tx.outboxEvent.findMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        aggregateType: "generation_run",
        eventType: "generation.requested",
        status: "FAILED",
        attemptCount: { lt: 5 },
      },
      select: { aggregateId: true },
    });
    expect(mocks.tx.generationRun.count).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        OR: [
          {
            status: {
              in: ["QUEUED", "PROCESSING", "WAITING_APPROVAL"],
            },
          },
          {
            id: { in: ["run-retrying-free"] },
            status: "FAILED",
          },
        ],
        runtimePolicySnapshot: {
          path: ["billingMode"],
          equals: "free",
        },
      },
    });
    expect(mocks.reserveConversationWalletUsage).toHaveBeenCalledTimes(1);
  });

  it("does not keep a terminal failed free run occupying a quota slot", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 2,
      representative: availableRepresentative,
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.tx.outboxEvent.findMany.mockResolvedValue([]);
    mocks.tx.generationRun.count.mockResolvedValue(0);

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "replacement after terminal failure",
      clientMessageId: "client-after-terminal-failure",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-after-terminal-failure",
      },
    });

    expect(mocks.reserveConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          runtimePolicySnapshot: {
            billingMode: "free",
            accessMode: "TRIAL_THEN_CREDITS",
            effectiveFreeReplyLimit: 3,
          },
        }),
      }),
    );
  });

  it("fails the accept transaction with a typed payment-required error", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      audienceIdentityId: "audience-1",
      freeRepliesUsed: 3,
      representative: availableRepresentative,
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: connectedWebChannelBindings,
    });
    mocks.tx.generationRun.findUnique.mockResolvedValue(null);
    mocks.reserveConversationWalletUsage.mockRejectedValue(
      new InsufficientAgentUsageCreditsError(),
    );

    const rejection = await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "no balance",
      clientMessageId: "client-no-balance",
      walletBilling: {
        externalUserId: "web:representative:audience",
        representativeId: "representative-1",
        freeReplyLimit: 3,
        tokenAmount: 1,
        idempotencyKey: "reserve:client-no-balance",
      },
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ServiceCreditRequiredError);
    expect(rejection).toMatchObject({
      effectiveFreeRepliesUsed: 3,
    });

    expect(mocks.tx.message.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.tx.generationRun.upsert).toHaveBeenCalledTimes(1);
    expect(
      mocks.tx.generationRun.upsert.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      mocks.reserveConversationWalletUsage.mock.invocationCallOrder[0]!,
    );
    expect(mocks.tx.outboxEvent.upsert).not.toHaveBeenCalled();
  });

  it("releases a reservation when a completed response is not billable", async () => {
    await completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "Operator-owned answer",
      senderDisplayName: "Representative",
      countUsage: false,
    });

    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-paid",
        reason: "generation_usage_not_counted",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("defers and releases a stale completion after human handoff wins", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      status: "PROCESSING",
      conversation: {
        ...reservedRun.conversation,
        state: "NEEDS_HUMAN",
      },
    });

    await expect(completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "This stale answer must not be persisted.",
      senderDisplayName: "Representative",
      countUsage: true,
      completeOutbox: false,
    })).rejects.toMatchObject({
      code: "CONVERSATION_HUMAN_ACTIVE",
    });

    expect(mocks.tx.message.create).not.toHaveBeenCalled();
    expect(mocks.settleConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-paid",
        reason: "generation_deferred_to_human",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: reservedRun.id },
      data: expect.objectContaining({
        status: "WAITING_HUMAN",
        runtimePolicySnapshot: expect.not.objectContaining({
          walletReservation: expect.anything(),
        }),
      }),
    });
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-paid",
        aggregateType: "generation_run",
        aggregateId: reservedRun.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 1,
      },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      },
    });
  });

  it("releases an active service entitlement when a completed response is not billable", async () => {
    mockActiveServiceEntitlement();
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      conversation: {
        id: reservedRun.conversationId,
        state: "PROCESSING",
        audienceIdentityId: activeServiceEntitlementReservation.audienceIdentityId,
        representativeId: activeServiceEntitlementReservation.representativeId,
      },
    });

    await completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "Non-billable answer",
      senderDisplayName: "Representative",
      countUsage: false,
      entitlementReservation: activeServiceEntitlementReservation,
    });

    expect(mocks.tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: reservedRun.id,
        kind: "RELEASE",
        idempotencyKey:
          `conversation-entitlement:${reservedRun.id}:1:release`,
      }),
    });
    expect(mocks.tx.serviceEntitlementLedgerEntry.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CONSUME" }),
    });
  });

  it("recovers and releases an active service entitlement without an in-memory handle", async () => {
    mockActiveServiceEntitlement();

    await completeInlineGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
      replyText: "Recovered non-billable answer",
      senderDisplayName: "Representative",
      countUsage: false,
    });

    expect(mocks.tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: reservedRun.id,
        kind: "RELEASE",
        idempotencyKey:
          `conversation-entitlement:${reservedRun.id}:1:release`,
      }),
    });
    expect(mocks.tx.serviceEntitlementLedgerEntry.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CONSUME" }),
    });
  });

  it("keeps the reservation during retryable failures", async () => {
    mockActiveServiceEntitlement();

    await failGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 4,
      errorCode: "provider_timeout",
      errorMessage: "Provider timed out.",
    });

    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.serviceEntitlementLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(mocks.tx.serviceEntitlementAccount.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.serviceEntitlementLedgerEntry.create).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-paid",
        aggregateType: "generation_run",
        aggregateId: reservedRun.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 4,
      },
      data: {
        status: "FAILED",
        lastError: "Provider timed out.",
        availableAt: expect.any(Date),
      },
    });
  });

  it("releases the reservation on terminal failure or human deferral", async () => {
    mockActiveServiceEntitlement();

    await failGenerationRun({
      conversationId: reservedRun.conversationId,
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 5,
      errorCode: "provider_failed",
      errorMessage: "Provider failed.",
    });

    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-paid",
        failed: true,
        reason: "provider_failed",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: reservedRun.id,
        kind: "RELEASE",
        idempotencyKey:
          `conversation-entitlement:${reservedRun.id}:1:release`,
      }),
    });
    expect(mocks.tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-paid",
        aggregateType: "generation_run",
        aggregateId: reservedRun.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 5,
      },
      data: {
        status: "DEAD_LETTER",
        lastError: "Provider failed.",
        availableAt: expect.any(Date),
      },
    });

    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (client: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
    );
    mocks.tx.generationRun.findUnique.mockResolvedValue(reservedRun);
    mocks.tx.generationRun.update.mockResolvedValue({
      ...reservedRun,
      status: "WAITING_HUMAN",
    });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.releaseConversationWalletUsage.mockResolvedValue({
      usageCharge: { id: "usage-reserved", status: "released" },
      entitlement: {
        consumed: null,
        released: { accountId: "wallet-entitlement-account-1" },
        current: { accountId: "wallet-entitlement-account-1" },
      },
    });
    mockActiveServiceEntitlement();

    await deferGenerationRunForHuman({
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
    });

    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-paid",
        reason: "generation_deferred_to_human",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: reservedRun.id },
      data: {
        status: "WAITING_HUMAN",
        runtimePolicySnapshot: expect.objectContaining({
          billingMode: "service_credit_released",
          billingFinalizedAt: expect.any(String),
        }),
      },
    });
    const deferredRunUpdate =
      mocks.tx.generationRun.update.mock.calls.at(-1)?.[0];
    expect(
      deferredRunUpdate.data.runtimePolicySnapshot,
    ).not.toHaveProperty("walletReservation");
    expect(mocks.tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: reservedRun.id,
        kind: "RELEASE",
        idempotencyKey:
          `conversation-entitlement:${reservedRun.id}:1:release`,
      }),
    });
  });

  it("releases a clarification-step reservation when human control defers it", async () => {
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...reservedRun,
      delegationTaskId: "task-clarifying",
      delegationTaskStepId: "step-clarifying",
      delegationTaskStep: { kind: "CLARIFICATION" },
    });

    await deferGenerationRunForHuman({
      runId: reservedRun.id,
      outboxId: "outbox-paid",
      leaseAttempt: 1,
    });

    expect(mocks.releaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        expectedGenerationRunId: "run-paid",
        reason: "generation_deferred_to_human",
        idempotencyKey: "generation:run-paid:release",
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: reservedRun.id },
      data: {
        status: "WAITING_HUMAN",
        runtimePolicySnapshot: expect.objectContaining({
          billingMode: "service_credit_released",
          billingFinalizedAt: expect.any(String),
        }),
      },
    });
  });
});

function mockActiveServiceEntitlement() {
  const account = {
    id: activeServiceEntitlementReservation.accountId,
    audienceIdentityId: activeServiceEntitlementReservation.audienceIdentityId,
    representativeId: activeServiceEntitlementReservation.representativeId,
    productCode: activeServiceEntitlementReservation.productCode,
    unitName: "reply",
    status: "ACTIVE",
    grantedUnits: 1,
    remainingUnits: 0,
    reservedUnits: 1,
    expiresAt: null,
  };
  const reserveEntry = {
    id: "entitlement-reserve-1",
    entitlementAccountId: account.id,
    paymentOrderId: null,
    generationRunId: reservedRun.id,
    kind: "RESERVE",
    units: 1,
    balanceAfter: 0,
    reservedAfter: 1,
    idempotencyKey:
      `conversation-entitlement:${reservedRun.id}:1:reserve`,
    notes: null,
    metadata: null,
    createdAt: new Date("2026-07-24T08:00:00.000Z"),
  };

  mocks.tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([
    reserveEntry,
  ]);
  mocks.tx.serviceEntitlementLedgerEntry.findUnique.mockImplementation(
    async (args: any) =>
      args.where.idempotencyKey === reserveEntry.idempotencyKey
        ? reserveEntry
        : null,
  );
  mocks.tx.serviceEntitlementAccount.findUnique.mockImplementation(
    async () => account,
  );
  mocks.tx.serviceEntitlementAccount.updateMany.mockImplementation(
    async (args: any) => {
      const remainingIncrement = args.data.remainingUnits?.increment;
      const reservedDecrement = args.data.reservedUnits?.decrement;
      if (typeof remainingIncrement === "number") {
        account.remainingUnits += remainingIncrement;
      }
      if (typeof reservedDecrement === "number") {
        account.reservedUnits -= reservedDecrement;
      }
      return { count: 1 };
    },
  );
  mocks.tx.serviceEntitlementLedgerEntry.create.mockImplementation(
    async (args: any) => ({
      id: "entitlement-release-1",
      entitlementAccountId: account.id,
      paymentOrderId: null,
      generationRunId: args.data.generationRunId ?? null,
      kind: args.data.kind,
      units: args.data.units,
      balanceAfter: args.data.balanceAfter,
      reservedAfter: args.data.reservedAfter,
      idempotencyKey: args.data.idempotencyKey,
      notes: args.data.notes ?? null,
      metadata: args.data.metadata ?? null,
      createdAt: new Date("2026-07-24T08:00:01.000Z"),
    }),
  );
}
