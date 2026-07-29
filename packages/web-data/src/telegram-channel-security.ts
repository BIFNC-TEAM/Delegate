import {
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";

import { resolveChannelAvailability } from "./channel-availability";
import { prisma } from "./prisma";

/**
 * Serializes the final Telegram provider call with representative assignment,
 * unassignment, Bot disable/revoke, and credential rotation. The conversation
 * binding carries the immutable assignment epoch created by Telegram ingress;
 * an old or NULL epoch always fails closed, including an A -> B -> A cycle.
 */
export async function withActiveTelegramRepresentativeChannelFence<T>(
  input: {
    conversationId: string;
    expectedConnectionId: string;
  },
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<
  | { executed: true; value: T }
  | { executed: false; reason: "telegram_channel_not_active" }
> {
  const conversationId = input.conversationId.trim();
  const expectedConnectionId = input.expectedConnectionId.trim();
  if (!conversationId || !expectedConnectionId) {
    return {
      executed: false,
      reason: "telegram_channel_not_active",
    };
  }
  const candidate =
    await prisma.conversationChannelBinding.findFirst({
      where: {
        conversationId,
        kind: RepresentativeChannelKind.TELEGRAM,
      },
      select: {
        representativeBinding: {
          select: {
            representativeId: true,
          },
        },
      },
    });
  const representativeId =
    candidate?.representativeBinding?.representativeId;
  if (!representativeId) {
    return {
      executed: false,
      reason: "telegram_channel_not_active",
    };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${`telegram-bot-channel:${representativeId}`})
      )
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${`telegram-bot-connection:${expectedConnectionId}`})
      )
    `;
    const binding =
      await tx.conversationChannelBinding.findFirst({
        where: {
          conversationId,
          kind: RepresentativeChannelKind.TELEGRAM,
        },
        select: {
          connectionId: true,
          representativeAssignmentRevision: true,
          representativeBinding: {
            select: {
              connectionId: true,
              telegramBotConnectionId: true,
              endpointAssignmentRevision: true,
              status: true,
              desiredState: true,
              healthStatus: true,
              telegramBotConnection: {
                select: {
                  id: true,
                  botId: true,
                  status: true,
                },
              },
              representative: {
                select: {
                  lifecycleState: true,
                  activeVersionId: true,
                  publicMode: true,
                  runtimePolicyOverlays: {
                    where: { enabled: true },
                    select: {
                      enabled: true,
                      priority: true,
                      startsAt: true,
                      expiresAt: true,
                      payload: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
    const representativeBinding = binding?.representativeBinding;
    const availability = resolveChannelAvailability({
      channel: "telegram",
      lifecycleState:
        representativeBinding?.representative.lifecycleState
        ?? "ARCHIVED",
      activeVersionId:
        representativeBinding?.representative.activeVersionId ?? null,
      publicMode:
        representativeBinding?.representative.publicMode ?? false,
      binding: representativeBinding
        ? {
            legacyStatus: representativeBinding.status,
            desiredState: representativeBinding.desiredState,
            healthStatus: representativeBinding.healthStatus,
          }
        : null,
      telegramEndpoint: {
        conversationConnectionId: binding?.connectionId,
        representativeConnectionId:
          representativeBinding?.connectionId,
        conversationRepresentativeAssignmentRevision:
          binding?.representativeAssignmentRevision,
        representativeAssignmentRevision:
          representativeBinding?.endpointAssignmentRevision,
        expectedConnectionId,
        representativeTelegramBotConnectionId:
          representativeBinding?.telegramBotConnectionId,
        representativeTelegramBot:
          representativeBinding?.telegramBotConnection,
      },
      overlays:
        representativeBinding?.representative.runtimePolicyOverlays.map(
          (overlay) => ({
            ...overlay,
            payload: isJsonRecord(overlay.payload)
              ? overlay.payload
              : {},
          }),
        ) ?? [],
    });
    if (!availability.available) {
      return {
        executed: false,
        reason: "telegram_channel_not_active",
      } as const;
    }
    return {
      executed: true,
      value: await operation(tx),
    } as const;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}
