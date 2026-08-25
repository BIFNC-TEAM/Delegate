import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  delegationExecutionSignalName,
  delegationExecutionSignalSchema,
  type DelegationExecutionSignal,
  type WorkflowEngineConfig,
} from "@delegate/workflows";
import { fileURLToPath } from "node:url";

import type { TemporalWorkflowDispatcher } from "./runner";
import {
  executeDelegationExecutionTransitionActivity,
  executeWorkflowRunActivity,
} from "./temporal/activities";

export type TemporalBridgeState = {
  status: "starting" | "running" | "failed";
  error?: string;
};

export type TemporalBridge = TemporalWorkflowDispatcher & {
  getState(): TemporalBridgeState;
  signalDelegationExecution(params: {
    workflowId: string;
    runId?: string;
    signal: DelegationExecutionSignal;
  }): Promise<void>;
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
      executeDelegationExecutionTransitionActivity,
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
        const isDelegationExecution =
          params.workflowKind === "DELEGATION_EXECUTION";
        if (isDelegationExecution && !params.delegationTaskId) {
          throw new Error("delegation_execution_task_missing");
        }
        const handle = await client.workflow.start(
          isDelegationExecution
            ? "runDelegationExecutionWorkflow"
            : "runDelegateWorkflowRun",
          {
          args: isDelegationExecution
            ? [{
                workflowRunId: params.workflowRunId,
                delegationTaskId: params.delegationTaskId!,
                // Plan revisions remain Postgres truth and may change while
                // this long-lived workflow is waiting. Pinning the initial
                // plan here would make a later signal fail its DB coordinate
                // check after an authorized replan.
              }]
            : [{
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
    async signalDelegationExecution(params) {
      const signal = delegationExecutionSignalSchema.parse(params.signal);
      const handle = client.workflow.getHandle(
        params.workflowId,
        params.runId,
      );
      await handle.signal(
        delegationExecutionSignalName(signal),
        signal,
      );
    },
  };
}

function isTemporalWorkflowNotFound(error: unknown) {
  return error instanceof Error && error.name === "WorkflowNotFoundError";
}
