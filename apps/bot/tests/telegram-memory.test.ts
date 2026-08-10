import { beforeEach, describe, expect, it, vi } from "vitest";

const webDataMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  claimMemoryChannelDisclosureDelivery: webDataMocks.claim,
  completeMemoryChannelDisclosureDelivery: webDataMocks.complete,
  failMemoryChannelDisclosureDelivery: webDataMocks.fail,
}));

import {
  ensureTelegramMemoryDisclosure,
  resolveTelegramProviderOccurredAt,
  telegramContactMemoryDeleteText,
} from "../src/telegram-memory";

describe("Telegram channel-local memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not send a duplicate disclosure when the exact binding is current", async () => {
    webDataMocks.claim.mockResolvedValue({
      send: false,
      status: "current",
      deliveryId: "delivery-1",
    });
    const send = vi.fn();

    await expect(
      ensureTelegramMemoryDisclosure({
        conversationId: "conversation-1",
        inboundExternalMessageId: "101",
        send,
      }),
    ).resolves.toBe("current");

    expect(webDataMocks.claim).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      channel: "telegram",
      inboundExternalMessageIds: ["101"],
    });
    expect(send).not.toHaveBeenCalled();
    expect(webDataMocks.complete).not.toHaveBeenCalled();
  });

  it("records provider message evidence only after Telegram accepts the notice", async () => {
    const deliveredAt = new Date("2026-08-06T08:00:00.000Z");
    webDataMocks.claim.mockResolvedValue({
      send: true,
      status: "claimed",
      deliveryId: "delivery-2",
      leaseToken: "lease-2",
      text: "记忆说明",
    });
    webDataMocks.complete.mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue({
      externalMessageId: "telegram-message-22",
      deliveredAt,
    });

    await expect(
      ensureTelegramMemoryDisclosure({
        conversationId: "conversation-2",
        inboundExternalMessageId: "102",
        send,
      }),
    ).resolves.toBe("delivered");

    expect(send).toHaveBeenCalledWith("记忆说明");
    expect(webDataMocks.complete).toHaveBeenCalledWith({
      deliveryId: "delivery-2",
      leaseToken: "lease-2",
      externalMessageId: "telegram-message-22",
      deliveredAt,
    });
    expect(webDataMocks.fail).not.toHaveBeenCalled();
  });

  it("fails closed and releases the claim when the send is not proven", async () => {
    webDataMocks.claim.mockResolvedValue({
      send: true,
      status: "claimed",
      deliveryId: "delivery-3",
      leaseToken: "lease-3",
      text: "记忆说明",
    });
    webDataMocks.complete.mockResolvedValue(false);
    webDataMocks.fail.mockResolvedValue(true);

    await expect(
      ensureTelegramMemoryDisclosure({
        conversationId: "conversation-3",
        inboundExternalMessageId: "103",
        send: vi.fn().mockResolvedValue({
          externalMessageId: "telegram-message-23",
          deliveredAt: new Date("2026-08-06T08:00:00.000Z"),
        }),
      }),
    ).rejects.toThrow("proof was not committed");

    expect(webDataMocks.fail).toHaveBeenCalledWith({
      deliveryId: "delivery-3",
      leaseToken: "lease-3",
      errorCode: "telegram_disclosure_delivery_failed",
    });
  });

  it("uses the provider timestamp and rejects an invalid future timestamp", () => {
    const receivedAt = new Date("2026-08-06T08:10:00.000Z");
    expect(
      resolveTelegramProviderOccurredAt(1_775_635_800, receivedAt),
    ).toEqual(new Date(1_775_635_800_000));
    expect(() =>
      resolveTelegramProviderOccurredAt(
        Math.floor(receivedAt.getTime() / 1_000) + 301,
        receivedAt,
      ),
    ).toThrow("too far in the future");
    expect(() => resolveTelegramProviderOccurredAt(Number.NaN, receivedAt))
      .toThrow("event time is invalid");
  });

  it("uses one server-owned exact deletion phrase", () => {
    expect(telegramContactMemoryDeleteText).toBe("删除我的记忆");
  });
});
