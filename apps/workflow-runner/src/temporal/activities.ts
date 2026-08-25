import { processWorkflowRunById } from "../runner";
import { executeDelegationExecutionTransition } from "../delegation-execution";
import type {
  DelegationExecutionState,
  DelegationExecutionTransitionInput,
} from "@delegate/workflows";

export async function executeWorkflowRunActivity(workflowRunId: string): Promise<void> {
  await processWorkflowRunById(workflowRunId);
}

export async function executeDelegationExecutionTransitionActivity(
  input: DelegationExecutionTransitionInput,
): Promise<DelegationExecutionState> {
  return executeDelegationExecutionTransition(input);
}
