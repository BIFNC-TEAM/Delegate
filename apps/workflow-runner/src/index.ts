import "dotenv/config";

import { createServer } from "node:http";

import {
  runWeChatPayOrderReconciliationTick,
  runWeChatRefundReversalTick,
  type WeChatPayReconciliationTickSummary,
  type WeChatRefundReversalTickSummary,
} from "@delegate/web-data";

import { workflowRunnerConfig } from "./config";
import { createTemporalBridge, type TemporalBridge } from "./temporal-bridge";
import { runWorkflowTick, type TemporalWorkflowDispatcher, type WorkflowTickSummary } from "./runner";

let lastTickAt: string | null = null;
let lastTickSummary: WorkflowTickSummary | null = null;
let lastError: string | null = null;
let paymentReconciliationActive = false;
let lastPaymentReconciliationAt: string | null = null;
let lastPaymentReconciliationSummary:
  | {
      orders: WeChatPayReconciliationTickSummary;
      refunds: WeChatRefundReversalTickSummary;
    }
  | null = null;
let lastPaymentReconciliationError: string | null = null;
let temporalBridgeState:
  | {
      status: "starting" | "running" | "failed";
      error?: string;
    }
  | null = null;

const server = createServer((request, response) => {
  if ((request.method === "GET" || request.method === "HEAD") && request.url === "/health") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    response.end(
      JSON.stringify({
        status: "ok",
        service: "workflow-runner",
        engine: workflowRunnerConfig.engine.effectiveEngine,
        configuredEngine: workflowRunnerConfig.engine.configuredEngine,
        queueName:
          workflowRunnerConfig.engine.effectiveEngine === "temporal"
            ? workflowRunnerConfig.engine.temporalTaskQueue
            : workflowRunnerConfig.engine.localQueueName,
        temporalReady: workflowRunnerConfig.engine.temporalReady,
        fallbackReason: workflowRunnerConfig.engine.fallbackReason ?? null,
        temporalBridgeState,
        pollMs: workflowRunnerConfig.pollMs,
        lastTickAt,
        lastTickSummary,
        lastError,
        paymentReconciliation: {
          status:
            lastPaymentReconciliationError === null
              ? "ok"
              : "degraded",
          enabled:
            workflowRunnerConfig.paymentReconciliation.enabled,
          active: paymentReconciliationActive,
          pollMs:
            workflowRunnerConfig.paymentReconciliation.pollMs,
          lastTickAt: lastPaymentReconciliationAt,
          lastTickSummary:
            lastPaymentReconciliationSummary,
          lastError: lastPaymentReconciliationError,
        },
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(workflowRunnerConfig.port, "0.0.0.0", () => {
  console.log(`workflow-runner listening on http://0.0.0.0:${workflowRunnerConfig.port}`);
});

void boot();

async function boot(): Promise<void> {
  if (workflowRunnerConfig.engine.effectiveEngine === "temporal") {
    temporalBridgeState = {
      status: "starting",
    };
  } else {
    temporalBridgeState = null;
  }

  void tickLoop();
  if (workflowRunnerConfig.paymentReconciliation.enabled) {
    void paymentReconciliationLoop();
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
    const [orderSummary, refundSummary] = await Promise.all([
      runWeChatPayOrderReconciliationTick({
        limit: config.batchSize,
        leaseMs: config.leaseMs,
        pendingBackoffMs: config.pendingBackoffMs,
        errorBackoffMs: config.errorBackoffMs,
        maxBackoffMs: config.maxBackoffMs,
      }),
      runWeChatRefundReversalTick({
        limit: config.batchSize,
        leaseMs: config.leaseMs,
        maxBackoffMs: config.maxBackoffMs,
      }),
    ]);
    const summary = {
      orders: orderSummary,
      refunds: refundSummary,
    };
    lastPaymentReconciliationAt = new Date().toISOString();
    lastPaymentReconciliationSummary = summary;
    lastPaymentReconciliationError =
      orderSummary.failed > 0
        ? "wechat_payment_reconciliation_item_failed"
        : refundSummary.unresolved > 0
          ? "wechat_refund_reconciliation_required"
          : refundSummary.retryScheduled > 0
            ? "wechat_refund_reversal_retry_scheduled"
        : null;
  } catch (error) {
    lastPaymentReconciliationAt = new Date().toISOString();
    lastPaymentReconciliationError =
      error instanceof Error
        ? error.name
        : "wechat_payment_reconciliation_tick_failed";
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
