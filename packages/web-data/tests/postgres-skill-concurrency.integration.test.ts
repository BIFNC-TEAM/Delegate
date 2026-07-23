import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  McpBindingConflictError,
  updateMcpBindingWithOptimisticLock,
} from "../src/mcp-binding-concurrency";
import { prisma } from "../src/prisma";
import { runWithPrismaWriteConflictRetry } from "../src/prisma-write-conflict-retry";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("workspace skill PostgreSQL concurrency", () => {
  it("allows exactly one MCP edit when two clients submit the same loaded timestamp", async () => {
    const binding = await createTemporaryBinding();

    try {
      const expectedUpdatedAt = binding.updatedAt.toISOString();
      const readBarrier = createBarrier(2);
      const contenders = [false, true].map((enabled, index) =>
        prisma.$transaction(async (transaction) =>
          updateMcpBindingWithOptimisticLock({
            expectedUpdatedAt,
            loadCurrent: async () => {
              const current = await transaction.representativeMcpBinding.findUnique({
                where: { id: binding.id },
              });
              await readBarrier.wait();
              return current;
            },
            claimUpdate: (loadedAt) =>
              transaction.representativeMcpBinding.updateMany({
                where: {
                  id: binding.id,
                  representativeId: binding.representativeId,
                  updatedAt: loadedAt,
                },
                data: {
                  enabled,
                  updatedAt: new Date(binding.updatedAt.getTime() + (index + 1) * 1_000),
                },
              }),
            loadUpdated: () =>
              transaction.representativeMcpBinding.findUniqueOrThrow({
                where: { id: binding.id },
              }),
          }),
        ),
      );

      const results = await Promise.allSettled(contenders);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        McpBindingConflictError,
      );
    } finally {
      await deleteTemporaryBinding(binding.id);
    }
  });

  it("retries a real serializable write conflict and preserves both updates", async () => {
    const binding = await createTemporaryBinding();

    try {
      const firstAttemptBarrier = createBarrier(2);
      const attempts: [number, number] = [0, 0];
      const increment = (index: 0 | 1) =>
        runWithPrismaWriteConflictRetry(async () => {
          attempts[index] += 1;
          const attempt = attempts[index];

          return prisma.$transaction(
            async (transaction) => {
              const current = await transaction.representativeMcpBinding.findUniqueOrThrow({
                where: { id: binding.id },
                select: { maxRetries: true },
              });
              if (attempt === 1) {
                await firstAttemptBarrier.wait();
              }
              return transaction.representativeMcpBinding.update({
                where: { id: binding.id },
                data: { maxRetries: current.maxRetries + 1 },
                select: { maxRetries: true },
              });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        }, { retryDelayMs: 1 });

      await Promise.all([increment(0), increment(1)]);

      const updated = await prisma.representativeMcpBinding.findUniqueOrThrow({
        where: { id: binding.id },
        select: { maxRetries: true },
      });
      expect(updated.maxRetries).toBe(2);
      expect(attempts[0] + attempts[1]).toBeGreaterThanOrEqual(3);
    } finally {
      await deleteTemporaryBinding(binding.id);
    }
  });
});

async function createTemporaryBinding() {
  const representative = await prisma.representative.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!representative) {
    throw new Error("PostgreSQL skill concurrency E2E requires one seeded representative.");
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return prisma.representativeMcpBinding.create({
    data: {
      representativeId: representative.id,
      slug: `postgres-concurrency-${suffix}`,
      displayName: "PostgreSQL concurrency probe",
      serverUrl: "https://mcp.example.com/mcp",
      allowedToolNames: ["lookup"],
      defaultToolName: "lookup",
      enabled: true,
      approvalRequired: true,
      maxRetries: 0,
      retryBackoffMs: 100,
    },
  });
}

async function deleteTemporaryBinding(id: string) {
  await prisma.representativeMcpBinding.delete({ where: { id } }).catch(() => undefined);
}

function createBarrier(participantCount: number) {
  let arrived = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    async wait() {
      arrived += 1;
      if (arrived === participantCount) {
        release?.();
      }
      await ready;
    },
  };
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the PostgreSQL skill concurrency E2E.");
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
