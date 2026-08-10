import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/telegram-bot-runtime.ts", import.meta.url),
  "utf8",
);

describe("Telegram memory runtime wiring", () => {
  it("delivers the notice before /start purchase and welcome flows", () => {
    const start = source.slice(
      source.indexOf('bot.command("start"'),
      source.indexOf('bot.command("plans"'),
    );
    expect(start.indexOf("deliverTelegramMemoryDisclosure")).toBeGreaterThan(-1);
    expect(start.indexOf("deliverTelegramMemoryDisclosure")).toBeLessThan(
      start.indexOf("startPayload.purchaseTier"),
    );
  });

  it("keeps group memory off and delivers the notice before private ingestion", () => {
    const handler = source.slice(source.indexOf('bot.on("message:text"'));
    const groupGate = handler.indexOf(
      'conversationPlatformMode === "worker" && !isPrivate',
    );
    const privateDisclosure = handler.indexOf(
      "if (isPrivate) {\n    try {\n      await deliverTelegramMemoryDisclosure",
    );
    const accept = handler.indexOf("await acceptInboundConversationMessage");

    expect(groupGate).toBeGreaterThan(-1);
    expect(privateDisclosure).toBeGreaterThan(groupGate);
    expect(privateDisclosure).toBeLessThan(accept);
    expect(handler).toContain(
      "occurredAt: resolveTelegramProviderOccurredAt(ctx.message.date)",
    );
  });

  it("routes both exact deletion commands through server-owned text without generation", () => {
    const deletion = source.slice(
      source.indexOf("const handleContactMemoryDeleteCommand"),
      source.indexOf('bot.command("compute"'),
    );
    expect(deletion).toContain("text: telegramContactMemoryDeleteText");
    expect(deletion).toContain("queueGeneration: false");
    expect(deletion).toContain(
      'bot.command("forget", handleContactMemoryDeleteCommand)',
    );
    expect(deletion).toContain(
      'bot.command("delete_memory", handleContactMemoryDeleteCommand)',
    );
    expect(deletion).not.toContain("deliverTelegramMemoryDisclosure");
  });

  it("requires a one-time challenge for sharing and keeps revocation reduction-only", () => {
    const sharing = source.slice(
      source.indexOf('bot.command("memory_share"'),
      source.indexOf("const handleContactMemoryDeleteCommand"),
    );
    expect(sharing).toContain("readContactMemorySharingChallengeToken");
    expect(sharing).toContain("createContactMemorySharingChallenge");
    expect(sharing).toContain("contactMemorySharingConsentContractVersion");
    expect(sharing).toContain("grantContactMemorySharingConsent");
    expect(sharing).toContain("ctx.update.update_id");
    expect(sharing).toContain("裸 /memory_share confirm 不会授权");
    expect(sharing).toContain('sourceChannel: "TELEGRAM"');
    expect(sharing).toContain('bot.command("memory_unshare"');
    expect(sharing).toContain("revokeContactMemorySharingConsent");
    expect(sharing).not.toContain("acceptInboundConversationMessage");
  });

  it("durably queues private Telegram edits before source invalidation", () => {
    const edit = source.slice(
      source.indexOf('bot.on("edited_message:text"'),
      source.indexOf('bot.on("message:text"'),
    );
    expect(edit).toContain('ctx.chat.type !== "private"');
    expect(edit).toContain("await trackTelegramMessageEditDurability");
    expect(edit).toContain("persistAndProcessTelegramMessageEdit");
    expect(edit).toContain("applyTelegramMessageEdit");
    expect(source).toContain("retryPendingTelegramMessageEdits");
    expect(source).toContain("await editConversationMessage");
    expect(source).toContain("telegramGuard: {");
    expect(source).toContain("await lockTelegramMessageEditLease(tx, lease)");
    const apply = source.slice(
      source.indexOf("async function applyTelegramMessageEdit"),
      source.indexOf("async function initializeTelegramBot"),
    );
    expect(apply).toContain(
      "if (!(error instanceof DelegationMessageEditConflictError)) throw error",
    );
    expect(apply.indexOf("await editConversationMessage"))
      .toBeLessThan(apply.indexOf("DelegationMessageEditConflictError"));
    expect(source.indexOf("await waitForTelegramMessageEditDurabilityFence()"))
      .toBeLessThan(source.indexOf("await bot.stop()"));
    expect(source).toContain(
      "error.error instanceof TelegramMessageEditNotDurableError",
    );
  });
});
