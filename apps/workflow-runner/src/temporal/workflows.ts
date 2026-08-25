import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import {
  DELEGATION_APPROVAL_SIGNAL,
  DELEGATION_CANCEL_SIGNAL,
  DELEGATION_POLICY_REVOKED_SIGNAL,
  DELEGATION_RECONCILIATION_SIGNAL,
  DELEGATION_USER_INPUT_SIGNAL,
  delegationApprovalSignalSchema,
  delegationCancelSignalSchema,
  delegationExecutionInputSchema,
  delegationPolicyRevokedSignalSchema,
  delegationReconciliationSignalSchema,
  delegationUserInputSignalSchema,
  type DelegationApprovalSignal,
  type DelegationCancelSignal,
  type DelegationExecutionInput,
  type DelegationExecutionSignal,
  type DelegationExecutionState,
  type DelegationExecutionTransitionInput,
  type DelegationPolicyRevokedSignal,
  type DelegationReconciliationSignal,
  type DelegationUserInputSignal,
  type TemporalWorkflowRunInput,
} from "@delegate/workflows";

type TemporalWorkflowActivities = {
  executeWorkflowRunActivity(workflowRunId: string): Promise<void>;
  executeDelegationExecutionTransitionActivity(
    input: DelegationExecutionTransitionInput,
  ): Promise<DelegationExecutionState>;
};

const {
  executeWorkflowRunActivity,
  executeDelegationExecutionTransitionActivity,
} = proxyActivities<TemporalWorkflowActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 3,
  },
});

export const delegationApprovalResolvedSignal =
  defineSignal<[DelegationApprovalSignal]>(DELEGATION_APPROVAL_SIGNAL);
export const delegationUserInputReceivedSignal =
  defineSignal<[DelegationUserInputSignal]>(DELEGATION_USER_INPUT_SIGNAL);
export const delegationCancelRequestedSignal =
  defineSignal<[DelegationCancelSignal]>(DELEGATION_CANCEL_SIGNAL);
export const delegationPolicyRevokedSignal =
  defineSignal<[DelegationPolicyRevokedSignal]>(
    DELEGATION_POLICY_REVOKED_SIGNAL,
  );
export const delegationReconciliationResolvedSignal =
  defineSignal<[DelegationReconciliationSignal]>(
    DELEGATION_RECONCILIATION_SIGNAL,
  );

export async function runDelegateWorkflowRun(
  input: TemporalWorkflowRunInput,
): Promise<void> {
  const delayMs = Date.parse(input.scheduledAt) - Date.now();
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await sleep(delayMs);
  }

  await executeWorkflowRunActivity(input.workflowRunId);
}

/**
 * Durable orchestration skeleton for a complete DelegationTask. Signals only
 * wake the workflow; the activity re-reads and persists authoritative DB state.
 */
export async function runDelegationExecutionWorkflow(
  rawInput: DelegationExecutionInput,
): Promise<void> {
  const input = delegationExecutionInputSchema.parse(rawInput);
  const pendingSignals: DelegationExecutionSignal[] = [];
  const acceptedSignalIds = new Set<string>();
  const enqueue = (signal: DelegationExecutionSignal) => {
    if (acceptedSignalIds.has(signal.signalId)) return;
    acceptedSignalIds.add(signal.signalId);
    pendingSignals.push(signal);
  };

  setHandler(delegationApprovalResolvedSignal, (rawSignal) => {
    enqueue(delegationApprovalSignalSchema.parse(rawSignal));
  });
  setHandler(delegationUserInputReceivedSignal, (rawSignal) => {
    enqueue(delegationUserInputSignalSchema.parse(rawSignal));
  });
  setHandler(delegationCancelRequestedSignal, (rawSignal) => {
    enqueue(delegationCancelSignalSchema.parse(rawSignal));
  });
  setHandler(delegationPolicyRevokedSignal, (rawSignal) => {
    enqueue(delegationPolicyRevokedSignalSchema.parse(rawSignal));
  });
  setHandler(delegationReconciliationResolvedSignal, (rawSignal) => {
    enqueue(delegationReconciliationSignalSchema.parse(rawSignal));
  });

  let transitionSequence = 0;
  let state = await executeDelegationExecutionTransitionActivity({
    ...input,
    transitionId: `bootstrap:${transitionSequence}`,
  });
  transitionSequence += 1;

  while (!isTerminalPhase(state.phase)) {
    await condition(() => pendingSignals.length > 0);
    const signal = pendingSignals.shift()!;
    state = await executeDelegationExecutionTransitionActivity({
      ...input,
      transitionId: `signal:${signal.signalId}`,
      signal,
    });
    transitionSequence += 1;
  }
}

function isTerminalPhase(phase: DelegationExecutionState["phase"]) {
  return phase === "completed" || phase === "failed" || phase === "canceled";
}
