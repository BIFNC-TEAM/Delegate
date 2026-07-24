import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  tx,
  mockResolveChannelAudienceIdentity,
} = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(),
    representative: {
      findUnique: vi.fn(),
    },
    matrixVirtualUserBinding: {
      upsert: vi.fn(),
    },
    representativeChannelBinding: {
      upsert: vi.fn(),
    },
    contact: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    conversationChannelBinding: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    conversationParticipant: {
      upsert: vi.fn(),
    },
  };
  return {
    tx: transactionClient,
    mockPrisma: {
      $transaction: vi.fn(),
    },
    mockResolveChannelAudienceIdentity: vi.fn(),
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../src/web-audience", () => ({
  resolveChannelAudienceIdentity: mockResolveChannelAudienceIdentity,
}));

import { provisionMatrixDirectConversation } from "../src/matrix-provisioning";

const roomId = "!room:example.org";
const audienceMatrixUserId = "@alice:example.org";
const representativeMatrixUserId = "@_delegate_rep:example.org";

describe("Matrix direct conversation provisioning", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    tx.$executeRaw.mockResolvedValue(0);
    mockResolveChannelAudienceIdentity.mockResolvedValue({
      id: "audience-identity-1",
    });
  });

  it.each([
    "ACTIVE",
    "ISOLATED",
    "PENDING_REMOTE_VALIDATION",
  ] as const)("does not regress an existing %s binding", async (securityState) => {
    tx.conversationChannelBinding.findFirst.mockResolvedValue(
      buildExistingBinding({ securityState }),
    );

    const result = await provisionMatrixDirectConversation(provisionInput());

    expect(result).toEqual(expect.objectContaining({
      status: "ready",
      securityState,
      channelBindingId: "matrix-binding-1",
    }));
    expect(mockResolveChannelAudienceIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "MATRIX",
        providerSubject: audienceMatrixUserId,
        issuer: "example.org",
        connectionId: "delegate-matrix-as",
      }),
    );
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.any(Array),
      `matrix-room-security:${roomId}`,
    );
    expect(tx.conversationChannelBinding.upsert).not.toHaveBeenCalled();
    expect(tx.conversationChannelBinding.update).not.toHaveBeenCalled();
    expect(tx.conversation.update).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "audience",
      existing: {
        securityState: "ACTIVE" as const,
        audienceMatrixUserId: "@mallory:example.org",
      },
      input: provisionInput(),
      observed: {
        observedAudienceMatrixUserId: audienceMatrixUserId,
      },
    },
    {
      label: "representative",
      existing: {
        securityState: "ACTIVE" as const,
      },
      input: provisionInput({
        representativeId: "representative-2",
        representativeMatrixUserId: "@_delegate_other:example.org",
      }),
      observed: {
        observedRepresentativeId: "representative-2",
        observedRepresentativeMatrixUserId: "@_delegate_other:example.org",
      },
    },
  ])("isolates a room instead of rebinding it to a different $label", async ({
    existing,
    input,
    observed,
  }) => {
    tx.conversationChannelBinding.findFirst.mockResolvedValue(
      buildExistingBinding(existing),
    );

    const result = await provisionMatrixDirectConversation(input);

    expect(result).toEqual(expect.objectContaining({
      status: "isolated_conflict",
      securityState: "ISOLATED",
      reason: "matrix_room_binding_participant_conflict",
    }));
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { state: "FAILED" },
    });
    expect(tx.conversationChannelBinding.update).toHaveBeenCalledWith({
      where: { id: "matrix-binding-1" },
      data: {
        metadata: expect.objectContaining({
          securityState: "ISOLATED",
          isolationReason: "matrix_room_binding_participant_conflict",
          ...observed,
        }),
      },
    });
    expect(tx.conversationChannelBinding.upsert).not.toHaveBeenCalled();
  });
});

function provisionInput(overrides: {
  representativeId?: string;
  representativeMatrixUserId?: string;
} = {}) {
  return {
    representativeId: overrides.representativeId ?? "representative-1",
    roomId,
    audienceMatrixUserId,
    representativeMatrixUserId:
      overrides.representativeMatrixUserId ?? representativeMatrixUserId,
    directInvite: true as const,
  };
}

function buildExistingBinding(input: {
  securityState: "PENDING_REMOTE_VALIDATION" | "ACTIVE" | "ISOLATED";
  audienceMatrixUserId?: string;
}) {
  return {
    id: "matrix-binding-1",
    conversationId: "conversation-1",
    metadata: {
      directMessageOnly: true,
      encrypted: false,
      securityState: input.securityState,
      audienceMatrixUserId:
        input.audienceMatrixUserId ?? audienceMatrixUserId,
      representativeMatrixUserId,
    },
    conversation: {
      representativeId: "representative-1",
      audienceIdentityId: "audience-identity-1",
      contactId: "contact-1",
    },
  };
}
