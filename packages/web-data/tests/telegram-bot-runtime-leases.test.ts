import { describe, expect, it, vi } from "vitest";

import {
  acquireTelegramBotRuntimeLease,
  releaseTelegramBotRuntimeLease,
  renewTelegramBotRuntimeLease,
  type TelegramBotRuntimeLease,
} from "../src/telegram-bot-runtime-leases";

const lease: TelegramBotRuntimeLease = {
  telegramBotConnectionId: "connection-a",
  holderId: "supervisor-a",
  leaseToken: "lease-token-a",
  expiresAt: new Date("2026-07-28T01:02:00.000Z"),
  acquiredAt: new Date("2026-07-28T01:00:00.000Z"),
  renewedAt: new Date("2026-07-28T01:00:00.000Z"),
};

describe("Telegram Bot runtime database leases", () => {
  it("acquires with a database-clock expiry and returns no lease on contention", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([lease])
      .mockResolvedValueOnce([]);
    const client = {
      $queryRaw: queryRaw,
      $executeRaw: vi.fn(),
    } as never;

    await expect(
      acquireTelegramBotRuntimeLease(
        {
          telegramBotConnectionId: "connection-a",
          holderId: "supervisor-a",
          leaseDurationMs: 120_000,
        },
        {
          client,
          tokenFactory: () => "lease-token-a",
        },
      ),
    ).resolves.toEqual(lease);
    await expect(
      acquireTelegramBotRuntimeLease(
        {
          telegramBotConnectionId: "connection-a",
          holderId: "supervisor-b",
          leaseDurationMs: 120_000,
        },
        {
          client,
          tokenFactory: () => "lease-token-b",
        },
      ),
    ).resolves.toBeNull();

    const statement = queryRaw.mock.calls[0]![0] as {
      sql: string;
      values: unknown[];
    };
    expect(statement.sql).toContain("CURRENT_TIMESTAMP");
    expect(statement.sql).toContain(
      '"TelegramBotRuntimeLease"."expiresAt" <= CURRENT_TIMESTAMP',
    );
    expect(statement.values).toEqual(
      expect.arrayContaining([
        "connection-a",
        "supervisor-a",
        "lease-token-a",
        120_000,
      ]),
    );
  });

  it("renews only the exact unexpired holder token", async () => {
    const renewed = {
      ...lease,
      expiresAt: new Date("2026-07-28T01:02:20.000Z"),
      renewedAt: new Date("2026-07-28T01:00:20.000Z"),
    };
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([renewed])
      .mockResolvedValueOnce([]);
    const client = {
      $queryRaw: queryRaw,
      $executeRaw: vi.fn(),
    } as never;

    await expect(
      renewTelegramBotRuntimeLease(
        {
          ...lease,
          leaseDurationMs: 120_000,
        },
        { client },
      ),
    ).resolves.toEqual(renewed);
    await expect(
      renewTelegramBotRuntimeLease(
        {
          ...lease,
          leaseToken: "stale-token",
          leaseDurationMs: 120_000,
        },
        { client },
      ),
    ).resolves.toBeNull();

    const statement = queryRaw.mock.calls[0]![0] as {
      sql: string;
      values: unknown[];
    };
    expect(statement.sql).toContain(
      'lease."expiresAt" > CURRENT_TIMESTAMP',
    );
    expect(statement.sql).toContain('lease."holderId" =');
    expect(statement.sql).toContain('lease."leaseToken" =');
    expect(statement.values).toEqual(
      expect.arrayContaining([
        "connection-a",
        "supervisor-a",
        "lease-token-a",
      ]),
    );
  });

  it("releases only the exact connection, holder, and token", async () => {
    const executeRaw = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const client = {
      $queryRaw: vi.fn(),
      $executeRaw: executeRaw,
    } as never;

    await expect(
      releaseTelegramBotRuntimeLease(lease, { client }),
    ).resolves.toBe(true);
    await expect(
      releaseTelegramBotRuntimeLease(
        { ...lease, leaseToken: "stale-token" },
        { client },
      ),
    ).resolves.toBe(false);

    const statement = executeRaw.mock.calls[0]![0] as {
      sql: string;
      values: unknown[];
    };
    expect(statement.sql).toContain('"telegramBotConnectionId" =');
    expect(statement.sql).toContain('"holderId" =');
    expect(statement.sql).toContain('"leaseToken" =');
    expect(statement.values).toEqual([
      "connection-a",
      "supervisor-a",
      "lease-token-a",
    ]);
  });

  it("rejects unsafe coordinates and lease durations", async () => {
    await expect(
      acquireTelegramBotRuntimeLease(
        {
          telegramBotConnectionId: "connection-a",
          holderId: "bad holder",
          leaseDurationMs: 120_000,
        },
        {
          client: {
            $queryRaw: vi.fn(),
            $executeRaw: vi.fn(),
          } as never,
        },
      ),
    ).rejects.toThrow("holderId is invalid");
    await expect(
      acquireTelegramBotRuntimeLease(
        {
          telegramBotConnectionId: "connection-a",
          holderId: "supervisor-a",
          leaseDurationMs: 999,
        },
        {
          client: {
            $queryRaw: vi.fn(),
            $executeRaw: vi.fn(),
          } as never,
        },
      ),
    ).rejects.toThrow("duration must be an integer");
  });
});
