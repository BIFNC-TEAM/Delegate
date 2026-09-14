import { processWorkflowRunById } from "../runner";

export async function executeWorkflowRunActivity(workflowRunId: string): Promise<void> {
  await processWorkflowRunById(workflowRunId);
}
