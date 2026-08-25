import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, tx, mockAbortDelegationTaskForGenerationFailure } =
vi.hoisted(() => {
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
    messageDeliveryAttempt: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    generationRun: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    memoryUseRun: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    delegationTask: {
      updateMany: vi.fn(),
    },
    delegationTaskStep: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    delegationTaskExternalEffect: {
      updateMany: vi.fn(),
    },
    toolExecution: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    computeSession: {
      updateMany: vi.fn(),
    },
    outboxEvent: {
      create: vi.fn(),
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
      conversation: {
        findUnique: vi.fn(),
      },
    },
    mockAbortDelegationTaskForGenerationFailure: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../src/delegation-tasks", () => ({
  abortDelegationTaskForGenerationFailureInTransaction:
    mockAbortDelegationTaskForGenerationFailure,
}));

import {
  acceptInboundConversationMessage,
  assertConversationChannelDeliveryAvailable,
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
    tx.delegationTask.updateMany.mockResolvedValue({ count: 1 });
    tx.delegationTaskStep.updateMany.mockResolvedValue({ count: 1 });
    tx.delegationTaskExternalEffect.updateMany.mockResolvedValue({ count: 0 });
    tx.toolExecution.findUnique.mockResolvedValue(null);
    tx.toolExecution.updateMany.mockResolvedValue({ count: 0 });
    tx.computeSession.updateMany.mockResolvedValue({ count: 0 });
    tx.message.updateMany.mockResolvedValue({ count: 1 });
    tx.messageDeliveryAttempt.upsert.mockResolvedValue({ id: "attempt-1" });
    tx.messageDeliveryAttempt.updateMany.mockResolvedValue({ count: 1 });
    tx.conversation.updateMany.mockResolvedValue({ count: 1 });
    tx.conversationEpisode.updateMany.mockResolvedValue({ count: 1 });
    tx.serviceEntitlementLedgerEntry.findMany.mockResolvedValue([]);
    tx.serviceEntitlementLedgerEntry.findUnique.mockResolvedValue(null);
    tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
    mockAbortDelegationTaskForGenerationFailure.mockResolvedValue({
      taskId: "task-1",
      status: "FAILED",
      aborted: true,
    });
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
      conversationId: "conversation-matrix-1",
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

  it("starts a new episode on the latest published version after the previous reply", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      state: "WAITING_USER",
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
        status: "WAITING_USER",
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
    tx.conversationEpisode.create.mockResolvedValue({
      id: "episode-2",
      sequence: 2,
      status: "ACTIVE",
      representativeVersionId: "representative-version-2",
    });

    await acceptInboundConversationMessage({
      representativeSlug: "representative",
      conversationId: "conversation-1",
      text: "continue after the previous reply",
      clientMessageId: "client-message-waiting-user",
    });

    expect(tx.conversationEpisode.update).toHaveBeenCalledWith({
      where: { id: "episode-1" },
      data: {
        status: "RESOLVED",
        endedAt: expect.any(Date),
        resolutionReason: "representative_version_updated",
      },
    });
    expect(tx.conversationEpisode.create).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation-1",
        representativeVersionId: "representative-version-2",
        sequence: 2,
        status: "ACTIVE",
      },
    });
    expect(tx.generationRun.upsert).toHaveBeenCalledWith({
      where: {
        idempotencyKey:
          "reply:conversation-1:client-message-waiting-user",
      },
      create: expect.objectContaining({
        episodeId: "episode-2",
        representativeVersionId: "representative-version-2",
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
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
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
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
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
        representativeAssignmentRevision: true,
        metadata: true,
        representativeBinding: {
          select: {
            endpointAssignmentRevision: true,
          },
        },
      },
    });
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("rejects inbound Matrix messages after the representative identity is reassigned", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-matrix-reassigned",
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
        id: "matrix-binding-reassigned",
        kind: "MATRIX",
        externalConversationId: "!old-room:example.org",
        metadata: {
          directMessageOnly: true,
          encrypted: false,
          securityState: "ACTIVE",
          audienceMatrixUserId: "@alice:example.org",
          representativeMatrixUserId:
            "@_delegate_rep_old:example.org",
        },
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          externalUserId: "@_delegate_rep_new:example.org",
        },
      }],
    });

    await expect(
      acceptInboundConversationMessage({
        representativeSlug: "representative",
        conversationId: "conversation-matrix-reassigned",
        text: "must not queue on the old identity",
        clientMessageId: "matrix-message-after-reassignment",
        channel: "matrix",
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "ChannelUnavailableError",
      code: "matrix_identity_reassigned",
    });

    expect(tx.conversationChannelBinding.findFirst).not.toHaveBeenCalled();
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
      conversationId: "conversation-matrix-1",
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

    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(tx.$executeRaw.mock.calls[2]?.[1]).toBe(
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

  it("cancels Matrix generation completion after the representative identity is reassigned", async () => {
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-matrix-completion-reassigned",
      status: "PROCESSING",
      conversationId: "conversation-matrix-reassigned",
      episodeId: "episode-1",
      inputMessageId: "message-matrix-completion-reassigned",
      delegationTaskId: null,
      runtimePolicySnapshot: null,
      inputMessage: {
        id: "message-matrix-completion-reassigned",
        channelBinding: {
          id: "matrix-binding-reassigned",
          kind: "MATRIX",
          externalConversationId: "!old-room:example.org",
          metadata: {
            directMessageOnly: true,
            encrypted: false,
            securityState: "ACTIVE",
            audienceMatrixUserId: "@alice:example.org",
            representativeMatrixUserId:
              "@_delegate_rep_old:example.org",
          },
          representativeBinding: {
            externalUserId: "@_delegate_rep_new:example.org",
          },
        },
      },
      outputMessage: null,
      conversation: {
        id: "conversation-matrix-reassigned",
        state: "AI_QUEUED",
        audienceIdentityId: "audience-1",
        representativeId: "representative-1",
      },
      delegationTaskStep: null,
    });

    await expect(completeInlineGenerationRun({
      conversationId: "conversation-matrix-reassigned",
      runId: "run-matrix-completion-reassigned",
      outboxId: "outbox-matrix-completion-reassigned",
      leaseAttempt: 1,
      replyText: "must never be persisted",
      senderDisplayName: "Representative",
      completeOutbox: false,
      countUsage: false,
    })).rejects.toMatchObject({
      name: "ChannelUnavailableError",
      code: "matrix_identity_reassigned",
    });

    expect(tx.conversationChannelBinding.findFirst).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-matrix-completion-reassigned",
        status: {
          in: ["QUEUED", "PROCESSING", "WAITING_APPROVAL", "WAITING_HUMAN"],
        },
      },
      data: expect.objectContaining({
        status: "CANCELED",
        errorCode: "matrix_identity_reassigned",
      }),
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: "run-matrix-completion-reassigned",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "matrix_identity_reassigned",
      }),
    });
  });

  it("cancels Matrix generation completion from an earlier channel activation", async () => {
    const matrixMetadata = {
      directMessageOnly: true,
      encrypted: false,
      securityState: "ACTIVE",
      audienceMatrixUserId: "@alice:example.org",
      representativeMatrixUserId: "@_delegate_rep:example.org",
      representativeAssignmentRevision: 3,
    };
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-matrix-completion-stale-lifecycle",
      status: "PROCESSING",
      conversationId: "conversation-matrix-lifecycle",
      episodeId: "episode-1",
      inputMessageId: "message-matrix-completion-stale-lifecycle",
      delegationTaskId: null,
      runtimePolicySnapshot: null,
      inputMessage: {
        id: "message-matrix-completion-stale-lifecycle",
        channelLifecycleRevision: 1,
        channelBinding: {
          id: "matrix-binding-lifecycle",
          kind: "MATRIX",
          externalConversationId: "!room:example.org",
          representativeAssignmentRevision: 3,
          metadata: matrixMetadata,
          representativeBinding: {
            externalUserId: "@_delegate_rep:example.org",
            endpointAssignmentRevision: 3,
            endpointLifecycleRevision: 2,
          },
        },
      },
      outputMessage: null,
      conversation: {
        id: "conversation-matrix-lifecycle",
        state: "AI_QUEUED",
        audienceIdentityId: "audience-1",
        representativeId: "representative-1",
      },
      delegationTaskStep: null,
    });
    tx.conversationChannelBinding.findFirst.mockResolvedValue({
      kind: "MATRIX",
      externalConversationId: "!room:example.org",
      representativeAssignmentRevision: 3,
      metadata: matrixMetadata,
      representativeBinding: {
        endpointAssignmentRevision: 3,
      },
    });

    await expect(completeInlineGenerationRun({
      conversationId: "conversation-matrix-lifecycle",
      runId: "run-matrix-completion-stale-lifecycle",
      outboxId: "outbox-matrix-completion-stale-lifecycle",
      leaseAttempt: 1,
      replyText: "must never be persisted",
      senderDisplayName: "Representative",
      completeOutbox: false,
      countUsage: false,
    })).rejects.toMatchObject({
      name: "ChannelUnavailableError",
      code: "matrix_channel_lifecycle_reactivated",
    });

    expect(tx.$executeRaw.mock.calls.at(-1)?.[1]).toBe(
      "matrix-room-security:!room:example.org",
    );
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-matrix-completion-stale-lifecycle",
        status: {
          in: ["QUEUED", "PROCESSING", "WAITING_APPROVAL", "WAITING_HUMAN"],
        },
      },
      data: expect.objectContaining({
        status: "CANCELED",
        errorCode: "matrix_channel_lifecycle_reactivated",
      }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-matrix-completion-stale-lifecycle" },
      data: expect.objectContaining({
        deliveryStatus: "CANCELED",
        failureCode: "matrix_channel_lifecycle_reactivated",
      }),
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: "run-matrix-completion-stale-lifecycle",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "matrix_channel_lifecycle_reactivated",
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
        accessMode: "CREDITS_ONLY",
        effectiveFreeReplyLimit: 0,
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
      accessMode: "CREDITS_ONLY",
      effectiveFreeReplyLimit: 0,
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
      delegationTaskId: "task-legacy",
      delegationTaskStepId: "step-legacy",
      delegationTask: { status: "READY" },
      delegationTaskStep: {
        kind: "COMPUTE",
        status: "READY",
        externalEffects: [],
        outputs: [],
      },
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

    expect(
      mockAbortDelegationTaskForGenerationFailure,
    ).toHaveBeenCalledWith(
      tx,
      {
        taskId: "task-legacy",
        generationRunId: "run-legacy",
        stepId: "step-legacy",
        failureReason:
          "The generation run has no valid representative version pin or differs from its conversation episode.",
      },
    );
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

  it("requeues a fresh recovery outbox when the latest terminal delegation result exhausts its lease", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-terminal-exhausted",
      aggregateId: "run-terminal-exhausted",
      status: "PROCESSING",
      attemptCount: 5,
    }]);
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-terminal-exhausted",
      status: "PROCESSING",
      inputMessageId: "message-terminal-exhausted",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      delegationTaskId: "task-terminal-exhausted",
      delegationTaskStepId: "step-terminal-exhausted",
      runtimePolicySnapshot: null,
    });
    tx.delegationTaskStep.findUnique.mockResolvedValue({
      status: "COMPLETED",
    });
    tx.generationRun.findFirst.mockResolvedValue({
      id: "run-terminal-exhausted",
    });
    tx.outboxEvent.create.mockResolvedValue({
      id: "outbox-terminal-recovery",
      attemptCount: 0,
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-terminal-exhausted" },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation-1",
        aggregateType: "generation_run",
        aggregateId: "run-terminal-exhausted",
        eventType: "generation.requested",
        payload: {
          runId: "run-terminal-exhausted",
          conversationId: "conversation-1",
          messageId: "message-terminal-exhausted",
          recoveryOfOutboxId: "outbox-terminal-exhausted",
        },
        status: "PENDING",
        attemptCount: 0,
        idempotencyKey:
          "generation.requested:run-terminal-exhausted:recovery:outbox-terminal-exhausted",
      },
    });
    expect(tx.generationRun.update).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("cancels an exhausted terminal delegation run when a newer step run exists", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-terminal-exhausted-old",
      aggregateId: "run-terminal-exhausted-old",
      status: "PROCESSING",
      attemptCount: 5,
    }]);
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-terminal-exhausted-old",
      status: "PROCESSING",
      inputMessageId: "message-terminal-exhausted-old",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      delegationTaskId: "task-terminal-exhausted",
      delegationTaskStepId: "step-terminal-exhausted",
      runtimePolicySnapshot: null,
    });
    tx.delegationTaskStep.findUnique.mockResolvedValue({
      status: "COMPLETED",
    });
    tx.generationRun.findFirst.mockResolvedValue({
      id: "run-terminal-newer",
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-terminal-exhausted-old" },
      data: {
        status: "CANCELED",
        errorCode: "delegation_step_already_finalized",
        errorMessage:
          "Generation was superseded after its delegation step advanced.",
        canceledAt: expect.any(Date),
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-terminal-exhausted-old" },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      },
    });
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("moves an uncertain external effect to reconciliation on the first expired lease", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-uncertain-effect",
      aggregateId: "run-uncertain-effect",
      status: "PROCESSING",
      attemptCount: 1,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-uncertain-effect",
        aggregateId: "run-uncertain-effect",
        attemptCount: 2,
      })
      .mockResolvedValueOnce({});
    tx.generationRun.findUnique
      .mockResolvedValueOnce({
        id: "run-uncertain-effect",
        status: "PROCESSING",
        delegationTaskId: "task-uncertain-effect",
        delegationTaskStepId: "step-uncertain-effect",
        delegationTaskStep: {
          status: "RUNNING",
          externalEffects: [{ id: "effect-uncertain" }],
        },
      })
      .mockResolvedValueOnce({
        id: "run-uncertain-effect",
        status: "PROCESSING",
        inputMessageId: "message-uncertain-effect",
        outputMessageId: null,
        conversationId: "conversation-1",
        episodeId: "episode-1",
        delegationTaskId: "task-uncertain-effect",
        delegationTaskStepId: "step-uncertain-effect",
        runtimePolicySnapshot: null,
      });
    tx.delegationTaskStep.findUnique.mockResolvedValueOnce({
      status: "RUNNING",
    });
    tx.delegationTaskExternalEffect.updateMany.mockResolvedValueOnce({
      count: 1,
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.delegationTaskExternalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        delegationTaskId: "task-uncertain-effect",
        delegationTaskStepId: "step-uncertain-effect",
        status: "EXECUTING",
      },
      data: {
        status: "RECONCILIATION_REQUIRED",
        failureReason: "delegation_external_effect_lease_lost",
      },
    });
    expect(tx.delegationTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-uncertain-effect",
        status: {
          notIn: ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"],
        },
      },
      data: {
        status: "WAITING_FOR_OWNER",
        nextActionBy: "OWNER",
        blockingReason:
          "Worker lease expired during an external effect. Reconcile the remote outcome before continuing.",
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-uncertain-effect" },
      data: {
        status: "DEAD_LETTER",
        lastError: "delegation_external_effect_lease_lost",
      },
    });
  });

  it("fences a permanently in-flight compute execution before Owner recovery", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-inflight-compute",
      aggregateId: "run-inflight-compute",
      conversationId: "conversation-1",
      delegationTaskId: "task-inflight-compute",
      status: "PROCESSING",
      attemptCount: 5,
    }]);
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-inflight-compute",
      status: "PROCESSING",
      inputMessageId: "message-inflight-compute",
      outputMessageId: null,
      conversationId: "conversation-1",
      episodeId: "episode-1",
      delegationTaskId: "task-inflight-compute",
      delegationTaskStepId: "step-inflight-compute",
      runtimePolicySnapshot: null,
    });
    tx.delegationTaskStep.findUnique.mockResolvedValue({
      status: "RUNNING",
    });
    tx.toolExecution.findUnique.mockResolvedValue({
      id: "execution-inflight-compute",
      sessionId: "session-inflight-compute",
      status: "RUNNING",
      delegationTaskId: "task-inflight-compute",
      delegationTaskStepId: "step-inflight-compute",
      session: {
        generationRunId: "run-inflight-compute",
      },
    });
    tx.toolExecution.updateMany.mockResolvedValue({ count: 1 });
    tx.delegationTaskExternalEffect.updateMany.mockResolvedValue({ count: 0 });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.toolExecution.updateMany).toHaveBeenCalledWith({
      where: {
        id: "execution-inflight-compute",
        status: "RUNNING",
      },
      data: {
        status: "FAILED",
        finishedAt: expect.any(Date),
        executionLeaseToken: null,
      },
    });
    expect(tx.computeSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-inflight-compute" },
      data: {
        status: "IDLE",
        failureReason: "generation_execution_result_unknown",
        lastHeartbeatAt: expect.any(Date),
      },
    });
    expect(tx.delegationTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-inflight-compute",
        status: {
          notIn: ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"],
        },
      },
      data: {
        status: "WAITING_FOR_OWNER",
        nextActionBy: "OWNER",
        blockingReason:
          "Worker lease expired while compute execution was still in flight. Review the unknown result before continuing.",
      },
    });
    expect(tx.delegationTaskStep.updateMany).not.toHaveBeenCalled();
    expect(
      tx.$executeRaw.mock.calls.slice(0, 3).map((call) => call[1]),
    ).toEqual([
      "conversation-1",
      "run-inflight-compute",
      "task-inflight-compute",
    ]);
  });

  it("replays a durable terminal compute result instead of failing its run", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-terminal-compute",
      aggregateId: "run-terminal-compute",
      conversationId: "conversation-1",
      delegationTaskId: "task-terminal-compute",
      status: "PROCESSING",
      attemptCount: 5,
    }]);
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-terminal-compute",
      status: "PROCESSING",
      inputMessageId: "message-terminal-compute",
      outputMessageId: null,
      conversationId: "conversation-1",
      episodeId: "episode-1",
      delegationTaskId: "task-terminal-compute",
      delegationTaskStepId: "step-terminal-compute",
      runtimePolicySnapshot: null,
    });
    tx.delegationTaskStep.findUnique.mockResolvedValue({
      status: "RUNNING",
    });
    tx.toolExecution.findUnique.mockResolvedValue({
      id: "execution-terminal-compute",
      sessionId: "session-terminal-compute",
      status: "SUCCEEDED",
      delegationTaskId: "task-terminal-compute",
      delegationTaskStepId: "step-terminal-compute",
      session: {
        generationRunId: "run-terminal-compute",
      },
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-terminal-compute" },
      data: {
        status: "PENDING",
        attemptCount: 0,
        availableAt: expect.any(Date),
        processedAt: null,
        lastError: "generation_execution_replay_pending",
      },
    });
    expect(tx.toolExecution.updateMany).not.toHaveBeenCalled();
    expect(tx.generationRun.update).not.toHaveBeenCalled();
    expect(tx.delegationTask.updateMany).not.toHaveBeenCalled();
  });

  it("allows a completed-and-sent predecessor before returning terminal delegation recovery", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-terminal-recovery",
      aggregateId: "run-terminal-recovery",
      status: "PENDING",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-terminal-recovery",
      aggregateId: "run-terminal-recovery",
      attemptCount: 1,
    });
    tx.generationRun.findUnique
      .mockResolvedValueOnce({
        id: "run-terminal-recovery",
        status: "PROCESSING",
        delegationTaskId: "task-terminal-recovery",
        delegationTaskStepId: "step-terminal-recovery",
        delegationTask: {
          status: "WAITING_FOR_OWNER",
        },
        delegationTaskStep: {
          status: "BLOCKED",
          externalEffects: [],
          outputs: [{
            artifact: {
              id: "artifact-terminal-recovery",
              kind: "REPORT",
              mimeType: "application/pdf",
              sizeBytes: 4096,
            },
          }],
        },
        contextSnapshot: {
          source: "delegation_plan_step",
          previousGenerationRunId: "run-terminal-recovery-previous",
        },
        representativeVersionId: "representative-version-1",
        episodeId: "episode-1",
        episode: {
          representativeVersionId: "representative-version-1",
        },
        inputMessageId: "message-terminal-recovery",
        inputMessage: {
          id: "message-terminal-recovery",
          text: "recover the finalized step",
          channelBinding: {
            id: "web-binding-terminal-recovery",
            kind: "WEB",
            externalConversationId: "web:conversation-1",
            representativeBinding: {
              status: "CONNECTED",
              desiredState: "ACTIVE",
              healthStatus: "HEALTHY",
            },
          },
        },
        outputMessage: null,
        runtimePolicySnapshot: null,
        startedAt: new Date("2026-07-23T00:00:00.000Z"),
        conversationId: "conversation-1",
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
      })
      .mockResolvedValueOnce({
        status: "COMPLETED",
        outputMessage: {
          deliveryStatus: "SENT",
        },
      });
    tx.generationRun.findFirst.mockResolvedValue({
      id: "run-terminal-recovery",
    });
    tx.generationRun.update.mockResolvedValue({
      id: "run-terminal-recovery",
    });
    tx.message.update.mockResolvedValue({
      id: "message-terminal-recovery",
    });

    await expect(claimNextGenerationWorkItem()).resolves.toMatchObject({
      outboxId: "outbox-terminal-recovery",
      runId: "run-terminal-recovery",
      delegationTerminalRecovery: {
        taskStatus: "WAITING_FOR_OWNER",
        stepStatus: "BLOCKED",
        attachments: [{
          fileName: "report-artifact-terminal-recovery.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4096,
          artifactId: "artifact-terminal-recovery",
          url:
            "/reps/representative/chat/artifacts/artifact-terminal-recovery/download",
        }],
      },
    });

    expect(tx.generationRun.findFirst).toHaveBeenCalledWith({
      where: {
        delegationTaskId: "task-terminal-recovery",
        delegationTaskStepId: "step-terminal-recovery",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    expect(tx.generationRun.findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: "run-terminal-recovery-previous" },
      select: {
        status: true,
        outputMessage: {
          select: { deliveryStatus: true },
        },
      },
    });
    expect(tx.generationRun.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELED" }),
      }),
    );
    expect(tx.outboxEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    );
  });

  it("cancels a terminal delegation run when a newer run exists for the step", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-superseded-terminal",
      aggregateId: "run-superseded-terminal",
      status: "PENDING",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-superseded-terminal",
        aggregateId: "run-superseded-terminal",
        attemptCount: 1,
      })
      .mockResolvedValueOnce({ id: "outbox-superseded-terminal" });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-superseded-terminal",
      status: "PROCESSING",
      delegationTaskId: "task-superseded-terminal",
      delegationTaskStepId: "step-superseded-terminal",
      delegationTask: {
        status: "WAITING_FOR_OWNER",
      },
      delegationTaskStep: {
        status: "BLOCKED",
        externalEffects: [],
        outputs: [],
      },
      contextSnapshot: null,
    });
    tx.generationRun.findFirst.mockResolvedValue({
      id: "run-newer-terminal",
    });
    tx.generationRun.update.mockResolvedValue({
      id: "run-superseded-terminal",
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-superseded-terminal" },
      data: {
        status: "CANCELED",
        errorCode: "delegation_step_already_finalized",
        errorMessage:
          "Generation was superseded after its delegation step advanced.",
        canceledAt: expect.any(Date),
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-superseded-terminal" },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      },
    });
  });

  it.each([
    [
      "is still processing",
      {
        status: "PROCESSING",
        outputMessage: null,
      },
    ],
    [
      "failed and remains retryable",
      {
        status: "FAILED",
        outputMessage: {
          deliveryStatus: "FAILED",
        },
      },
    ],
    [
      "completed but its output is still queued",
      {
        status: "COMPLETED",
        outputMessage: {
          deliveryStatus: "QUEUED",
        },
      },
    ],
  ])("defers a delegated run while its predecessor %s", async (
    _description,
    previousRun,
  ) => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-next-delegation-run",
      aggregateId: "run-next-delegation",
      status: "PENDING",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update
      .mockResolvedValueOnce({
        id: "outbox-next-delegation-run",
        aggregateId: "run-next-delegation",
        attemptCount: 1,
      })
      .mockResolvedValueOnce({ id: "outbox-next-delegation-run" });
    tx.generationRun.findUnique
      .mockResolvedValueOnce({
        id: "run-next-delegation",
        status: "QUEUED",
        delegationTaskId: "task-sequential",
        delegationTaskStepId: "step-next",
        delegationTaskStep: {
          status: "QUEUED",
          externalEffects: [],
          outputs: [],
        },
        contextSnapshot: {
          source: "delegation_plan_step",
          previousGenerationRunId: "run-previous-delegation",
        },
      })
      .mockResolvedValueOnce(previousRun);

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.generationRun.findUnique).toHaveBeenLastCalledWith({
      where: { id: "run-previous-delegation" },
      select: {
        status: true,
        outputMessage: {
          select: { deliveryStatus: true },
        },
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-next-delegation-run" },
      data: {
        status: "PENDING",
        attemptCount: { decrement: 1 },
        availableAt: expect.any(Date),
        lastError: "delegation_previous_generation_not_completed",
      },
    });
    expect(tx.generationRun.update).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("claims a completed Telegram delivery with a legacy null outbox connection when the live bindings still match", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-delivery",
      aggregateId: "run-delivery",
      status: "PROCESSING",
      attemptCount: 1,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-delivery",
      aggregateId: "run-delivery",
      connectionId: null,
    });
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-delivery",
      status: "COMPLETED",
      delegationTaskId: "task-completed",
      delegationTaskStep: {
        status: "COMPLETED",
        externalEffects: [],
      },
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
          connectionId: "111111111",
          representativeAssignmentRevision: 1,
          externalConversationId: "123456",
          representativeBinding: {
            status: "CONNECTED",
            desiredState: "ACTIVE",
            healthStatus: "HEALTHY",
            connectionId: "111111111",
            telegramBotConnectionId: "telegram-connection-a",
            endpointAssignmentRevision: 1,
            telegramBotConnection: {
              id: "telegram-connection-a",
              botId: "111111111",
              status: "ACTIVE",
            },
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
      telegramConnectionId: "111111111",
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
        attemptCount: 1,
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
    expect(tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-matrix-isolated",
        status: "PROCESSING",
        attemptCount: 1,
      },
      data: {
        status: "DEAD_LETTER",
        lastError: "matrix_private_room_not_verified",
      },
    });
  });

  it("cancels queued Matrix work after the representative identity is reassigned", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-matrix-reassigned",
      aggregateId: "run-matrix-reassigned",
      status: "PENDING",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-matrix-reassigned",
      aggregateId: "run-matrix-reassigned",
      attemptCount: 1,
    });
    const matrixBinding = {
      id: "matrix-binding-reassigned",
      kind: "MATRIX",
      representativeAssignmentRevision: 1,
      externalConversationId: "!old-room:example.org",
      metadata: {
        directMessageOnly: true,
        encrypted: false,
        securityState: "ACTIVE",
        audienceMatrixUserId: "@alice:example.org",
        representativeMatrixUserId: "@_delegate_rep_old:example.org",
        representativeAssignmentRevision: 1,
      },
      representativeBinding: {
        status: "CONNECTED",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
        externalUserId: "@_delegate_rep_new:example.org",
        endpointAssignmentRevision: 1,
      },
    };
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-matrix-reassigned",
      status: "QUEUED",
      delegationTaskId: null,
      delegationTaskStepId: null,
      delegationTaskStep: null,
      contextSnapshot: null,
      runtimePolicySnapshot: null,
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-matrix-reassigned",
      inputMessage: {
        id: "message-matrix-reassigned",
        text: "must not generate",
        channelBinding: matrixBinding,
      },
      outputMessage: null,
      conversation: {
        id: "conversation-matrix-reassigned",
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        state: "AI_QUEUED",
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
        channelBindings: [matrixBinding],
      },
    });
    tx.conversationChannelBinding.findFirst.mockResolvedValue({
      kind: "MATRIX",
      externalConversationId: "!old-room:example.org",
      representativeAssignmentRevision: 1,
      metadata: matrixBinding.metadata,
      representativeBinding: {
        endpointAssignmentRevision: 1,
      },
    });

    await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-matrix-reassigned" },
      data: expect.objectContaining({
        status: "CANCELED",
        errorCode: "matrix_identity_reassigned",
      }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-matrix-reassigned" },
      data: expect.objectContaining({
        deliveryStatus: "CANCELED",
        failureCode: "matrix_identity_reassigned",
      }),
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-matrix-reassigned",
        status: "PROCESSING",
        attemptCount: 1,
      },
      data: {
        status: "DEAD_LETTER",
        lastError: "matrix_identity_reassigned",
      },
    });
  });

  it.each([
    ["missing", null],
    ["stale", 1],
  ])(
    "cancels queued Matrix work with a %s channel lifecycle revision",
    async (_case, channelLifecycleRevision) => {
      const suffix = channelLifecycleRevision === null ? "missing" : "stale";
      const runId = `run-matrix-lifecycle-${suffix}`;
      const messageId = `message-matrix-lifecycle-${suffix}`;
      const outboxId = `outbox-matrix-lifecycle-${suffix}`;
      const matrixMetadata = {
        directMessageOnly: true,
        encrypted: false,
        securityState: "ACTIVE",
        audienceMatrixUserId: "@alice:example.org",
        representativeMatrixUserId: "@_delegate_rep:example.org",
        representativeAssignmentRevision: 3,
      };
      const matrixBinding = {
        id: "matrix-binding-lifecycle",
        kind: "MATRIX",
        representativeAssignmentRevision: 3,
        externalConversationId: "!room:example.org",
        metadata: matrixMetadata,
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          externalUserId: "@_delegate_rep:example.org",
          endpointAssignmentRevision: 3,
          endpointLifecycleRevision: 2,
        },
      };
      tx.$queryRaw.mockResolvedValue([{
        id: outboxId,
        aggregateId: runId,
        status: "PENDING",
        attemptCount: 0,
      }]);
      tx.outboxEvent.update.mockResolvedValue({
        id: outboxId,
        aggregateId: runId,
        attemptCount: 1,
      });
      tx.generationRun.findUnique.mockResolvedValue({
        id: runId,
        status: "QUEUED",
        delegationTaskId: null,
        delegationTaskStepId: null,
        delegationTaskStep: null,
        contextSnapshot: null,
        runtimePolicySnapshot: null,
        representativeVersionId: "representative-version-1",
        episodeId: "episode-1",
        episode: {
          representativeVersionId: "representative-version-1",
        },
        inputMessageId: messageId,
        inputMessage: {
          id: messageId,
          text: "must not generate",
          channelLifecycleRevision,
          channelBinding: matrixBinding,
        },
        outputMessage: null,
        conversation: {
          id: "conversation-matrix-lifecycle",
          representativeId: "representative-1",
          contactId: "contact-1",
          audienceIdentityId: "audience-1",
          state: "AI_QUEUED",
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
          channelBindings: [matrixBinding],
        },
      });
      tx.conversationChannelBinding.findFirst.mockResolvedValue({
        kind: "MATRIX",
        externalConversationId: "!room:example.org",
        representativeAssignmentRevision: 3,
        metadata: matrixMetadata,
        representativeBinding: {
          endpointAssignmentRevision: 3,
        },
      });

      await expect(claimNextGenerationWorkItem()).resolves.toBeNull();

      expect(tx.$executeRaw.mock.calls.at(-1)?.[1]).toBe(
        "matrix-room-security:!room:example.org",
      );
      expect(tx.generationRun.update).toHaveBeenCalledWith({
        where: { id: runId },
        data: expect.objectContaining({
          status: "CANCELED",
          errorCode: "matrix_channel_lifecycle_reactivated",
        }),
      });
      expect(tx.message.update).toHaveBeenCalledWith({
        where: { id: messageId },
        data: expect.objectContaining({
          deliveryStatus: "CANCELED",
          failureCode: "matrix_channel_lifecycle_reactivated",
        }),
      });
      expect(tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: outboxId,
          status: "PROCESSING",
          attemptCount: 1,
        },
        data: {
          status: "DEAD_LETTER",
          lastError: "matrix_channel_lifecycle_reactivated",
        },
      });
    },
  );

  it("cancels queued Telegram generation after the representative switches Bots", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-telegram-reassigned-queued",
      aggregateId: "run-telegram-reassigned-queued",
      status: "PENDING",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-telegram-reassigned-queued",
      aggregateId: "run-telegram-reassigned-queued",
      connectionId: "111111111",
      attemptCount: 1,
    });
    const telegramBinding = {
      id: "telegram-binding-reassigned-queued",
      kind: "TELEGRAM",
      connectionId: "111111111",
      externalConversationId: "123456",
      representativeBinding: {
        status: "CONFIGURED",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
        connectionId: "222222222",
        telegramBotConnectionId: "telegram-connection-b",
        telegramBotConnection: {
          id: "telegram-connection-b",
          botId: "222222222",
        },
      },
    };
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-telegram-reassigned-queued",
      status: "QUEUED",
      delegationTaskId: null,
      delegationTaskStepId: null,
      delegationTaskStep: null,
      contextSnapshot: null,
      runtimePolicySnapshot: null,
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-telegram-inbound-queued",
      inputMessage: {
        id: "message-telegram-inbound-queued",
        text: "hello from Bot A",
        channelBinding: telegramBinding,
      },
      outputMessage: null,
      conversation: {
        id: "conversation-telegram-reassigned-queued",
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        state: "AI_QUEUED",
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
        channelBindings: [telegramBinding],
      },
    });

    await expect(claimNextGenerationWorkItem({
      telegramWorkerEnabled: true,
    })).resolves.toBeNull();

    expect(tx.generationRun.update).toHaveBeenCalledWith({
      where: { id: "run-telegram-reassigned-queued" },
      data: {
        status: "CANCELED",
        errorCode: "telegram_connection_reassigned",
        errorMessage:
          "Generation canceled because this Telegram conversation belongs to a previously assigned Bot.",
        canceledAt: expect.any(Date),
      },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-telegram-inbound-queued" },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "telegram_connection_reassigned",
        failureReason:
          "This Telegram conversation belongs to a previously assigned Bot.",
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-telegram-reassigned-queued" },
      data: {
        status: "DEAD_LETTER",
        lastError: "telegram_connection_reassigned",
      },
    });
  });

  it("dead-letters completed Telegram delivery after the representative switches Bots", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-telegram-reassigned",
      aggregateId: "run-telegram-reassigned",
      status: "PENDING",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-telegram-reassigned",
      aggregateId: "run-telegram-reassigned",
      connectionId: "111111111",
      attemptCount: 1,
    });
    const telegramBinding = {
      id: "telegram-binding-reassigned",
      kind: "TELEGRAM",
      connectionId: "111111111",
      externalConversationId: "123456",
      representativeBinding: {
        status: "CONFIGURED",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
        connectionId: "222222222",
        telegramBotConnectionId: "telegram-connection-b",
        telegramBotConnection: {
          id: "telegram-connection-b",
          botId: "222222222",
        },
      },
    };
    tx.generationRun.findUnique.mockResolvedValue({
      id: "run-telegram-reassigned",
      status: "COMPLETED",
      delegationTaskId: null,
      delegationTaskStepId: null,
      delegationTaskStep: null,
      contextSnapshot: null,
      representativeVersionId: "representative-version-1",
      episodeId: "episode-1",
      episode: {
        representativeVersionId: "representative-version-1",
      },
      inputMessageId: "message-telegram-inbound",
      inputMessage: {
        id: "message-telegram-inbound",
        text: "hello from Bot A",
        channelBinding: telegramBinding,
      },
      outputMessage: {
        id: "message-telegram-output",
        text: "must not be sent",
        externalMessageId: null,
      },
      conversation: {
        id: "conversation-telegram-reassigned",
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
        channelBindings: [telegramBinding],
      },
    });

    await expect(claimNextGenerationWorkItem({
      telegramWorkerEnabled: true,
    })).resolves.toBeNull();

    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message-telegram-output",
        deliveryStatus: {
          in: ["QUEUED", "PROCESSING", "FAILED"],
        },
      },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "telegram_connection_reassigned",
        failureReason:
          "Telegram delivery was canceled because this conversation belongs to a previously assigned Bot.",
      },
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "outbox-telegram-reassigned",
        aggregateType: "generation_run",
        aggregateId: "run-telegram-reassigned",
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: 1,
      },
      data: {
        status: "DEAD_LETTER",
        processedAt: expect.any(Date),
        lastError: "telegram_connection_reassigned",
      },
    });
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: "message-telegram-output",
        attemptNumber: 1,
        status: { in: ["QUEUED", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "CANCELED",
        failureCode: "telegram_connection_reassigned",
      }),
    });
  });

  it("rejects delivery availability for a historical Telegram conversation after Bot reassignment", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      state: "WAITING_USER",
      representative: {
        lifecycleState: "PUBLISHED",
        activeVersionId: "representative-version-1",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      channelBindings: [{
        metadata: null,
        connectionId: "111111111",
        representativeBinding: {
          status: "CONFIGURED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          connectionId: "222222222",
          telegramBotConnectionId: "telegram-connection-b",
          telegramBotConnection: {
            id: "telegram-connection-b",
            botId: "222222222",
          },
        },
      }],
    });

    await expect(
      assertConversationChannelDeliveryAvailable({
        conversationId: "conversation-telegram-reassigned",
        channel: "telegram",
        senderMode: "ai",
      }),
    ).rejects.toMatchObject({
      name: "ChannelUnavailableError",
      code: "telegram_connection_reassigned",
    });
  });

  it("rejects delivery availability for a historical Matrix room after identity reassignment", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      state: "WAITING_USER",
      representative: {
        lifecycleState: "PUBLISHED",
        activeVersionId: "representative-version-1",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      channelBindings: [{
        metadata: {
          directMessageOnly: true,
          encrypted: false,
          securityState: "ACTIVE",
          audienceMatrixUserId: "@alice:example.org",
          representativeMatrixUserId:
            "@_delegate_rep_old:example.org",
        },
        connectionId: "delegate-matrix-as",
        representativeBinding: {
          status: "CONFIGURED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          externalUserId: "@_delegate_rep_new:example.org",
        },
      }],
    });

    await expect(
      assertConversationChannelDeliveryAvailable({
        conversationId: "conversation-matrix-reassigned",
        channel: "matrix",
        senderMode: "ai",
      }),
    ).rejects.toMatchObject({
      name: "ChannelUnavailableError",
      code: "matrix_identity_reassigned",
    });
  });

  it("allows a system task-status delivery while a human controls the conversation", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      state: "HUMAN_ACTIVE",
      representative: {
        lifecycleState: "PUBLISHED",
        activeVersionId: "representative-version-1",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      channelBindings: [{
        id: "web-binding-system",
        kind: "WEB",
        metadata: null,
        connectionId: "web",
        representativeAssignmentRevision: 1,
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          connectionId: "web",
          endpointAssignmentRevision: 1,
          telegramBotConnectionId: null,
          telegramBotConnection: null,
        },
      }],
    });

    await expect(assertConversationChannelDeliveryAvailable({
      conversationId: "conversation-human-active-system",
      channel: "web",
      senderMode: "system",
      allowNeedsHumanDelivery: true,
    })).resolves.toBeUndefined();

    await expect(assertConversationChannelDeliveryAvailable({
      conversationId: "conversation-human-active-system",
      channel: "web",
      senderMode: "ai",
      allowNeedsHumanDelivery: true,
    })).rejects.toMatchObject({
      code: "CONVERSATION_HUMAN_ACTIVE",
    });
  });

  it("dead-letters an Operator reply queued for a previously assigned Telegram Bot", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-operator-reassigned",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-operator-reassigned",
      aggregateId: "message-operator-reassigned",
      connectionId: "111111111",
    });
    tx.message.findUnique.mockResolvedValue({
      id: "message-operator-reassigned",
      conversationId: "conversation-telegram-reassigned",
      text: "operator reply",
      senderDisplayName: "Owner",
      externalMessageId: null,
      channelBinding: {
        kind: "TELEGRAM",
        connectionId: "111111111",
        externalConversationId: "123456",
        representativeBinding: {
          connectionId: "222222222",
          telegramBotConnectionId: "telegram-connection-b",
          telegramBotConnection: {
            id: "telegram-connection-b",
            botId: "222222222",
          },
        },
      },
      conversation: {
        representative: {
          id: "representative-1",
          ownerId: "owner-1",
        },
      },
    });

    await expect(claimNextOperatorMessageWorkItem({
      telegramWorkerEnabled: true,
    })).resolves.toBeNull();

    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-operator-reassigned" },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "telegram_connection_reassigned",
        failureReason:
          "Telegram delivery was canceled because this conversation belongs to a previously assigned Bot.",
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-operator-reassigned" },
      data: {
        status: "DEAD_LETTER",
        lastError: "telegram_connection_reassigned",
      },
    });
  });

  it("dead-letters an Operator reply queued for a reassigned Matrix identity", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-operator-matrix-reassigned",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-operator-matrix-reassigned",
      aggregateId: "message-operator-matrix-reassigned",
      connectionId: "delegate-matrix-as",
    });
    tx.message.findUnique.mockResolvedValue({
      id: "message-operator-matrix-reassigned",
      conversationId: "conversation-matrix-reassigned",
      text: "operator reply",
      senderDisplayName: "Owner",
      externalMessageId: null,
      channelBinding: {
        kind: "MATRIX",
        connectionId: "delegate-matrix-as",
        externalConversationId: "!old-room:example.org",
        metadata: {
          directMessageOnly: true,
          encrypted: false,
          securityState: "ACTIVE",
          audienceMatrixUserId: "@alice:example.org",
          representativeMatrixUserId:
            "@_delegate_rep_old:example.org",
        },
        representativeBinding: {
          externalUserId: "@_delegate_rep_new:example.org",
        },
      },
      conversation: {
        representative: {
          id: "representative-1",
          ownerId: "owner-1",
        },
      },
    });

    await expect(claimNextOperatorMessageWorkItem()).resolves.toBeNull();

    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-operator-matrix-reassigned" },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "matrix_identity_reassigned",
        failureReason:
          "Matrix delivery was canceled because this room belongs to a previously assigned representative identity.",
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-operator-matrix-reassigned" },
      data: {
        status: "DEAD_LETTER",
        lastError: "matrix_identity_reassigned",
      },
    });
  });

  it("dead-letters an Operator reply from an earlier Matrix channel activation", async () => {
    tx.$queryRaw.mockResolvedValue([{
      id: "outbox-operator-matrix-stale-lifecycle",
      attemptCount: 0,
    }]);
    tx.outboxEvent.update.mockResolvedValue({
      id: "outbox-operator-matrix-stale-lifecycle",
      aggregateId: "message-operator-matrix-stale-lifecycle",
      connectionId: "delegate-matrix-as",
    });
    tx.message.findUnique.mockResolvedValue({
      id: "message-operator-matrix-stale-lifecycle",
      conversationId: "conversation-matrix-lifecycle",
      text: "operator reply",
      senderDisplayName: "Owner",
      externalMessageId: null,
      channelLifecycleRevision: 1,
      channelBinding: {
        kind: "MATRIX",
        connectionId: "delegate-matrix-as",
        externalConversationId: "!room:example.org",
        representativeAssignmentRevision: 3,
        metadata: {
          directMessageOnly: true,
          encrypted: false,
          securityState: "ACTIVE",
          audienceMatrixUserId: "@alice:example.org",
          representativeMatrixUserId: "@_delegate_rep:example.org",
          representativeAssignmentRevision: 3,
        },
        representativeBinding: {
          externalUserId: "@_delegate_rep:example.org",
          endpointAssignmentRevision: 3,
          endpointLifecycleRevision: 2,
        },
      },
      conversation: {
        representative: {
          id: "representative-1",
          ownerId: "owner-1",
        },
      },
    });

    await expect(claimNextOperatorMessageWorkItem()).resolves.toBeNull();

    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-operator-matrix-stale-lifecycle" },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "matrix_channel_lifecycle_reactivated",
        failureReason:
          "Matrix delivery was canceled because it belongs to an earlier channel activation.",
      },
    });
    expect(tx.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: "outbox-operator-matrix-stale-lifecycle" },
      data: {
        status: "DEAD_LETTER",
        lastError: "matrix_channel_lifecycle_reactivated",
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
        connectionId: "111111111",
      })
      .mockResolvedValueOnce({ id: "outbox-operator" });
    tx.message.findUnique.mockResolvedValue({
      id: "message-operator",
      conversationId: "conversation-1",
      text: "operator reply",
      senderDisplayName: "Owner",
      channelBinding: {
        kind: "TELEGRAM",
        connectionId: "111111111",
        representativeAssignmentRevision: 1,
        externalConversationId: "123456",
        representativeBinding: {
          connectionId: "111111111",
          telegramBotConnectionId: "telegram-connection-a",
          endpointAssignmentRevision: 1,
          telegramBotConnection: {
            id: "telegram-connection-a",
            botId: "111111111",
            status: "ACTIVE",
          },
        },
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
    tx.message.findUnique.mockResolvedValue({
      conversationId: "conversation-operator-paused",
    });

    await expect(deferOperatorMessageDelivery({
      outboxId: "operator-outbox-paused",
      leaseAttempt: 1,
      messageId: "operator-message-paused",
      reason: "channel_paused",
      retryAfterMs: 60_000,
    })).resolves.toBe(true);

    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "operator-outbox-paused",
        status: "PROCESSING",
        attemptCount: 1,
      },
      data: {
        status: "PENDING",
        attemptCount: { decrement: 1 },
        availableAt: expect.any(Date),
        processedAt: null,
        lastError: "channel_paused",
      },
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "operator-message-paused",
        deliveryStatus: "PROCESSING",
      },
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
