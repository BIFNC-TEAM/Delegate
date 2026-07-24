import {
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";

import { prisma } from "./prisma";

export type MatrixRoomSecurityState =
  | "PENDING_REMOTE_VALIDATION"
  | "ACTIVE"
  | "ISOLATED"
  | "UNKNOWN";

export type MatrixRoomSecuritySnapshot = {
  bindingId: string;
  conversationId: string;
  securityState: MatrixRoomSecurityState;
  audienceMatrixUserId: string | null;
  representativeMatrixUserId: string | null;
};

export async function lockMatrixRoomSecurityState(
  tx: Prisma.TransactionClient,
  roomId: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`matrix-room-security:${roomId}`})
    )
  `;
}

export async function getMatrixRoomSecuritySnapshot(
  roomId: string,
): Promise<MatrixRoomSecuritySnapshot | null> {
  const binding = await prisma.conversationChannelBinding.findFirst({
    where: {
      kind: RepresentativeChannelKind.MATRIX,
      externalConversationId: roomId,
    },
    select: {
      id: true,
      conversationId: true,
      metadata: true,
    },
  });
  if (!binding) return null;

  const metadata = isJsonRecord(binding.metadata) ? binding.metadata : {};
  return {
    bindingId: binding.id,
    conversationId: binding.conversationId,
    securityState: normalizeMatrixRoomSecurityState(metadata.securityState),
    audienceMatrixUserId:
      typeof metadata.audienceMatrixUserId === "string"
        ? metadata.audienceMatrixUserId
        : null,
    representativeMatrixUserId:
      typeof metadata.representativeMatrixUserId === "string"
        ? metadata.representativeMatrixUserId
        : null,
  };
}

function normalizeMatrixRoomSecurityState(
  value: unknown,
): MatrixRoomSecurityState {
  return value === "PENDING_REMOTE_VALIDATION"
    || value === "ACTIVE"
    || value === "ISOLATED"
    ? value
    : "UNKNOWN";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
