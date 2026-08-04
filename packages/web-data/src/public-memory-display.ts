import {
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";

import {
  markMemoryUseItemsDisplayedInTransaction,
} from "./memory-use-execution";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";
import { buildWebConversationThreadId } from "./web-audience";

type PublicMemoryDisplayTransaction = Prisma.TransactionClient;

export type PublicMemoryDisplayErrorCode =
  | "public_memory_display_invalid_input"
  | "public_memory_display_not_found";

export class PublicMemoryDisplayError extends Error {
  constructor(
    readonly code: PublicMemoryDisplayErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublicMemoryDisplayError";
  }
}

export type AcknowledgePublicMemoryDisplayInput = {
  representativeSlug: string;
  generationRunId: string;
  outputMessageId: string;
  audienceIdentityId: string;
  audienceId: string;
};

export type PublicMemoryDisplayAcknowledgement = {
  acknowledged: true;
  displayedCount: number;
};

export type PublicMemoryDisplayOptions = {
  client?: Pick<typeof prisma, "$transaction">;
  now?: () => Date;
};

/**
 * Records only the cited memory-use items attached to an output that the
 * server-authoritative public audience owns. The browser never chooses item
 * identifiers, so an acknowledgement cannot expand beyond the citations that
 * were actually serialized for that output.
 */
export async function acknowledgePublicMemoryDisplay(
  input: AcknowledgePublicMemoryDisplayInput,
  options: PublicMemoryDisplayOptions = {},
): Promise<PublicMemoryDisplayAcknowledgement> {
  const client = options.client ?? prisma;
  return runWithPrismaWriteConflictRetry(() =>
    client.$transaction((tx) =>
      acknowledgePublicMemoryDisplayInTransaction(
        tx,
        input,
        options.now?.() ?? new Date(),
      ),
    ),
  );
}

export async function acknowledgePublicMemoryDisplayInTransaction(
  tx: PublicMemoryDisplayTransaction,
  input: AcknowledgePublicMemoryDisplayInput,
  occurredAt = new Date(),
): Promise<PublicMemoryDisplayAcknowledgement> {
  const representativeSlug = requiredPublicValue(
    input.representativeSlug,
    "representativeSlug",
  );
  const generationRunId = requiredPublicValue(
    input.generationRunId,
    "generationRunId",
  );
  const outputMessageId = requiredPublicValue(
    input.outputMessageId,
    "outputMessageId",
  );
  const audienceIdentityId = requiredPublicValue(
    input.audienceIdentityId,
    "audienceIdentityId",
  );
  const audienceId = requiredPublicValue(input.audienceId, "audienceId");

  const ownedRunWhere = {
    id: generationRunId,
    outputMessageId,
    conversation: {
      audienceIdentityId,
      sourceChannel: RepresentativeChannelKind.WEB,
      channelThreadId: buildWebConversationThreadId(audienceId),
      representative: { slug: representativeSlug },
    },
  } satisfies Prisma.GenerationRunWhereInput;
  const visibleRun = await tx.generationRun.findFirst({
    where: ownedRunWhere,
    select: { conversationId: true },
  });
  if (!visibleRun) {
    throw new PublicMemoryDisplayError(
      "public_memory_display_not_found",
      "Generation output was not found for the active public audience.",
      404,
    );
  }

  // Keep identity-link changes and the display acknowledgement ordered around
  // the already-authorized conversation row, then re-read ownership.
  await tx.$executeRaw`
    SELECT "id"
      FROM "Conversation"
     WHERE "id" = ${visibleRun.conversationId}
     FOR UPDATE
  `;

  const ownedRun = await tx.generationRun.findFirst({
    where: {
      ...ownedRunWhere,
      conversationId: visibleRun.conversationId,
    },
    select: {
      id: true,
      outputMessageId: true,
      memoryUseRun: { select: { id: true } },
    },
  });
  if (!ownedRun || ownedRun.outputMessageId !== outputMessageId) {
    throw new PublicMemoryDisplayError(
      "public_memory_display_not_found",
      "Generation output was not found for the active public audience.",
      404,
    );
  }

  if (!ownedRun.memoryUseRun) {
    return { acknowledged: true, displayedCount: 0 };
  }

  const citedItems = await tx.memoryUseItem.findMany({
    where: {
      useRunId: ownedRun.memoryUseRun.id,
      citedAt: { not: null },
      citationId: { not: null },
      citation: { messageId: outputMessageId },
    },
    select: { id: true },
  });
  const snapshot = await markMemoryUseItemsDisplayedInTransaction(
    tx,
    {
      useRunId: ownedRun.memoryUseRun.id,
      displayedItemIds: citedItems.map((item) => item.id),
    },
    occurredAt,
  );

  return {
    acknowledged: true,
    displayedCount: snapshot.displayedCount,
  };
}

function requiredPublicValue(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new PublicMemoryDisplayError(
      "public_memory_display_invalid_input",
      `${field} is required.`,
      400,
    );
  }
  return normalized;
}
