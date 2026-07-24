import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, tx } = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
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
    conversationChannelBinding: {
      findFirst: vi.fn(),
    },
    message: {
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    generationRun: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    outboxEvent: {
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    serviceEntitlementLedgerEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    serviceEntitlementAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    tx: transactionClient,
    mockPrisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import {
  acceptInboundConversationMessage,
  claimNextGenerationWorkItem,
  claimNextOperatorMessageWorkItem,
  completeInlineGenerationRun,
  deferOperatorMessageDelivery,
  hasGenerationServiceCreditEntitlement,
} from "../src/conversation-platform";

describe("conversation runtime version pin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    tx.message.upsert.mockResolvedValue({ id: "message-1" });
    tx.generationRun.upsert.mockResolvedValue({ id: "run-1" });
    tx.outboxEvent.upsert.mockResolvedValue({ id: "outbox-1" });
    tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    tx.generationRun.updateMany.mockResolvedValue({ count: 1 });
    tx.message.updateMany.mockResolvedValue({ count: 1 });
    tx.conversation.updateMany.mockResolvedValue({ count: 1 });
    tx.conversationEpisode.updateMany.mockResolvedValue({ count: 1 });
    tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([]);
    tx.serviceEntitlementLedgerEntry.findUnique.mockResolvedValue(null);
    tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
  });

  it("does not grant paid entitlement from an incomplete runtime snapshot", () => {
    expect(
      hasGenerationServiceCreditEntitlement({
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      }),
    ).toBe(false);
    expect(
      hasGenerationServiceCreditEntitlement({
        billingMode: "service_credit",
      }),
    ).toBe(false);
  });

  it("keeps subsequent runs on the episode version after the representative active version changes", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      state: "ACTIVE",
      representative: {
        id: "representative-1",
        activeVersionId: "representative-version-2",
        lifecycleState: "PUBLISHED",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "representative-version-1",
      }],
      channelBindings: [{
        id: "web-binding-1",
        kind: "WEB",
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
        },
      }],
    });

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "continue the existing conversation",
      clientMessageId: "client-message-1",
    });

    expect(tx.conversationEpisode.create).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "reply:conversation-1:client-message-1",
      },
      create: expect.objectContaining({
        episodeId: "episode-1",
        representativeVersionId: "representative-version-1",
      }),
      update: {},
    });
  });

  it("fails closed when a Telegram conversation binding has no representative binding", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-telegram-unbound",
      state: "ACTIVE",
      representative: {
        id: "representative-1",
        activeVersionId: "representative-version-1",
        lifecycleState: "PUBLISHED",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      episodes: [],
      channelBindings: [{
        id: "telegram-binding-orphaned",
        kind: "TELEGRAM",
        representativeBindingId: null,
        representativeBinding: null,
      }],
    });

    await expect(
      acceptInboundConversationMessage({
        representativeSlug: "representative",
        conversationId: "conversation-telegram-unbound",
        text: "must not queue",
        clientMessageId: "telegram-message-orphaned",
        channel: "telegram",
      }),
    ).rejects.toMatchObject({
      name: "ChannelUnavailableError",
      code: "channel_not_connected",
    });

    expect(tx.conversationEpisode.create).not.toHaveBeenCalled();
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("re-reads Matrix room security under the room lock before accepting a message", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-matrix-1",
      state: "ACTIVE",
      representative: {
        id: "representative-1",
        activeVersionId: "representative-version-1",
        lifecycleState: "PUBLISHED",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      episodes: [],
      channelBindings: [{
        id: "matrix-binding-1",
        kind: "MATRIX",
        externalConversationId: "!room:example.org",
        metadata: {
          directMessageOnly: true,
          encrypted: false,
          securityState: "ACTIVE",
          audienceMatrixUserId: "@alice:example.org",
          representativeMatrixUserId: "@_delegate_rep:example.org",
        },
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
        },
      }],
    });
    tx.conversationChannelBinding.findFirst.mockResolvedValue({
      kind: "MATRIX",
      externalConversationId: "!room:example.org",
      metadata: {
        directMessageOnly: true,
        encrypted: false,
        securityState: "ISOLATED",
        audienceMatrixUserId: "@alice:example.org",
        representativeMatrixUserId: "@_delegate_rep:example.org",
      },
    });

    await expect(
      acceptInboundConversationMessage({
        representativeSlug: "representative",
        conversationId: "conversation-matrix-1",
        text: "must not cross the isolation boundary",
        clientMessageId: "matrix-message-after-isolation",
        channel: "matrix",
      }),
    ).rejects.toThrow("matrix_private_room_not_verified");

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[1]?.[1]).toBe(
      "matrix-room-security:!room:example.org",
    );
    expect(tx.conversationChannelBinding.findFirst).toHaveBeenCalledWith({
      where: {
        id: "matrix-binding-1",
        kind: "MATRIX",
        externalConversationId: "!room:example.org",
      },
      select: {
        kind: true,
        externalConversationId: true,
        metadata: true,
      },
    });
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("does not consume a reservation when Matrix isolates after claim but before completion", async () => {
    const entitlementAccount = {
      id: "entitlement-account-complete",
      audienceIdentityId: "audience-1",
      representativeId: "representative-1",
      productCode: "plan:pass",
      unitName: "reply",
      status: "ACTIVE",
      grantedUnits: 1,
      remainingUnits: 0,
      reservedUnits: 1,
      expiresAt: null,
    };
    const reserveEntry = {
      id: "reserve-ledger-complete",
      entitlementAccountId: entitlementAccount.id,
      paymentOrderId: null,
      generationRunId: "run-matrix-complete",
      kind: "RESERVE",
      units: 1,
      balanceAfter: 0,
      reservedAfter: 1,
      idempotencyKey:
        "conversation-entitlement:run-matrix-complete:1:reserve",
      notes: null,
      metadata: null,
      createdAt: new Date("2026-07-23T00:00:00.000Z"),
    };
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-matrix-complete",
      status: "PROCESSING",
      conversationId: "conversation-matrix-1",
      episodeId: "episode-1",
      inputMessageId: "message-matrix-complete",
      inputMessage: {
        id: "message-matrix-complete",
        channelBinding: {
          id: "matrix-binding-1",
          kind: "MATRIX",
          externalConversationId: "!room:example.org",
        },
      },
      outputMessage: null,
      conversation: {
        audienceIdentityId: "audience-1",
        representativeId: "representative-1",
      },
    });
    tx.conversationChannelBinding.findFirst.mockResolvedValue({
      kind: "MATRIX",
      externalConversationId: "!room:example.org",
      metadata: {
        directMessageOnly: true,
        encrypted: false,
        securityState: "ISOLATED",
        audienceMatrixUserId: "@alice:example.org",
        representativeMatrixUserId: "@_delegate_rep:example.org",
      },
    });
    tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([reserveEntry]);
    tx.serviceEntitlementLedgerEntry.findUnique.mockImplementation(
      async (args: any) =>
        args.where.idempotencyKey === reserveEntry.idempotencyKey
          ? reserveEntry
          : null,
    );
    tx.serviceEntitlementAccount.findUnique.mockResolvedValue(
      entitlementAccount,
    );
    tx.serviceEntitlementAccount.updateMany.mockResolvedValue({ count: 1 });
    tx.serviceEntitlementLedgerEntry.create.mockResolvedValue({
      ...reserveEntry,
      id: "release-ledger-complete",
      kind: "RELEASE",
      balanceAfter: 1,
      reservedAfter: 0,
      idempotencyKey:
        "conversation-entitlement:run-matrix-complete:1:release",
    });

    await expect(completeInlineGenerationRun({
      runId: "run-matrix-complete",
      outboxId: "outbox-matrix-complete",
      leaseAttempt: 1,
      replyText: "must never be persisted",
      senderDisplayName: "Representative",
      completeOutbox: false,
      countUsage: true,
      entitlementReservation: {
        audienceIdentityId: "audience-1",
        representativeId: "representative-1",
        productCode: "plan:pass",
        generationRunId: "run-matrix-complete",
        operationKey: "generation:run-matrix-complete:attempt:1",
        accountId: entitlementAccount.id,
        attempt: 1,
      },
    })).rejects.toMatchObject({
      name: "ChannelUnavailableError",
      code: "matrix_private_room_not_verified",
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[1]?.[1]).toBe(
      "matrix-room-security:!room:example.org",
    );
    expect(tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledTimes(1);
    expect(tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: "run-matrix-complete",
        kind: "RELEASE",
        idempotencyKey:
          "conversation-entitlement:run-matrix-complete:1:release",
      }),
    });
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.generationRun.update).not.toHaveBeenCalled();
    expect(tx.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-matrix-complete",
        status: {
          in: ["QUEUED", "PROCESSING", "WAITING_APPROVAL", "WAITING_HUMAN"],
        },
      },
      data: expect.objectContaining({
        status: "CANCELED",
        errorCode: "matrix_private_room_not_verified",
      }),
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: "run-matrix-complete",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "matrix_private_room_not_verified",
      }),
    });
  });

  it("treats the current service-credit reservation as paid entitlement after free replies are exhausted", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-paid",
      aggregateId: "run-paid",
      status: "PENDING",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-paid",
      aggregateId: "run-paid",
      attemptCount: 1,
    });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-paid",
      status: "QUEUED",
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      delegationTaskId: null,
      delegationTaskStepId: null,
      contextSnapshot: null,
      inputMessageId: "message-paid",
      inputMessage: {
        id: "message-paid",
        text: "continue with my paid credit",
      },
      runtimePolicySnapshot: {
        billingMode: "service_credit",
        walletReservation: {
          usageChargeId: "usage-reserved",
          tokenAmount: 1,
        },
      },
      startedAt: null,
      episode: {
        representativeVersionId: "representative-version-1",
      },
      conversation: {
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        state: "AI_QUEUED",
        freeRepliesUsed: 3,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
          lifecycleState: "PUBLISHED",
          activeVersionId: "representative-version-1",
          publicMode: true,
          runtimePolicyOverlays: [],
        },
        channelBindings: [{
          id: "web-binding-paid",
          kind: "WEB",
          externalConversationId: "web:conversation-1",
          representativeBinding: {
            status: "CONNECTED",
            desiredState: "ACTIVE",
            healthStatus: "HEALTHY",
          },
        }],
      },
    });
    tx.generationRun.update.mockResolvedValue({ id: "run-paid" });
    tx.message.update.mockResolvedValue({ id: "message-paid" });

    await expect(claimNextGenerationWorkItem()).resolves.toMatchObject({
      runId: "run-paid",
      walletReservation: {
        usageChargeId: "usage-reserved",
        tokenAmount: 1,
      },
      usage: {
        freeRepliesUsed: 3,
        passUnlocked: true,
        deepHelpUnlocked: false,
      },
    });
  });

  it("dead-letters a legacy run whose version differs from its episode", async () => {
    tx.$queryRaw.mockResolvedValue([{ id: "outbox-legacy" }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-legacy",
        aggregateId: "run-legacy",
      })
      .mockResolvedValueOnce({ id: "outbox-legacy" });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-legacy",
      status: "QUEUED",
      representativeVersionId: "representative-version-2",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-legacy",
      inputMessage: {
        id: "message-legacy",
        text: "legacy work",
      },
      conversation: {
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        state: "AI_QUEUED",
        freeRepliesUsed: 0,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
        },
        channelBindings: [],
      },
    });
    tx.generationRun.update.mockResolvedValue({ id: "run-legacy" });
    tx.message.update.mockResolvedValue({ id: "message-legacy" });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-legacy" },
      data: expect.objectContaining({
        status: "FAILED",
        errorCode: "representative_version_context_mismatch",
      }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-legacy" },
      data: expect.objectContaining({
        deliveryStatus: "FAILED",
        failureCode: "representative_version_context_mismatch",
      }),
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-legacy" },
      data: {
        status: "DEAD_LETTER",
        lastError: "representative_version_context_mismatch",
      },
    });
  });

  it("releases a crash-surviving reservation in the same claim transaction when the run was canceled", async () => {
    const account = {
      id: "entitlement-account-1",
      audienceIdentityId: "audience-1",
      representativeId: "representative-1",
      productCode: "plan:pass",
      unitName: "reply",
      status: "ACTIVE",
      grantedUnits: 1,
      remainingUnits: 0,
      reservedUnits: 1,
      expiresAt: null,
    };
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-canceled",
      aggregateId: "run-canceled",
      attemptCount: 1,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-canceled",
        aggregateId: "run-canceled",
      })
      .mockResolvedValueOnce({ id: "outbox-canceled" });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-canceled",
      status: "CANCELED",
    });
    const reserveEntry = {
      id: "reserve-ledger-1",
      entitlementAccountId: account.id,
      paymentOrderId: null,
      generationRunId: "run-canceled",
      kind: "RESERVE",
      units: 1,
      balanceAfter: 0,
      reservedAfter: 1,
      idempotencyKey: "conversation-entitlement:run-canceled:1:reserve",
      notes: null,
      metadata: null,
      createdAt: new Date("2026-07-23T00:00:00.000Z"),
    };
    tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([reserveEntry]);
    tx.serviceEntitlementLedgerEntry.findUnique.mockImplementation(async (args: any) =>
      args.where.idempotencyKey === reserveEntry.idempotencyKey
        ? reserveEntry
        : null
    );
    tx.serviceEntitlementAccount.findUnique.mockResolvedValue(account);
    tx.serviceEntitlementAccount.updateMany.mockResolvedValue({ count: 1 });
    tx.serviceEntitlementLedgerEntry.create.mockResolvedValue({
      id: "release-ledger-1",
      entitlementAccountId: account.id,
      paymentOrderId: null,
      generationRunId: "run-canceled",
      kind: "RELEASE",
      units: 1,
      balanceAfter: 1,
      reservedAfter: 0,
      idempotencyKey: "conversation-entitlement:run-canceled:1:release",
      notes: "Released after generation run termination: generation_run_canceled.",
      metadata: null,
      createdAt: new Date("2026-07-23T00:00:01.000Z"),
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.serviceEntitlementAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: account.id,
        reservedUnits: { gte: 1 },
      },
      data: {
        remainingUnits: { increment: 1 },
        reservedUnits: { decrement: 1 },
      },
    });
    expect(tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: "run-canceled",
        kind: "RELEASE",
        idempotencyKey: "conversation-entitlement:run-canceled:1:release",
      }),
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-canceled" },
      data: { status: "PROCESSED", processedAt: expect.any(Date) },
    });
  });

  it("terminally fails a generation run after its outbox retry budget is exhausted", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-exhausted",
      aggregateId: "run-exhausted",
      status: "PROCESSING",
      attemptCount: 5,
    }]);
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-exhausted",
      status: "PROCESSING",
      inputMessageId: "message-exhausted",
      conversationId: "conversation-1",
      episodeId: "episode-1",
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-exhausted" },
      data: expect.objectContaining({
        status: "FAILED",
        errorCode: "generation_work_lease_exhausted",
        completedAt: expect.any(Date),
      }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-exhausted" },
      data: expect.objectContaining({
        deliveryStatus: "FAILED",
        failureCode: "generation_work_lease_exhausted",
      }),
    });
    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-exhausted" },
      data: {
        status: "DEAD_LETTER",
        lastError: "generation_work_lease_exhausted",
      },
    });
  });

  it("reclaims an expired processing lease and returns only persisted delivery for a completed run", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-delivery",
      attemptCount: 1,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-delivery",
      aggregateId: "run-delivery",
    });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-delivery",
      status: "COMPLETED",
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-inbound",
      inputMessage: {
        id: "message-inbound",
        text: "hello",
        channelBinding: {
          id: "telegram-binding-1",
          kind: "TELEGRAM",
          externalConversationId: "123456",
          representativeBinding: {
            status: "CONNECTED",
            desiredState: "ACTIVE",
            healthStatus: "HEALTHY",
          },
        },
      },
      outputMessage: {
        id: "message-output",
        text: "persisted reply",
        externalMessageId: null,
      },
      conversation: {
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        state: "WAITING_USER",
        freeRepliesUsed: 1,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
          lifecycleState: "PUBLISHED",
          activeVersionId: "representative-version-1",
          publicMode: true,
          runtimePolicyOverlays: [],
        },
        channelBindings: [{
          id: "matrix-binding-should-not-win",
          kind: "MATRIX",
          externalConversationId: "!wrong:example.org",
          representativeBinding: {
            status: "CONNECTED",
            desiredState: "ACTIVE",
            healthStatus: "HEALTHY",
          },
        }],
      },
    });

    await expect(claimNextGenerationWorkItem({
      telegramWorkerEnabled: true,
      processingLeaseMs: 60_000,
    })).resolves.toMatchObject({
      outboxId: "outbox-delivery",
      runId: "run-delivery",
      channel: "telegram",
      externalConversationId: "123456",
      deliveryOnly: true,
      outputMessageId: "message-output",
      outputText: "persisted reply",
    });

    const claimSql = (tx.$queryRaw.mock.calls[0]?.[0] as readonly string[]).join("");
    expect(claimSql).toContain("'PROCESSING'");
    expect(claimSql).toContain('"availableAt" <= NOW()');
    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-delivery" },
      data: expect.objectContaining({
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: expect.any(Date),
        processedAt: null,
      }),
    });
    expect(tx.generationRun.update).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("defers Telegram work without consuming an attempt when worker does not own delivery", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-telegram",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-telegram",
        aggregateId: "run-telegram",
      })
      .mockResolvedValueOnce({ id: "outbox-telegram" });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-telegram",
      status: "QUEUED",
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-telegram",
      inputMessage: {
        id: "message-telegram",
        text: "hello",
        channelBinding: {
          id: "telegram-binding-1",
          kind: "TELEGRAM",
          externalConversationId: "123456",
          representativeBinding: {
            status: "CONNECTED",
            desiredState: "ACTIVE",
            healthStatus: "HEALTHY",
          },
        },
      },
      outputMessage: null,
      conversation: {
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        state: "AI_QUEUED",
        freeRepliesUsed: 0,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
          lifecycleState: "PUBLISHED",
          activeVersionId: "representative-version-1",
          publicMode: true,
          runtimePolicyOverlays: [],
        },
        channelBindings: [],
      },
    });

    await expect(claimNextGenerationWorkItem({
      telegramWorkerEnabled: false,
    })).resolves.toBeNull();

    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-telegram" },
      data: {
        status: "PENDING",
        attemptCount: { decrement: 1 },
        availableAt: expect.any(Date),
        lastError: "telegram_worker_not_delivery_owner",
      },
    });
    expect(tx.generationRun.update).not.toHaveBeenCalled();
  });

  it("cancels before generation when a Telegram binding lost its representative binding", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-orphaned-binding",
      aggregateId: "run-orphaned-binding",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-orphaned-binding",
        aggregateId: "run-orphaned-binding",
      })
      .mockResolvedValueOnce({ id: "outbox-orphaned-binding" });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-orphaned-binding",
      status: "QUEUED",
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-orphaned-binding",
      inputMessage: {
        id: "message-orphaned-binding",
        text: "must not generate",
        channelBinding: {
          id: "telegram-binding-orphaned",
          kind: "TELEGRAM",
          externalConversationId: "123456",
          representativeBindingId: null,
          representativeBinding: null,
        },
      },
      outputMessage: null,
      conversation: {
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        state: "AI_QUEUED",
        freeRepliesUsed: 4,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
          lifecycleState: "PUBLISHED",
          activeVersionId: "representative-version-1",
          publicMode: true,
          runtimePolicyOverlays: [],
        },
        channelBindings: [],
      },
    });
    tx.generationRun.update.mockResolvedValue({ id: "run-orphaned-binding" });
    tx.message.update.mockResolvedValue({ id: "message-orphaned-binding" });

    await expect(claimNextGenerationWorkItem({
      telegramWorkerEnabled: true,
    })).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-orphaned-binding" },
      data: expect.objectContaining({
        status: "CANCELED",
        errorCode: "channel_not_connected",
      }),
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-orphaned-binding" },
      data: {
        status: "DEAD_LETTER",
        lastError: "channel_not_connected",
      },
    });
  });

  it("cancels queued Matrix work when the room becomes isolated before claim", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-matrix-isolated",
      aggregateId: "run-matrix-isolated",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-matrix-isolated",
        aggregateId: "run-matrix-isolated",
      })
      .mockResolvedValueOnce({ id: "outbox-matrix-isolated" });
    const matrixBinding = {
      id: "matrix-binding-1",
      kind: "MATRIX",
      externalConversationId: "!room:example.org",
      metadata: {
        directMessageOnly: true,
        encrypted: false,
        securityState: "ACTIVE",
        audienceMatrixUserId: "@alice:example.org",
        representativeMatrixUserId: "@_delegate_rep:example.org",
      },
      representativeBinding: {
        status: "CONNECTED",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
      },
    };
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-matrix-isolated",
      status: "QUEUED",
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-matrix-isolated",
      inputMessage: {
        id: "message-matrix-isolated",
        text: "must not generate",
        channelBinding: matrixBinding,
      },
      outputMessage: null,
      conversation: {
        id: "conversation-matrix-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        state: "AI_QUEUED",
        freeRepliesUsed: 4,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        representative: {
          slug: "representative",
          displayName: "Representative",
          lifecycleState: "PUBLISHED",
          activeVersionId: "representative-version-1",
          publicMode: true,
          runtimePolicyOverlays: [],
        },
        channelBindings: [matrixBinding],
      },
    });
    tx.conversationChannelBinding.findFirst.mockResolvedValue({
      kind: "MATRIX",
      externalConversationId: "!room:example.org",
      metadata: {
        ...matrixBinding.metadata,
        securityState: "ISOLATED",
      },
    });
    tx.generationRun.update.mockResolvedValue({ id: "run-matrix-isolated" });
    tx.message.update.mockResolvedValue({ id: "message-matrix-isolated" });
    const entitlementAccount = {
      id: "entitlement-account-matrix",
      audienceIdentityId: "audience-1",
      representativeId: "representative-1",
      productCode: "plan:pass",
      unitName: "reply",
      status: "ACTIVE",
      grantedUnits: 1,
      remainingUnits: 0,
      reservedUnits: 1,
      expiresAt: null,
    };
    const reserveEntry = {
      id: "reserve-ledger-matrix",
      entitlementAccountId: entitlementAccount.id,
      paymentOrderId: null,
      generationRunId: "run-matrix-isolated",
      kind: "RESERVE",
      units: 1,
      balanceAfter: 0,
      reservedAfter: 1,
      idempotencyKey:
        "conversation-entitlement:run-matrix-isolated:1:reserve",
      notes: null,
      metadata: null,
      createdAt: new Date("2026-07-23T00:00:00.000Z"),
    };
    tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([reserveEntry]);
    tx.serviceEntitlementLedgerEntry.findUnique.mockImplementation(
      async (args: any) =>
        args.where.idempotencyKey === reserveEntry.idempotencyKey
          ? reserveEntry
          : null,
    );
    tx.serviceEntitlementAccount.findUnique.mockResolvedValue(
      entitlementAccount,
    );
    tx.serviceEntitlementAccount.updateMany.mockResolvedValue({ count: 1 });
    tx.serviceEntitlementLedgerEntry.create.mockResolvedValue({
      ...reserveEntry,
      id: "release-ledger-matrix",
      kind: "RELEASE",
      balanceAfter: 1,
      reservedAfter: 0,
      idempotencyKey:
        "conversation-entitlement:run-matrix-isolated:1:release",
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.$executeRaw.mock.calls.at(-1)?.[1]).toBe(
      "matrix-room-security:!room:example.org",
    );
    expect(tx.serviceEntitlementLedgerEntry.findMany).toHaveBeenCalledWith({
      where: {
        generationRunId: "run-matrix-isolated",
        idempotencyKey: {
          startsWith: "conversation-entitlement:",
        },
        kind: { in: ["RESERVE", "CONSUME", "RELEASE"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(tx.serviceEntitlementAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: entitlementAccount.id,
        reservedUnits: { gte: 1 },
      },
      data: {
        remainingUnits: { increment: 1 },
        reservedUnits: { decrement: 1 },
      },
    });
    expect(tx.serviceEntitlementLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generationRunId: "run-matrix-isolated",
        kind: "RELEASE",
        idempotencyKey:
          "conversation-entitlement:run-matrix-isolated:1:release",
        notes:
          "Released after generation run termination: matrix_private_room_not_verified.",
      }),
    });
    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-matrix-isolated" },
      data: expect.objectContaining({
        status: "CANCELED",
        errorCode: "matrix_private_room_not_verified",
        canceledAt: expect.any(Date),
      }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-matrix-isolated" },
      data: expect.objectContaining({
        deliveryStatus: "CANCELED",
        failureCode: "matrix_private_room_not_verified",
      }),
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-matrix-isolated" },
      data: {
        status: "DEAD_LETTER",
        lastError: "matrix_private_room_not_verified",
      },
    });
  });

  it("keeps Telegram operator outbox pending when worker does not own delivery", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-operator",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-operator",
        aggregateId: "message-operator",
      })
      .mockResolvedValueOnce({ id: "outbox-operator" });
    tx.message.findUnique.mockResolvedValue({
      id: "message-operator",
      conversationId: "conversation-1",
      text: "operator reply",
      senderDisplayName: "Owner",
      channelBinding: {
        kind: "TELEGRAM",
        externalConversationId: "123456",
      },
      conversation: {
        representative: {
          ownerId: "owner-1",
        },
      },
    });

    await expect(claimNextOperatorMessageWorkItem({
      telegramWorkerEnabled: false,
      processingLeaseMs: 60_000,
    })).resolves.toBeNull();

    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-operator" },
      data: {
        status: "PENDING",
        attemptCount: { decrement: 1 },
        availableAt: expect.any(Date),
        lastError: "telegram_worker_not_delivery_owner",
      },
    });
  });

  it("marks an operator message failed when delivery attempts are exhausted", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-operator-exhausted",
      aggregateId: "message-operator-exhausted",
      attemptCount: 5,
    }]);

    await expect(claimNextOperatorMessageWorkItem()).resolves.toBeNull();

    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { id: "message-operator-exhausted" },
      data: {
        deliveryStatus: "FAILED",
        failureCode: "operator_channel_delivery_attempts_exhausted",
        failureReason: "Operator message delivery exhausted its retry budget.",
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-operator-exhausted" },
      data: {
        status: "DEAD_LETTER",
        lastError: "conversation_outbox_attempts_exhausted",
      },
    });
  });

  it("requeues a paused operator message and gives its claimed attempt back", async () => {
    tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    tx.message.update.mockResolvedValue({ id: "operator-message-paused" });

    await expect(deferOperatorMessageDelivery({
      outboxId: "operator-outbox-paused",
      messageId: "operator-message-paused",
      reason: "channel_paused",
      retryAfterMs: 60_000,
    })).resolves.toBe(true);

    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "operator-outbox-paused",
        status: "PROCESSING",
        attemptCount: { gt: 0 },
      },
      data: {
        status: "PENDING",
        attemptCount: { decrement: 1 },
        availableAt: expect.any(Date),
        processedAt: null,
        lastError: "channel_paused",
      },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "operator-message-paused" },
      data: {
        deliveryStatus: "QUEUED",
        failureCode: null,
        failureReason: null,
      },
    });
  });

  it("does not let publishing overwrite an existing Web channel pause", () => {
    const source = readFileSync(
      new URL("../src/conversation-platform.ts", import.meta.url),
      "utf8",
    );
    const publishStart = source.indexOf("export async function publishRepresentativeVersion");
    const publishEnd = source.indexOf(
      "export async function activateRepresentativeVersion",
      publishStart,
    );
    const publishSource = source.slice(publishStart, publishEnd);
    const upsertStart = publishSource.indexOf(
      "await tx.representativeChannelBinding.upsert",
    );
    const upsertEnd = publishSource.indexOf("await tx.eventAudit.create", upsertStart);
    const upsertSource = publishSource.slice(upsertStart, upsertEnd);
    const updateSource = upsertSource.slice(upsertSource.lastIndexOf("update: {"));

    expect(updateSource).toContain('status: "CONNECTED"');
    expect(updateSource).not.toContain("desiredState:");
    expect(updateSource).not.toContain("healthStatus:");
    expect(updateSource).not.toContain("lastError:");
  });
});
