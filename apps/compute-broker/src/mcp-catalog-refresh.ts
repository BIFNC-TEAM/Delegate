import {
  beginRepresentativeMcpBindingHealthObservation,
  recordRepresentativeMcpBindingFailure,
  recordRepresentativeMcpBindingSuccess,
} from "./mcp-bindings";
import { syncRepresentativeMcpToolDefinitions } from "./mcp-tool-definitions";
import { prisma } from "./prisma";

const MCP_CATALOG_REFRESH_LOCK_KEY = "delegate:mcp-catalog-refresh:v1";

type RefreshBinding = { id: string; configRevision: number };

export type McpCatalogRefreshResult = {
  acquired: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  staleObservations: number;
};

export async function refreshMcpCatalogOnce(): Promise<McpCatalogRefreshResult> {
  return prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(
        hashtext(${MCP_CATALOG_REFRESH_LOCK_KEY})
      ) AS "acquired"
    `;
    if (lock[0]?.acquired !== true) return emptyResult(false);
    const bindings = await tx.representativeMcpBinding.findMany({
      where: { enabled: true },
      select: { id: true, configRevision: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    });
    return refreshMcpBindings(bindings);
  }, {
    // tools/list is bounded by the MCP transport timeout, but a pass may span
    // several independent bindings. The advisory transaction is intentionally
    // long-lived so a second Broker instance cannot duplicate refresh traffic.
    timeout: 30 * 60_000,
  });
}

export async function refreshMcpBindings(
  bindings: RefreshBinding[],
  dependencies: {
    begin?: typeof beginRepresentativeMcpBindingHealthObservation;
    sync?: typeof syncRepresentativeMcpToolDefinitions;
    recordSuccess?: typeof recordRepresentativeMcpBindingSuccess;
    recordFailure?: typeof recordRepresentativeMcpBindingFailure;
    now?: () => Date;
  } = {},
): Promise<McpCatalogRefreshResult> {
  const begin = dependencies.begin ?? beginRepresentativeMcpBindingHealthObservation;
  const sync = dependencies.sync ?? syncRepresentativeMcpToolDefinitions;
  const recordSuccess = dependencies.recordSuccess
    ?? recordRepresentativeMcpBindingSuccess;
  const recordFailure = dependencies.recordFailure
    ?? recordRepresentativeMcpBindingFailure;
  const now = dependencies.now ?? (() => new Date());
  const result = emptyResult(true);
  for (const binding of bindings) {
    result.attempted += 1;
    const observation = await begin({
      bindingId: binding.id,
      configRevision: binding.configRevision,
      startedAt: now(),
    }).catch(() => null);
    if (!observation) {
      result.staleObservations += 1;
      continue;
    }
    let syncFailure: unknown;
    try {
      await sync(binding.id);
    } catch (error) {
      syncFailure = error;
    }
    if (typeof syncFailure !== "undefined") {
      const accepted = await recordFailure({
        observation,
        failureReason: syncFailure instanceof Error
          ? syncFailure.message
          : "mcp_catalog_refresh_failed",
        completedAt: now(),
      }).catch(() => false);
      if (accepted) result.failed += 1;
      else result.staleObservations += 1;
      continue;
    }
    // A persisted tools/list observation is already positive availability
    // evidence. If the separate health write loses a race or transiently
    // fails, do not turn that successful read into a synthetic failure.
    const accepted = await recordSuccess({ observation, completedAt: now() })
      .catch(() => false);
    if (accepted) result.succeeded += 1;
    else result.staleObservations += 1;
  }
  return result;
}

export function startMcpCatalogRefreshLoop(input: {
  intervalMs: number;
  refresh?: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  const intervalMs = Math.max(1_000, Math.floor(input.intervalMs));
  const refresh = input.refresh ?? refreshMcpCatalogOnce;
  const onError = input.onError ?? ((error) =>
    console.error("mcp_catalog_refresh_failed", error));
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
  // Refresh immediately at process startup; persisted observations make a
  // restart self-healing even when the previous process died between passes.
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function emptyResult(acquired: boolean): McpCatalogRefreshResult {
  return {
    acquired,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    staleObservations: 0,
  };
}
