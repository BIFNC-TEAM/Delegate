import "dotenv/config";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  getWeChatPayOperationsHealthSnapshot,
  preflightWeChatPayRuntime,
  prisma,
} from "@delegate/web-data";

import { workflowRunnerConfig } from "./config";
import { buildWorkflowRunnerReadiness } from "./health";
import { createTemporalBridge, type TemporalBridge } from "./temporal-bridge";
import { runWorkflowTick, type TemporalWorkflowDispatcher, type WorkflowTickSummary } from "./runner";
import {
  runWeChatPayOperationsTick,
  type WeChatPayOperationsTickResult,
  updateWeChatPayOperationsFailureCodes,
} from "./wechat-pay-operations";
import {
  runOpenVikingOperationsTick,
} from "./openviking-operations";

let lastTickAt: string | null = null;
let lastTickSummary: WorkflowTickSummary | null = null;
let lastError: string | null = null;
let paymentReconciliationActive = false;
let lastPaymentReconciliationAt: string | null = null;
let lastPaymentReconciliationSummary:
  WeChatPayOperationsTickResult | null = null;
let lastPaymentReconciliationError: string | null = null;
let paymentReconciliationFailureCodes: string[] = [];
let temporalBridgeState:
  | {
      status: "starting" | "running" | "failed";
      error?: string;
    }
  | null = null;

const server = createServer((request, response) => {
  void handleHttpRequest(request, response);
});

void start();

async function start(): Promise<void> {
  const preflight = preflightWeChatPayRuntime();
  if (!preflight.ready) {
    console.error(
      "workflow-runner startup preflight failed:",
      preflight.errorCode,
    );
    process.exitCode = 1;
    return;
  }
  server.listen(workflowRunnerConfig.port, "0.0.0.0", () => {
    console.log(
      `workflow-runner listening on http://0.0.0.0:${workflowRunnerConfig.port}`,
    );
  });
  await boot();
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const isProbeMethod =
    request.method === "GET" || request.method === "HEAD";
  if (isProbeMethod && request.url === "/health") {
    sendJson(
      request.method,
      response,
      200,
      { status: "ok", service: "workflow-runner" },
    );
    return;
  }
  if (isProbeMethod && request.url === "/ready") {
    const reconciliationEnabled =
      workflowRunnerConfig.paymentReconciliation.enabled;
    const [
      databaseReady,
      weChatPay,
      persistentPaymentWorkerFailure,
    ] = await Promise.all([
      checkDatabaseReadiness(),
      Promise.resolve(preflightWeChatPayRuntime()),
      reconciliationEnabled
        ? getWeChatPayOperationsHealthSnapshot({
            staleAfterMs:
              workflowRunnerConfig.readinessStaleMs,
            processingEnabled: true,
          })
          .then((snapshot) =>
            snapshot.workers.some(
              (worker) => worker.status === "failing",
            ),
          )
          .catch(() => true)
        : Promise.resolve(false),
    ]);
    const readiness = buildWorkflowRunnerReadiness({
      now: new Date(),
      staleAfterMs: workflowRunnerConfig.readinessStaleMs,
      databaseReady,
      weChatPay,
      workflow: {
        lastTickAt,
        lastTickFailed: lastError !== null,
      },
      paymentReconciliation: {
        enabled: reconciliationEnabled,
        lastTickAt: lastPaymentReconciliationAt,
        lastTickFailed:
          lastPaymentReconciliationError !== null,
        persistentWorkerFailure:
          persistentPaymentWorkerFailure,
      },
    });
    sendJson(
      request.method,
      response,
      readiness.status === "ready" ? 200 : 503,
      readiness,
    );
    return;
  }
  if (
    isProbeMethod
    && request.url === "/operations/wechat-pay/health"
  ) {
    try {
      const snapshot =
        await getWeChatPayOperationsHealthSnapshot({
          staleAfterMs:
            workflowRunnerConfig.readinessStaleMs,
          processingEnabled:
            workflowRunnerConfig.paymentReconciliation.enabled,
        });
      sendJson(request.method, response, 200, snapshot);
    } catch {
      sendJson(request.method, response, 200, {
        status: "critical",
        workers: [],
        alerts: [
          {
            code: "wechat_operations_health_query_failed",
            severity: "critical",
            count: 1,
          },
        ],
      });
    }
    return;
  }

  sendJson(
    request.method,
    response,
    404,
    { error: "not_found" },
  );
}

async function checkDatabaseReadiness(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function sendJson(
  method: string | undefined,
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader(
    "content-type",
    "application/json; charset=utf-8",
  );
  response.setHeader("cache-control", "no-store");
  response.end(method === "HEAD" ? undefined : JSON.stringify(body));
}

async function boot(): Promise<void> {
  if (workflowRunnerConfig.engine.effectiveEngine === "temporal") {
    temporalBridgeState = {
      status: "starting",
    };
  } else {
    temporalBridgeState = null;
  }

  void tickLoop();
  void openVikingMaintenanceLoop();
  if (workflowRunnerConfig.paymentReconciliation.enabled) {
    void paymentReconciliationLoop();
  }
}

async function openVikingMaintenanceLoop(): Promise<void> {
  try {
    const result = await runOpenVikingOperationsTick(
      workflowRunnerConfig.openVikingMaintenance,
    );
    if (result.failedLaneCodes.length > 0) {
      console.error(
        "OpenViking maintenance lanes failed:",
        result.failedLaneCodes.join(","),
      );
    }
  } catch (error) {
    const maintenanceError =
      error instanceof Error
        ? error.message
        : "openviking_maintenance_tick_failed";
    console.error(
      "OpenViking maintenance tick failed:",
      maintenanceError,
    );
  } finally {
    setTimeout(
      () => void openVikingMaintenanceLoop(),
      workflowRunnerConfig.openVikingMaintenance.pollMs,
    );
  }
}

async function tickLoop(
  temporalDispatcher?: TemporalWorkflowDispatcher,
  temporalBridge?: TemporalBridge,
): Promise<void> {
  let nextDispatcher = temporalDispatcher;
  let nextBridge = temporalBridge;

  try {
    if (
      workflowRunnerConfig.engine.effectiveEngine === "temporal" &&
      !nextBridge
    ) {
      temporalBridgeState = {
        status: "starting",
      };
      try {
        nextBridge = await createTemporalBridge(workflowRunnerConfig.engine);
        nextDispatcher = nextBridge;
        temporalBridgeState = nextBridge.getState();
      } catch (error) {
        temporalBridgeState = {
          status: "failed",
          error: error instanceof Error ? error.message : "temporal_bridge_boot_failed",
        };
        lastError = temporalBridgeState.error ?? null;
      }
    }

    const options: {
      engine: "LOCAL_RUNNER" | "TEMPORAL";
      limit: number;
      temporalDispatcher?: TemporalWorkflowDispatcher;
    } = {
      engine:
        workflowRunnerConfig.engine.effectiveEngine === "temporal"
          ? "TEMPORAL"
          : "LOCAL_RUNNER",
      limit: workflowRunnerConfig.batchSize,
    };
    if (nextDispatcher) {
      options.temporalDispatcher = nextDispatcher;
    }

    const result = await runWorkflowTick(options);
    lastTickAt = new Date().toISOString();
    lastTickSummary = result;
    lastError = null;
    if (nextBridge) {
      temporalBridgeState = nextBridge.getState();
    }
  } catch (error) {
    lastTickAt = new Date().toISOString();
    lastError = error instanceof Error ? error.message : "workflow_tick_failed";
    console.error("workflow-runner tick failed:", error);
  } finally {
    setTimeout(() => {
      void tickLoop(nextDispatcher, nextBridge);
    }, workflowRunnerConfig.pollMs);
  }
}

async function paymentReconciliationLoop(): Promise<void> {
  try {
    paymentReconciliationActive = true;
    const config = workflowRunnerConfig.paymentReconciliation;
    const summary = await runWeChatPayOperationsTick(config);
    lastPaymentReconciliationAt = new Date().toISOString();
    lastPaymentReconciliationSummary = summary;
    // Durable business anomalies are reported by the operations endpoint and
    // do not affect readiness. A lane/checkpoint/synchronization execution
    // failure does: the loop ran, but did not complete its required work.
    paymentReconciliationFailureCodes =
      updateWeChatPayOperationsFailureCodes(
        paymentReconciliationFailureCodes,
        summary,
      );
    lastPaymentReconciliationError =
      paymentReconciliationFailureCodes[0] ?? null;
    if (summary.failedWorkerCodes.length > 0) {
      console.error(
        "WeChat Pay operations lanes failed:",
        summary.failedWorkerCodes.join(","),
      );
    }
    if (summary.exceptionSyncFailed) {
      console.error(
        "WeChat Pay exception queue sync failed:",
        "wechat_exception_queue_sync_failed",
      );
    }
  } catch (error) {
    lastPaymentReconciliationAt = new Date().toISOString();
    lastPaymentReconciliationError =
      error instanceof Error
        ? error.name
        : "wechat_payment_reconciliation_tick_failed";
    paymentReconciliationFailureCodes = [
      lastPaymentReconciliationError,
    ];
    console.error(
      "WeChat Pay reconciliation tick failed:",
      lastPaymentReconciliationError,
    );
  } finally {
    paymentReconciliationActive = false;
    setTimeout(
      () => void paymentReconciliationLoop(),
      workflowRunnerConfig.paymentReconciliation.pollMs,
    );
  }
}
