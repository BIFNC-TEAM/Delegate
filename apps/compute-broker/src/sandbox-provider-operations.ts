import { createHash, randomBytes } from "node:crypto";
import type {
  Prisma,
  SandboxProviderKind,
  SandboxProviderOperationState,
} from "@prisma/client";

import { prisma } from "./prisma";

const CREATE_ATTEMPT_DEADLINE_MS = 2 * 60 * 1000;

export function buildSandboxCreationKey(sandboxLeaseId: string, attemptNumber: number) {
  return createHash("sha256")
    .update(`delegate-sandbox-create:v1:${sandboxLeaseId}:${attemptNumber}`)
    .digest("hex");
}

export async function createSandboxProviderOperation(
  tx: Prisma.TransactionClient,
  input: {
    sandboxLeaseId: string;
    provider: SandboxProviderKind;
    attemptNumber?: number | undefined;
    now?: Date | undefined;
  },
) {
  const attemptNumber = input.attemptNumber ?? 1;
  const now = input.now ?? new Date();
  const creationKey = buildSandboxCreationKey(input.sandboxLeaseId, attemptNumber);
  return tx.sandboxProviderOperation.create({
    data: {
      sandboxLeaseId: input.sandboxLeaseId,
      attemptNumber,
      creationKey,
      provider: input.provider,
      operation: "CREATE",
      state: "PENDING",
      ownerTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      ownerLeaseExpiresAt: new Date(now.getTime() + 30_000),
      deadlineAt: new Date(now.getTime() + CREATE_ATTEMPT_DEADLINE_MS),
    },
  });
}

export function markSandboxProviderOperationCalled(
  operationId: string,
  now = new Date(),
) {
  return {
    where: {
      id: operationId,
      state: "PENDING" as const,
      deadlineAt: { gt: now },
    },
    data: {
      state: "CALLED" as const,
      calledAt: now,
    },
  };
}

export function markSandboxProviderOperationBound(input: {
  operationId: string;
  providerSandboxId: string | null;
  providerOperationId?: string | null | undefined;
  now?: Date | undefined;
}) {
  const now = input.now ?? new Date();
  return {
    where: {
      id: input.operationId,
      state: "CALLED" as const,
      deadlineAt: { gt: now },
    },
    data: {
      state: "BOUND" as const,
      providerSandboxId: input.providerSandboxId,
      providerOperationId: input.providerOperationId ?? null,
      ownerTokenHash: null,
      ownerLeaseExpiresAt: null,
    },
  };
}

export function markSandboxProviderOperationResolved(operationId: string, now = new Date()) {
  return {
    where: { id: operationId, state: "BOUND" as const },
    data: {
      state: "RESOLVED" as const,
      resolvedAt: now,
      ownerTokenHash: null,
      ownerLeaseExpiresAt: null,
    },
  };
}

export function markSandboxProviderOperationFailed(input: {
  operationId: string;
  errorCode: string;
  ambiguous: boolean;
}) {
  return {
    where: {
      id: input.operationId,
      state: {
        in: ["PENDING", "CALLED", "BOUND", "UNKNOWN"] as SandboxProviderOperationState[],
      },
    },
    data: {
      state: input.ambiguous ? "UNKNOWN" as const : "FAILED" as const,
      lastErrorCode: input.errorCode.slice(0, 120),
      ownerTokenHash: null,
      ownerLeaseExpiresAt: null,
      ...(!input.ambiguous ? { resolvedAt: new Date() } : {}),
    },
  };
}

export function quarantineExpiredSandboxProviderOperations(now = new Date()) {
  return prisma.sandboxProviderOperation.updateMany({
    where: {
      state: { in: ["PENDING", "CALLED", "UNKNOWN"] },
      deadlineAt: { lte: now },
    },
    data: {
      state: "QUARANTINED",
      ownerTokenHash: null,
      ownerLeaseExpiresAt: null,
    },
  });
}

export function startSandboxProviderOperationQuarantineLoop(input: {
  intervalMs: number;
  logger?: Pick<typeof console, "error"> | undefined;
}) {
  const timer = setInterval(() => {
    void quarantineExpiredSandboxProviderOperations().catch((error) => {
      (input.logger ?? console).error("sandbox provider operation quarantine failed", error);
    });
  }, input.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
