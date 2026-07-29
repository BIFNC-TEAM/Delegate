import { randomUUID } from "node:crypto";

import {
  acquireTelegramBotRuntimeLease,
  bootstrapLegacyTelegramBotConnectionFromEnv,
  hasPersistedTelegramBotConnections,
  listActiveTelegramBotRuntimeDescriptors,
  markTelegramBotRuntimeHealth,
  releaseTelegramBotRuntimeLease,
  resolveTelegramBotRuntimeCredential,
  renewTelegramBotRuntimeLease,
  type TelegramBotRuntimeLease,
} from "@delegate/web-data";

import {
  createTelegramBotRuntime,
  type TelegramBotRuntime,
  type TelegramBotRuntimeConfig,
} from "./telegram-bot-runtime";
import {
  buildTelegramPollingFailureLog,
  sanitizeTelegramError,
} from "./telegram-runtime";
import {
  isSameTelegramRuntimeRevision,
  legacyRuntimeConfig,
  resolveReconcileIntervalMs,
  resolveTelegramSupervisorLeaseTiming,
  type TelegramSupervisorLeaseTiming,
} from "./telegram-supervisor-config";

type PersistedTelegramBotRuntimeDescriptor = {
  connectionId: string;
  botId: string;
  username?: string | null;
  displayName?: string | null;
  credentialRevision: number;
};

type RuntimeConfigSnapshot = {
  configs: PersistedTelegramBotRuntimeDescriptor[];
  hasPersistedConnections: boolean;
};

type TelegramRuntimeDescriptor = {
  internalConnectionId: string;
  botId: string;
  username?: string;
  displayName?: string;
  credentialRevision: number;
};

export type TelegramBotSupervisorDependencies = {
  env?: Readonly<Record<string, string | undefined>>;
  holderId?: string;
  bootstrapLegacyConnection?: () => Promise<unknown>;
  loadRuntimeConfigs?: () => Promise<RuntimeConfigSnapshot>;
  createRuntime?: (
    config: TelegramBotRuntimeConfig,
  ) => Promise<TelegramBotRuntime>;
  acquireLease?: typeof acquireTelegramBotRuntimeLease;
  renewLease?: typeof renewTelegramBotRuntimeLease;
  releaseLease?: typeof releaseTelegramBotRuntimeLease;
  resolveRuntimeCredential?: typeof resolveTelegramBotRuntimeCredential;
  markRuntimeHealth?: typeof markTelegramBotRuntimeHealth;
};

type ResolvedSupervisorDependencies = {
  env: Readonly<Record<string, string | undefined>>;
  holderId: string;
  bootstrapLegacyConnection: () => Promise<unknown>;
  loadRuntimeConfigs: () => Promise<RuntimeConfigSnapshot>;
  createRuntime: (
    config: TelegramBotRuntimeConfig,
  ) => Promise<TelegramBotRuntime>;
  acquireLease: typeof acquireTelegramBotRuntimeLease;
  renewLease: typeof renewTelegramBotRuntimeLease;
  releaseLease: typeof releaseTelegramBotRuntimeLease;
  resolveRuntimeCredential: typeof resolveTelegramBotRuntimeCredential;
  markRuntimeHealth: typeof markTelegramBotRuntimeHealth;
};

type ManagedConnection = {
  config: TelegramBotRuntimeConfig;
  lease: TelegramBotRuntimeLease | null;
  leaseLost: boolean;
  stopRequested: boolean;
  retryAbort: AbortController;
  leaseAbort: AbortController;
  runtime: TelegramBotRuntime | undefined;
  task: Promise<void>;
};

type SupervisorState = {
  stopping: boolean;
  holderId: string;
  timing: TelegramSupervisorLeaseTiming;
  dependencies: ResolvedSupervisorDependencies;
  connections: Map<string, ManagedConnection>;
  contendedConnections: Set<string>;
  reconcileTimer: ReturnType<typeof setInterval> | undefined;
  reconcilePromise: Promise<void> | undefined;
};

export type TelegramBotSupervisor = {
  connectionCount: number;
  stop: (signal: "SIGINT" | "SIGTERM") => Promise<void>;
};

const minimumRestartDelayMs = 1_000;
const maximumRestartDelayMs = 30_000;

export async function startTelegramBotSupervisor(
  input: TelegramBotSupervisorDependencies = {},
): Promise<TelegramBotSupervisor> {
  const dependencies = resolveSupervisorDependencies(input);
  const timing = resolveTelegramSupervisorLeaseTiming(dependencies.env);
  try {
    await dependencies.bootstrapLegacyConnection();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_legacy_connection_bootstrap_failed",
        error: sanitizeTelegramError(error),
      }),
    );
  }
  const state: SupervisorState = {
    stopping: false,
    holderId: dependencies.holderId,
    timing,
    dependencies,
    connections: new Map(),
    contendedConnections: new Set(),
    reconcileTimer: undefined,
    reconcilePromise: undefined,
  };
  await reconcileConnections(state);

  const reconcileIntervalMs =
    resolveReconcileIntervalMs(dependencies.env);
  state.reconcileTimer = setInterval(() => {
    if (state.stopping || state.reconcilePromise) return;
    const reconciliation = reconcileConnections(state)
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "telegram_supervisor_reconcile_failed",
            error: sanitizeTelegramError(error),
          }),
        );
      })
      .finally(() => {
        if (state.reconcilePromise === reconciliation) {
          state.reconcilePromise = undefined;
        }
      });
    state.reconcilePromise = reconciliation;
  }, reconcileIntervalMs);

  console.info(
    JSON.stringify({
      event: "telegram_supervisor_started",
      connectionCount: state.connections.size,
      reconcileIntervalMs,
      leaseDurationMs: timing.leaseDurationMs,
      leaseRenewIntervalMs: timing.renewIntervalMs,
    }),
  );

  return {
    connectionCount: state.connections.size,
    stop: async (signal) => {
      if (state.stopping) return;
      state.stopping = true;
      if (state.reconcileTimer) {
        clearInterval(state.reconcileTimer);
      }
      await state.reconcilePromise;
      await Promise.allSettled(
        [...state.connections.values()].map((connection) =>
          stopManagedConnection(connection, signal, state),
        ),
      );
      state.connections.clear();
      console.info(
        JSON.stringify({
          event: "telegram_supervisor_stopped",
          signal,
        }),
      );
    },
  };
}

async function reconcileConnections(state: SupervisorState): Promise<void> {
  if (state.stopping) return;
  const {
    configs: persisted,
    hasPersistedConnections,
  } = await state.dependencies.loadRuntimeConfigs();
  const legacy = hasPersistedConnections
    ? null
    : legacyRuntimeConfig(state.dependencies.env);
  const desiredConfigs =
    persisted.length > 0
      ? persisted.map(normalizePersistedRuntimeDescriptor)
      : !hasPersistedConnections && legacy
        ? [legacy]
        : [];
  const desiredById = new Map(
    desiredConfigs.map((config) => [
      config.internalConnectionId,
      config,
    ]),
  );

  for (const [connectionId, existing] of state.connections) {
    const desired = desiredById.get(connectionId);
    if (
      desired
      && isSameTelegramRuntimeRevision(existing.config, desired)
    ) {
      continue;
    }
    state.connections.delete(connectionId);
    await stopManagedConnection(existing, "SUPERVISOR", state);
    console.info(
      JSON.stringify({
        event: desired
          ? "telegram_runtime_revision_replaced"
          : "telegram_runtime_removed",
        internalConnectionId: connectionId,
        botId: existing.config.botId,
        credentialRevision: existing.config.credentialRevision,
        ...(desired
          ? { nextCredentialRevision: desired.credentialRevision }
          : {}),
      }),
    );
  }

  for (const config of desiredConfigs) {
    if (
      state.stopping
      || state.connections.has(config.internalConnectionId)
    ) {
      continue;
    }
    const legacyConfig = hasRuntimeCredential(config);
    const lease = legacyConfig
      ? null
      : await tryAcquireRuntimeLease(config, state);
    if (!legacyConfig && !lease) continue;
    const runtimeConfig = legacyConfig
      ? config
      : await resolveLeasedRuntimeConfig(config, lease!, state);
    if (!runtimeConfig) continue;

    const managed = startManagedConnection(runtimeConfig, lease, state);
    state.connections.set(runtimeConfig.internalConnectionId, managed);
    state.contendedConnections.delete(runtimeConfig.internalConnectionId);
    console.info(
      JSON.stringify({
        event: "telegram_runtime_added",
        internalConnectionId: runtimeConfig.internalConnectionId,
        botId: runtimeConfig.botId,
        credentialRevision: runtimeConfig.credentialRevision,
        leaseMode: lease ? "database" : "legacy_single_instance",
      }),
    );
  }

  if (state.connections.size === 0) {
    console.info(
      JSON.stringify({
        event: "telegram_supervisor_idle",
        reason: desiredConfigs.length > 0
          ? "bot_connections_owned_by_other_supervisor"
          : "no_active_bot_connections",
      }),
    );
  }
}

async function tryAcquireRuntimeLease(
  config: TelegramRuntimeDescriptor,
  state: SupervisorState,
): Promise<TelegramBotRuntimeLease | null> {
  try {
    const lease = await withOperationTimeout(
      state.dependencies.acquireLease({
        telegramBotConnectionId: config.internalConnectionId,
        holderId: state.holderId,
        leaseDurationMs: state.timing.leaseDurationMs,
      }),
      state.timing.operationTimeoutMs,
      "Telegram runtime lease acquisition timed out.",
    );
    if (!lease && !state.contendedConnections.has(config.internalConnectionId)) {
      state.contendedConnections.add(config.internalConnectionId);
      console.info(
        JSON.stringify({
          event: "telegram_runtime_lease_contended",
          internalConnectionId: config.internalConnectionId,
          botId: config.botId,
        }),
      );
    }
    return lease;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_runtime_lease_acquire_failed",
        internalConnectionId: config.internalConnectionId,
        botId: config.botId,
        error: sanitizeTelegramError(error),
      }),
    );
    return null;
  }
}

async function resolveLeasedRuntimeConfig(
  descriptor: TelegramRuntimeDescriptor,
  lease: TelegramBotRuntimeLease,
  state: SupervisorState,
): Promise<TelegramBotRuntimeConfig | null> {
  try {
    const credential = await withOperationTimeout(
      state.dependencies.resolveRuntimeCredential({
        connectionId: descriptor.internalConnectionId,
      }),
      state.timing.operationTimeoutMs,
      "Telegram runtime credential resolution timed out.",
    );
    if (
      !credential
      || credential.connectionId !== descriptor.internalConnectionId
      || credential.botId !== descriptor.botId
      || credential.credentialRevision !== descriptor.credentialRevision
    ) {
      throw new Error(
        "Telegram runtime descriptor changed after lease acquisition.",
      );
    }
    return normalizePersistedRuntimeConfig(credential);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_runtime_credential_resolution_failed",
        internalConnectionId: descriptor.internalConnectionId,
        botId: descriptor.botId,
        error: sanitizeTelegramError(error),
      }),
    );
    await releaseRuntimeLease(
      lease,
      descriptor,
      state,
    );
    return null;
  }
}

function startManagedConnection(
  config: TelegramBotRuntimeConfig,
  lease: TelegramBotRuntimeLease | null,
  state: SupervisorState,
): ManagedConnection {
  const managed: ManagedConnection = {
    config,
    lease,
    leaseLost: false,
    stopRequested: false,
    retryAbort: new AbortController(),
    leaseAbort: new AbortController(),
    runtime: undefined,
    task: Promise.resolve(),
  };
  const runtimeTask = runConnection(managed, state);
  const leaseTask = lease
    ? maintainRuntimeLease(managed, state)
    : Promise.resolve();
  managed.task = Promise.allSettled([runtimeTask, leaseTask])
    .then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            JSON.stringify({
              event: "telegram_managed_runtime_task_failed",
              internalConnectionId: config.internalConnectionId,
              botId: config.botId,
              error: sanitizeTelegramError(result.reason),
            }),
          );
        }
      }
    })
    .finally(() => {
      if (state.connections.get(config.internalConnectionId) === managed) {
        state.connections.delete(config.internalConnectionId);
      }
    });
  return managed;
}

async function stopManagedConnection(
  managed: ManagedConnection,
  signal: "SIGINT" | "SIGTERM" | "SUPERVISOR",
  state: SupervisorState,
) {
  await requestManagedStop(managed, signal);
  await managed.task;
  if (!managed.lease || managed.leaseLost) return;
  await releaseRuntimeLease(managed.lease, managed.config, state);
}

async function releaseRuntimeLease(
  lease: TelegramBotRuntimeLease,
  connection: Pick<
    TelegramRuntimeDescriptor,
    "internalConnectionId" | "botId"
  >,
  state: SupervisorState,
) {
  try {
    const released = await withOperationTimeout(
      state.dependencies.releaseLease({
        telegramBotConnectionId: lease.telegramBotConnectionId,
        holderId: lease.holderId,
        leaseToken: lease.leaseToken,
      }),
      state.timing.operationTimeoutMs,
      "Telegram runtime lease release timed out.",
    );
    if (!released) {
      console.warn(
        JSON.stringify({
          event: "telegram_runtime_lease_release_not_owned",
          internalConnectionId: connection.internalConnectionId,
          botId: connection.botId,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_runtime_lease_release_failed",
        internalConnectionId: connection.internalConnectionId,
        botId: connection.botId,
        error: sanitizeTelegramError(error),
      }),
    );
  }
}

async function requestManagedStop(
  managed: ManagedConnection,
  signal: "SIGINT" | "SIGTERM" | "SUPERVISOR",
) {
  if (managed.stopRequested) return;
  managed.stopRequested = true;
  managed.retryAbort.abort();
  managed.leaseAbort.abort();
  if (!managed.runtime) return;
  try {
    await managed.runtime.stop(signal);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_runtime_stop_failed",
        internalConnectionId: managed.config.internalConnectionId,
        botId: managed.config.botId,
        error: sanitizeTelegramError(error),
      }),
    );
  }
}

async function maintainRuntimeLease(
  managed: ManagedConnection,
  state: SupervisorState,
) {
  while (!managed.stopRequested && managed.lease) {
    await waitForRetry(
      state.timing.renewIntervalMs,
      managed.leaseAbort.signal,
    );
    if (managed.stopRequested || !managed.lease) return;

    try {
      const renewed = await withOperationTimeout(
        state.dependencies.renewLease({
          ...managed.lease,
          leaseDurationMs: state.timing.leaseDurationMs,
        }),
        state.timing.operationTimeoutMs,
        "Telegram runtime lease renewal timed out.",
      );
      if (!renewed) {
        throw new Error(
          "Telegram runtime lease is no longer owned by this supervisor.",
        );
      }
      managed.lease = renewed;
    } catch (error) {
      managed.leaseLost = true;
      console.error(
        JSON.stringify({
          event: "telegram_runtime_lease_lost",
          internalConnectionId: managed.config.internalConnectionId,
          botId: managed.config.botId,
          error: sanitizeTelegramError(error),
        }),
      );
      await requestManagedStop(managed, "SUPERVISOR");
      return;
    }
  }
}

async function runConnection(
  managed: ManagedConnection,
  state: SupervisorState,
) {
  let failedAttempts = 0;

  while (!managed.stopRequested) {
    let runtime: TelegramBotRuntime | undefined;
    try {
      runtime = await state.dependencies.createRuntime(managed.config);
      managed.runtime = runtime;
      if (managed.stopRequested) break;
      failedAttempts = 0;
      await updateRuntimeHealth(
        managed,
        "HEALTHY",
        null,
        state.dependencies,
      );
      if (managed.stopRequested) break;
      await runtime.start();
      if (!managed.stopRequested) {
        throw new Error("Telegram polling stopped unexpectedly.");
      }
    } catch (error) {
      if (managed.stopRequested) break;
      failedAttempts += 1;
      const failure = buildTelegramPollingFailureLog(error);
      console.error(
        JSON.stringify({
          ...failure,
          internalConnectionId:
            managed.config.internalConnectionId,
          botId: managed.config.botId,
          attempt: failedAttempts,
        }),
      );
      await updateRuntimeHealth(
        managed,
        failure.reason === "another_get_updates_consumer"
          ? "DEGRADED"
          : "UNHEALTHY",
        sanitizeTelegramError(error),
        state.dependencies,
      );
    } finally {
      managed.runtime = undefined;
      if (runtime) {
        try {
          await runtime.stop("SUPERVISOR");
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "telegram_runtime_stop_failed",
              internalConnectionId:
                managed.config.internalConnectionId,
              botId: managed.config.botId,
              error: sanitizeTelegramError(error),
            }),
          );
        }
      }
    }

    if (managed.stopRequested) break;
    const delayMs = Math.min(
      maximumRestartDelayMs,
      minimumRestartDelayMs
        * 2 ** Math.min(failedAttempts - 1, 5),
    );
    await waitForRetry(delayMs, managed.retryAbort.signal);
  }
}

function resolveSupervisorDependencies(
  input: TelegramBotSupervisorDependencies,
): ResolvedSupervisorDependencies {
  const env = input.env ?? process.env;
  return {
    env,
    holderId:
      input.holderId?.trim()
      || `telegram-supervisor:${process.pid}:${randomUUID()}`,
    bootstrapLegacyConnection:
      input.bootstrapLegacyConnection
      ?? (() => bootstrapLegacyTelegramBotConnectionFromEnv({ env })),
    loadRuntimeConfigs:
      input.loadRuntimeConfigs
      ?? (() => loadPersistedRuntimeConfigs(env)),
    createRuntime: input.createRuntime ?? createTelegramBotRuntime,
    acquireLease:
      input.acquireLease ?? acquireTelegramBotRuntimeLease,
    renewLease:
      input.renewLease ?? renewTelegramBotRuntimeLease,
    releaseLease:
      input.releaseLease ?? releaseTelegramBotRuntimeLease,
    resolveRuntimeCredential:
      input.resolveRuntimeCredential
      ?? ((request) =>
        resolveTelegramBotRuntimeCredential(request, { env })),
    markRuntimeHealth:
      input.markRuntimeHealth ?? markTelegramBotRuntimeHealth,
  };
}

async function loadPersistedRuntimeConfigs(
  env: Readonly<Record<string, string | undefined>>,
): Promise<RuntimeConfigSnapshot> {
  try {
    const [configs, hasPersistedConnections] = await Promise.all([
      listActiveTelegramBotRuntimeDescriptors(),
      hasPersistedTelegramBotConnections(),
    ]);
    return { configs, hasPersistedConnections };
  } catch (error) {
    if (!env.DATABASE_URL?.trim()) {
      return {
        configs: [],
        hasPersistedConnections: false,
      };
    }
    throw error;
  }
}

function normalizePersistedRuntimeDescriptor(
  config: PersistedTelegramBotRuntimeDescriptor,
): TelegramRuntimeDescriptor {
  return {
    internalConnectionId: requireText(
      config.connectionId,
      "connection id",
    ),
    botId: requireNumericBotId(config.botId),
    ...(config.username ? { username: config.username } : {}),
    ...(config.displayName ? { displayName: config.displayName } : {}),
    credentialRevision: normalizeCredentialRevision(
      config.credentialRevision,
    ),
  };
}

function normalizePersistedRuntimeConfig(
  config: PersistedTelegramBotRuntimeDescriptor & { token: string },
): TelegramBotRuntimeConfig {
  return {
    ...normalizePersistedRuntimeDescriptor(config),
    token: requireText(config.token, "Bot token"),
  };
}

function hasRuntimeCredential(
  config: TelegramRuntimeDescriptor | TelegramBotRuntimeConfig,
): config is TelegramBotRuntimeConfig {
  return "token" in config;
}

async function updateRuntimeHealth(
  managed: ManagedConnection,
  healthStatus: "HEALTHY" | "DEGRADED" | "UNHEALTHY",
  lastError: string | null,
  dependencies: ResolvedSupervisorDependencies,
) {
  const config = managed.config;
  if (config.legacy) return;
  const lease = managed.lease;
  if (!lease || managed.leaseLost || managed.stopRequested) return;
  try {
    await dependencies.markRuntimeHealth({
      telegramBotConnectionId: config.internalConnectionId,
      expectedCredentialRevision: config.credentialRevision,
      leaseHolderId: lease.holderId,
      leaseToken: lease.leaseToken,
      healthStatus,
      lastError,
      checkedAt: new Date(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_runtime_health_update_failed",
        internalConnectionId: config.internalConnectionId,
        botId: config.botId,
        error: sanitizeTelegramError(error),
      }),
    );
  }
}

function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function requireText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Telegram ${label} is required.`);
  return normalized;
}

function requireNumericBotId(value: string) {
  const normalized = requireText(value, "bot id");
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("Telegram bot id must be numeric.");
  }
  return normalized;
}

function normalizeCredentialRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      "Telegram credential revision must be a positive integer.",
    );
  }
  return value;
}
