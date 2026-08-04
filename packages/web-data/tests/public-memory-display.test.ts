import {
  MemoryUseRunStatus,
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  acknowledgePublicMemoryDisplayInTransaction,
} from "../src/public-memory-display";
import type { MemoryUseRunSnapshot } from "../src/memory-use-execution";

const occurredAt = new Date("2026-08-04T09:30:00.000Z");

describe("public memory display acknowledgement", () => {
  it("fails closed before reading citations when the run is outside the public audience thread", async () => {
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      generationRun: { findFirst: vi.fn().mockResolvedValue(null) },
      memoryUseItem: { findMany: vi.fn(), updateMany: vi.fn() },
    });

    await expect(acknowledgePublicMemoryDisplayInTransaction(
      tx,
      acknowledgementInput(),
      occurredAt,
    )).rejects.toMatchObject({
      code: "public_memory_display_not_found",
      status: 404,
    });
    expect(tx.generationRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "generation_run_1",
          outputMessageId: "output_message_1",
          conversation: expect.objectContaining({
            audienceIdentityId: "audience_identity_1",
            sourceChannel: RepresentativeChannelKind.WEB,
            channelThreadId: "web:audience_1",
            representative: { slug: "delegate" },
          }),
        }),
      }),
    );
    expect(tx.memoryUseItem.findMany).not.toHaveBeenCalled();
    expect(tx.memoryUseItem.updateMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("acknowledges a run without governed citations as an idempotent no-op", async () => {
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      generationRun: {
        findFirst: vi.fn()
          .mockResolvedValueOnce({ conversationId: "conversation_1" })
          .mockResolvedValueOnce({
            id: "generation_run_1",
            outputMessageId: "output_message_1",
            memoryUseRun: null,
          }),
      },
      memoryUseItem: { findMany: vi.fn(), updateMany: vi.fn() },
    });

    await expect(acknowledgePublicMemoryDisplayInTransaction(
      tx,
      acknowledgementInput(),
      occurredAt,
    )).resolves.toEqual({ acknowledged: true, displayedCount: 0 });
    expect(tx.memoryUseItem.findMany).not.toHaveBeenCalled();
  });

  it("derives only this output's cited items and remains idempotent", async () => {
    let run = completedRun();
    const findItems = vi.fn().mockImplementation(async (args) => {
      if (args.select?.citation) {
        return [{
          id: "memory_use_item_1",
          citedAt: occurredAt,
          citationId: "citation_1",
          citation: { messageId: "output_message_1" },
        }];
      }
      return [{ id: "memory_use_item_1" }];
    });
    const updateItems = vi.fn().mockImplementation(async () => {
      run = { ...run, displayedCount: 1 };
      return { count: 1 };
    });
    const tx = asTransaction({
      $executeRaw: vi.fn().mockResolvedValue(1),
      generationRun: {
        findFirst: vi.fn().mockImplementation(async (args) => (
          args.select?.conversationId
            ? { conversationId: "conversation_1" }
            : {
                id: "generation_run_1",
                outputMessageId: "output_message_1",
                memoryUseRun: { id: "memory_use_run_1" },
              }
        )),
      },
      memoryUseRun: {
        findUnique: vi.fn().mockImplementation(async () => run),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => run),
      },
      message: {
        findUnique: vi.fn().mockResolvedValue({
          conversationId: "conversation_1",
          deliveryStatus: "SENT",
        }),
      },
      memoryUseItem: {
        findMany: findItems,
        updateMany: updateItems,
      },
    });

    await expect(acknowledgePublicMemoryDisplayInTransaction(
      tx,
      acknowledgementInput(),
      occurredAt,
    )).resolves.toEqual({ acknowledged: true, displayedCount: 1 });
    await expect(acknowledgePublicMemoryDisplayInTransaction(
      tx,
      acknowledgementInput(),
      occurredAt,
    )).resolves.toEqual({ acknowledged: true, displayedCount: 1 });

    expect(findItems).toHaveBeenCalledWith({
      where: {
        useRunId: "memory_use_run_1",
        citedAt: { not: null },
        citationId: { not: null },
        citation: { messageId: "output_message_1" },
      },
      select: { id: true },
    });
    expect(updateItems).toHaveBeenCalledWith({
      where: {
        useRunId: "memory_use_run_1",
        id: { in: ["memory_use_item_1"] },
        displayedAt: null,
      },
      data: { displayedAt: occurredAt },
    });
  });
});

function acknowledgementInput() {
  return {
    representativeSlug: "delegate",
    generationRunId: "generation_run_1",
    outputMessageId: "output_message_1",
    audienceIdentityId: "audience_identity_1",
    audienceId: "audience_1",
  };
}

function completedRun(): MemoryUseRunSnapshot {
  return {
    id: "memory_use_run_1",
    generationRunId: "generation_run_1",
    representativeId: "representative_1",
    conversationId: "conversation_1",
    contactId: "contact_1",
    sourceChannel: RepresentativeChannelKind.WEB,
    representativeVersionId: "representative_version_1",
    inputMessageId: "input_message_1",
    outputMessageId: "output_message_1",
    status: MemoryUseRunStatus.COMPLETED,
    reasonCode: null,
    unmappedCandidateCount: 0,
    searchedCount: 1,
    scopePassedCount: 1,
    safetyPassedCount: 1,
    injectedCount: 1,
    citedCount: 1,
    displayedCount: 0,
    startedAt: occurredAt,
    completedAt: occurredAt,
  };
}

function asTransaction(value: Record<string, unknown>) {
  return value as unknown as Prisma.TransactionClient;
}
