import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildRepresentativeWebRechargeUrl,
  buildTelegramBotCommands,
  buildWebRechargeMessage,
  formatTelegramPlans,
  resolveTelegramInlineKeyboardUrl,
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
  it("keeps a Web buy command while Telegram Stars purchases are unavailable", () => {
    const commands = buildTelegramBotCommands(false);

    expect(commands.map((command) => command.command)).toContain("buy");
    expect(commands.map((command) => command.command)).toContain("plans");
    expect(commands.map((command) => command.description).join(" ")).not.toContain(
      "Stars",
    );
    expect(commands.find((command) => command.command === "buy")).toEqual({
      command: "buy",
      description: "Continue Pass / Deep Help / Sponsor on Web",
    });
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

  it("describes worker-owned compute as a Web continuation", () => {
    expect(
      buildTelegramBotCommands(false, false).find(
        (command) => command.command === "compute",
      ),
    ).toEqual({
      command: "compute",
      description: "Continue governed compute requests on Web",
    });
  });

  it("builds the Web recharge entry from representative URL and slug config", () => {
    expect(
      buildRepresentativeWebRechargeUrl("lin founder/测试", {
        NEXT_PUBLIC_REPRESENTATIVE_URL:
          "https://representatives.example.test/public/",
      }),
    ).toBe(
      "https://representatives.example.test/public/reps/lin%20founder%2F%E6%B5%8B%E8%AF%95?source=telegram#recharge",
    );
  });

  it("prefers a Bot-specific recharge origin without changing the Web app origin", () => {
    expect(
      buildRepresentativeWebRechargeUrl("lin", {
        TELEGRAM_WEB_RECHARGE_BASE_URL: "https://tunnel.example.test",
        NEXT_PUBLIC_REPRESENTATIVE_URL: "http://localhost:3002",
      }),
    ).toBe("https://tunnel.example.test/reps/lin?source=telegram#recharge");
  });

  it("fails closed instead of inventing a Web host", () => {
    expect(buildRepresentativeWebRechargeUrl("rep", {})).toBeNull();
    expect(
      buildRepresentativeWebRechargeUrl("rep", {
        NEXT_PUBLIC_REPRESENTATIVE_URL: "javascript:alert(1)",
      }),
    ).toBeNull();
    expect(
      buildRepresentativeWebRechargeUrl("rep", {
        NEXT_PUBLIC_REPRESENTATIVE_URL:
          "https://user:password@representatives.example.test",
      }),
    ).toBeNull();
  });

  it("only creates Telegram buttons for public HTTPS recharge URLs", () => {
    expect(
      resolveTelegramInlineKeyboardUrl(
        "https://representatives.example.test/reps/lin#recharge",
      ),
    ).toBe("https://representatives.example.test/reps/lin#recharge");
    expect(
      resolveTelegramInlineKeyboardUrl(
        "http://localhost:3002/reps/lin#recharge",
      ),
    ).toBeNull();
    expect(
      resolveTelegramInlineKeyboardUrl(
        "http://representatives.example.test/reps/lin#recharge",
      ),
    ).toBeNull();
    expect(
      resolveTelegramInlineKeyboardUrl(
        "https://user:password@representatives.example.test/reps/lin",
      ),
    ).toBeNull();
    for (const privateUrl of [
      "https://localhost./reps/lin",
      "https://127.1/reps/lin",
      "https://10.0.0.1/reps/lin",
      "https://169.254.1.2/reps/lin",
      "https://172.16.0.1/reps/lin",
      "https://192.168.1.1/reps/lin",
      "https://[fc00::1]/reps/lin",
      "https://[fe80::1]/reps/lin",
      "https://[::192.168.1.1]/reps/lin",
      "https://[2001::1]/reps/lin",
      "https://[2001:2a::1]/reps/lin",
    ]) {
      expect(resolveTelegramInlineKeyboardUrl(privateUrl)).toBeNull();
    }
    expect(
      resolveTelegramInlineKeyboardUrl("https://8.8.8.8/reps/lin"),
    ).toBe("https://8.8.8.8/reps/lin");
    expect(
      resolveTelegramInlineKeyboardUrl(
        "https://[2001:4860:4860::8888]/reps/lin",
      ),
    ).toBe("https://[2001:4860:4860::8888]/reps/lin");
    for (const publicUrl of [
      "https://[2a00::1]/reps/lin",
      "https://[2400::1]/reps/lin",
    ]) {
      expect(resolveTelegramInlineKeyboardUrl(publicUrl)).toBe(publicUrl);
    }
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
        "https://representatives.example.test/reps/lin?source=telegram#recharge",
    });

    expect(message).toContain("当前充值与付费统一在 Web 完成");
    expect(message).toContain("先在 Web 登录并完成 Telegram 绑定");
    expect(message).toContain("Pass");
    expect(message).toContain(
      "https://representatives.example.test/reps/lin?source=telegram#recharge",
    );
    expect(message).not.toContain("Stars");
  });

  it("wires command registration and all generated buy buttons through the gate", () => {
    const source = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("buildTelegramBotCommands(");
    expect(source).toContain("conversationPlatformMode !== \"worker\"");

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
    expect(plansKeyboard).toContain("buildWebRechargeKeyboard(");

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
    expect(conversationKeyboard).toContain("buildWebRechargeKeyboard(");

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
