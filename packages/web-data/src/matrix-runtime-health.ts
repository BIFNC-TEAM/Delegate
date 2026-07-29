import {
  ChannelDesiredState,
  ChannelHealthStatus,
  RepresentativeChannelKind,
} from "@prisma/client";

import { normalizeMatrixUserId } from "./matrix-identifiers";
import { prisma } from "./prisma";

export type MatrixRuntimeHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY";

export async function checkMatrixRuntimePersistenceReadiness(
  client: Pick<typeof prisma, "$queryRawUnsafe"> = prisma,
): Promise<boolean> {
  try {
    await client.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors protocol-level evidence from the Matrix Application Service into
 * the owner control plane. This is deliberately scoped by the managed MXID so
 * one representative cannot affect another representative's channel row.
 */
export async function recordMatrixRuntimeHealth(input: {
  matrixUserId: string;
  status: MatrixRuntimeHealthStatus;
  errorCode?: string | null;
  checkedAt?: Date;
  expectedAssignmentRevision?: number;
}): Promise<boolean> {
  const matrixUserId = normalizeMatrixUserId(input.matrixUserId);
  const checkedAt = input.checkedAt ?? new Date();
  const healthStatus = ChannelHealthStatus[input.status];
  const lastError =
    input.status === "HEALTHY"
      ? null
      : normalizeMatrixRuntimeError(input.errorCode);
  const expectedAssignmentRevision =
    input.expectedAssignmentRevision;
  if (
    expectedAssignmentRevision !== undefined
    && (
      !Number.isSafeInteger(expectedAssignmentRevision)
      || expectedAssignmentRevision <= 0
    )
  ) {
    return false;
  }
  const virtualUser = await prisma.matrixVirtualUserBinding.findFirst({
    where: {
      matrixUserId,
      kind: "REPRESENTATIVE",
      enabled: true,
      representativeId: { not: null },
    },
    select: { representativeId: true },
  });
  const representativeId = virtualUser?.representativeId;
  if (!representativeId) return false;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${`matrix-virtual-user:${representativeId}`})
      )
    `;
    const activeVirtualUser = await tx.matrixVirtualUserBinding.findFirst({
      where: {
        matrixUserId,
        kind: "REPRESENTATIVE",
        enabled: true,
        representativeId,
      },
      select: { representativeId: true },
    });
    if (!activeVirtualUser) return false;

    const updated = await tx.representativeChannelBinding.updateMany({
      where: {
        representativeId,
        kind: RepresentativeChannelKind.MATRIX,
        externalUserId: matrixUserId,
        desiredState: { not: ChannelDesiredState.DISCONNECTED },
        status: { not: "DISCONNECTED" },
        ...(expectedAssignmentRevision === undefined
          ? {}
          : {
              endpointAssignmentRevision:
                expectedAssignmentRevision,
            }),
      },
      data: {
        healthStatus,
        lastHealthCheckAt: checkedAt,
        lastError,
        ...(input.status === "HEALTHY" ? { status: "CONNECTED" } : {}),
      },
    });
    return updated.count === 1;
  });
}

function normalizeMatrixRuntimeError(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() || "matrix_runtime_unhealthy";
  return /^[a-z0-9][a-z0-9:_-]{0,159}$/.test(normalized)
    ? normalized
    : "matrix_runtime_error";
}
