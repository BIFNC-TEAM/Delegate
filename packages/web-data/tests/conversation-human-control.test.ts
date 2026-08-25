import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    conversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationAssignment: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    conversationEpisode: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationStateTransition: {
      create: vi.fn(),
    },
    handoffRequest: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workflowRun: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workflowCommandOutbox: {
      create: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    lead: {
      updateMany: vi.fn(),
    },
    message: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    messageRevision: {
      create: vi.fn(),
    },
    generationRun: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    outboxEvent: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    approvalRequest: {
      updateMany: vi.fn(),
    },
    delegationTask: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    delegationTaskStep: {
      updateMany: vi.fn(),
    },
    delegationTaskExternalEffect: {
      updateMany: vi.fn(),
    },
  };

  return {
    tx,
    prisma: {
      $transaction: vi.fn(),
    },
    releaseConversationWalletUsage: vi.fn(),
    transferAgentUsageEntitlementReservation: vi.fn(),
    releaseConversationEntitlementByGenerationRunId: vi.fn(),
    transferConversationEntitlementByGenerationRunId: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../src/agent-wallet-usage-charge", () => ({
  InsufficientAgentUsageCreditsError:
    class InsufficientAgentUsageCreditsError extends Error {},
  releaseConversationWalletUsage: mocks.releaseConversationWalletUsage,
  reserveConversationWalletUsage: vi.fn(),
  settleConversationWalletUsage: vi.fn(),
  transferAgentUsageEntitlementReservation:
    mocks.transferAgentUsageEntitlementReservation,
}));
vi.mock("../src/service-entitlements", () => ({
  consumeConversationEntitlement: vi.fn(),
  releaseConversationEntitlement: vi.fn(),
  releaseConversationEntitlementByGenerationRunId:
    mocks.releaseConversationEntitlementByGenerationRunId,
  reserveConversationEntitlement: vi.fn(),
  transferConversationEntitlementByGenerationRunId:
    mocks.transferConversationEntitlementByGenerationRunId,
}));

import {
  assignConversationOperator,
  controlPublicAudienceHandoff,
  editConversationMessage,
} from "../src/conversation-platform";

const conversationId = "conversation-human-control";
const episodeId = "episode-human-control";
const inputMessageId = "message-human-control";
const processingRunId = "run-processing";
const replacementRunId = "run-replacement";
const generationOutboxId = "outbox-processing";

const walletReservation = {
  usageChargeId: "usage-reserved",
  tokenAmount: 1,
};

const processingRun = {
  id: processingRunId,
  conversationId,
  episodeId,
  inputMessageId,
  outputMessageId: null,
  representativeVersionId: "representative-version-1",
  status: "PROCESSING",
  runtimePolicySnapshot: {
    billingMode: "service_credit",
    walletReservation,
  },
  createdAt: new Date("2026-07-24T08:00:00.000Z"),
};

describe("conversation human control and message-edit fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.prisma.$transaction.mockImplementation(
      async (
        callback: (client: typeof mocks.tx) => unknown,
      ) => callback(mocks.tx),
    );
    mocks.tx.$executeRaw.mockResolvedValue(0);
    mocks.tx.conversation.findUnique.mockResolvedValue({
      id: conversationId,
      representativeId: "representative-1",
      contactId: "contact-1",
      audienceIdentityId: null,
      representative: {
        humanInLoop: true,
        handoffAccessMode: "FREE",
      },
    });
    mocks.tx.conversation.update.mockResolvedValue({ id: conversationId });
    mocks.tx.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.conversationAssignment.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.conversationAssignment.create.mockResolvedValue({
      id: "assignment-1",
      conversationId,
      episodeId,
      operatorId: "operator-1",
      operatorName: "Operator",
    });
    mocks.tx.conversationEpisode.update.mockResolvedValue({ id: episodeId });
    mocks.tx.conversationEpisode.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.conversationStateTransition.create.mockResolvedValue({
      id: "transition-1",
    });
    mocks.tx.handoffRequest.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.handoffRequest.findFirst.mockResolvedValue(null);
    mocks.tx.handoffRequest.findUnique.mockResolvedValue(null);
    mocks.tx.handoffRequest.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        representativeId: "representative-1",
        contactId: "contact-1",
        audienceIdentityId: "audience-1",
        conversationId,
        handoffEntitlementGrantId: null,
        status: "CLOSED",
        ...data,
      }),
    );
    mocks.tx.workflowRun.findMany.mockResolvedValue([]);
    mocks.tx.workflowRun.update.mockResolvedValue({ id: "workflow-1" });
    mocks.tx.workflowCommandOutbox.create.mockResolvedValue({ id: "command-1" });
    mocks.tx.eventAudit.create.mockResolvedValue({ id: "audit-1" });
    mocks.tx.lead.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.message.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "system-message-1",
        ...data,
      }),
    );
    mocks.tx.message.update.mockResolvedValue({ id: inputMessageId });
    mocks.tx.message.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.messageRevision.create.mockResolvedValue({
      id: "revision-1",
      messageId: inputMessageId,
      version: 1,
      text: "edited request",
      editedBy: "@alice:example.org",
    });
    mocks.tx.generationRun.findMany.mockResolvedValue([processingRun]);
    mocks.tx.generationRun.findUnique.mockResolvedValue(processingRun);
    mocks.tx.generationRun.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...processingRun,
        ...data,
      }),
    );
    mocks.tx.generationRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.generationRun.create.mockResolvedValue({
      ...processingRun,
      id: replacementRunId,
      status: "QUEUED",
    });
    mocks.tx.outboxEvent.findMany.mockResolvedValue([{
      id: generationOutboxId,
      aggregateId: processingRunId,
      status: "PROCESSING",
    }]);
    mocks.tx.outboxEvent.create.mockResolvedValue({
      id: "outbox-replacement",
      aggregateId: replacementRunId,
    });
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.delegationTask.findMany.mockResolvedValue([]);
    mocks.tx.delegationTask.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.delegationTaskStep.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.delegationTaskExternalEffect.updateMany.mockResolvedValue({
      count: 0,
    });
    mocks.releaseConversationWalletUsage.mockResolvedValue({ status: "released" });
    mocks.transferAgentUsageEntitlementReservation.mockResolvedValue({
      id: "usage-reserved",
      status: "reserved",
      generationRunId: replacementRunId,
    });
    mocks.releaseConversationEntitlementByGenerationRunId.mockResolvedValue(null);
    mocks.transferConversationEntitlementByGenerationRunId.mockResolvedValue(null);
  });

  it("lets the audience cancel an unaccepted handoff and releases its workflow", async () => {
    const handoff = {
      id: "handoff-open",
      representativeId: "representative-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      conversationId,
      status: "OPEN",
      handoffEntitlementGrantId: null,
      createdAt: new Date("2026-07-24T08:00:00.000Z"),
    };
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      representativeId: "representative-1",
      contactId: "contact-1",
      state: "NEEDS_HUMAN",
      episodes: [{ id: episodeId, status: "NEEDS_HUMAN" }],
      assignments: [],
    });
    mocks.tx.handoffRequest.findFirst.mockResolvedValueOnce(handoff);
    mocks.tx.handoffRequest.findUnique.mockResolvedValue(handoff);
    mocks.tx.workflowRun.findMany.mockResolvedValueOnce([{
      id: "workflow-handoff",
      engine: "TEMPORAL",
      externalWorkflowId: "handoff-workflow-1",
    }]);

    await expect(controlPublicAudienceHandoff({
      representativeSlug: "representative",
      audienceIdentityId: "audience-1",
      audienceId: "audience-session-1",
      action: "cancel_request",
    })).resolves.toMatchObject({
      action: "cancel_request",
      changed: true,
      conversationState: "active",
      message: {
        id: "system-message-1",
      },
    });

    expect(mocks.tx.handoffRequest.update).toHaveBeenCalledWith({
      where: { id: "handoff-open" },
      data: { status: "CLOSED" },
    });
    expect(mocks.tx.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "workflow-handoff" },
      data: expect.objectContaining({
        status: "CANCELED",
        enginePhase: "CANCEL_REQUESTED",
        output: { outcome: "audience_canceled_handoff_request" },
      }),
    });
    expect(mocks.tx.workflowCommandOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowRunId: "workflow-handoff",
        commandType: "CANCEL",
      }),
    });
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: {
        state: "ACTIVE",
        assignedOperatorId: null,
        lastMessageAt: expect.any(Date),
      },
    });
    expect(mocks.tx.eventAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "HANDOFF_RESOLVED",
        payload: expect.objectContaining({ actorType: "audience" }),
      }),
    });
  });

  it("lets the audience end active human service without restoring consumed access", async () => {
    const acceptedHandoff = {
      id: "handoff-accepted",
      representativeId: "representative-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      conversationId,
      status: "ACCEPTED",
      handoffEntitlementGrantId: null,
      createdAt: new Date("2026-07-24T08:00:00.000Z"),
    };
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      representativeId: "representative-1",
      contactId: "contact-1",
      state: "HUMAN_ACTIVE",
      episodes: [{ id: episodeId, status: "HUMAN_ACTIVE" }],
      assignments: [{ id: "assignment-1" }],
    });
    mocks.tx.handoffRequest.findFirst.mockResolvedValueOnce(acceptedHandoff);
    mocks.tx.handoffRequest.findUnique.mockResolvedValue(acceptedHandoff);

    await expect(controlPublicAudienceHandoff({
      representativeSlug: "representative",
      audienceIdentityId: "audience-1",
      audienceId: "audience-session-1",
      action: "end_human_service",
    })).resolves.toMatchObject({
      action: "end_human_service",
      changed: true,
      conversationState: "active",
      message: {
        id: "system-message-1",
      },
    });

    expect(mocks.tx.conversationAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        conversationId,
        status: "ACTIVE",
      },
      data: {
        status: "RELEASED",
        releasedAt: expect.any(Date),
        releaseReason: "audience_returned_to_ai",
      },
    });
    expect(mocks.tx.handoffRequest.update).toHaveBeenCalledWith({
      where: { id: "handoff-accepted" },
      data: { status: "CLOSED" },
    });
    expect(mocks.tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        text: "The audience ended human service. The digital representative may continue.",
      }),
    });
  });

  it("re-reads human control after the conversation lock before canceling", async () => {
    mocks.tx.conversation.findFirst
      .mockResolvedValueOnce({ id: conversationId })
      .mockResolvedValueOnce({
        id: conversationId,
        representativeId: "representative-1",
        contactId: "contact-1",
        state: "HUMAN_ACTIVE",
        episodes: [{ id: episodeId, status: "HUMAN_ACTIVE" }],
        assignments: [{ id: "assignment-concurrent" }],
      });

    await expect(controlPublicAudienceHandoff({
      representativeSlug: "representative",
      audienceIdentityId: "audience-1",
      audienceId: "audience-session-1",
      action: "cancel_request",
    })).rejects.toMatchObject({
      code: "human_service_active",
      statusCode: 409,
    });

    expect(mocks.tx.handoffRequest.update).not.toHaveBeenCalled();
    expect(mocks.tx.conversationAssignment.updateMany).not.toHaveBeenCalled();
  });

  it("fences and terminates active generation work before an operator takes control", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      state: "PROCESSING",
      representativeId: "representative-1",
      contactId: "contact-1",
      episodes: [{
        id: episodeId,
        sequence: 1,
        status: "ACTIVE",
      }],
      generationRuns: [processingRun],
    });

    await assignConversationOperator({
      representativeSlug: "representative",
      conversationId,
      operatorId: "operator-1",
      operatorName: "Operator",
    });

    expect(lockInvocationOrder(conversationId)).toBeDefined();
    expect(lockInvocationOrder(processingRunId)).toBeDefined();
    expect(mocks.tx.generationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: processingRunId,
          status: expect.objectContaining({
            in: expect.arrayContaining(["PROCESSING"]),
          }),
        }),
        data: expect.objectContaining({
          status: "WAITING_HUMAN",
        }),
      }),
    );
    expect(hasOutboxTerminalization(processingRunId)).toBe(true);
    expect(mocks.tx.approvalRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          generationRunId: processingRunId,
          status: "PENDING",
        }),
        data: expect.objectContaining({
          status: "REJECTED",
          resolvedAt: expect.any(Date),
        }),
      }),
    );
    expect(
      mocks.releaseConversationEntitlementByGenerationRunId,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ generationRunId: processingRunId }),
      mocks.tx,
    );
  });

  it("preserves a reply when the locked reload observes that generation already completed", async () => {
    mockEditableMessage(processingRun);
    mocks.tx.generationRun.findUnique.mockResolvedValue({
      ...processingRun,
      status: "COMPLETED",
      outputMessageId: "message-output",
    });

    const result = await editConversationMessage({
      representativeSlug: "representative",
      conversationId,
      messageId: inputMessageId,
      text: "edited request",
      editedBy: "@alice:example.org",
    });

    expect(result.action).toBe("preserve_reply");
    const runLockOrder = lockInvocationOrder(processingRunId);
    expect(runLockOrder).toBeDefined();
    expect(
      mocks.tx.generationRun.findUnique.mock.invocationCallOrder[0],
    ).toBeGreaterThan(runLockOrder!);
    expect(mocks.tx.generationRun.create).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(
      mocks.releaseConversationEntitlementByGenerationRunId,
    ).not.toHaveBeenCalled();
  });

  it("atomically cancels the old run and transfers its wallet reservation to one replacement", async () => {
    mockEditableMessage(processingRun);

    const result = await editConversationMessage({
      representativeSlug: "representative",
      conversationId,
      messageId: inputMessageId,
      text: "edited request",
      editedBy: "@alice:example.org",
    });

    expect(result.action).toBe("cancel_and_requeue");
    expect(lockInvocationOrder(conversationId)).toBeDefined();
    expect(lockInvocationOrder(processingRunId)).toBeDefined();
    expect(mocks.tx.generationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: processingRunId,
          status: expect.objectContaining({
            in: expect.arrayContaining(["PROCESSING"]),
          }),
        }),
        data: expect.objectContaining({
          status: "CANCELED",
          canceledAt: expect.any(Date),
        }),
      }),
    );
    expect(hasOutboxTerminalization(processingRunId)).toBe(true);
    expect(
      mocks.transferConversationEntitlementByGenerationRunId,
    ).toHaveBeenCalledWith(
      {
        fromGenerationRunId: processingRunId,
        toGenerationRunId: replacementRunId,
      },
      mocks.tx,
    );
    expect(
      mocks.transferAgentUsageEntitlementReservation,
    ).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-reserved",
        fromGenerationRunId: processingRunId,
        toGenerationRunId: replacementRunId,
        conversationId,
      },
      mocks.tx,
    );
    expect(mocks.tx.generationRun.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.outboxEvent.create).toHaveBeenCalledTimes(1);

    const replacementCreate = mocks.tx.generationRun.create.mock.calls[0]?.[0];
    expect(replacementCreate).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          runtimePolicySnapshot: expect.objectContaining({
            walletReservation,
          }),
        }),
      }),
    );

    const transferredSnapshot = oldRunMutationSnapshots(processingRunId).find(
      (snapshot) =>
        snapshot
        && typeof snapshot === "object"
        && !Array.isArray(snapshot)
        && !("walletReservation" in snapshot),
    ) as Record<string, unknown> | undefined;
    expect(transferredSnapshot).toEqual(
      expect.objectContaining({
        billingTransferredToGenerationRunId: replacementRunId,
      }),
    );
    expect(transferredSnapshot).not.toHaveProperty("walletReservation");
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("edits text without reactivating AI while the conversation needs a human", async () => {
    mockEditableMessage(processingRun, "NEEDS_HUMAN");

    const result = await editConversationMessage({
      representativeSlug: "representative",
      conversationId,
      messageId: inputMessageId,
      text: "edited request",
      editedBy: "@alice:example.org",
    });

    expect(result.action).toBe("update_only");
    expect(mocks.tx.generationRun.create).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(mocks.tx.conversation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "AI_QUEUED" }),
      }),
    );
    expect(mocks.tx.conversationEpisode.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
  });

  it("claims the Telegram update-id watermark in the same write transaction", async () => {
    mockEditableMessage(processingRun, "NEEDS_HUMAN");

    const result = await editConversationMessage({
      representativeSlug: "representative",
      conversationId,
      messageId: inputMessageId,
      text: "newest Telegram request",
      editedBy: "telegram:123456",
      telegramGuard: {
        connectionId: "777000",
        chatId: "123456",
        senderId: "123456",
        externalMessageId: "77",
        updateId: 43,
        editedAt: "2026-08-06T12:01:00.000Z",
      },
    });

    expect(result.providerEditStatus).toBe("applied");
    const watermarkClaim = mocks.tx.message.updateMany.mock.calls.find(
      ([args]) => args?.data?.telegramLastEditUpdateId === 43n,
    );
    expect(watermarkClaim?.[0]).toEqual({
      where: {
        id: inputMessageId,
        conversationId,
        OR: [
          {
            telegramLastEditAt: null,
            telegramLastEditUpdateId: null,
          },
          { telegramLastEditUpdateId: { lt: 43n } },
        ],
      },
      data: {
        telegramLastEditAt: new Date("2026-08-06T12:01:00.000Z"),
        telegramLastEditUpdateId: 43n,
      },
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.messageRevision.create).toHaveBeenCalledTimes(1);
  });

  it("does not allow a delayed older Telegram update to overwrite the body", async () => {
    mockEditableMessage(processingRun, "NEEDS_HUMAN");
    mocks.tx.message.updateMany.mockImplementation(async ({ data }) =>
      data.telegramLastEditUpdateId === 42n ? { count: 0 } : { count: 1 }
    );

    const result = await editConversationMessage({
      representativeSlug: "representative",
      conversationId,
      messageId: inputMessageId,
      text: "older Telegram request",
      editedBy: "telegram:123456",
      telegramGuard: {
        connectionId: "777000",
        chatId: "123456",
        senderId: "123456",
        externalMessageId: "77",
        updateId: 42,
        editedAt: "2026-08-06T12:02:00.000Z",
      },
    });

    expect(result).toMatchObject({
      action: "update_only",
      providerEditStatus: "superseded",
    });
    expect(mocks.tx.messageRevision.create).not.toHaveBeenCalled();
    expect(mocks.tx.message.update).not.toHaveBeenCalled();
  });

  it("rejects a Telegram edit whose complete provider scope does not match", async () => {
    mockEditableMessage(processingRun, "NEEDS_HUMAN");

    await expect(editConversationMessage({
      representativeSlug: "representative",
      conversationId,
      messageId: inputMessageId,
      text: "cross-chat edit",
      editedBy: "telegram:123456",
      telegramGuard: {
        connectionId: "777000",
        chatId: "different-chat",
        senderId: "123456",
        externalMessageId: "77",
        updateId: 44,
        editedAt: "2026-08-06T12:03:00.000Z",
      },
    })).rejects.toThrow("Telegram message edit scope is invalid.");

    expect(mocks.tx.message.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.messageRevision.create).not.toHaveBeenCalled();
  });

  it("does not reinterpret a delegated task authorization as a normal message edit", async () => {
    mockEditableMessage({
      ...processingRun,
      delegationTaskId: "delegation-task-1",
    } as typeof processingRun);

    await expect(
      editConversationMessage({
        representativeSlug: "representative",
        conversationId,
        messageId: inputMessageId,
        text: "edited request",
        editedBy: "@alice:example.org",
      }),
    ).rejects.toThrow("Cancel the task and submit a new message");

    expect(mocks.tx.messageRevision.create).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.create).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("requires explicit delegation cancellation before operator takeover", async () => {
    const delegatedRun = {
      ...processingRun,
      delegationTaskId: "delegation-task-1",
      delegationTaskStepId: "delegation-step-1",
    };
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      state: "PROCESSING",
      representativeId: "representative-1",
      contactId: "contact-1",
      episodes: [{
        id: episodeId,
        sequence: 1,
        status: "ACTIVE",
      }],
    });
    mocks.tx.delegationTask.findMany.mockResolvedValue([
      { id: "delegation-task-1" },
    ]);
    mocks.tx.generationRun.findMany.mockResolvedValue([delegatedRun]);
    mocks.tx.generationRun.findUnique.mockResolvedValue(delegatedRun);

    await expect(
      assignConversationOperator({
        representativeSlug: "representative",
        conversationId,
        operatorId: "operator-1",
        operatorName: "Operator",
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_DELEGATION_TASK" });

    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
    expect(mocks.tx.generationRun.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.conversationAssignment.create).not.toHaveBeenCalled();
  });

  it("does not bypass package-required handoff access during direct takeover", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      state: "NEEDS_HUMAN",
      representativeId: "representative-1",
      contactId: "contact-1",
      episodes: [{
        id: episodeId,
        sequence: 1,
        status: "NEEDS_HUMAN",
      }],
    });
    mocks.tx.conversation.findUnique.mockResolvedValue({
      id: conversationId,
      representativeId: "representative-1",
      contactId: "contact-1",
      audienceIdentityId: "audience-1",
      representative: {
        humanInLoop: true,
        handoffAccessMode: "PACKAGE_REQUIRED",
      },
    });
    mocks.tx.handoffRequest.findFirst.mockResolvedValue(null);

    await expect(assignConversationOperator({
      representativeSlug: "representative",
      conversationId,
      operatorId: "operator-1",
      operatorName: "Operator",
    })).rejects.toMatchObject({ code: "HANDOFF_ENTITLEMENT_REQUIRED" });

    expect(mocks.tx.generationRun.findMany).not.toHaveBeenCalled();
    expect(mocks.tx.conversationAssignment.create).not.toHaveBeenCalled();
  });

  it("cancels a completed reply that has not crossed the channel delivery fence", async () => {
    const completedRun = {
      ...processingRun,
      status: "COMPLETED",
      outputMessageId: "message-output-pending",
      completedAt: new Date("2026-07-24T08:01:00.000Z"),
    };
    mocks.tx.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      state: "WAITING_USER",
      representativeId: "representative-1",
      contactId: "contact-1",
      episodes: [{
        id: episodeId,
        sequence: 1,
        status: "WAITING_USER",
      }],
    });
    mocks.tx.generationRun.findMany.mockResolvedValue([completedRun]);
    mocks.tx.generationRun.findUnique.mockResolvedValue(completedRun);

    await assignConversationOperator({
      representativeSlug: "representative",
      conversationId,
      operatorId: "operator-1",
      operatorName: "Operator",
    });

    expect(hasOutboxTerminalization(completedRun.id)).toBe(true);
    expect(mocks.tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: completedRun.outputMessageId,
        deliveryStatus: { in: ["PROCESSING", "QUEUED", "FAILED"] },
      },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "operator_takeover_before_delivery",
        failureReason:
          "AI delivery was canceled because a human operator took control.",
      },
    });
    expect(mocks.tx.generationRun.updateMany).not.toHaveBeenCalled();
    expect(
      mocks.releaseConversationEntitlementByGenerationRunId,
    ).not.toHaveBeenCalled();
    expect(mocks.releaseConversationWalletUsage).not.toHaveBeenCalled();
  });
});

function mockEditableMessage(
  run: typeof processingRun,
  conversationState = "PROCESSING",
) {
  mocks.tx.message.findFirst.mockResolvedValue({
    id: inputMessageId,
    conversationId,
    episodeId,
    text: "original request",
    senderType: "AUDIENCE",
    senderId: "123456",
    externalMessageId: "77",
    redactedAt: null,
    channelBinding: {
      kind: "TELEGRAM",
      connectionId: "777000",
      externalConversationId: "123456",
    },
    conversation: { state: conversationState },
    revisions: [],
    inputForGenerationRuns: [run],
  });
}

function lockInvocationOrder(lockKey: string) {
  const callIndex = mocks.tx.$executeRaw.mock.calls.findIndex((call) =>
    call.slice(1).includes(lockKey),
  );
  return callIndex < 0
    ? undefined
    : mocks.tx.$executeRaw.mock.invocationCallOrder[callIndex];
}

function hasOutboxTerminalization(runId: string) {
  return mocks.tx.outboxEvent.updateMany.mock.calls.some(([args]) => {
    const where = args?.where as Record<string, unknown> | undefined;
    const data = args?.data as Record<string, unknown> | undefined;
    return (
      where?.aggregateType === "generation_run"
      && where?.aggregateId === runId
      && data?.status === "PROCESSED"
      && data.processedAt instanceof Date
    );
  });
}

function oldRunMutationSnapshots(runId: string): unknown[] {
  const updateSnapshots = mocks.tx.generationRun.update.mock.calls
    .filter(([args]) => args?.where?.id === runId)
    .map(([args]) => args?.data?.runtimePolicySnapshot)
    .filter((snapshot) => snapshot !== undefined);
  const updateManySnapshots = mocks.tx.generationRun.updateMany.mock.calls
    .filter(([args]) => args?.where?.id === runId)
    .map(([args]) => args?.data?.runtimePolicySnapshot)
    .filter((snapshot) => snapshot !== undefined);
  return [...updateSnapshots, ...updateManySnapshots];
}
