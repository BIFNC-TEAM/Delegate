import { readFileSync } from "node:fs";

import { ChannelUnavailableError } from "@delegate/web-data";
import { describe, expect, it } from "vitest";

import {
  resolveTelegramConversationPlatformMode,
  shouldFailClosedAfterConversationPlatformWrite,
} from "../src/conversation-platform-mode";

describe("Telegram conversation platform mode", () => {
  it("checks channel availability before branching into legacy, shadow, or worker mode", () => {
    const source = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );
    const handlerStart = source.indexOf('bot.on("message:text"');
    const handlerSource = source.slice(handlerStart);

    expect(
      handlerSource.indexOf("assertConversationChannelDeliveryAvailable"),
    ).toBeGreaterThan(-1);
    expect(
      handlerSource.indexOf("assertConversationChannelDeliveryAvailable"),
    ).toBeLessThan(
      handlerSource.indexOf('conversationPlatformMode === "worker"'),
    );
  });

  it("does not fall through to legacy group generation in worker mode", () => {
    const source = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );
    const handlerSource = source.slice(source.indexOf('bot.on("message:text"'));
    const groupGate = handlerSource.indexOf(
      'conversationPlatformMode === "worker" && !isPrivate',
    );
    const legacyPlan = handlerSource.indexOf("const plan = createConversationPlan");

    expect(groupGate).toBeGreaterThan(-1);
    expect(groupGate).toBeLessThan(legacyPlan);
  });

  it("blocks the legacy direct-compute path when worker owns Telegram", () => {
    const source = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );
    const commandSource = source.slice(
      source.indexOf('bot.command("compute"'),
      source.indexOf('bot.callbackQuery(/^buy:'),
    );

    expect(commandSource.indexOf('conversationPlatformMode === "worker"')).toBeGreaterThan(-1);
    expect(commandSource.indexOf('conversationPlatformMode === "worker"')).toBeLessThan(
      commandSource.indexOf("await handleComputeRequest"),
    );
  });

  it("removes new Stars invoices and still checks compute channel availability", () => {
    const source = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );
    const computeSource = source.slice(
      source.indexOf("async function handleComputeRequest"),
      source.indexOf("function buildComputeReplyOptions"),
    );

    expect(source).not.toContain("async function sendPlanInvoice");
    expect(source).not.toContain("createPlanInvoice");
    expect(computeSource.indexOf("assertConversationChannelDeliveryAvailable")).toBeGreaterThan(-1);
    expect(computeSource.indexOf("assertConversationChannelDeliveryAvailable")).toBeLessThan(
      computeSource.indexOf("const session = await createAudienceComputeSession"),
    );
  });

  it.each(["legacy", "shadow"] as const)(
    "fails closed for an explicit channel pause in %s mode",
    (mode) => {
      expect(
        shouldFailClosedAfterConversationPlatformWrite(
          mode,
          new ChannelUnavailableError("channel_paused"),
        ),
      ).toBe(true);
    },
  );

  it("allows shadow mode to fall back only for a non-policy shadow-write outage", () => {
    expect(
      shouldFailClosedAfterConversationPlatformWrite(
        "shadow",
        new Error("shadow persistence unavailable"),
      ),
    ).toBe(false);
  });

  it("always fails closed in worker mode", () => {
    expect(
      shouldFailClosedAfterConversationPlatformWrite(
        "worker",
        new Error("conversation platform unavailable"),
      ),
    ).toBe(true);
  });

  it("defaults to worker and rejects legacy ownership in production", () => {
    expect(resolveTelegramConversationPlatformMode({})).toBe("worker");
    expect(() =>
      resolveTelegramConversationPlatformMode({
        NODE_ENV: "production",
        TELEGRAM_CONVERSATION_PLATFORM_MODE: "shadow",
      }),
    ).toThrow("Production Telegram traffic must use");
  });

});
