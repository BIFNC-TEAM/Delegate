import { describe, expect, it } from "vitest";

import {
  getTelegramRuntimeContext,
  requireTelegramRuntimeContext,
  runWithTelegramRuntimeContext,
} from "../src/telegram-runtime-context";
import {
  isSameTelegramRuntimeRevision,
  legacyRuntimeConfig,
  resolveReconcileIntervalMs,
  resolveTelegramSupervisorLeaseTiming,
} from "../src/telegram-supervisor-config";

describe("Telegram multi-Bot runtime", () => {
  it("keeps concurrent update metadata isolated by Bot connection", async () => {
    const first = runWithTelegramRuntimeContext(
      {
        internalConnectionId: "connection-a",
        botId: "111",
        username: "first_bot",
      },
      async () => {
        await Promise.resolve();
        return requireTelegramRuntimeContext();
      },
    );
    const second = runWithTelegramRuntimeContext(
      {
        internalConnectionId: "connection-b",
        botId: "222",
        username: "second_bot",
      },
      async () => {
        await Promise.resolve();
        return requireTelegramRuntimeContext();
      },
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        internalConnectionId: "connection-a",
        botId: "111",
        username: "first_bot",
      },
      {
        internalConnectionId: "connection-b",
        botId: "222",
        username: "second_bot",
      },
    ]);
    expect(getTelegramRuntimeContext()).toBeUndefined();
  });

  it("fails closed when connection-scoped storage is used outside a runtime", () => {
    expect(() => requireTelegramRuntimeContext()).toThrow(
      "runtime context is unavailable",
    );
  });

  it("builds a legacy runtime only from a self-consistent token", () => {
    expect(
      legacyRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "123456:testing-token-value",
        TELEGRAM_BOT_ID: "123456",
        TELEGRAM_BOT_USERNAME: "@delegate_test_bot",
      }),
    ).toEqual({
      internalConnectionId: "legacy:123456",
      botId: "123456",
      username: "delegate_test_bot",
      token: "123456:testing-token-value",
      credentialRevision: 1,
      legacy: true,
    });
    expect(() =>
      legacyRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "123456:testing-token-value",
        TELEGRAM_BOT_ID: "654321",
      })
    ).toThrow("must match");
  });

  it("restarts only the connection whose credential revision changed", () => {
    const current = {
      internalConnectionId: "connection-a",
      botId: "123456",
      token: "123456:old-testing-token",
      credentialRevision: 1,
    };
    expect(
      isSameTelegramRuntimeRevision(current, {
        ...current,
        token: "123456:same-revision-token-is-not-compared",
      }),
    ).toBe(true);
    expect(
      isSameTelegramRuntimeRevision(current, {
        ...current,
        token: "123456:rotated-testing-token",
        credentialRevision: 2,
      }),
    ).toBe(false);
  });

  it("uses a bounded reconcile interval", () => {
    expect(resolveReconcileIntervalMs({})).toBe(5_000);
    expect(
      resolveReconcileIntervalMs({
        TELEGRAM_RUNTIME_RECONCILE_MS: "1200",
      }),
    ).toBe(1_200);
    expect(() =>
      resolveReconcileIntervalMs({
        TELEGRAM_RUNTIME_RECONCILE_MS: "999",
      }),
    ).toThrow("between 1000 and 60000");
  });

  it("keeps lease renewal ahead of the maximum Telegram API timeout", () => {
    expect(resolveTelegramSupervisorLeaseTiming({})).toEqual({
      leaseDurationMs: 120_000,
      renewIntervalMs: 20_000,
      operationTimeoutMs: 10_000,
    });
    expect(() =>
      resolveTelegramSupervisorLeaseTiming({
        TELEGRAM_RUNTIME_LEASE_MS: "60000",
        TELEGRAM_RUNTIME_LEASE_RENEW_MS: "20000",
        TELEGRAM_RUNTIME_LEASE_DB_TIMEOUT_MS: "10000",
      })
    ).toThrow("maximum Telegram API timeout");
  });
});
