import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  tx,
  mockProvisionMatrixDirectConversation,
  mockConsumeIdentityBindingChallenge,
  mockReleaseConversationEntitlement,
  mockReleaseConversationWalletUsage,
  mockWithActiveMatrixRepresentativeChannelFence,
  fencedTx,
} = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(),
    conversation: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationParticipant: {
      upsert: vi.fn(),
    },
    conversationChannelBinding: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    conversationEpisode: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    generationRun: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    outboxEvent: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    approvalRequest: {
      updateMany: vi.fn(),
    },
  };
  const prismaClient = {
    $transaction: vi.fn(),
    channelEventInbox: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    matrixVirtualUserBinding: {
      findUnique: vi.fn(),
    },
    identityLink: {
      findUnique: vi.fn(),
    },
    identityLinkConnectionProof: {
      findUnique: vi.fn(),
    },
    conversationChannelBinding: {
      findFirst: vi.fn(),
    },
    representativeChannelBinding: {
      findUnique: vi.fn(),
    },
    message: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };
  const fencedTransactionClient = {
    ...transactionClient,
    channelEventInbox: prismaClient.channelEventInbox,
    identityLink: prismaClient.identityLink,
    identityLinkConnectionProof:
      prismaClient.identityLinkConnectionProof,
    representativeChannelBinding:
      prismaClient.representativeChannelBinding,
    message: {
      ...transactionClient.message,
      findFirst: vi.fn((args: {
        select?: { senderId?: boolean };
      }) =>
        args.select?.senderId
          ? prismaClient.message.findFirst(args)
          : transactionClient.message.findFirst(args)),
    },
  };
  return {
    tx: transactionClient,
    fencedTx: fencedTransactionClient,
    mockPrisma: prismaClient,
    mockProvisionMatrixDirectConversation: vi.fn(),
    mockConsumeIdentityBindingChallenge: vi.fn(),
    mockReleaseConversationEntitlement: vi.fn(),
    mockReleaseConversationWalletUsage: vi.fn(),
    mockWithActiveMatrixRepresentativeChannelFence: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../src/matrix-provisioning", () => ({
  provisionMatrixDirectConversation: mockProvisionMatrixDirectConversation,
  resolveMatrixApplicationServiceConnectionId: () => "delegate-matrix-as",
}));
vi.mock("../src/audience-identity-binding", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/audience-identity-binding")
    >();
  return {
    ...actual,
    consumeIdentityBindingChallenge:
      mockConsumeIdentityBindingChallenge,
  };
});
vi.mock("../src/service-entitlements", () => ({
  consumeConversationEntitlement: vi.fn(),
  releaseConversationEntitlementByGenerationRunId: mockReleaseConversationEntitlement,
}));
vi.mock("../src/agent-wallet-usage-charge", () => ({
  InsufficientAgentUsageCreditsError:
    class InsufficientAgentUsageCreditsError extends Error {},
  releaseConversationWalletUsage: mockReleaseConversationWalletUsage,
  reserveConversationWalletUsage: vi.fn(),
  settleConversationWalletUsage: vi.fn(),
}));
vi.mock("../src/matrix-room-security", () => ({
  lockMatrixRoomSecurityState: vi.fn(),
  withActiveMatrixRepresentativeChannelFence:
    mockWithActiveMatrixRepresentativeChannelFence,
}));

import {
  ConversationWorkInFlightControlError,
  ingestMatrixApplicationServiceTransaction,
  redactConversationMessage,
  type MatrixApplicationServiceEvent,
} from "../src/conversation-platform";

const aliceMatrixUserId = "@alice:example.org";

describe("Matrix application service ingress", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockPrisma.channelEventInbox.upsert.mockImplementation(
      async (args: {
        create: {
          externalEventId: string;
          eventType: string;
          payload: MatrixApplicationServiceEvent;
          privateCredentialHash: string | null;
        };
      }) => ({
        id: `inbox:${args.create.externalEventId}`,
        status: "PENDING",
        attemptCount: 0,
        eventType: args.create.eventType,
        payload: args.create.payload,
        privateCredentialHash: args.create.privateCredentialHash,
        lastError: null,
      }),
    );
    mockPrisma.channelEventInbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.channelEventInbox.update.mockResolvedValue({});
    mockPrisma.channelEventInbox.findUnique.mockResolvedValue(null);
    mockPrisma.matrixVirtualUserBinding.findUnique.mockResolvedValue(null);
    mockPrisma.identityLink.findUnique.mockResolvedValue({
      id: "matrix-identity-link-1",
      audienceIdentityId: "audience-identity-1",
      issuer: "example.org",
      verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      assuranceLevel: "PLATFORM_VERIFIED",
      revokedAt: null,
    });
    mockPrisma.identityLinkConnectionProof.findUnique.mockResolvedValue({
      verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      assuranceLevel: "PLATFORM_VERIFIED",
      revokedAt: null,
    });
    mockProvisionMatrixDirectConversation.mockResolvedValue({
      status: "ready",
      securityState: "PENDING_REMOTE_VALIDATION",
      conversationId: "conversation-1",
    });
    mockConsumeIdentityBindingChallenge.mockResolvedValue({
      audienceIdentityId: "registered-audience-1",
    });
    mockReleaseConversationEntitlement.mockResolvedValue(null);
    mockReleaseConversationWalletUsage.mockResolvedValue({ status: "released" });
    mockWithActiveMatrixRepresentativeChannelFence.mockImplementation(
      async (
        _input: unknown,
        operation: (client: typeof fencedTx) => Promise<unknown>,
      ) => ({ executed: true, value: await operation(fencedTx) }),
    );
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(buildMatrixBinding());
    mockPrisma.representativeChannelBinding.findUnique.mockResolvedValue({
      status: "CONNECTED",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      representative: {
        lifecycleState: "PUBLISHED",
        activeVersionId: "version-1",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
    });
    tx.conversationChannelBinding.findFirst.mockResolvedValue(buildMatrixBinding());
    tx.message.findFirst.mockResolvedValue({
      id: "message-alice",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [],
    });
    mockPrisma.message.update.mockResolvedValue({});
    tx.message.update.mockResolvedValue({});
    tx.outboxEvent.findFirst.mockResolvedValue(null);

    mockPrisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    tx.$executeRaw.mockResolvedValue(0);
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      state: "ACTIVE",
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
        lifecycleState: "PUBLISHED",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: [{
        id: "matrix-binding-1",
        kind: "MATRIX",
        externalConversationId: "!room:example.org",
        metadata: matrixSafetyMetadata(),
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
        },
      }],
    });
    tx.message.upsert.mockResolvedValue({ id: "message-1" });
    tx.generationRun.upsert.mockResolvedValue({ id: "run-1" });
    tx.outboxEvent.upsert.mockResolvedValue({ id: "outbox-1" });
    tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
  });

  it("deduplicates a replayed transaction without reapplying side effects", async () => {
    const event = matrixTextEvent("$event-1", aliceMatrixUserId);
    mockPrisma.channelEventInbox.upsert.mockResolvedValue({
      id: "inbox:event-1",
      status: "PROCESSED",
      eventType: event.type,
      payload: event,
      lastError: null,
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-replay",
      events: [event],
    });

    expect(result).toEqual([{ eventId: "$event-1", status: "duplicate" }]);
    expect(mockPrisma.channelEventInbox.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.conversationChannelBinding.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps an in-flight duplicate retryable until the active lease finishes", async () => {
    const event = matrixTextEvent("$event-in-flight", aliceMatrixUserId);
    mockPrisma.channelEventInbox.upsert.mockResolvedValue({
      id: "inbox:event-in-flight",
      status: "PROCESSING",
      eventType: event.type,
      payload: event,
      lastError: null,
    });
    mockPrisma.channelEventInbox.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.channelEventInbox.findUnique.mockResolvedValue({
      status: "PROCESSING",
      lastError: null,
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-in-flight-replay",
      events: [event],
    });

    expect(result).toEqual([{
      eventId: "$event-in-flight",
      status: "failed",
      reason: "matrix_event_already_processing",
    }]);
    expect(mockPrisma.conversationChannelBinding.findFirst).not.toHaveBeenCalled();
  });

  it("keeps an unknown room retryable instead of marking it successfully ignored", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(null);

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-unknown-room",
      events: [matrixTextEvent("$event-unknown-room", aliceMatrixUserId, "!new:example.org")],
    });

    expect(result).toEqual([{
      eventId: "$event-unknown-room",
      status: "failed",
      reason: "matrix_room_not_provisioned",
    }]);
    expect(mockPrisma.channelEventInbox.update).toHaveBeenCalledWith({
      where: { id: "inbox:$event-unknown-room" },
      data: expect.objectContaining({
        status: "FAILED",
        lastError: "matrix_room_not_provisioned",
        availableAt: expect.any(Date),
      }),
    });
    expect(mockPrisma.channelEventInbox.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    );
  });

  it("provisions a native Matrix DM from a managed representative invite", async () => {
    mockPrisma.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      representativeId: "representative-1",
      matrixUserId: "@_delegate_rep:example.org",
      enabled: true,
    });
    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-invite",
      events: [{
        event_id: "$invite-1",
        type: "m.room.member",
        room_id: "!dm:example.org",
        sender: aliceMatrixUserId,
        state_key: "@_delegate_rep:example.org",
        content: { membership: "invite", is_direct: true },
      }],
    });

    expect(result).toEqual([{ eventId: "$invite-1", status: "processed" }]);
    expect(mockProvisionMatrixDirectConversation).toHaveBeenCalledWith({
      representativeId: "representative-1",
      roomId: "!dm:example.org",
      audienceMatrixUserId: aliceMatrixUserId,
      representativeMatrixUserId: "@_delegate_rep:example.org",
      directInvite: true,
    });
  });

  it("acknowledges a conflicting Matrix invite after provisioning isolates it", async () => {
    mockPrisma.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      representativeId: "representative-1",
      matrixUserId: "@_delegate_rep:example.org",
      enabled: true,
    });
    mockProvisionMatrixDirectConversation.mockResolvedValue({
      status: "isolated_conflict",
      securityState: "ISOLATED",
      reason: "matrix_room_binding_participant_conflict",
      conversationId: "conversation-1",
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-conflicting-invite",
      events: [{
        event_id: "$conflicting-invite-1",
        type: "m.room.member",
        room_id: "!room:example.org",
        sender: "@mallory:example.org",
        state_key: "@_delegate_rep:example.org",
        content: { membership: "invite", is_direct: true },
      }],
    });

    expect(result).toEqual([{
      eventId: "$conflicting-invite-1",
      status: "ignored",
      reason: "matrix_room_binding_participant_conflict",
    }]);
    expect(mockPrisma.channelEventInbox.update).toHaveBeenCalledWith({
      where: { id: "inbox:$conflicting-invite-1" },
      data: expect.objectContaining({ status: "PROCESSED" }),
    });
  });

  it("does not provision a managed user from a non-direct Matrix invite", async () => {
    mockPrisma.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      representativeId: "representative-1",
      matrixUserId: "@_delegate_rep:example.org",
      enabled: true,
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-group-invite",
      events: [{
        event_id: "$group-invite-1",
        type: "m.room.member",
        room_id: "!group:example.org",
        sender: aliceMatrixUserId,
        state_key: "@_delegate_rep:example.org",
        content: { membership: "invite" },
      }],
    });

    expect(result).toEqual([{
      eventId: "$group-invite-1",
      status: "ignored",
      reason: "matrix_membership_not_explicit_direct_invite",
    }]);
    expect(mockProvisionMatrixDirectConversation).not.toHaveBeenCalled();
  });

  it("isolates an encrypted Matrix room before it can reach AI", async () => {
    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-encrypted-room",
      events: [{
        event_id: "$encryption-1",
        type: "m.room.encryption",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      }],
    });

    expect(result).toEqual([{
      eventId: "$encryption-1",
      status: "ignored",
      reason: "matrix_room_encrypted",
    }]);
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { state: "FAILED" },
    });
    expect(tx.conversationChannelBinding.update).toHaveBeenCalledWith({
      where: { id: "matrix-binding-1" },
      data: {
        metadata: expect.objectContaining({
          securityState: "ISOLATED",
          encrypted: true,
          isolationReason: "matrix_room_encrypted",
        }),
      },
    });
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("records and isolates a third Matrix member joining a provisioned room", async () => {
    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-third-member",
      events: [{
        event_id: "$mallory-join-1",
        type: "m.room.member",
        room_id: "!room:example.org",
        sender: "@mallory:example.org",
        state_key: "@mallory:example.org",
        content: { membership: "join" },
      }],
    });

    expect(result).toEqual([{
      eventId: "$mallory-join-1",
      status: "ignored",
      reason: "matrix_room_membership_isolated",
    }]);
    expect(tx.conversationParticipant.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        kind: "SYSTEM",
        participantId: "@mallory:example.org",
        metadata: expect.objectContaining({ untrustedMember: true }),
      }),
    }));
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { state: "FAILED" },
    });
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("applies a later encryption state before an earlier message in the same transaction", async () => {
    let isolated = false;
    tx.conversationChannelBinding.update.mockImplementation(
      async (args: { data?: { metadata?: { securityState?: string } } }) => {
        if (args.data?.metadata?.securityState === "ISOLATED") isolated = true;
        return {};
      },
    );
    mockPrisma.conversationChannelBinding.findFirst.mockImplementation(
      async () => buildMatrixBinding({
        metadata: isolated
          ? { ...matrixSafetyMetadata(), securityState: "ISOLATED", encrypted: true }
          : matrixSafetyMetadata(),
      }),
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-message-before-encryption",
      events: [
        matrixTextEvent("$event-before-encryption", aliceMatrixUserId),
        {
          event_id: "$encryption-after-message",
          type: "m.room.encryption",
          room_id: "!room:example.org",
          sender: aliceMatrixUserId,
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });

    expect(result).toEqual([
      {
        eventId: "$event-before-encryption",
        status: "ignored",
        reason: "matrix_room_not_private_unencrypted",
      },
      {
        eventId: "$encryption-after-message",
        status: "ignored",
        reason: "matrix_room_encrypted",
      },
    ]);
    expect(tx.conversationChannelBinding.update.mock.invocationCallOrder[0])
      .toBeLessThan(
        mockPrisma.conversationChannelBinding.findFirst.mock.invocationCallOrder[0]!,
      );
    expect(tx.message.upsert).not.toHaveBeenCalled();
  });

  it("applies a later third-member join before an earlier message in the same transaction", async () => {
    let isolated = false;
    tx.conversationChannelBinding.update.mockImplementation(
      async (args: { data?: { metadata?: { securityState?: string } } }) => {
        if (args.data?.metadata?.securityState === "ISOLATED") isolated = true;
        return {};
      },
    );
    mockPrisma.conversationChannelBinding.findFirst.mockImplementation(
      async () => buildMatrixBinding({
        metadata: isolated
          ? { ...matrixSafetyMetadata(), securityState: "ISOLATED" }
          : matrixSafetyMetadata(),
      }),
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-message-before-third-member",
      events: [
        matrixTextEvent("$event-before-third-member", aliceMatrixUserId),
        {
          event_id: "$mallory-join-after-message",
          type: "m.room.member",
          room_id: "!room:example.org",
          sender: "@mallory:example.org",
          state_key: "@mallory:example.org",
          content: { membership: "join" },
        },
      ],
    });

    expect(result).toEqual([
      {
        eventId: "$event-before-third-member",
        status: "ignored",
        reason: "matrix_room_not_private_unencrypted",
      },
      {
        eventId: "$mallory-join-after-message",
        status: "ignored",
        reason: "matrix_room_membership_isolated",
      },
    ]);
    expect(tx.conversationChannelBinding.update.mock.invocationCallOrder[0])
      .toBeLessThan(
        mockPrisma.conversationChannelBinding.findFirst.mock.invocationCallOrder[0]!,
      );
    expect(tx.message.upsert).not.toHaveBeenCalled();
  });

  it("applies a later third-member join before an earlier redaction in the same transaction", async () => {
    let isolated = false;
    tx.conversationChannelBinding.update.mockImplementation(
      async (args: { data?: { metadata?: { securityState?: string } } }) => {
        if (args.data?.metadata?.securityState === "ISOLATED") isolated = true;
        return {};
      },
    );
    mockPrisma.conversationChannelBinding.findFirst.mockImplementation(
      async () => buildMatrixBinding({
        metadata: isolated
          ? { ...matrixSafetyMetadata(), securityState: "ISOLATED" }
          : matrixSafetyMetadata(),
      }),
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-redaction-before-third-member",
      events: [
        {
          event_id: "$redaction-before-third-member",
          type: "m.room.redaction",
          room_id: "!room:example.org",
          sender: aliceMatrixUserId,
          redacts: "$event-alice",
          content: {},
        },
        {
          event_id: "$mallory-join-after-redaction",
          type: "m.room.member",
          room_id: "!room:example.org",
          sender: "@mallory:example.org",
          state_key: "@mallory:example.org",
          content: { membership: "join" },
        },
      ],
    });

    expect(result).toEqual([
      {
        eventId: "$redaction-before-third-member",
        status: "ignored",
        reason: "matrix_room_not_private_unencrypted",
      },
      {
        eventId: "$mallory-join-after-redaction",
        status: "ignored",
        reason: "matrix_room_membership_isolated",
      },
    ]);
    expect(mockPrisma.message.findFirst).not.toHaveBeenCalled();
  });

  it("keeps third-member leave evidence and does not reopen the room", async () => {
    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-third-member-left",
      events: [{
        event_id: "$mallory-leave-1",
        type: "m.room.member",
        room_id: "!room:example.org",
        sender: "@mallory:example.org",
        state_key: "@mallory:example.org",
        content: { membership: "leave" },
      }],
    });

    expect(result).toEqual([{
      eventId: "$mallory-leave-1",
      status: "ignored",
      reason: "matrix_room_membership_isolated",
    }]);
    expect(tx.conversationParticipant.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        participantId: "@mallory:example.org",
        leftAt: expect.any(Date),
      }),
    }));
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { state: "FAILED" },
    });
  });

  it("persists the full batch first and isolates a failed event from its siblings", async () => {
    mockPrisma.conversationChannelBinding.findFirst
      .mockResolvedValueOnce(buildMatrixBinding())
      .mockResolvedValueOnce(null);

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-partial-failure",
      events: [
        matrixTextEvent("$event-ok", aliceMatrixUserId),
        matrixTextEvent("$event-failed", aliceMatrixUserId, "!unknown:example.org"),
        {
          event_id: "$event-member",
          type: "m.room.member",
          room_id: "!room:example.org",
          sender: aliceMatrixUserId,
          content: { membership: "join" },
        },
      ],
    });

    expect(result).toEqual([
      { eventId: "$event-ok", status: "processed" },
      {
        eventId: "$event-failed",
        status: "failed",
        reason: "matrix_room_not_provisioned",
      },
      {
        eventId: "$event-member",
        status: "ignored",
        reason: "matrix_membership_not_managed_invite",
      },
    ]);
    expect(mockPrisma.channelEventInbox.upsert).toHaveBeenCalledTimes(3);
    expect(mockPrisma.channelEventInbox.updateMany).toHaveBeenCalledTimes(3);
    const lastPersistCall = Math.max(
      ...mockPrisma.channelEventInbox.upsert.mock.invocationCallOrder,
    );
    const firstClaimCall = Math.min(
      ...mockPrisma.channelEventInbox.updateMany.mock.invocationCallOrder,
    );
    expect(lastPersistCall).toBeLessThan(firstClaimCall);
    expect(tx.message.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects a room member who is not the bound contact or an allowed audience participant", async () => {
    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-unbound-sender",
      events: [matrixTextEvent("$event-mallory", "@mallory:example.org")],
    });

    expect(result).toEqual([{
      eventId: "$event-mallory",
      status: "ignored",
      reason: "matrix_sender_not_authorized",
    }]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts an explicitly provisioned active audience participant", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({
        contactMatrixUserId: null,
        participants: [{
          kind: "AUDIENCE",
          participantId: "contact-2",
          leftAt: null,
          metadata: { matrixUserId: "@bob:example.org" },
        }],
      }),
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-allowed-participant",
      events: [matrixTextEvent("$event-bob", "@bob:example.org")],
    });

    expect(result).toEqual([{ eventId: "$event-bob", status: "processed" }]);
    expect(tx.message.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        senderId: "@bob:example.org",
        externalMessageId: "$event-bob",
      }),
    }));
  });

  it("consumes Matrix binding commands without queuing them for AI or retaining the token", async () => {
    const token = "a".repeat(43);
    const event = matrixTextEvent("$event-bind", aliceMatrixUserId);
    event.content = {
      msgtype: "m.text",
      body: `!bind ${token}`,
      format: "org.matrix.custom.html",
      formatted_body: `<strong>!bind ${token}</strong>`,
      "m.new_content": {
        msgtype: "m.text",
        body: `!bind ${token}`,
        formatted_body: `<code>/bind ${token}</code>`,
        nested: {
          command: `/bind ${token}`,
          [`secret-${token}`]: "must redact object keys too",
        },
      },
    };

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-bind",
      events: [event],
    });

    expect(result).toEqual([{ eventId: "$event-bind", status: "processed" }]);
    expect(mockConsumeIdentityBindingChallenge).toHaveBeenCalledWith(
      {
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        provider: "MATRIX",
        providerSubject: aliceMatrixUserId,
        issuer: "example.org",
        connectionId: "delegate-matrix-as",
        proofMetadata: {
          matrixRoomId: "!room:example.org",
          matrixEventId: "$event-bind",
          directMessage: true,
        },
      },
      fencedTx,
    );
    expect(mockPrisma.channelEventInbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          privateCredentialHash:
            expect.stringMatching(/^[a-f0-9]{64}$/),
          payload: expect.objectContaining({
            content: expect.objectContaining({
              body: "!bind [redacted]",
            }),
          }),
        }),
      }),
    );
    expect(
      JSON.stringify(mockPrisma.channelEventInbox.upsert.mock.calls),
    ).not.toContain(token);
    const persistedPayload =
      mockPrisma.channelEventInbox.upsert.mock.calls[0]?.[0].create.payload;
    expect(JSON.stringify(persistedPayload)).toContain("[redacted]");
    expect(JSON.stringify(persistedPayload)).not.toContain(token);
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.identityLink.findUnique).not.toHaveBeenCalled();
    expect(
      mockPrisma.identityLinkConnectionProof.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("scrubs a nested token from a partially sanitized inbox replay", async () => {
    const token = "r".repeat(43);
    const tokenHash = createHash("sha256")
      .update(token, "utf8")
      .digest("hex");
    const event = matrixTextEvent("$event-bind-replay", aliceMatrixUserId);
    event.content = {
      msgtype: "m.text",
      body: `!bind ${token}`,
    };
    mockPrisma.channelEventInbox.upsert.mockResolvedValue({
      id: "inbox:$event-bind-replay",
      status: "PENDING",
      attemptCount: 0,
      eventType: "m.room.message",
      payload: {
        ...event,
        content: {
          msgtype: "m.text",
          body: "!bind [redacted]",
          formatted_body: `<strong>!bind ${token}</strong>`,
          "m.new_content": {
            msgtype: "m.text",
            body: `!bind ${token}`,
            formatted_body: `<code>${token}</code>`,
          },
          "com.delegate.private_channel_binding_token_hash": tokenHash,
        },
      },
      privateCredentialHash: tokenHash,
      lastError: null,
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-bind-replay",
      events: [event],
    });

    expect(result).toEqual([{
      eventId: "$event-bind-replay",
      status: "processed",
    }]);
    expect(mockConsumeIdentityBindingChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash }),
      fencedTx,
    );
    const payloadRewrite = mockPrisma.channelEventInbox.update.mock.calls.find(
      ([args]) => "payload" in args.data,
    )?.[0].data.payload;
    expect(payloadRewrite).toBeDefined();
    expect(JSON.stringify(payloadRewrite)).not.toContain(token);
  });

  it("does not trust a Matrix event supplied binding-token hash", async () => {
    const forgedHash = "f".repeat(64);
    const event = matrixTextEvent(
      "$event-forged-binding-hash",
      aliceMatrixUserId,
    );
    event.content = {
      msgtype: "m.text",
      body: "!bind [redacted]",
      "com.delegate.private_channel_binding_token_hash": forgedHash,
      nested: {
        "com.delegate.private_channel_binding_token_hash": forgedHash,
      },
    };

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-forged-binding-hash",
      events: [event],
    });

    expect(result).toEqual([{
      eventId: "$event-forged-binding-hash",
      status: "processed",
    }]);
    expect(mockConsumeIdentityBindingChallenge).not.toHaveBeenCalled();
    const created =
      mockPrisma.channelEventInbox.upsert.mock.calls[0]?.[0].create;
    expect(created.privateCredentialHash).toBeNull();
    expect(JSON.stringify(created.payload)).not.toContain(
      "private_channel_binding_token_hash",
    );
  });

  it("parks messages until remote Matrix room validation completes without consuming retries", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({
        metadata: {
          ...matrixSafetyMetadata(),
          securityState: "PENDING_REMOTE_VALIDATION",
        },
      }),
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-pending-room",
      events: [matrixTextEvent("$event-pending-room", aliceMatrixUserId)],
    });

    expect(result).toEqual([{
      eventId: "$event-pending-room",
      status: "failed",
      reason: "matrix_room_pending_remote_validation",
    }]);
    expect(mockPrisma.channelEventInbox.update).toHaveBeenCalledWith({
      where: { id: "inbox:$event-pending-room" },
      data: {
        status: "FAILED",
        attemptCount: { decrement: 1 },
        processedAt: null,
        availableAt: expect.any(Date),
        lastError: "matrix_room_pending_remote_validation",
      },
    });
    expect(tx.message.upsert).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "representative is paused",
      code: "representative_paused",
      binding: { lifecycleState: "PAUSED" as const },
    },
    {
      name: "channel is paused",
      code: "channel_paused",
      binding: { desiredState: "PAUSED" as const },
    },
    {
      name: "channel is disconnected",
      code: "channel_disconnected",
      binding: { desiredState: "DISCONNECTED" as const },
    },
    {
      name: "representative is unpublished",
      code: "representative_unpublished",
      binding: { lifecycleState: "DRAFT" as const },
    },
    {
      name: "representative is archived",
      code: "representative_archived",
      binding: { lifecycleState: "ARCHIVED" as const },
    },
    {
      name: "representative channel is missing",
      code: "channel_not_connected",
      binding: { representativeBinding: null },
    },
    {
      name: "channel is unhealthy",
      code: "channel_unhealthy",
      binding: { healthStatus: "UNHEALTHY" as const },
    },
    {
      name: "runtime policy disables Matrix",
      code: "policy_disabled",
      binding: {
        runtimePolicyOverlays: [{
          enabled: true,
          priority: 100,
          startsAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: null,
          payload: {
            channels: {
              matrix: { enabled: false },
            },
          },
        }],
      },
    },
  ])("terminally acknowledges Matrix binding commands when $name", async ({
    code,
    binding,
  }) => {
    const token = "p".repeat(43);
    const event = matrixTextEvent(`$event-bind-${code}`, aliceMatrixUserId);
    event.content = {
      msgtype: "m.text",
      body: `!bind ${token}`,
    };
    const configuredBinding = buildMatrixBinding(binding);
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      configuredBinding,
    );
    mockPrisma.representativeChannelBinding.findUnique.mockResolvedValue(
      configuredBinding.representativeBinding
        ? {
            status: configuredBinding.representativeBinding.status,
            desiredState:
              configuredBinding.representativeBinding.desiredState,
            healthStatus:
              configuredBinding.representativeBinding.healthStatus,
            representative: {
              lifecycleState:
                configuredBinding.conversation.representative.lifecycleState,
              activeVersionId:
                configuredBinding.conversation.representative.activeVersionId,
              publicMode:
                configuredBinding.conversation.representative.publicMode,
              runtimePolicyOverlays:
                configuredBinding.conversation.representative
                  .runtimePolicyOverlays,
            },
          }
        : null,
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: `transaction-bind-${code}`,
      events: [event],
    });

    expect(result).toEqual([{
      eventId: `$event-bind-${code}`,
      status: "ignored",
      reason: code,
    }]);
    expect(mockConsumeIdentityBindingChallenge).not.toHaveBeenCalled();
    expect(mockPrisma.channelEventInbox.update).toHaveBeenLastCalledWith({
      where: { id: `inbox:$event-bind-${code}` },
      data: expect.objectContaining({
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      }),
    });
  });

  it("terminally acknowledges normal Matrix messages after channel disconnect", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({ desiredState: "DISCONNECTED" }),
    );
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      state: "ACTIVE",
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
        lifecycleState: "PUBLISHED",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "ACTIVE",
        representativeVersionId: "version-1",
      }],
      channelBindings: [{
        id: "matrix-binding-1",
        kind: "MATRIX",
        externalConversationId: "!room:example.org",
        metadata: matrixSafetyMetadata(),
        representativeBinding: {
          status: "DISCONNECTED",
          desiredState: "DISCONNECTED",
          healthStatus: "UNKNOWN",
        },
      }],
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-message-channel-disconnected",
      events: [
        matrixTextEvent(
          "$event-message-channel-disconnected",
          aliceMatrixUserId,
        ),
      ],
    });

    expect(result).toEqual([{
      eventId: "$event-message-channel-disconnected",
      status: "ignored",
      reason: "channel_disconnected",
    }]);
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.channelEventInbox.update).toHaveBeenLastCalledWith({
      where: { id: "inbox:$event-message-channel-disconnected" },
      data: expect.objectContaining({
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      }),
    });
  });

  it.each([
    {
      name: "edit",
      event: {
        event_id: "$event-edit-after-disconnect",
        type: "m.room.message",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        content: {
          msgtype: "m.text",
          body: "* edited after disconnect",
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: "$event-original",
          },
          "m.new_content": {
            msgtype: "m.text",
            body: "edited after disconnect",
          },
        },
      } satisfies MatrixApplicationServiceEvent,
    },
    {
      name: "redaction",
      event: {
        event_id: "$event-redaction-after-disconnect",
        type: "m.room.redaction",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        redacts: "$event-original",
        content: {},
      } satisfies MatrixApplicationServiceEvent,
    },
  ])("blocks Matrix $name side effects after channel disconnect", async ({
    event,
  }) => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({ desiredState: "DISCONNECTED" }),
    );
    mockPrisma.representativeChannelBinding.findUnique.mockResolvedValue({
      status: "DISCONNECTED",
      desiredState: "DISCONNECTED",
      healthStatus: "UNKNOWN",
      representative: {
        lifecycleState: "PUBLISHED",
        activeVersionId: "version-1",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: `transaction-${event.event_id}`,
      events: [event],
    });

    expect(result).toEqual([{
      eventId: event.event_id,
      status: "ignored",
      reason: "channel_disconnected",
    }]);
    expect(mockPrisma.message.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });

  it("lets a concurrent disconnect win before any Matrix content side effect", async () => {
    mockWithActiveMatrixRepresentativeChannelFence.mockResolvedValue({
      executed: false,
      reason: "matrix_channel_not_active",
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-disconnect-wins",
      events: [
        matrixTextEvent("$event-disconnect-wins", aliceMatrixUserId),
      ],
    });

    expect(result).toEqual([{
      eventId: "$event-disconnect-wins",
      status: "ignored",
      reason: "channel_disconnected",
    }]);
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(mockConsumeIdentityBindingChallenge).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "bind",
      event: {
        ...matrixTextEvent("$event-bind-after-isolation", aliceMatrixUserId),
        content: {
          msgtype: "m.text",
          body: `!bind ${"r".repeat(43)}`,
        },
      } satisfies MatrixApplicationServiceEvent,
    },
    {
      name: "normal message",
      event: matrixTextEvent(
        "$event-message-after-isolation",
        aliceMatrixUserId,
      ),
    },
    {
      name: "edit",
      event: {
        event_id: "$event-edit-after-isolation",
        type: "m.room.message",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        content: {
          msgtype: "m.text",
          body: "* isolated edit",
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: "$event-original",
          },
          "m.new_content": {
            msgtype: "m.text",
            body: "isolated edit",
          },
        },
      } satisfies MatrixApplicationServiceEvent,
    },
    {
      name: "redaction",
      event: {
        event_id: "$event-redaction-after-isolation",
        type: "m.room.redaction",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        redacts: "$event-original",
        content: {},
      } satisfies MatrixApplicationServiceEvent,
    },
  ])("terminally blocks Matrix $name when the room is isolated after the initial read", async ({
    event,
  }) => {
    tx.conversationChannelBinding.findFirst.mockResolvedValue({
      ...buildMatrixBinding(),
      metadata: {
        ...matrixSafetyMetadata(),
        securityState: "ISOLATED",
        isolationReason: "matrix_room_encrypted",
      },
    });
    mockPrisma.message.findFirst.mockResolvedValue({
      id: "message-alice",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: `transaction-${event.event_id}`,
      events: [event],
    });

    expect(result).toEqual([{
      eventId: event.event_id,
      status: "ignored",
      reason: "matrix_private_room_not_verified",
    }]);
    expect(mockConsumeIdentityBindingChallenge).not.toHaveBeenCalled();
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
    expect(mockPrisma.channelEventInbox.update).toHaveBeenLastCalledWith({
      where: { id: `inbox:${event.event_id}` },
      data: expect.objectContaining({
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      }),
    });
  });

  it("fails closed when an existing Matrix room has no proof for the exact connection", async () => {
    mockPrisma.identityLinkConnectionProof.findUnique.mockResolvedValue(null);

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-missing-connection-proof",
      events: [matrixTextEvent(
        "$event-missing-connection-proof",
        aliceMatrixUserId,
      )],
    });

    expect(result).toEqual([{
      eventId: "$event-missing-connection-proof",
      status: "ignored",
      reason: "matrix_identity_connection_not_verified",
    }]);
    expect(mockPrisma.identityLink.findUnique).toHaveBeenCalledWith({
      where: {
        provider_providerSubject: {
          provider: "MATRIX",
          providerSubject: aliceMatrixUserId,
        },
      },
      select: {
        id: true,
        audienceIdentityId: true,
        issuer: true,
        verifiedAt: true,
        assuranceLevel: true,
        revokedAt: true,
      },
    });
    expect(
      mockPrisma.identityLinkConnectionProof.findUnique,
    ).toHaveBeenCalledWith({
      where: {
        identityLinkId_issuer_connectionId: {
          identityLinkId: "matrix-identity-link-1",
          issuer: "example.org",
          connectionId: "delegate-matrix-as",
        },
      },
      select: {
        verifiedAt: true,
        assuranceLevel: true,
        revokedAt: true,
      },
    });
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("ignores an old Matrix room after the representative identity is reassigned", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          externalUserId: "@_delegate_rep_new:example.org",
        },
      }),
    );
    mockPrisma.representativeChannelBinding.findUnique.mockResolvedValue({
      status: "CONNECTED",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@_delegate_rep_new:example.org",
      representative: {
        lifecycleState: "PUBLISHED",
        activeVersionId: "version-1",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-representative-matrix-reassigned",
      events: [matrixTextEvent(
        "$event-representative-matrix-reassigned",
        aliceMatrixUserId,
      )],
    });

    expect(result).toEqual([{
      eventId: "$event-representative-matrix-reassigned",
      status: "ignored",
      reason: "matrix_identity_reassigned",
    }]);
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("ignores an A to B to A room whose Matrix assignment revision is stale", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
          externalUserId: "@_delegate_rep:example.org",
          endpointAssignmentRevision: 3,
        },
      }),
    );
    mockPrisma.representativeChannelBinding.findUnique.mockResolvedValue({
      status: "CONNECTED",
      desiredState: "ACTIVE",
      healthStatus: "HEALTHY",
      externalUserId: "@_delegate_rep:example.org",
      endpointAssignmentRevision: 3,
      representative: {
        lifecycleState: "PUBLISHED",
        activeVersionId: "version-1",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-matrix-assignment-revision-stale",
      events: [matrixTextEvent(
        "$event-matrix-assignment-revision-stale",
        aliceMatrixUserId,
      )],
    });

    expect(result).toEqual([{
      eventId: "$event-matrix-assignment-revision-stale",
      status: "ignored",
      reason: "matrix_identity_reassigned",
    }]);
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [
      "another audience identity",
      { audienceIdentityId: "audience-identity-other" },
    ],
    [
      "another issuer",
      { issuer: "elsewhere.example.org" },
    ],
    [
      "an issuer differing only by case",
      { issuer: "EXAMPLE.ORG" },
    ],
    [
      "a revoked identity link",
      { revokedAt: new Date("2026-07-28T01:00:00.000Z") },
    ],
  ])("fails closed when the Matrix proof belongs to %s", async (
    _case,
    identityLinkOverride,
  ) => {
    mockPrisma.identityLink.findUnique.mockResolvedValue({
      id: "matrix-identity-link-1",
      audienceIdentityId: "audience-identity-1",
      issuer: "example.org",
      verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      assuranceLevel: "PLATFORM_VERIFIED",
      revokedAt: null,
      ...identityLinkOverride,
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: `transaction-invalid-link-${_case}`,
      events: [matrixTextEvent(
        `$event-invalid-link-${_case}`,
        aliceMatrixUserId,
      )],
    });

    expect(result).toEqual([{
      eventId: `$event-invalid-link-${_case}`,
      status: "ignored",
      reason: "matrix_identity_connection_not_verified",
    }]);
    expect(
      mockPrisma.identityLinkConnectionProof.findUnique,
    ).not.toHaveBeenCalled();
    expect(tx.message.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when the exact Matrix connection proof is revoked", async () => {
    mockPrisma.identityLinkConnectionProof.findUnique.mockResolvedValue({
      verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
      assuranceLevel: "PLATFORM_VERIFIED",
      revokedAt: new Date("2026-07-28T01:00:00.000Z"),
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-revoked-connection-proof",
      events: [matrixTextEvent(
        "$event-revoked-connection-proof",
        aliceMatrixUserId,
      )],
    });

    expect(result).toEqual([{
      eventId: "$event-revoked-connection-proof",
      status: "ignored",
      reason: "matrix_identity_connection_not_verified",
    }]);
    expect(tx.message.upsert).not.toHaveBeenCalled();
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
  });

  it("consumes !bind before proof validation and accepts the next Matrix message", async () => {
    let rebound = false;
    mockPrisma.identityLinkConnectionProof.findUnique.mockImplementation(
      async () => rebound
        ? {
            verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
            assuranceLevel: "PLATFORM_VERIFIED",
            revokedAt: null,
          }
        : null,
    );
    mockConsumeIdentityBindingChallenge.mockImplementation(async () => {
      rebound = true;
      return { audienceIdentityId: "audience-identity-1" };
    });
    const token = "d".repeat(43);
    const bindEvent = matrixTextEvent("$event-rebind", aliceMatrixUserId);
    bindEvent.content = {
      msgtype: "m.text",
      body: `!bind ${token}`,
    };

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-rebind-before-proof-check",
      events: [
        bindEvent,
        matrixTextEvent("$event-after-rebind", aliceMatrixUserId),
      ],
    });

    expect(result).toEqual([
      { eventId: "$event-rebind", status: "processed" },
      { eventId: "$event-after-rebind", status: "processed" },
    ]);
    expect(mockConsumeIdentityBindingChallenge).toHaveBeenCalledTimes(1);
    expect(
      mockPrisma.identityLinkConnectionProof.findUnique,
    ).toHaveBeenCalledTimes(1);
    expect(tx.message.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        externalMessageId: "$event-after-rebind",
      }),
    }));
  });

  it("terminally acknowledges a rejected Matrix binding command", async () => {
    const token = "b".repeat(43);
    const event = matrixTextEvent("$event-bind-rejected", aliceMatrixUserId);
    event.content = {
      msgtype: "m.text",
      body: `!bind ${token}`,
    };
    mockConsumeIdentityBindingChallenge.mockRejectedValue(
      new Error("Binding challenge is invalid."),
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-bind-rejected",
      events: [event],
    });

    expect(result).toEqual([{
      eventId: "$event-bind-rejected",
      status: "ignored",
      reason: "matrix_identity_binding_rejected",
    }]);
    expect(mockPrisma.channelEventInbox.update).toHaveBeenLastCalledWith({
      where: { id: "inbox:$event-bind-rejected" },
      data: expect.objectContaining({
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      }),
    });
  });

  it("dead-letters a repeatedly failing Matrix event instead of retrying forever", async () => {
    const event = matrixTextEvent("$event-bind-dead-letter", aliceMatrixUserId);
    event.content = {
      msgtype: "m.text",
      body: `!bind ${"c".repeat(43)}`,
    };
    mockPrisma.channelEventInbox.upsert.mockImplementationOnce(
      async (args: any) => ({
        id: `inbox:${args.create.externalEventId}`,
        status: "FAILED",
        attemptCount: 4,
        eventType: args.create.eventType,
        payload: args.create.payload,
        privateCredentialHash: args.create.privateCredentialHash,
        lastError: "database temporarily unavailable",
      }),
    );
    mockConsumeIdentityBindingChallenge.mockRejectedValue(
      Object.assign(new Error("database temporarily unavailable"), { code: "P1001" }),
    );

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-bind-dead-letter",
      events: [event],
    });

    expect(result).toEqual([{
      eventId: "$event-bind-dead-letter",
      status: "ignored",
      reason: "matrix_event_attempts_exhausted",
    }]);
    expect(mockPrisma.channelEventInbox.update).toHaveBeenLastCalledWith({
      where: { id: "inbox:$event-bind-dead-letter" },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        processedAt: expect.any(Date),
      }),
    });
  });

  it("does not let one authorized audience participant edit another author's message", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({
        participants: buildMultipleAudienceParticipants(),
      }),
    );
    mockPrisma.message.findFirst.mockResolvedValue({
      id: "message-alice",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-forged-edit",
      events: [{
        event_id: "$event-forged-edit",
        type: "m.room.message",
        room_id: "!room:example.org",
        sender: "@mallory:example.org",
        content: {
          msgtype: "m.text",
          body: "* forged",
          "m.new_content": { msgtype: "m.text", body: "forged" },
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: "$event-alice",
          },
        },
      }],
    });

    expect(result).toEqual([{
      eventId: "$event-forged-edit",
      status: "ignored",
      reason: "matrix_edit_author_mismatch",
    }]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("treats edits to delegated input as a permanent Matrix conflict", async () => {
    mockPrisma.message.findFirst.mockResolvedValue({
      id: "message-delegated",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });
    tx.message.findFirst.mockResolvedValue({
      id: "message-delegated",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      text: "original request",
      redactedAt: null,
      revisions: [],
      inputForGenerationRuns: [{
        id: "run-delegated",
        delegationTaskId: "task-delegated",
      }],
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-delegated-edit",
      events: [{
        event_id: "$event-delegated-edit",
        type: "m.room.message",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        content: {
          msgtype: "m.text",
          body: "* revised",
          "m.new_content": { msgtype: "m.text", body: "revised" },
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: "$event-original-delegated",
          },
        },
      }],
    });

    expect(result).toEqual([{
      eventId: "$event-delegated-edit",
      status: "ignored",
      reason: "matrix_edit_delegation_active",
    }]);
    expect(mockPrisma.channelEventInbox.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("keeps inbound messages waiting for an operator without inventing an active assignment", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      state: "NEEDS_HUMAN",
      representative: {
        id: "representative-1",
        activeVersionId: "version-1",
        lifecycleState: "PUBLISHED",
        publicMode: true,
        runtimePolicyOverlays: [],
      },
      episodes: [{
        id: "episode-1",
        sequence: 1,
        status: "NEEDS_HUMAN",
        representativeVersionId: "version-1",
      }],
      channelBindings: [{
        id: "matrix-binding-1",
        kind: "MATRIX",
        externalConversationId: "!room:example.org",
        metadata: matrixSafetyMetadata(),
        representativeBinding: {
          status: "CONNECTED",
          desiredState: "ACTIVE",
          healthStatus: "HEALTHY",
        },
      }],
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-needs-human-inbound",
      events: [matrixTextEvent(
        "$event-needs-human-inbound",
        aliceMatrixUserId,
      )],
    });

    expect(result).toEqual([{
      eventId: "$event-needs-human-inbound",
      status: "processed",
    }]);
    expect(tx.generationRun.upsert).not.toHaveBeenCalled();
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: expect.objectContaining({
        state: "NEEDS_HUMAN",
      }),
    });
  });

  it("does not let one authorized audience participant redact another author's message", async () => {
    mockPrisma.conversationChannelBinding.findFirst.mockResolvedValue(
      buildMatrixBinding({
        participants: buildMultipleAudienceParticipants(),
      }),
    );
    mockPrisma.message.findFirst.mockResolvedValue({
      id: "message-alice",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-forged-redaction",
      events: [{
        event_id: "$event-forged-redaction",
        type: "m.room.redaction",
        room_id: "!room:example.org",
        sender: "@mallory:example.org",
        redacts: "$event-alice",
        content: {},
      }],
    });

    expect(result).toEqual([{
      eventId: "$event-forged-redaction",
      status: "ignored",
      reason: "matrix_redaction_author_mismatch",
    }]);
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });

  it("allows the original audience author to redact their own message", async () => {
    mockPrisma.message.findFirst.mockResolvedValueOnce({
      id: "message-alice",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-valid-redaction",
      events: [{
        event_id: "$event-valid-redaction",
        type: "m.room.redaction",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        content: { redacts: "$event-alice" },
      }],
    });

    expect(result).toEqual([{
      eventId: "$event-valid-redaction",
      status: "processed",
    }]);
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-alice" },
      data: expect.objectContaining({
        deliveryStatus: "REDACTED",
        redactedAt: expect.any(Date),
        redactionReason: "matrix_redaction",
      }),
    });
  });

  it("treats redaction of active delegated input as a permanent Matrix conflict", async () => {
    mockPrisma.message.findFirst.mockResolvedValueOnce({
      id: "message-delegated",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });
    tx.message.findFirst.mockResolvedValueOnce({
      id: "message-delegated",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-delegated" }],
    });
    tx.generationRun.findUnique.mockResolvedValueOnce({
      id: "run-delegated",
      status: "PROCESSING",
      delegationTaskId: "task-delegated",
      runtimePolicySnapshot: null,
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-redact-delegated",
      events: [{
        event_id: "$event-redact-delegated",
        type: "m.room.redaction",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        redacts: "$event-original-delegated",
        content: {},
      }],
    });

    expect(result).toEqual([{
      eventId: "$event-redact-delegated",
      status: "ignored",
      reason: "matrix_redaction_delegation_active",
    }]);
    expect(tx.generationRun.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("cancels queued generation and releases its entitlement when the input is redacted", async () => {
    mockPrisma.message.findFirst.mockResolvedValueOnce({
      id: "message-alice",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });
    tx.message.findFirst.mockResolvedValueOnce({
      id: "message-alice",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-redacted" }],
    });
    tx.generationRun.findUnique.mockResolvedValueOnce({
      id: "run-redacted",
      status: "QUEUED",
      delegationTaskId: null,
      runtimePolicySnapshot: {
        billingMode: "service_credit",
        walletReservation: {
          usageChargeId: "usage-redacted",
          tokenAmount: 1,
        },
      },
    });
    tx.generationRun.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-redact-queued",
      events: [{
        event_id: "$event-redact-queued",
        type: "m.room.redaction",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        redacts: "$event-alice",
        content: {},
      }],
    });

    expect(result).toEqual([{
      eventId: "$event-redact-queued",
      status: "processed",
    }]);
    expect(mockReleaseConversationEntitlement).toHaveBeenCalledWith(
      {
        generationRunId: "run-redacted",
        reason: "input_message_redacted",
      },
      fencedTx,
    );
    expect(mockReleaseConversationWalletUsage).toHaveBeenCalledWith(
      {
        usageChargeId: "usage-redacted",
        expectedGenerationRunId: "run-redacted",
        reason: "input_message_redacted",
        idempotencyKey:
          "message:message-alice:redaction:usage-redacted:release",
      },
      fencedTx,
    );
    expect(tx.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-redacted",
        status: { in: ["QUEUED", "PROCESSING", "WAITING_APPROVAL", "WAITING_HUMAN"] },
      },
      data: expect.objectContaining({
        status: "CANCELED",
        errorCode: "input_message_redacted",
        canceledAt: expect.any(Date),
        runtimePolicySnapshot: expect.not.objectContaining({
          walletReservation: expect.anything(),
        }),
      }),
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: "run-redacted",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "PROCESSED",
        processedAt: expect.any(Date),
      }),
    });
  });

  it("rejects redaction when a failed run still belongs to an active delegation task", async () => {
    mockPrisma.message.findFirst.mockResolvedValueOnce({
      id: "message-delegated-failed",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });
    tx.message.findFirst.mockResolvedValueOnce({
      id: "message-delegated-failed",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-delegated-failed" }],
    });
    tx.generationRun.findUnique.mockResolvedValueOnce({
      id: "run-delegated-failed",
      status: "FAILED",
      delegationTaskId: "task-delegated",
      delegationTask: { status: "WAITING_FOR_OWNER" },
      outputMessageId: null,
      outputMessage: null,
      runtimePolicySnapshot: null,
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-redact-failed-delegated",
      events: [{
        event_id: "$event-redact-failed-delegated",
        type: "m.room.redaction",
        room_id: "!room:example.org",
        sender: aliceMatrixUserId,
        redacts: "$event-original-delegated",
        content: {},
      }],
    });

    expect(result).toEqual([{
      eventId: "$event-redact-failed-delegated",
      status: "ignored",
      reason: "matrix_redaction_delegation_active",
    }]);
    expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.generationRun.updateMany).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("cancels completed output that has not crossed the delivery boundary", async () => {
    tx.message.findFirst.mockResolvedValueOnce({
      id: "message-completed-input",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-completed" }],
    });
    tx.generationRun.findUnique.mockResolvedValueOnce({
      id: "run-completed",
      status: "COMPLETED",
      delegationTaskId: null,
      delegationTask: null,
      outputMessageId: "message-completed-output",
      outputMessage: {
        id: "message-completed-output",
        deliveryStatus: "QUEUED",
      },
      runtimePolicySnapshot: null,
    });
    tx.outboxEvent.findFirst.mockResolvedValueOnce({
      status: "PENDING",
      availableAt: new Date(Date.now() - 1_000),
    });

    await redactConversationMessage({
      representativeSlug: "sktone",
      conversationId: "conversation-1",
      messageId: "message-completed-input",
      reason: "matrix_redaction",
    });

    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        aggregateType: "generation_run",
        aggregateId: "run-completed",
        eventType: "generation.requested",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: "input_message_redacted_before_delivery",
      },
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message-completed-output",
        deliveryStatus: { in: ["PROCESSING", "QUEUED", "FAILED"] },
      },
      data: {
        deliveryStatus: "CANCELED",
        failureCode: "input_message_redacted_before_delivery",
        failureReason:
          "AI delivery was canceled because its input message was redacted.",
      },
    });
    expect(tx.generationRun.updateMany).not.toHaveBeenCalled();
    expect(mockReleaseConversationEntitlement).not.toHaveBeenCalled();
    expect(mockReleaseConversationWalletUsage).not.toHaveBeenCalled();
  });

  it("rejects redaction while completed output has a valid delivery lease", async () => {
    tx.message.findFirst.mockResolvedValueOnce({
      id: "message-delivery-in-flight",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-delivery-in-flight" }],
    });
    tx.generationRun.findUnique.mockResolvedValueOnce({
      id: "run-delivery-in-flight",
      status: "COMPLETED",
      delegationTaskId: null,
      delegationTask: null,
      outputMessageId: "message-output-in-flight",
      outputMessage: {
        id: "message-output-in-flight",
        deliveryStatus: "PROCESSING",
      },
      runtimePolicySnapshot: null,
    });
    tx.outboxEvent.findFirst.mockResolvedValueOnce({
      status: "PROCESSING",
      availableAt: new Date(Date.now() + 60_000),
    });

    await expect(redactConversationMessage({
      representativeSlug: "sktone",
      conversationId: "conversation-1",
      messageId: "message-delivery-in-flight",
      reason: "matrix_redaction",
    })).rejects.toBeInstanceOf(ConversationWorkInFlightControlError);

    expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.message.updateMany).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("defers an in-flight redaction without consuming its retry budget and applies it after delivery", async () => {
    const event: MatrixApplicationServiceEvent = {
      event_id: "$event-redaction-after-delivery",
      type: "m.room.redaction",
      room_id: "!room:example.org",
      sender: aliceMatrixUserId,
      redacts: "$event-audience-message",
      content: {},
    };
    const inbox = {
      id: "inbox:$event-redaction-after-delivery",
      status: "PENDING",
      attemptCount: 4,
      eventType: event.type!,
      payload: event,
      lastError: null,
    };
    mockPrisma.channelEventInbox.upsert
      .mockResolvedValueOnce(inbox)
      .mockResolvedValueOnce({
        ...inbox,
        status: "FAILED",
      });
    mockPrisma.message.findFirst.mockResolvedValue({
      id: "message-audience-redacted",
      senderId: aliceMatrixUserId,
      senderType: "AUDIENCE",
    });
    tx.message.findFirst.mockResolvedValue({
      id: "message-audience-redacted",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputForGenerationRuns: [{ id: "run-delivery-redaction" }],
    });
    tx.generationRun.findUnique
      .mockResolvedValueOnce({
        id: "run-delivery-redaction",
        status: "COMPLETED",
        delegationTaskId: null,
        delegationTask: null,
        outputMessageId: "message-output-delivery-redaction",
        outputMessage: {
          id: "message-output-delivery-redaction",
          deliveryStatus: "PROCESSING",
        },
        runtimePolicySnapshot: null,
      })
      .mockResolvedValueOnce({
        id: "run-delivery-redaction",
        status: "COMPLETED",
        delegationTaskId: null,
        delegationTask: null,
        outputMessageId: "message-output-delivery-redaction",
        outputMessage: {
          id: "message-output-delivery-redaction",
          deliveryStatus: "SENT",
        },
        runtimePolicySnapshot: null,
      });
    tx.outboxEvent.findFirst
      .mockResolvedValueOnce({
        status: "PROCESSING",
        availableAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce(null);

    const deferred = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-redaction-after-delivery-1",
      events: [event],
    });
    const processed = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-redaction-after-delivery-2",
      events: [event],
    });

    expect(deferred).toEqual([{
      eventId: event.event_id,
      status: "failed",
      reason: "matrix_redaction_delivery_in_flight",
    }]);
    expect(processed).toEqual([{
      eventId: event.event_id,
      status: "processed",
    }]);
    expect(mockPrisma.channelEventInbox.update).toHaveBeenCalledWith({
      where: { id: inbox.id },
      data: {
        status: "FAILED",
        attemptCount: { decrement: 1 },
        processedAt: null,
        availableAt: expect.any(Date),
        lastError: "matrix_redaction_delivery_in_flight",
      },
    });
    expect(mockPrisma.channelEventInbox.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DEAD_LETTER" }),
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-audience-redacted" },
      data: expect.objectContaining({
        deliveryStatus: "REDACTED",
        redactedAt: expect.any(Date),
        redactionReason: "matrix_redaction",
      }),
    });
  });

  it("continues to suppress managed virtual-user echoes", async () => {
    mockPrisma.matrixVirtualUserBinding.findUnique.mockResolvedValue({
      id: "virtual-representative-1",
    });

    const result = await ingestMatrixApplicationServiceTransaction({
      transactionId: "transaction-echo",
      events: [matrixTextEvent("$event-echo", "@_delegate_rep:example.org")],
    });

    expect(result).toEqual([{
      eventId: "$event-echo",
      status: "ignored",
      reason: "matrix_managed_sender_echo",
    }]);
    expect(mockPrisma.conversationChannelBinding.findFirst).not.toHaveBeenCalled();
  });
});

function matrixTextEvent(
  eventId: string,
  sender: string,
  roomId = "!room:example.org",
): MatrixApplicationServiceEvent {
  return {
    event_id: eventId,
    type: "m.room.message",
    room_id: roomId,
    sender,
    content: {
      msgtype: "m.text",
      body: "hello",
    },
  };
}

function buildMatrixBinding(input: {
  contactMatrixUserId?: string | null;
  desiredState?: "ACTIVE" | "PAUSED" | "DISCONNECTED";
  healthStatus?: "HEALTHY" | "UNHEALTHY";
  lifecycleState?: "PUBLISHED" | "PAUSED" | "DRAFT" | "ARCHIVED";
  representativeBinding?: {
    status: string;
    desiredState: string;
    healthStatus: string;
    externalUserId?: string;
    endpointAssignmentRevision?: number;
  } | null;
  metadata?: Record<string, unknown>;
  runtimePolicyOverlays?: Array<{
    enabled: boolean;
    priority: number;
    startsAt: Date;
    expiresAt: Date | null;
    payload: Record<string, unknown>;
  }>;
  participants?: Array<{
    kind: string;
    participantId: string;
    leftAt: Date | null;
    metadata: Record<string, unknown> | null;
  }>;
} = {}) {
  return {
    id: "matrix-binding-1",
    conversationId: "conversation-1",
    kind: "MATRIX",
    connectionId: "delegate-matrix-as",
    representativeAssignmentRevision: 1,
    externalConversationId: "!room:example.org",
    metadata: input.metadata ?? matrixSafetyMetadata(),
    representativeBinding: input.representativeBinding === undefined
      ? {
          status: "CONNECTED",
          desiredState: input.desiredState ?? "ACTIVE",
          healthStatus: input.healthStatus ?? "HEALTHY",
          externalUserId: "@_delegate_rep:example.org",
          endpointAssignmentRevision: 1,
        }
      : input.representativeBinding
        ? {
            ...input.representativeBinding,
            externalUserId:
              input.representativeBinding.externalUserId
              ?? "@_delegate_rep:example.org",
            endpointAssignmentRevision:
              input.representativeBinding
                .endpointAssignmentRevision ?? 1,
          }
        : null,
    conversation: {
      audienceIdentityId: "audience-identity-1",
      representative: {
        id: "representative-1",
        slug: "representative",
        lifecycleState: input.lifecycleState ?? "PUBLISHED",
        activeVersionId: "version-1",
        publicMode: true,
        runtimePolicyOverlays: input.runtimePolicyOverlays ?? [],
      },
      contact: {
        id: "contact-1",
        channelUserId: input.contactMatrixUserId === undefined
          ? aliceMatrixUserId
          : input.contactMatrixUserId,
        externalUserId: null,
      },
      participants: input.participants ?? [{
        kind: "AUDIENCE",
        participantId: "contact-1",
        leftAt: null,
        metadata: null,
      }],
    },
  };
}

function matrixSafetyMetadata() {
  return {
    directMessageOnly: true,
    encrypted: false,
    securityState: "ACTIVE",
    audienceMatrixUserId: aliceMatrixUserId,
    representativeMatrixUserId: "@_delegate_rep:example.org",
    representativeAssignmentRevision: 1,
  };
}

function buildMultipleAudienceParticipants() {
  return [
    {
      kind: "AUDIENCE",
      participantId: "contact-1",
      leftAt: null,
      metadata: { matrixUserId: aliceMatrixUserId },
    },
    {
      kind: "AUDIENCE",
      participantId: "contact-2",
      leftAt: null,
      metadata: { matrixUserId: "@mallory:example.org" },
    },
  ];
}
