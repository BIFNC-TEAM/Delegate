import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryMocks = vi.hoisted(() => ({
  revalidateMemoryUseDeliverySourcesInTransaction: vi.fn(),
}));
const databaseMocks = vi.hoisted(() => {
  const state: { tx: unknown } = { tx: null };
  return {
    state,
    prisma: {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback(state.tx)),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: databaseMocks.prisma }));

vi.mock("../src/memory-use-execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/memory-use-execution")>(),
  revalidateMemoryUseDeliverySourcesInTransaction:
    memoryMocks.revalidateMemoryUseDeliverySourcesInTransaction,
}));

import {
  admitGenerationMessageProviderDelivery,
  withGenerationMessageProviderDeliveryFence,
  type GenerationMessageDeliveryFenceInput,
} from "../src/conversation-platform";

function buildInput(): GenerationMessageDeliveryFenceInput {
  return {
    conversationId: "conversation-1",
    runId: "run-1",
    outboxId: "generation-outbox-1",
    leaseAttempt: 4,
    outputMessageId: "output-message-1",
    deliveryAdmission: {
      attemptNumber: 4,
      leaseToken: "delivery-lease-4",
    },
  };
}

function buildTx() {
  return {
    $executeRaw: vi.fn(),
    messageDeliveryAttempt: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    message: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue({
        conversationId: "conversation-1",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    generationRun: { findUnique: vi.fn().mockResolvedValue(null) },
    eventAudit: { upsert: vi.fn() },
  };
}

function currentPreparedAttempt() {
  return {
    status: "PROCESSING",
    attemptPhase: "CALL_PREPARED",
    leaseToken: "delivery-lease-4",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    deliveryOutboxId: "generation-outbox-1",
    deliveryLeaseAttempt: 4,
    failureCode: null,
  };
}

function currentCallStartedAttempt() {
  return {
    ...currentPreparedAttempt(),
    attemptPhase: "CALL_STARTED",
  };
}

describe("generation delivery atomic admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryMocks.revalidateMemoryUseDeliverySourcesInTransaction
      .mockResolvedValue({ authorized: true });
  });

  it("moves the leased delivery from prepared to response-received around one provider call", async () => {
    const tx = buildTx();
    databaseMocks.state.tx = tx;
    tx.messageDeliveryAttempt.findUnique
      .mockResolvedValueOnce(currentPreparedAttempt())
      .mockResolvedValueOnce(currentCallStartedAttempt());
    const provider = vi.fn().mockResolvedValue("provider-message-1");

    await expect(admitGenerationMessageProviderDelivery(
      buildInput(),
    )).resolves.toBe(true);
    await expect(withGenerationMessageProviderDeliveryFence(
      tx as never,
      buildInput(),
      provider,
    )).resolves.toEqual({
      executed: true,
      value: "provider-message-1",
    });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          leaseToken: "delivery-lease-4",
          deliveryOutboxId: "generation-outbox-1",
          deliveryLeaseAttempt: 4,
          attemptPhase: "CALL_PREPARED",
        }),
        data: expect.objectContaining({ attemptPhase: "CALL_STARTED" }),
      }),
    );
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          leaseToken: "delivery-lease-4",
          attemptPhase: "CALL_STARTED",
        }),
        data: expect.objectContaining({ attemptPhase: "RESPONSE_RECEIVED" }),
      }),
    );
  });

  it("keeps CALL_STARTED in the committed admission when the provider outcome throws", async () => {
    const tx = buildTx();
    databaseMocks.state.tx = tx;
    tx.messageDeliveryAttempt.findUnique
      .mockResolvedValueOnce(currentPreparedAttempt())
      .mockResolvedValueOnce(currentCallStartedAttempt());

    await admitGenerationMessageProviderDelivery(buildInput());
    await expect(withGenerationMessageProviderDeliveryFence(
      tx as never,
      buildInput(),
      async () => {
        throw new Error("provider outcome unknown");
      },
    )).rejects.toThrow("provider outcome unknown");

    expect(databaseMocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.messageDeliveryAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptPhase: "CALL_STARTED" }),
      }),
    );
  });

});
