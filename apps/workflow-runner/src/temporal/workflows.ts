import {
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import {
  type TemporalWorkflowRunInput,
} from "@delegate/workflows";

type TemporalWorkflowActivities = {
  executeWorkflowRunActivity(workflowRunId: string): Promise<void>;
};

const {
  executeWorkflowRunActivity,
} = proxyActivities<TemporalWorkflowActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 3,
  },
});

export async function runDelegateWorkflowRun(
  input: TemporalWorkflowRunInput,
): Promise<void> {
  const delayMs = Date.parse(input.scheduledAt) - Date.now();
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await sleep(delayMs);
  }

  await executeWorkflowRunActivity(input.workflowRunId);
}
