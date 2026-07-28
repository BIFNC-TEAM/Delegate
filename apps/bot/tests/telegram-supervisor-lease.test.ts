import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/telegram-bot-runtime", () => ({
  createTelegramBotRuntime: vi.fn(),
}));

import {
  startTelegramBotSupervisor,
  type TelegramBotSupervisorDependencies,
} from "../src/telegram-supervisor";
import type {
  TelegramBotRuntime,
  TelegramBotRuntimeConfig,
} from "../src/telegram-bot-runtime";

const descriptor = {
  connectionId: "connection-a",
  botId: "1234567890",
  username: "delegate_test_bot",
  displayName: "Delegate Test Bot",
  credentialRevision: 1,
};
const lease = {
  telegramBotConnectionId: "connection-a",
  holderId: "supervisor-a",
  leaseToken: "lease-token-a",
  expiresAt: new Date("2026-07-28T01:02:00.000Z"),
  acquiredAt: new Date("2026-07-28T01:00:00.000Z"),
  renewedAt: new Date("2026-07-28T01:00:00.000Z"),
};
const credential = {
  ...descriptor,
  token:
    "1234567890:abcdefghijklmnopqrstuvwxyzABCDE_12345",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Telegram supervisor polling leases", () => {
  it("does not resolve credentials or start polling when another holder owns the lease", async () => {
    const resolveRuntimeCredential = vi.fn();
    const createRuntime = vi.fn();
    const supervisor = await startTelegramBotSupervisor(
      buildDependencies({
        acquireLease: vi.fn().mockResolvedValue(null),
        resolveRuntimeCredential,
        createRuntime,
      }),
    );

    expect(supervisor.connectionCount).toBe(0);
    expect(resolveRuntimeCredential).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();

    await supervisor.stop("SIGTERM");
  });

  it("decrypts once after acquisition, keeps the runtime across unchanged reconciles, and releases on shutdown", async () => {
    vi.useFakeTimers();
    const runtime = createPendingRuntime();
    const resolveRuntimeCredential = vi.fn()
      .mockResolvedValue(credential);
    const releaseLease = vi.fn().mockResolvedValue(true);
    const supervisor = await startTelegramBotSupervisor(
      buildDependencies({
        acquireLease: vi.fn().mockResolvedValue(lease),
        resolveRuntimeCredential,
        createRuntime: vi.fn().mockResolvedValue(runtime.value),
        releaseLease,
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.value.start).toHaveBeenCalledOnce();
    });

    expect(supervisor.connectionCount).toBe(1);
    expect(resolveRuntimeCredential).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolveRuntimeCredential).toHaveBeenCalledOnce();

    await supervisor.stop("SIGTERM");
    expect(runtime.value.stop).toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledWith({
      telegramBotConnectionId: "connection-a",
      holderId: "supervisor-a",
      leaseToken: "lease-token-a",
    });
  });

  it("stops polling immediately and does not release a successor lease after heartbeat loss", async () => {
    vi.useFakeTimers();
    const runtime = createPendingRuntime();
    const renewLease = vi.fn().mockResolvedValue(null);
    const releaseLease = vi.fn().mockResolvedValue(true);
    const supervisor = await startTelegramBotSupervisor(
      buildDependencies({
        acquireLease: vi.fn().mockResolvedValue(lease),
        renewLease,
        resolveRuntimeCredential: vi.fn()
          .mockResolvedValue(credential),
        createRuntime: vi.fn().mockResolvedValue(runtime.value),
        releaseLease,
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.value.start).toHaveBeenCalledOnce();
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => {
      expect(runtime.value.stop).toHaveBeenCalled();
    });

    expect(renewLease).toHaveBeenCalledWith({
      ...lease,
      leaseDurationMs: 120_000,
    });
    expect(releaseLease).not.toHaveBeenCalled();

    await supervisor.stop("SIGTERM");
  });

  it("stops polling when a lease heartbeat exceeds the database operation timeout", async () => {
    vi.useFakeTimers();
    const runtime = createPendingRuntime();
    const renewLease = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const releaseLease = vi.fn().mockResolvedValue(true);
    const supervisor = await startTelegramBotSupervisor(
      buildDependencies({
        acquireLease: vi.fn().mockResolvedValue(lease),
        renewLease,
        resolveRuntimeCredential: vi.fn()
          .mockResolvedValue(credential),
        createRuntime: vi.fn().mockResolvedValue(runtime.value),
        releaseLease,
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.value.start).toHaveBeenCalledOnce();
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(runtime.value.stop).toHaveBeenCalled();
    });

    expect(renewLease).toHaveBeenCalledOnce();
    expect(releaseLease).not.toHaveBeenCalled();

    await supervisor.stop("SIGTERM");
  });
});

function buildDependencies(
  overrides: Partial<TelegramBotSupervisorDependencies> = {},
): TelegramBotSupervisorDependencies {
  return {
    env: {
      DATABASE_URL: "postgresql://test.invalid/delegate",
      TELEGRAM_RUNTIME_RECONCILE_MS: "5000",
      TELEGRAM_RUNTIME_LEASE_MS: "120000",
      TELEGRAM_RUNTIME_LEASE_RENEW_MS: "20000",
      TELEGRAM_RUNTIME_LEASE_DB_TIMEOUT_MS: "10000",
    },
    holderId: "supervisor-a",
    bootstrapLegacyConnection: vi.fn().mockResolvedValue(null),
    loadRuntimeConfigs: vi.fn().mockResolvedValue({
      configs: [descriptor],
      hasPersistedConnections: true,
    }),
    acquireLease: vi.fn().mockResolvedValue(lease),
    renewLease: vi.fn().mockResolvedValue({
      ...lease,
      expiresAt: new Date("2026-07-28T01:02:20.000Z"),
      renewedAt: new Date("2026-07-28T01:00:20.000Z"),
    }),
    releaseLease: vi.fn().mockResolvedValue(true),
    resolveRuntimeCredential: vi.fn().mockResolvedValue(credential),
    createRuntime: vi.fn(),
    markRuntimeHealth: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function createPendingRuntime() {
  let resolveStart: (() => void) | undefined;
  const config: TelegramBotRuntimeConfig = {
    internalConnectionId: "connection-a",
    botId: "1234567890",
    username: "delegate_test_bot",
    displayName: "Delegate Test Bot",
    token:
      "1234567890:abcdefghijklmnopqrstuvwxyzABCDE_12345",
    credentialRevision: 1,
  };
  const runtime: TelegramBotRuntime = {
    config,
    start: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    ),
    stop: vi.fn(async () => {
      resolveStart?.();
    }),
  };
  return { value: runtime };
}
