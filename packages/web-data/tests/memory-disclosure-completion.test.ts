import { MemoryExpiryAction, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    $transaction: prismaMocks.transaction,
  },
}));

import {
  activateCurrentMemoryChannelDisclosureAfterMessage,
  completeMemoryChannelDisclosureDelivery,
  memoryChannelDisclosureContractVersion,
  type MemoryDisclosureChannel,
} from "../src/memory-disclosure";

const policy = {
  revision: 1,
  longTermMemoryEnabled: true,
  shortTermMemoryEnabled: true,
  contactMemoryEnabled: true,
  contactMemoryCrossChannelEnabled: false,
  representativeExperienceEnabled: true,
  autoExtract: true,
  matrixRecallEnabled: true,
  matrixExtractEnabled: true,
  telegramRecallEnabled: true,
  telegramExtractEnabled: true,
  retentionDays: 30,
  expiryAction: MemoryExpiryAction.ARCHIVE,
};

describe("private-channel disclosure completion boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    { channel: "matrix" as const, priorSequence: 7 },
    { channel: "telegram" as const, priorSequence: 41 },
  ])(
    "seals the PostgreSQL ingress boundary and activates $channel on the next message",
    async ({ channel, priorSequence }) => {
      const deliveredAt = new Date("2026-08-07T01:00:00.000Z");
      const evidenceKind = channel === "matrix"
        ? "MATRIX_MESSAGE"
        : "TELEGRAM_MESSAGE";
      const bindingKind = channel.toUpperCase();
      const connectionId = `${channel}-connection-1`;
      const deliveryFindUnique = vi.fn()
        .mockResolvedValueOnce({
          conversationId: "conversation-1",
          sourceChannel: bindingKind,
          channelBinding: { externalConversationId: `${channel}-room-1` },
        })
        .mockResolvedValueOnce({
          id: "delivery-1",
          representativeId: "representative-1",
          contactId: "contact-1",
          conversationId: "conversation-1",
          channelBindingId: "binding-1",
          bindingEpoch: "binding-epoch-1",
          sourceChannel: bindingKind,
          policyRevision: 1,
          disclosureContractVersion: memoryChannelDisclosureContractVersion,
          disclosureFingerprint: "A".repeat(43),
          disclosureHash: "a".repeat(64),
          evidenceKind,
          connectionId,
          representativeAssignmentRevision: 3,
          status: "PENDING",
          leaseToken: "lease-1",
          leaseExpiresAt: new Date("2026-08-07T01:01:00.000Z"),
        });
      const deliveryUpdateMany = vi.fn(async (_input: {
        where: unknown;
        data: {
          deliveredAfterIngressSequence: number;
          proofHash: string;
          [key: string]: unknown;
        };
      }) => ({ count: 1 }));
      const completionTx = {
        $executeRaw: vi.fn(async () => []),
        $queryRaw: vi.fn(async () => []),
        memoryChannelDisclosureDelivery: {
          findUnique: deliveryFindUnique,
          updateMany: deliveryUpdateMany,
        },
        message: {
          aggregate: vi.fn(async () => ({
            _max: { ingressSequence: priorSequence },
          })),
        },
        channelEventInbox: {
          updateMany: vi.fn(async () => ({ count: 0 })),
          findMany: vi.fn(async () => []),
        },
        memoryChannelDisclosureExcludedInbound: {
          createMany: vi.fn(async () => ({ count: 0 })),
        },
      } as unknown as Prisma.TransactionClient;
      prismaMocks.transaction.mockImplementationOnce(
        async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(completionTx),
      );

      await expect(completeMemoryChannelDisclosureDelivery({
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        externalMessageId: "provider-notice-1",
        deliveredAt,
      })).resolves.toBe(true);

      expect(completionTx.message.aggregate).toHaveBeenCalledWith({
        where: {
          conversationId: "conversation-1",
          senderType: "AUDIENCE",
          ingressSequence: { not: null },
        },
        _max: { ingressSequence: true },
      });
      const update = deliveryUpdateMany.mock.calls[0]![0];
      expect(update.data.deliveredAfterIngressSequence).toBe(priorSequence);
      expect(update.data.proofHash).toMatch(/^[0-9a-f]{64}$/u);

      const nextSequence = priorSequence + 1;
      const nextMessage = {
        id: "message-next",
        ingressSequence: nextSequence,
        channelBindingId: "binding-1",
        channelBinding: {
          id: "binding-1",
          kind: bindingKind,
          connectionId,
          representativeAssignmentRevision: 3,
        },
      };
      const activationCreateMany = vi.fn(async () => ({ count: 1 }));
      const activationTx = {
        message: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(nextMessage)
            .mockResolvedValueOnce({
              id: nextMessage.id,
              ingressSequence: nextSequence,
            }),
        },
        representativeMemoryPolicy: {
          findUnique: vi.fn(async () => policy),
        },
        memoryChannelDisclosureDelivery: {
          findFirst: vi.fn(async () => ({
            id: "delivery-1",
            deliveredAfterIngressSequence: priorSequence,
            connectionId,
            representativeAssignmentRevision: 3,
            evidenceKind,
            proofHash: update.data.proofHash,
            activation: null,
          })),
        },
        memoryChannelDisclosureActivation: {
          createMany: activationCreateMany,
        },
      } as unknown as Prisma.TransactionClient;

      await expect(activateCurrentMemoryChannelDisclosureAfterMessage(
        activationTx,
        {
          representativeId: "representative-1",
          contactId: "contact-1",
          conversationId: "conversation-1",
          messageId: nextMessage.id,
          channel: channel as MemoryDisclosureChannel,
        },
      )).resolves.toBe(true);
      expect(activationCreateMany).toHaveBeenCalledWith({
        data: [{
          deliveryId: "delivery-1",
          firstExcludedMessageId: nextMessage.id,
          firstExcludedIngressSequence: nextSequence,
        }],
        skipDuplicates: true,
      });
    },
  );
});
