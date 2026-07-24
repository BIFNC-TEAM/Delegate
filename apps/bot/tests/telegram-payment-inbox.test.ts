import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    invoice: {
      findUnique: vi.fn(),
    },
    channelEventInbox: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import {
  persistAndProcessTelegramSuccessfulPayment,
  retryPendingTelegramSuccessfulPayments,
} from "../src/runtime-store";

const payment = {
  invoicePayload: "delegate:invoice:invoice-1",
  totalAmount: 500,
  currency: "XTR",
  telegramUserId: 123456,
  telegramPaymentChargeId: "charge-1",
  providerPaymentChargeId: "provider-charge-1",
};

describe("Telegram payment inbox", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.TELEGRAM_BOT_ID = "777000";
    mockPrisma.channelEventInbox.upsert.mockResolvedValue({
      id: "payment-inbox-1",
      status: "PENDING",
      payload: payment,
    });
    mockPrisma.channelEventInbox.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.channelEventInbox.findUnique.mockResolvedValue({
      status: "PROCESSING",
    });
    mockPrisma.channelEventInbox.findMany.mockResolvedValue([]);
    mockPrisma.channelEventInbox.update.mockResolvedValue({});
    mockPrisma.invoice.findUnique.mockResolvedValue({
      conversationId: "conversation-1",
    });
  });

  it("durably records the canonical charge before fulfillment", async () => {
    await expect(
      persistAndProcessTelegramSuccessfulPayment(payment),
    ).resolves.toEqual({ status: "retrying" });

    expect(mockPrisma.channelEventInbox.upsert).toHaveBeenCalledWith({
      where: {
        kind_externalEventId: {
          kind: "TELEGRAM",
          externalEventId: "777000:charge-1",
        },
      },
      create: expect.objectContaining({
        kind: "TELEGRAM",
        transport: "TELEGRAM",
        sourceProvider: "TELEGRAM",
        connectionId: "777000",
        originKey: "telegram:successful-payment:777000:charge-1",
        externalEventId: "777000:charge-1",
        eventType: "telegram.successful_payment",
        payload: payment,
        status: "PENDING",
        attemptCount: 0,
      }),
      update: {},
      select: {
        id: true,
        status: true,
        payload: true,
      },
    });
  });

  it("rejects a charge replay whose canonical payment facts changed", async () => {
    mockPrisma.channelEventInbox.upsert.mockResolvedValue({
      id: "payment-inbox-1",
      status: "PENDING",
      payload: {
        ...payment,
        invoicePayload: "delegate:invoice:another-invoice",
      },
    });

    await expect(
      persistAndProcessTelegramSuccessfulPayment(payment),
    ).rejects.toThrow("conflicting payment data");
    expect(mockPrisma.channelEventInbox.updateMany).not.toHaveBeenCalled();
  });

  it("scans only due payment events for this bot connection", async () => {
    await expect(retryPendingTelegramSuccessfulPayments()).resolves.toEqual({
      examined: 0,
      confirmed: 0,
      retrying: 0,
    });
    expect(mockPrisma.channelEventInbox.findMany).toHaveBeenCalledWith({
      where: {
        kind: "TELEGRAM",
        connectionId: "777000",
        eventType: "telegram.successful_payment",
        status: { in: ["PENDING", "FAILED", "PROCESSING", "DEAD_LETTER"] },
        availableAt: { lte: expect.any(Date) },
      },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: {
        id: true,
        payload: true,
      },
    });
  });

  it("associates a durable payment event with its conversation for owner visibility", async () => {
    await persistAndProcessTelegramSuccessfulPayment(payment);

    expect(mockPrisma.channelEventInbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: "payment-inbox-1",
        conversationId: null,
      },
      data: {
        conversationId: "conversation-1",
      },
    });
  });

  it("keeps an exhausted charged event retryable instead of dead-lettering it", async () => {
    mockPrisma.channelEventInbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.channelEventInbox.findUnique.mockResolvedValue({
      attemptCount: 25,
    });
    mockPrisma.$transaction.mockRejectedValue(
      new Error("Telegram service payment order is missing."),
    );

    await expect(
      persistAndProcessTelegramSuccessfulPayment(payment),
    ).resolves.toEqual({ status: "retrying" });

    expect(mockPrisma.channelEventInbox.update).toHaveBeenLastCalledWith({
      where: { id: "payment-inbox-1" },
      data: {
        status: "FAILED",
        processedAt: null,
        availableAt: expect.any(Date),
        lastError: "Telegram service payment order is missing.",
      },
    });
  });

  it("reclaims historical payment dead letters for continued recovery", async () => {
    mockPrisma.channelEventInbox.upsert.mockResolvedValue({
      id: "payment-inbox-1",
      status: "DEAD_LETTER",
      payload: payment,
    });
    mockPrisma.channelEventInbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.channelEventInbox.findUnique.mockResolvedValue({
      attemptCount: 26,
    });
    mockPrisma.$transaction.mockRejectedValue(
      new Error("Temporary payment fulfillment outage."),
    );

    await expect(
      persistAndProcessTelegramSuccessfulPayment(payment),
    ).resolves.toEqual({ status: "retrying" });

    expect(mockPrisma.channelEventInbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: "payment-inbox-1",
        OR: [
          {
            status: { in: ["PENDING", "FAILED", "DEAD_LETTER"] },
            availableAt: { lte: expect.any(Date) },
          },
          {
            status: "PROCESSING",
            availableAt: { lte: expect.any(Date) },
          },
        ],
      },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: expect.any(Date),
        processedAt: null,
        lastError: null,
      },
    });
    expect(mockPrisma.channelEventInbox.update).toHaveBeenLastCalledWith({
      where: { id: "payment-inbox-1" },
      data: expect.objectContaining({
        status: "FAILED",
        processedAt: null,
      }),
    });
  });
});
