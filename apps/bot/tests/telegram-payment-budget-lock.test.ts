import { PricingPlanType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, tx, mockFulfillServicePaymentOrder } = vi.hoisted(() => {
  const tx = {
    invoice: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    servicePaymentOrder: {
      findUnique: vi.fn(),
    },
    wallet: {
      update: vi.fn(),
      create: vi.fn(),
    },
    contact: {
      update: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    eventAudit: {
      create: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };
  return {
    tx,
    mockFulfillServicePaymentOrder: vi.fn(),
    mockPrisma: {
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => unknown) => callback(tx),
      ),
      invoice: {
        findUnique: vi.fn(),
      },
      servicePaymentOrder: {
        findUnique: vi.fn(),
      },
    },
  };
});

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@delegate/web-data", () => ({
  assertConversationChannelDeliveryAvailable: vi.fn(),
  createServicePaymentOrder: vi.fn(),
  fulfillServicePaymentOrder: mockFulfillServicePaymentOrder,
  resolveChannelAudienceIdentity: vi.fn(),
}));

import { runWithTelegramRuntimeContext } from "../src/telegram-runtime-context";

describe("Telegram payment conversation budget locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.invoice.findUnique
      .mockResolvedValueOnce(buildInvoice())
      .mockResolvedValueOnce(null);
    tx.servicePaymentOrder.findUnique.mockResolvedValue({
      providerAccountId: "777000",
    });
    tx.invoice.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.update.mockResolvedValue({ id: "wallet-1" });
    tx.contact.update.mockResolvedValue({ id: "contact-1" });
    tx.conversation.findUnique.mockResolvedValue({
      computeBudgetRemainingCredits: 7,
    });
    tx.conversation.update.mockResolvedValue({ id: "conversation-1" });
    tx.eventAudit.create.mockResolvedValue({ id: "event-1" });
    tx.$executeRaw.mockResolvedValue(1);
    mockFulfillServicePaymentOrder.mockResolvedValue({ status: "PAID" });
  });

  it("locks and re-reads the budget after the wallet write", async () => {
    const { confirmInvoicePayment } = await import("../src/runtime-store");

    await runWithTelegramRuntimeContext(
      {
        internalConnectionId: "connection-1",
        botId: "777000",
      },
      () =>
        confirmInvoicePayment({
          invoicePayload: "invoice-payload-1",
          currency: "XTR",
          totalAmount: 25,
          telegramUserId: 12345,
          telegramPaymentChargeId: "telegram-charge-1",
          providerPaymentChargeId: "provider-charge-1",
        }),
    );

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        passUnlockedAt: expect.any(Date),
        computeBudgetRemainingCredits: 67,
      },
    });
    expect(tx.wallet.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0]!,
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.conversation.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(tx.conversation.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      tx.conversation.update.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects a payment delivered by a different Bot connection", async () => {
    const { confirmInvoicePayment } = await import("../src/runtime-store");
    tx.servicePaymentOrder.findUnique.mockResolvedValue({
      providerAccountId: "888000",
    });

    await expect(
      runWithTelegramRuntimeContext(
        {
          internalConnectionId: "connection-1",
          botId: "777000",
        },
        () =>
          confirmInvoicePayment({
            invoicePayload: "invoice-payload-1",
            currency: "XTR",
            totalAmount: 25,
            telegramUserId: 12345,
            telegramPaymentChargeId: "telegram-charge-1",
          }),
      ),
    ).rejects.toThrow("different Bot connection");
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
  });
});

function buildInvoice() {
  return {
    id: "invoice-1",
    payload: "invoice-payload-1",
    status: "PENDING",
    title: "Pass",
    starsAmount: 25,
    planType: PricingPlanType.PASS,
    representativeId: "representative-1",
    contactId: "contact-1",
    conversationId: "conversation-1",
    telegramPaymentChargeId: null,
    representative: {
      id: "representative-1",
      slug: "representative",
      owner: {
        id: "owner-1",
        wallet: {
          id: "wallet-1",
        },
      },
    },
    contact: {
      id: "contact-1",
      telegramUserId: "12345",
      audienceIdentityId: "audience-1",
    },
    conversation: {
      computeBudgetRemainingCredits: 100,
    },
  };
}
