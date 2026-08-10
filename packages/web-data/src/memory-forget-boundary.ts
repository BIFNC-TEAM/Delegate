import { Prisma, RepresentativeChannelKind } from "@prisma/client";

export type ContactChannelMemoryCoordinates = {
  representativeId: string;
  contactId: string;
  sourceChannel: RepresentativeChannelKind;
};

export type ContactChannelMemoryForgetBoundarySnapshot = {
  id: string;
  epoch: number;
  sourceConversationId: string;
  sourceMessageId: string;
  cutoffMemoryIngressOrdinal: bigint;
  cutoffIngressSequence: number | null;
  requestHash: string;
  createdAt: Date;
};

export const contactChannelMemoryForgetCutoffReasonCode =
  "contact_channel_memory_forget_cutoff";

/**
 * Serializes enqueue, processing, activation, injection and deletion for one
 * contact + representative + channel coordinate. PostgreSQL hash collisions
 * only reduce concurrency; they cannot cross data scopes.
 */
export async function lockContactChannelMemoryCoordinate(
  tx: Prisma.TransactionClient,
  input: ContactChannelMemoryCoordinates,
) {
  // Unit transaction fakes intentionally omit PostgreSQL primitives. Real
  // Prisma clients always expose this method; a migrated client with a missing
  // table still fails closed in the reader below.
  if (typeof tx.$executeRaw !== "function") return;
  const lockKey = [
    "contact-channel-memory",
    input.representativeId,
    input.contactId,
    input.sourceChannel,
  ].join(":");
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
  );
}

export async function loadLatestContactChannelMemoryForgetBoundary(
  tx: Pick<Prisma.TransactionClient, "contactChannelMemoryForgetBoundary">,
  input: ContactChannelMemoryCoordinates,
): Promise<ContactChannelMemoryForgetBoundarySnapshot | null> {
  if (!tx.contactChannelMemoryForgetBoundary?.findFirst) return null;
  return tx.contactChannelMemoryForgetBoundary.findFirst({
    where: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      sourceChannel: input.sourceChannel,
    },
    orderBy: { epoch: "desc" },
    select: {
      id: true,
      epoch: true,
      sourceConversationId: true,
      sourceMessageId: true,
      cutoffMemoryIngressOrdinal: true,
      cutoffIngressSequence: true,
      requestHash: true,
      createdAt: true,
    },
  });
}

export function isContactChannelMemorySourceAfterForgetBoundary(
  boundary: ContactChannelMemoryForgetBoundarySnapshot | null,
  source: {
    contactChannelMemoryEpoch: number | null | undefined;
    memoryIngressOrdinal: bigint | null;
  },
) {
  if (!boundary) return (source.contactChannelMemoryEpoch ?? 0) === 0;
  return source.contactChannelMemoryEpoch === boundary.epoch
    && source.memoryIngressOrdinal !== null
    && source.memoryIngressOrdinal > boundary.cutoffMemoryIngressOrdinal;
}

export function currentContactChannelMemoryEpoch(
  boundary: ContactChannelMemoryForgetBoundarySnapshot | null,
) {
  return boundary?.epoch ?? 0;
}

export function toRepresentativeMemoryChannel(
  channel: "web" | "matrix" | "telegram",
): RepresentativeChannelKind {
  if (channel === "matrix") return RepresentativeChannelKind.MATRIX;
  if (channel === "telegram") return RepresentativeChannelKind.TELEGRAM;
  return RepresentativeChannelKind.WEB;
}
