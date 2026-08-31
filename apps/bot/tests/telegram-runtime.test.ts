import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildTelegramAssignmentEpochScope,
  buildTelegramPollingFailureLog,
  buildTelegramUpdateMetadata,
  handleTelegramMiddlewareError,
  logTelegramUpdateExecution,
  normalizeTelegramCommandEntity,
  planTelegramBotChannelBindingSynchronization,
  resolveTelegramPollingExitCode,
  resolveTelegramRepresentativeSession,
  resolveTelegramRuntimeConfig,
  sanitizeTelegramError,
  TelegramRepresentativeSelectionRequiredError,
  TelegramRepresentativeSessionUnavailableError,
} from "../src/telegram-runtime";

describe("Telegram bot runtime", () => {
  it("creates immutable conversation coordinates for every assignment epoch", () => {
    const first = buildTelegramAssignmentEpochScope({
      representativeId: "rep-1",
      botId: "8718299151",
      chatId: 42,
      assignmentRevision: 1,
    });
    const reassignedBack = buildTelegramAssignmentEpochScope({
      representativeId: "rep-1",
      botId: "8718299151",
      chatId: 42,
      assignmentRevision: 3,
    });

    expect(first).toEqual({
      scopedTelegramChatId: "8718299151:42:r1",
      bindingKey: "TELEGRAM:rep-1:8718299151:42:r1",
    });
    expect(reassignedBack).toEqual({
      scopedTelegramChatId: "8718299151:42:r3",
      bindingKey: "TELEGRAM:rep-1:8718299151:42:r3",
    });
    expect(reassignedBack).not.toEqual(first);
  });

  it("only synchronizes the same direct Bot and never rewrites Matrix transport", () => {
    expect(
      planTelegramBotChannelBindingSynchronization(
        [
          {
            id: "direct-empty",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: null,
            telegramBotConnectionId: "connection-current",
          },
          {
            id: "legacy-empty",
            transport: null,
            sourceProvider: null,
            connectionId: "",
            telegramBotConnectionId: "connection-current",
          },
          {
            id: "direct-same",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: "8718299151",
            telegramBotConnectionId: "connection-current",
          },
          {
            id: "matrix-canary",
            transport: "MATRIX",
            sourceProvider: "TELEGRAM",
            connectionId: "matrix-appservice",
            telegramBotConnectionId: null,
          },
          {
            id: "direct-conflict",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: "999",
            telegramBotConnectionId: "connection-other",
          },
        ],
        {
          internalConnectionId: "connection-current",
          botId: "8718299151",
        },
      ),
    ).toEqual({
      updateBindingIds: ["direct-same"],
      conflictingBindingIds: ["direct-empty", "legacy-empty"],
    });
  });

  it("lets a legacy runtime refresh only an explicitly matching bot id", () => {
    expect(
      planTelegramBotChannelBindingSynchronization(
        [
          {
            id: "legacy-explicit",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: "8718299151",
            telegramBotConnectionId: null,
          },
          {
            id: "legacy-unassigned",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: null,
            telegramBotConnectionId: null,
          },
          {
            id: "other-bot",
            transport: "TELEGRAM",
            sourceProvider: "TELEGRAM",
            connectionId: "999",
            telegramBotConnectionId: null,
          },
        ],
        {
          internalConnectionId: "legacy:8718299151",
          botId: "8718299151",
          legacy: true,
        },
      ),
    ).toEqual({
      updateBindingIds: ["legacy-explicit"],
      conflictingBindingIds: [],
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
    expect(botService).not.toContain(
      'if [ -n "$$TELEGRAM_BOT_TOKEN" ]',
    );
    expect(botService).not.toContain("tail -f /dev/null");
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
    const dashboardService = compose.slice(
      compose.indexOf("  dashboard:"),
      compose.indexOf("  reps:"),
    );
    const repsService = compose.slice(
      compose.indexOf("  reps:"),
      compose.indexOf("  bot:"),
    );
    const workerService = compose.slice(
      compose.indexOf("  conversation-worker:"),
      compose.indexOf("  temporal-db-init:"),
    );
    expect(sharedEnvironment).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(sharedEnvironment).not.toContain(
      "CHANNEL_CREDENTIAL_MASTER_KEY",
    );
    expect(botService).toContain("TELEGRAM_BOT_TOKEN");
    expect(botService).toContain("CHANNEL_CREDENTIAL_MASTER_KEY");
    expect(dashboardService).toContain("CHANNEL_CREDENTIAL_MASTER_KEY");
    expect(repsService).not.toContain("CHANNEL_CREDENTIAL_MASTER_KEY");
    expect(workerService).toContain("TELEGRAM_BOT_TOKEN");
    expect(workerService).toContain("CHANNEL_CREDENTIAL_MASTER_KEY");
  });

  it("requires an explicitly assigned channel binding instead of claiming an empty binding", () => {
    const runtimeStore = readFileSync(
      new URL("../src/runtime-store.ts", import.meta.url),
      "utf8",
    );
    const bindingLookup = runtimeStore.slice(
      runtimeStore.indexOf(
        "const representativeBinding =",
      ),
      runtimeStore.indexOf("if (!representativeBinding)"),
    );
    expect(bindingLookup).toContain(
      "telegramBotConnectionId:",
    );
    expect(bindingLookup).toContain("connectionId,");
    expect(bindingLookup).not.toContain("upsert");
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

  it("uses the saved private-chat representative and defaults only when no session exists", async () => {
    await expect(
      resolveTelegramRepresentativeSession({
        chatType: "private",
        defaultRepresentativeSlug: "lin-founder-rep",
        readActiveRepresentativeSlug: async () => "sktone",
      }),
    ).resolves.toBe("sktone");

    await expect(
      resolveTelegramRepresentativeSession({
        chatType: "private",
        defaultRepresentativeSlug: "lin-founder-rep",
        readActiveRepresentativeSlug: async () => null,
      }),
    ).resolves.toBe("lin-founder-rep");
  });

  it("fails closed instead of silently routing to the default representative on a session read error", async () => {
    const readFailure = new Error("database temporarily unavailable");

    await expect(
      resolveTelegramRepresentativeSession({
        chatType: "private",
        defaultRepresentativeSlug: "lin-founder-rep",
        readActiveRepresentativeSlug: async () => {
          throw readFailure;
        },
      }),
    ).rejects.toMatchObject({
      name: "TelegramRepresentativeSessionUnavailableError",
      cause: readFailure,
    });

    await expect(
      resolveTelegramRepresentativeSession({
        chatType: "private",
        defaultRepresentativeSlug: "lin-founder-rep",
        readActiveRepresentativeSlug: async () => {
          throw readFailure;
        },
      }),
    ).rejects.toBeInstanceOf(
      TelegramRepresentativeSessionUnavailableError,
    );
  });

  it("does not persist or read a representative session for group chats", async () => {
    const readActiveRepresentativeSlug = vi.fn(async () => "sktone");

    await expect(
      resolveTelegramRepresentativeSession({
        chatType: "group",
        defaultRepresentativeSlug: "lin-founder-rep",
        readActiveRepresentativeSlug,
      }),
    ).resolves.toBe("lin-founder-rep");
    expect(readActiveRepresentativeSlug).not.toHaveBeenCalled();
  });

  it("requires an explicit representative selection when a Bot is shared", async () => {
    await expect(
      resolveTelegramRepresentativeSession({
        chatType: "private",
        defaultRepresentativeSlug: null,
        readActiveRepresentativeSlug: async () => null,
      }),
    ).rejects.toBeInstanceOf(
      TelegramRepresentativeSelectionRequiredError,
    );
  });

  it("replies with a fail-closed message when representative session lookup fails", async () => {
    const reply = vi.fn(async () => undefined);
    const logger = { error: vi.fn() };

    await handleTelegramMiddlewareError({
      error: new TelegramRepresentativeSessionUnavailableError(
        new Error("database temporarily unavailable"),
      ),
      context: {
        update: { update_id: 45 },
        reply,
      },
      logger,
    });

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("本次消息未处理"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"telegram_middleware_error"'),
    );
  });

  it("asks for an explicit representative when a shared Bot has no session", async () => {
    const reply = vi.fn(async () => undefined);

    await handleTelegramMiddlewareError({
      error: new TelegramRepresentativeSelectionRequiredError(),
      context: {
        update: { update_id: 48 },
        reply,
      },
      logger: { error: vi.fn() },
    });

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("目标对外代理"),
    );
  });

  it("does not send the session message for unrelated middleware errors", async () => {
    const reply = vi.fn(async () => undefined);

    await handleTelegramMiddlewareError({
      error: new Error("unrelated failure"),
      context: {
        update: { update_id: 46 },
        reply,
      },
      logger: { error: vi.fn() },
    });

    expect(reply).not.toHaveBeenCalled();
  });

  it("contains a failure to send the fail-closed message without rejecting the error handler", async () => {
    const logger = { error: vi.fn() };

    await expect(
      handleTelegramMiddlewareError({
        error: new TelegramRepresentativeSessionUnavailableError(
          new Error("database temporarily unavailable"),
        ),
        context: {
          update: { update_id: 47 },
          reply: async () => {
            throw new Error("Telegram API unavailable");
          },
        },
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"telegram_session_error_reply_failed"'),
    );
  });

  it("keeps the current session when a /start representative switch fails", () => {
    const source = readFileSync(
      new URL("../src/telegram-bot-runtime.ts", import.meta.url),
      "utf8",
    );
    const startHandler = source.slice(
      source.indexOf('bot.command("start"'),
      source.indexOf('bot.command("plans"'),
    );
    const switchFailure = startHandler.slice(
      startHandler.indexOf('event: "telegram_representative_switch_failed"'),
    );

    expect(switchFailure).toContain("原会话保持不变");
    expect(switchFailure).toMatch(/await ctx\.reply\([\s\S]+?\);\s+return;/);
    expect(switchFailure).not.toContain(
      "activeRepresentativeSlug = defaultRepresentativeSlug",
    );
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
    expect(
      sanitizeTelegramError(
        "8718299151:AASecretTokenValueLongEnough failed",
      ),
    ).toBe("[REDACTED] failed");
  });
});
