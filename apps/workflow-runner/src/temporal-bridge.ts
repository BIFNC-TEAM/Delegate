import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  type WorkflowEngineConfig,
} from "@delegate/workflows";
import { fileURLToPath } from "node:url";

import type { TemporalWorkflowDispatcher } from "./runner";
import {
  executeWorkflowRunActivity,
} from "./temporal/activities";

export type TemporalBridgeState = {
  status: "starting" | "running" | "failed";
  error?: string;
};

export type TemporalBridge = TemporalWorkflowDispatcher & {
  getState(): TemporalBridgeState;
};

export async function createTemporalBridge(
  config: WorkflowEngineConfig,
): Promise<TemporalBridge> {
  if (!config.temporalReady || !config.temporalAddress || !config.temporalNamespace || !config.temporalTaskQueue) {
    throw new Error("temporal_not_ready");
  }

  const state: TemporalBridgeState = {
    status: "starting",
  };

  const clientConnection = await Connection.connect({
    address: config.temporalAddress,
  });
  const client = new Client({
    connection: clientConnection,
    namespace: config.temporalNamespace,
  });
  const workerConnection = await NativeConnection.connect({
    address: config.temporalAddress,
  });

  const worker = await Worker.create({
    connection: workerConnection,
    namespace: config.temporalNamespace,
    taskQueue: config.temporalTaskQueue,
    workflowsPath: fileURLToPath(new URL("./temporal/workflows.ts", import.meta.url)),
    activities: {
      executeWorkflowRunActivity,
    },
  });

  state.status = "running";
  void worker.run().catch((error: unknown) => {
    state.status = "failed";
    state.error = error instanceof Error ? error.message : "temporal_worker_failed";
  });

  return {
    getState() {
      return { ...state };
    },
    async startWorkflowExecution(params) {
      try {
        const handle = await client.workflow.start(
          "runDelegateWorkflowRun",
          {
          args: [{
                workflowRunId: params.workflowRunId,
                scheduledAt: params.scheduledAt.toISOString(),
              }],
          taskQueue: params.taskQueue,
          workflowId: params.workflowId,
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          },
        );

        return {
          outcome: "started" as const,
          runId: handle.firstExecutionRunId,
          observedAt: new Date(),
        };
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
          throw error;
        }

        const handle = client.workflow.getHandle(params.workflowId);
        const description = await handle.describe();

        return {
          outcome: "already_started" as const,
          runId: description.runId,
          observedAt: new Date(),
        };
      }
    },
    async cancelWorkflowExecution(params) {
      const handle = client.workflow.getHandle(
        params.workflowId,
        params.runId,
      );

      try {
        const description = await handle.describe();
        if (description.status.name !== "RUNNING") {
          return {
            outcome: "already_closed" as const,
            runId: description.runId,
            observedAt: new Date(),
          };
        }

        await handle.cancel();

        return {
          outcome: "canceled" as const,
          runId: description.runId,
          observedAt: new Date(),
        };
      } catch (error) {
        if (isTemporalWorkflowNotFound(error)) {
          return {
            outcome: "not_found" as const,
            runId: params.runId ?? null,
            observedAt: new Date(),
          };
        }

        throw error;
      }
    },
  };
}

function isTemporalWorkflowNotFound(error: unknown) {
  return error instanceof Error && error.name === "WorkflowNotFoundError";
}
