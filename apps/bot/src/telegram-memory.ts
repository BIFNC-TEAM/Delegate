import {
  claimMemoryChannelDisclosureDelivery,
  completeMemoryChannelDisclosureDelivery,
  failMemoryChannelDisclosureDelivery,
} from "@delegate/web-data";

export const telegramContactMemoryDeleteText = "删除我的记忆";

export type TelegramMemoryDisclosureSendResult = {
  externalMessageId: string;
  deliveredAt: Date;
};

export type TelegramMemoryDisclosureResult =
  | "current"
  | "in_flight"
  | "delivered";

/**
 * Sends and durably records the current memory notice for one exact Telegram
 * conversation. A failed or unproven send never authorizes memory use.
 */
export async function ensureTelegramMemoryDisclosure(input: {
  conversationId: string;
  inboundExternalMessageId: string;
  send: (text: string) => Promise<TelegramMemoryDisclosureSendResult>;
}): Promise<TelegramMemoryDisclosureResult> {
  const claim = await claimMemoryChannelDisclosureDelivery({
    conversationId: input.conversationId,
    channel: "telegram",
    inboundExternalMessageIds: [input.inboundExternalMessageId],
  });
  if (!claim.send) return claim.status;

  try {
    const sent = await input.send(claim.text);
    const completed = await completeMemoryChannelDisclosureDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      externalMessageId: sent.externalMessageId,
      deliveredAt: sent.deliveredAt,
    });
    if (!completed) {
      throw new Error("Telegram memory disclosure proof was not committed.");
    }
    return "delivered";
  } catch (error) {
    try {
      await failMemoryChannelDisclosureDelivery({
        deliveryId: claim.deliveryId,
        leaseToken: claim.leaseToken,
        errorCode: "telegram_disclosure_delivery_failed",
      });
    } catch (failureRecordError) {
      console.error(
        "Telegram memory disclosure failure could not be recorded:",
        failureRecordError,
      );
    }
    throw error;
  }
}

/**
 * Telegram timestamps are trusted provider event times with second precision.
 * Reject obviously invalid or far-future values rather than letting them move a
 * message beyond the disclosure fence.
 */
export function resolveTelegramProviderOccurredAt(
  unixSeconds: number | null | undefined,
  receivedAt = new Date(),
): Date {
  if (!Number.isSafeInteger(unixSeconds) || (unixSeconds ?? -1) < 0) {
    throw new Error("Telegram provider event time is invalid.");
  }
  const occurredAt = new Date(unixSeconds! * 1_000);
  if (
    !Number.isFinite(occurredAt.getTime())
    || occurredAt.getTime() > receivedAt.getTime() + 5 * 60_000
  ) {
    throw new Error("Telegram provider event time is too far in the future.");
  }
  return occurredAt;
}
