import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildRepresentativeWebRechargeUrl,
  buildTelegramBotCommands,
  buildWebRechargeMessage,
  formatTelegramPlans,
} from "../src/commerce-ux";

const plans = [
  {
    tier: "free" as const,
    name: "Free",
    stars: 0,
    summary: "Basic help.",
    includedReplies: 4,
    includesPriorityHandoff: false,
  },
  {
    tier: "pass" as const,
    name: "Pass",
    stars: 180,
    summary: "Continue the conversation.",
    includedReplies: 12,
    includesPriorityHandoff: false,
  },
];

describe("Telegram commerce UX", () => {
  it("does not register the Stars buy command while purchases are unavailable", () => {
    const commands = buildTelegramBotCommands(false);

    expect(commands.map((command) => command.command)).not.toContain("buy");
    expect(commands.map((command) => command.command)).toContain("plans");
    expect(commands.map((command) => command.description).join(" ")).not.toContain(
      "Stars",
    );
  });

  it("keeps the buy command only for a gate-approved Stars environment", () => {
    expect(
      buildTelegramBotCommands(true).find(
        (command) => command.command === "buy",
      ),
    ).toEqual({
      command: "buy",
      description: "Buy Pass / Deep Help / Sponsor in Telegram Stars",
    });
  });

  it("builds the Web recharge entry from representative URL and slug config", () => {
    expect(
      buildRepresentativeWebRechargeUrl("lin founder/测试", {
        NEXT_PUBLIC_REPRESENTATIVE_URL:
          "https://representatives.example.test/public/",
      }),
    ).toBe(
      "https://representatives.example.test/public/reps/lin%20founder%2F%E6%B5%8B%E8%AF%95#recharge",
    );
  });

  it("fails closed instead of inventing a Web host", () => {
    expect(buildRepresentativeWebRechargeUrl("rep", {})).toBeNull();
    expect(
      buildRepresentativeWebRechargeUrl("rep", {
        NEXT_PUBLIC_REPRESENTATIVE_URL: "javascript:alert(1)",
      }),
    ).toBeNull();
  });

  it("removes Stars pricing from plan copy when the release gate is closed", () => {
    const webFirstCopy = formatTelegramPlans(plans, false);
    const starsCopy = formatTelegramPlans(plans, true);

    expect(webFirstCopy).not.toContain("Stars");
    expect(webFirstCopy).toContain("Pass");
    expect(starsCopy).toContain("180 Stars");
  });

  it("gives typed /buy traffic an explicit Web continuation entry", () => {
    const message = buildWebRechargeMessage({
      representativeName: "Lin Representative",
      selectedPlanName: "Pass",
      rechargeUrl:
        "https://representatives.example.test/reps/lin#recharge",
    });

    expect(message).toContain("当前充值与付费统一在 Web 完成");
    expect(message).toContain("Pass");
    expect(message).toContain(
      "https://representatives.example.test/reps/lin#recharge",
    );
    expect(message).not.toContain("Stars");
  });

  it("wires command registration and all generated buy buttons through the gate", () => {
    const source = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "buildTelegramBotCommands(telegramStarsPurchasesEnabled)",
    );

    const plansKeyboard = source.slice(
      source.indexOf("function buildPlansKeyboard"),
      source.indexOf("function buildPlanKeyboardForConversation"),
    );
    expect(plansKeyboard.indexOf("telegramStarsPurchasesEnabled")).toBeGreaterThan(
      -1,
    );
    expect(plansKeyboard.indexOf("telegramStarsPurchasesEnabled")).toBeLessThan(
      plansKeyboard.indexOf('.text("Buy Pass"'),
    );
    expect(plansKeyboard).toContain('.url("打开 Web 充值"');

    const conversationKeyboard = source.slice(
      source.indexOf("function buildPlanKeyboardForConversation"),
      source.indexOf("function buildPlanReplyOptions"),
    );
    expect(
      conversationKeyboard.indexOf("!telegramStarsPurchasesEnabled"),
    ).toBeGreaterThan(-1);
    expect(
      conversationKeyboard.indexOf("!telegramStarsPurchasesEnabled"),
    ).toBeLessThan(conversationKeyboard.indexOf("`buy:${plan.suggestedPlan}`"));
    expect(conversationKeyboard).toContain('.url("在 Web 继续服务"');

    const computeKeyboard = source.slice(
      source.indexOf("function buildComputeReplyOptions"),
      source.indexOf("function formatComputeReply"),
    );
    expect(
      computeKeyboard.indexOf("!telegramStarsPurchasesEnabled"),
    ).toBeGreaterThan(-1);
    expect(
      computeKeyboard.indexOf("!telegramStarsPurchasesEnabled"),
    ).toBeLessThan(computeKeyboard.indexOf('"buy:deep_help"'));
    expect(computeKeyboard).toContain('.url(');
  });
});
