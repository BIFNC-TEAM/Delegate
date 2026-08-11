import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildRepresentativeWebRechargeUrl,
  buildTelegramBotCommands,
  buildWebRechargeMessage,
  resolveTelegramInlineKeyboardUrl,
} from "../src/commerce-ux";

describe("Telegram commerce UX", () => {
  it("keeps a Web buy command while Telegram Stars purchases are unavailable", () => {
    const commands = buildTelegramBotCommands();

    expect(commands.map((command) => command.command)).toContain("buy");
    expect(commands.map((command) => command.command)).toContain("plans");
    expect(commands.map((command) => command.command)).toEqual(
      expect.arrayContaining([
        "forget",
        "delete_memory",
        "memory_share",
        "memory_unshare",
      ]),
    );
    expect(commands.map((command) => command.description).join(" ")).not.toContain(
      "Stars",
    );
    expect(commands.find((command) => command.command === "buy")).toEqual({
      command: "buy",
      description: "Open the current service catalog on Web",
    });
  });

  it("describes worker-owned compute as a Web continuation", () => {
    expect(
      buildTelegramBotCommands(false).find(
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

  it("routes every generated purchase entry to the Web catalog", () => {
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
    expect(plansKeyboard).toContain("buildWebRechargeKeyboard(");
    expect(plansKeyboard).not.toContain('text("Buy Pass"');

    const conversationKeyboard = source.slice(
      source.indexOf("function buildPlanKeyboardForConversation"),
      source.indexOf("function buildPlanReplyOptions"),
    );
    expect(conversationKeyboard).toContain("buildWebRechargeKeyboard(");
    expect(conversationKeyboard).not.toContain("buy:${plan.suggestedPlan}");

    const computeKeyboard = source.slice(
      source.indexOf("function buildComputeReplyOptions"),
      source.indexOf("function formatComputeReply"),
    );
    expect(computeKeyboard).toContain('.url(');
    expect(computeKeyboard).not.toContain('"buy:deep_help"');
  });
});
