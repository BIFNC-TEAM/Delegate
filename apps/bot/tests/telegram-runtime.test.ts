import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildTelegramPollingFailureLog,
  buildTelegramUpdateMetadata,
  logTelegramUpdateExecution,
  normalizeTelegramCommandEntity,
  planTelegramBotChannelBindingSynchronization,
  resolveTelegramPollingExitCode,
  resolveTelegramRuntimeConfig,
  sanitizeTelegramError,
} from "../src/telegram-runtime";

describe("Telegram bot runtime", () => {
  it("only synchronizes the same direct Bot and never rewrites Matrix transport", () => {
    expect(
      planTelegramBotChannelBindingSynchronization(
        [
          {
            id: "direct-empty",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: null,
          },
          {
            id: "legacy-empty",
            transport: null,
            sourceProvider: null,
            connectionId: "",
          },
          {
            id: "direct-same",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: "8718299151",
          },
          {
            id: "matrix-canary",
            transport: "MATRIX",
            sourceProvider: "TELEGRAM",
            connectionId: "matrix-appservice",
          },
          {
            id: "direct-conflict",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: "999",
          },
        ],
        "8718299151",
      ),
    ).toEqual({
      updateBindingIds: ["direct-empty", "legacy-empty", "direct-same"],
      conflictingBindingIds: ["direct-conflict"],
    });
  });

  it("runs Node as the Bot container process so shutdown signals reach grammY", () => {
    const compose = readFileSync(
      new URL("../../../compose.yml", import.meta.url),
      "utf8",
    );
    const botService = compose.slice(
      compose.indexOf("  bot:"),
      compose.indexOf("  compute-broker:"),
    );
    expect(botService).toContain(
      "cd /app/apps/bot && exec node --import tsx src/index.ts",
    );
    expect(botService).toContain('restart: "on-failure:3"');
    expect(botService).toContain("stop_grace_period: 70s");
  });

  it("scopes the Telegram token to delivery runtimes", () => {
    const compose = readFileSync(
      new URL("../../../compose.yml", import.meta.url),
      "utf8",
    );
    const sharedEnvironment = compose.slice(
      compose.indexOf("x-app-environment:"),
      compose.indexOf("x-app-service:"),
    );
    const botService = compose.slice(
      compose.indexOf("  bot:"),
      compose.indexOf("  compute-broker:"),
    );
    const workerService = compose.slice(
      compose.indexOf("  conversation-worker:"),
      compose.indexOf("  temporal-db-init:"),
    );
    expect(sharedEnvironment).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(botService).toContain("TELEGRAM_BOT_TOKEN");
    expect(workerService).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("refreshes a seeded channel binding with the configured Bot identity", () => {
    const runtimeStore = readFileSync(
      new URL("../src/runtime-store.ts", import.meta.url),
      "utf8",
    );
    const bindingUpsert = runtimeStore.slice(
      runtimeStore.indexOf(
        "const telegramBotExternalUserId = process.env.TELEGRAM_BOT_USERNAME",
      ),
      runtimeStore.indexOf("const bindingKey ="),
    );
    expect(bindingUpsert).toContain(
      "externalUserId: telegramBotExternalUserId",
    );
    expect(
      bindingUpsert.match(/externalUserId: telegramBotExternalUserId/g),
    ).toHaveLength(2);
  });

  it("uses a bounded API timeout that leaves headroom around long polling", () => {
    expect(resolveTelegramRuntimeConfig({})).toEqual({
      apiTimeoutSeconds: 15,
      pollingTimeoutSeconds: 10,
    });
    expect(
      resolveTelegramRuntimeConfig({
        TELEGRAM_REQUEST_TIMEOUT_MS: "5000",
      }),
    ).toEqual({
      apiTimeoutSeconds: 5,
      pollingTimeoutSeconds: 3,
    });
    expect(() =>
      resolveTelegramRuntimeConfig({
        TELEGRAM_REQUEST_TIMEOUT_MS: "1000",
      }),
    ).toThrow("between 3000 and 60000");
  });

  it("synthesizes a missing command entity without changing existing entities", () => {
    const message = {
      text: "/compute",
      entities: [{ type: "bold", offset: 1, length: 3 }],
    };

    expect(normalizeTelegramCommandEntity(message)).toBe(true);
    expect(message.entities).toEqual([
      { type: "bot_command", offset: 0, length: 8 },
      { type: "bold", offset: 1, length: 3 },
    ]);
    expect(normalizeTelegramCommandEntity(message)).toBe(false);
  });

  it("does not reinterpret slash-prefixed prose as a command", () => {
    const message = { text: "/not-a-command" };
    expect(normalizeTelegramCommandEntity(message)).toBe(false);
    expect(message).toEqual({ text: "/not-a-command" });
  });

  it("logs only update metadata and never the message body", async () => {
    const info = vi.fn();
    const error = vi.fn();
    const update = {
      update_id: 42,
      message: {
        text: "/plans private-message-body",
      },
    };
    const metadata = buildTelegramUpdateMetadata(update, true);

    await logTelegramUpdateExecution(
      metadata,
      async () => undefined,
      { info, error },
    );

    expect(info).toHaveBeenCalledTimes(2);
    const serializedLogs = info.mock.calls.flat().join("\n");
    expect(serializedLogs).toContain('"command":"plans"');
    expect(serializedLogs).toContain('"synthesizedCommandEntity":true');
    expect(serializedLogs).not.toContain("private-message-body");
    expect(error).not.toHaveBeenCalled();
  });

  it("does not log arbitrary command text", () => {
    expect(
      buildTelegramUpdateMetadata({
        update_id: 44,
        message: { text: "/private_secret_name argument" },
      }),
    ).toEqual({
      updateId: 44,
      type: "message",
      command: "other_command",
    });
  });

  it("logs a sanitized failure and rethrows the original error", async () => {
    const info = vi.fn();
    const error = vi.fn();
    const failure = new Error(
      "request to bot8718299151:AASecretTokenValue failed",
    );

    await expect(
      logTelegramUpdateExecution(
        { updateId: 43, type: "message", command: "compute" },
        async () => {
          throw failure;
        },
        { info, error },
      ),
    ).rejects.toBe(failure);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("bot[REDACTED]"),
    );
    expect(error.mock.calls.flat().join("\n")).not.toContain(
      "AASecretTokenValue",
    );
  });

  it("explains duplicate pollers without exposing arbitrary error objects", () => {
    const log = buildTelegramPollingFailureLog({
      error_code: 409,
      message: "Conflict",
    });
    expect(log).toEqual({
      event: "telegram_polling_stopped",
      reason: "another_get_updates_consumer",
      restartable: false,
      errorCode: 409,
      error: "unknown_error",
    });
    expect(resolveTelegramPollingExitCode({ error_code: 409 })).toBe(0);
    expect(resolveTelegramPollingExitCode({ error_code: 401 })).toBe(1);
    expect(
      sanitizeTelegramError(
        "bot8718299151:AASecretTokenValue is unavailable",
      ),
    ).toBe("bot[REDACTED] is unavailable");
  });
});
