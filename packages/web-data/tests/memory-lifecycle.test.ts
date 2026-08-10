import {
  GovernedMemoryStatus,
  MemoryCandidateStatus,
  MemoryExpiryAction,
  MemoryProjectionStatus,
  type PrismaClient,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { runNextMemoryLifecycle } from "../src/memory-lifecycle";

const occurredAt = new Date("2026-08-06T08:00:00.000Z");
const contentHash = "a".repeat(64);

type LifecycleClaim = {
  id: string;
  representativeId: string;
  status: GovernedMemoryStatus;
  currentVersionId: string;
  contentHash: string;
  expiryAction: MemoryExpiryAction;
  recallDisabledAt: Date | null;
  archivedAt: Date | null;
  deleteRequestedAt: Date | null;
};

describe("memory lifecycle execution", () => {
  it("claims a bounded representative-scoped batch with SKIP LOCKED", async () => {
    const client = lifecycleClient([]);

    await expect(runNextMemoryLifecycle({
      client,
      representativeId: "  rep_1  ",
      limit: 999,
      now: () => occurredAt,
    })).resolves.toEqual({ processed: false });

    expect(sqlText(client.__query.mock.calls[0]![0])).toContain(
      "FOR UPDATE OF memory_record SKIP LOCKED",
    );
    expect(queryValues(client.__query.mock.calls[0]![0])).toEqual(
      expect.arrayContaining([occurredAt, "rep_1", 100]),
    );
  });

  it("archives an expired memory, blocks recall, and queues exact projection deletion", async () => {
    const claim = lifecycleClaim({ expiryAction: MemoryExpiryAction.ARCHIVE });
    const client = lifecycleClient([claim]);

    await expect(runNextMemoryLifecycle({
      client,
      now: () => occurredAt,
    })).resolves.toEqual({
      processed: true,
      status: "completed",
      processedCount: 1,
      archivedCount: 1,
      deletePendingCount: 0,
    });

    expect(client.governedMemory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: GovernedMemoryStatus.ARCHIVED,
          recallDisabledAt: occurredAt,
          archivedAt: occurredAt,
        }),
      }),
    );
    expect(client.memoryProjectionItem.updateMany).toHaveBeenCalledTimes(2);
    expect(client.memoryProjectionItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MemoryProjectionStatus.DELETE_PENDING,
          deleteRequestedAt: occurredAt,
        }),
      }),
    );
    expect(client.memoryDeletionProof.create).not.toHaveBeenCalled();
  });

  it("blocks active recall before DELETE_PENDING and creates a body-free cleanup proof", async () => {
    const client = lifecycleClient([lifecycleClaim({
      expiryAction: MemoryExpiryAction.DELETE,
      status: GovernedMemoryStatus.ACTIVE,
    })]);

    await expect(runNextMemoryLifecycle({
      client,
      now: () => occurredAt,
    })).resolves.toMatchObject({
      processed: true,
      archivedCount: 0,
      deletePendingCount: 1,
    });

    expect(client.governedMemory.update).toHaveBeenCalledWith({
      where: { id: "memory_1" },
      data: {
        status: GovernedMemoryStatus.EXPIRED,
        recallDisabledAt: occurredAt,
      },
      select: { status: true, recallDisabledAt: true },
    });
    expect(client.governedMemory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: GovernedMemoryStatus.EXPIRED }),
        data: expect.objectContaining({
          status: GovernedMemoryStatus.DELETE_PENDING,
          recallDisabledAt: occurredAt,
          deleteRequestedAt: occurredAt,
        }),
      }),
    );
    const proof = client.memoryDeletionProof.create.mock.calls[0]![0].data;
    expect(proof).toMatchObject({
      requestId: "expiry:memory_1",
      requestedByActorId: "system:memory-lifecycle",
      reasonCode: "memory_retention_expired",
      contentHash,
      recallBlockedAt: occurredAt,
      availableAt: occurredAt,
      createdAt: occurredAt,
    });
    expect(JSON.stringify(proof)).not.toContain("safeText");
    expect(JSON.stringify(proof)).not.toContain("summary");
  });

  it("fences deletion before purging a legacy versioned pending correction", async () => {
    const client = lifecycleClient([lifecycleClaim({
      expiryAction: MemoryExpiryAction.DELETE,
      status: GovernedMemoryStatus.EXPIRED,
      recallDisabledAt: occurredAt,
    })], [{
      id: "candidate_1",
    }]);

    await runNextMemoryLifecycle({ client, now: () => occurredAt });

    expect(client.memoryCandidate.update).toHaveBeenCalledWith({
      where: { id: "candidate_1" },
      data: {
        status: MemoryCandidateStatus.EXPIRED,
        safeText: null,
        summary: null,
        contentPurgedAt: occurredAt,
      },
    });
    expect(client.__events.indexOf("memory:delete_pending")).toBeLessThan(
      client.__events.indexOf("candidate:purged"),
    );
    expect(client.__events.indexOf("candidate:purged")).toBeLessThan(
      client.__events.indexOf("proof:created"),
    );
  });
});

function lifecycleClaim(
  overrides: Partial<LifecycleClaim> = {},
): LifecycleClaim {
  return { ...lifecycleClaimBase(), ...overrides };
}

function lifecycleClaimBase(): LifecycleClaim {
  return {
    id: "memory_1",
    representativeId: "rep_1",
    status: GovernedMemoryStatus.ACTIVE,
    currentVersionId: "version_1",
    contentHash,
    expiryAction: MemoryExpiryAction.ARCHIVE,
    recallDisabledAt: null,
    archivedAt: null,
    deleteRequestedAt: null,
  };
}

function lifecycleClient(
  claims: LifecycleClaim[],
  pendingCorrections: Array<Record<string, unknown>> = [],
) {
  const events: string[] = [];
  const query = vi.fn(async (_query: unknown) => claims);
  const governedMemory = {
    update: vi.fn(async () => ({
      status: GovernedMemoryStatus.EXPIRED,
      recallDisabledAt: occurredAt,
    })),
    updateMany: vi.fn(async (input: {
      data?: { status?: GovernedMemoryStatus };
    }) => {
      if (input.data?.status === GovernedMemoryStatus.DELETE_PENDING) {
        events.push("memory:delete_pending");
      }
      return { count: 1 };
    }),
  };
  const memoryProjectionItem = {
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const memoryDeletionProof = {
    create: vi.fn(async (_input: { data: Record<string, unknown> }) => {
      events.push("proof:created");
      return { id: "proof_1" };
    }),
  };
  const memoryCandidate = {
    findMany: vi.fn(async () => pendingCorrections),
    update: vi.fn(async (_input: unknown) => {
      events.push("candidate:purged");
      return { id: "candidate_1" };
    }),
  };
  const transaction = {
    $queryRaw: query,
    governedMemory,
    memoryProjectionItem,
    memoryDeletionProof,
    memoryCandidate,
  };
  const client = {
    ...transaction,
    __query: query,
    __events: events,
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction)),
  };
  return client as unknown as PrismaClient & typeof client;
}

function queryValues(query: unknown) {
  return typeof query === "object"
    && query !== null
    && "values" in query
    && Array.isArray(query.values)
    ? query.values
    : [];
}

function sqlText(query: unknown) {
  if (
    typeof query === "object"
    && query !== null
    && "strings" in query
    && Array.isArray(query.strings)
  ) {
    return query.strings.join("?");
  }
  return String(query);
}
