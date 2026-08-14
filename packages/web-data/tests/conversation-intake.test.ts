import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServiceRequest, prisma, tx } = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(),
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    intakeSubmission: { upsert: vi.fn() },
    lead: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    contact: { update: vi.fn() },
    eventAudit: { upsert: vi.fn() },
  };
  return {
    tx: transactionClient,
    createServiceRequest: vi.fn(),
    prisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma }));
vi.mock("../src/delegation-tasks", () => ({
  createConversationServiceRequestInTransaction: createServiceRequest,
}));

import { completeConversationIntake } from "../src/conversation-intake";

const input = {
  representativeId: "representative-1",
  representativeVersionId: "version-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  episodeId: "episode-1",
  inputMessageId: "message-1",
  intent: "service_request",
  collectorKind: "service_request",
  sourceChannel: "web",
  summary: "需求描述：希望梳理退款问题",
  objective: "希望梳理退款问题",
  desiredOutcome: "Owner review and a clear next-step response.",
  priority: 60,
  recommendedNextStep: "owner_service_request_review",
  payload: { answers: { description: "希望梳理退款问题" } },
};

describe("complete conversation intake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      representativeId: "representative-1",
      contactId: "contact-1",
      state: "COLLECTING",
      sourceChannel: "web",
      contact: { displayName: "Ada", username: null },
      episodes: [{ id: "episode-1", status: "ACTIVE" }],
    });
    createServiceRequest.mockResolvedValue({
      task: { id: "service-request-1" },
      skipped: null,
    });
    tx.intakeSubmission.upsert.mockResolvedValue({ id: "intake-1" });
    tx.lead.findFirst.mockResolvedValue(null);
    tx.lead.create.mockResolvedValue({ id: "lead-1" });
  });

  it("writes the request, intake, lead, contact stage, collector state, and audit atomically", async () => {
    await expect(completeConversationIntake(input)).resolves.toEqual({
      serviceRequestId: "service-request-1",
      intakeSubmissionId: "intake-1",
      leadId: "lead-1",
      skipped: null,
    });

    expect(createServiceRequest).toHaveBeenCalledWith(tx, expect.objectContaining({
      inputMessageId: "message-1",
      objective: "希望梳理退款问题",
    }));
    expect(tx.intakeSubmission.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        requestType: "service_request",
        payload: { answers: { description: "希望梳理退款问题" } },
      }),
    }));
    expect(tx.lead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        intakeSubmissionId: "intake-1",
        status: "QUALIFIED",
      }),
    });
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "contact-1" },
      data: { stage: "QUALIFIED" },
    });
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { collectorState: expect.anything(), state: "ACTIVE" },
    });
    expect(tx.eventAudit.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        delegationTaskId: "service-request-1",
        type: "INTAKE_SUBMITTED",
      }),
    }));
  });

  it.each(["NEEDS_HUMAN", "HUMAN_ACTIVE"])(
    "only clears stale collector state while the conversation is %s",
    async (state) => {
      tx.conversation.findUnique.mockResolvedValue({
        id: "conversation-1",
        representativeId: "representative-1",
        contactId: "contact-1",
        state,
        sourceChannel: "web",
        contact: { displayName: "Ada", username: null },
        episodes: [{ id: "episode-1", status: "ACTIVE" }],
      });

      await expect(completeConversationIntake(input)).resolves.toEqual({
        serviceRequestId: null,
        intakeSubmissionId: null,
        leadId: null,
        skipped: "human_active",
      });
      expect(tx.conversation.update).toHaveBeenCalledWith({
        where: { id: "conversation-1" },
        data: { collectorState: expect.anything() },
      });
      expect(createServiceRequest).not.toHaveBeenCalled();
      expect(tx.intakeSubmission.upsert).not.toHaveBeenCalled();
    },
  );
});
