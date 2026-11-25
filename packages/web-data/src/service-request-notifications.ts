import { prisma } from "./prisma";
import { enqueueConversationMessageDeliveryInTransaction } from "./conversation-platform";

/** Retries preparation separately from the committed business decision. */
export async function flushServiceRequestNotification(notificationId?: string) {
  const item = await prisma.serviceRequestNotification.findFirst({ where: { status: "pending", ...(notificationId ? { id: notificationId } : {}), availableAt: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
  if (!item) return { processed: false as const };
  try {
    await prisma.$transaction(async tx => {
      // The row lock fences competing workers; the message and existing channel outbox commit together.
      await tx.$queryRaw`SELECT id FROM "ServiceRequestNotification" WHERE id = ${item.id} FOR UPDATE`;
      const current = await tx.serviceRequestNotification.findUniqueOrThrow({ where: { id: item.id } });
      if (current.status !== "pending") return;
      const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: current.conversationId } });
      const message = await tx.message.create({ data: {
        conversationId: current.conversationId, episodeId: conversation.activeEpisodeId,
        senderType: "SYSTEM", contentType: "TEXT", text: current.text, deliveryStatus: "QUEUED",
      } });
      await enqueueConversationMessageDeliveryInTransaction(tx, { conversationId: current.conversationId, messageId: message.id, deliveryKind: "system_notification" });
      await tx.serviceRequestNotification.update({ where: { id: current.id }, data: { status: "queued", messageId: message.id, attempts: { increment: 1 } } });
    });
    return { processed: true as const, status: "queued" };
  } catch {
    await prisma.serviceRequestNotification.updateMany({ where: { id: item.id, status: "pending" }, data: {
      attempts: { increment: 1 }, availableAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(item.attempts, 8))),
    } });
    return { processed: true as const, status: "retrying" };
  }
}
