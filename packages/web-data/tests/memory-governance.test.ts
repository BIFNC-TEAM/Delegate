import { createHash } from "node:crypto";

import {
  GovernedMemoryStatus,
  MemoryCleanupStatus,
  MemoryProjectionStatus,
  MemoryScope,
  RepresentativeChannelKind,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  requestAutomaticContactChannelMemoryDeletionInTransaction,
  requestAutomaticContactReplyPreferenceDeletionInTransaction,
  requestAutomaticContactSharedMemoryDeletionInTransaction,
} from "../src/memory-governance";

const occurredAt = new Date("2026-08-04T01:02:03.000Z");

describe("automatic memory governance", () => {
  it("deletes only the current contact-channel reply preference", async () => {
    const memory = {
      id: "memory-1",
      representativeId: "rep-1",
      contactId: "contact-1",
      scope: MemoryScope.CONTACT_CHANNEL,
      sourceChannel: RepresentativeChannelKind.WEB,
      semanticKey: "contact-preference:communication",
      status: GovernedMemoryStatus.ACTIVE,
      recallDisabledAt: null,
      deletionProof: null,
      currentVersion: {
        id: "version-1",
        contentHash: sha256("reply preference"),
      },
    };
    let updateCount = 0;
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "locked-row" }]),
      governedMemory: {
        findMany: vi.fn(async () => [{ id: memory.id }]),
        findFirst: vi.fn(async () => memory),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updateCount += 1;
          return updateCount === 1
            ? { ...memory, ...data, recallDisabledAt: occurredAt }
            : { ...memory, ...data };
        }),
      },
      memoryCandidate: {
        findMany: vi.fn(async () => []),
        update: vi.fn(),
      },
      representativeMemoryPolicy: { findUnique: vi.fn() },
      memoryPolicyDecision: { create: vi.fn() },
      memoryProjectionItem: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      memoryDeletionProof: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "proof-1",
          ...data,
        })),
      },
    };

    await expect(requestAutomaticContactReplyPreferenceDeletionInTransaction(
      tx as never,
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        sourceChannel: RepresentativeChannelKind.WEB,
        sourceMessageId: "forget-message-1",
        sourceHash: sha256("forget my reply preference"),
        occurredAt,
      },
    )).resolves.toEqual({
      matched: true,
      memoryId: memory.id,
      replayed: false,
    });

    expect(tx.governedMemory.findMany).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        contactId: "contact-1",
        scope: MemoryScope.CONTACT_CHANNEL,
        sourceChannel: RepresentativeChannelKind.WEB,
        semanticKey: "contact-preference:communication",
        status: {
          notIn: [
            GovernedMemoryStatus.DELETE_PENDING,
            GovernedMemoryStatus.DELETED,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true },
    });
    expect(tx.memoryDeletionProof.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        memoryId: memory.id,
        requestId: "contact-forget:forget-message-1",
        requestedByActorId: "system:contact:contact-1",
        reasonCode: "contact_forget_reply_preference",
        cleanupStatus: MemoryCleanupStatus.QUEUED,
      }),
    });
    expect(tx.memoryProjectionItem.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.memoryProjectionItem.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        memoryId: memory.id,
        status: MemoryProjectionStatus.PROJECTING,
      },
      data: { deleteRequestedAt: occurredAt },
    });
  });

  it("immediately fences every memory in only the current contact channel", async () => {
    const memories = ["memory-preference", "memory-goal"].map((id, index) => ({
      id,
      representativeId: "rep-1",
      contactId: "contact-1",
      scope: MemoryScope.CONTACT_CHANNEL,
      sourceChannel: RepresentativeChannelKind.TELEGRAM,
      semanticKey: index === 0 ? "preference:format" : "goal:learning",
      status: GovernedMemoryStatus.SUPPRESSED,
      recallDisabledAt: new Date("2026-08-04T00:00:00.000Z"),
      deletionProof: null,
      currentVersion: {
        id: `version-${index + 1}`,
        contentHash: sha256(id),
      },
    }));
    const deletionProofs: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "locked-row" }]),
      governedMemory: {
        findMany: vi.fn(async () => memories.map(({ id }) => ({ id }))),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          memories.find((memory) => memory.id === where.id) ?? null),
        update: vi.fn(async ({ where, data }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({
          ...memories.find((memory) => memory.id === where.id),
          ...data,
        })),
      },
      memoryCandidate: {
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      memoryProjectionItem: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      memoryDeletionProof: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          deletionProofs.push(data);
          return { id: `proof-${deletionProofs.length}`, ...data };
        }),
      },
    };

    await expect(requestAutomaticContactChannelMemoryDeletionInTransaction(
      tx as never,
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        sourceChannel: RepresentativeChannelKind.TELEGRAM,
        sourceMessageId: "delete-message-1",
        sourceHash: sha256("删除我的记忆"),
        occurredAt,
      },
    )).resolves.toEqual({
      matchedCount: 2,
      queuedCount: 2,
      replayedCount: 0,
      memoryIds: ["memory-preference", "memory-goal"],
    });

    expect(tx.governedMemory.findMany).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        contactId: "contact-1",
        scope: MemoryScope.CONTACT_CHANNEL,
        sourceChannel: RepresentativeChannelKind.TELEGRAM,
        status: { not: GovernedMemoryStatus.DELETED },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(deletionProofs).toHaveLength(2);
    for (const proof of deletionProofs) {
      expect(proof).toMatchObject({
        representativeId: "rep-1",
        requestedByActorId: "system:contact:contact-1",
        reasonCode: "contact_forget_all_channel_memory",
        cleanupStatus: MemoryCleanupStatus.QUEUED,
      });
      expect(JSON.stringify(proof)).not.toContain("safeText");
      expect(JSON.stringify(proof)).not.toContain("summary");
    }
    expect(tx.memoryProjectionItem.updateMany).toHaveBeenCalledTimes(4);
  });

  it("revokes every shared memory for only the canonical identity", async () => {
    let memory = {
      id: "shared-memory-1",
      representativeId: "rep-1",
      contactId: null,
      audienceIdentityId: "identity-1",
      scope: MemoryScope.CONTACT_SHARED,
      sourceChannel: null,
      status: GovernedMemoryStatus.ACTIVE,
      recallDisabledAt: null as Date | null,
      deletionProof: null,
      currentVersion: {
        id: "shared-version-1",
        contentHash: sha256("Preference: reply_length=concise"),
      },
    };
    const proofCreates: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 1),
      memoryCandidate: {
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      governedMemory: {
        findMany: vi.fn(async () => [{ id: memory.id }]),
        findFirst: vi.fn(async () => memory),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          memory = { ...memory, ...data };
          return memory;
        }),
      },
      memoryProjectionItem: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      memoryDeletionProof: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          proofCreates.push(data);
          return { id: "proof-1", ...data };
        }),
      },
    };

    await expect(requestAutomaticContactSharedMemoryDeletionInTransaction(
      tx as never,
      {
        representativeId: "rep-1",
        audienceIdentityId: "identity-1",
        requestId: "consent-2",
        requestedByActorId: "system:contact:identity-1",
        reasonCode: "contact_shared_consent_revoked",
        occurredAt,
      },
    )).resolves.toEqual({
      matchedCount: 1,
      queuedCount: 1,
      replayedCount: 0,
      memoryIds: ["shared-memory-1"],
    });
    expect(tx.governedMemory.findMany).toHaveBeenCalledWith({
      where: {
        representativeId: "rep-1",
        audienceIdentityId: "identity-1",
        scope: MemoryScope.CONTACT_SHARED,
        status: { not: GovernedMemoryStatus.DELETED },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(memory).toMatchObject({
      status: GovernedMemoryStatus.DELETE_PENDING,
      recallDisabledAt: occurredAt,
      deleteRequestedAt: occurredAt,
    });
    expect(tx.memoryProjectionItem.updateMany).toHaveBeenCalledTimes(2);
    expect(proofCreates).toHaveLength(1);
    expect(proofCreates[0]).toMatchObject({
      representativeId: "rep-1",
      memoryId: "shared-memory-1",
      requestedByActorId: "system:contact:identity-1",
      reasonCode: "contact_shared_consent_revoked",
      cleanupStatus: MemoryCleanupStatus.QUEUED,
    });
    expect(String(proofCreates[0]?.requestId)).toMatch(
      /^shared-contact-delete:[0-9a-f]{64}$/u,
    );
    expect(JSON.stringify(proofCreates[0])).not.toContain("safeText");
    expect(JSON.stringify(proofCreates[0])).not.toContain("summary");
  });
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
