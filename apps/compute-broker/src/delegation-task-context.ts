export function isDelegationTaskSessionContextValid(
  input: {
    representativeId: string;
    contactId?: string | undefined;
    conversationId?: string | undefined;
    generationRunId?: string | undefined;
    delegationTaskStepId: string;
    requestedCapabilities: string[];
  },
  task: {
    representativeId: string;
    contactId: string | null;
    originConversationId: string | null;
    status: string;
    generationRuns: Array<{
      id: string;
      status: string;
      delegationTaskStepId: string | null;
    }>;
    resourcePolicy: { allowedCapabilities: string[] } | null;
    steps: Array<{
      id: string;
      capability: string | null;
      status: string;
    }>;
  } | null,
) {
  const step = task?.steps[0];
  const generationRun = task?.generationRuns[0];
  const allowedCapabilities = new Set(
    task?.resourcePolicy?.allowedCapabilities.map((capability) => capability.toLowerCase()) ?? [],
  );
  return Boolean(
    task &&
    task.representativeId === input.representativeId &&
    task.contactId === (input.contactId ?? null) &&
    task.originConversationId === (input.conversationId ?? null) &&
    task.generationRuns.length === (input.generationRunId ? 1 : 0) &&
    generationRun?.id === input.generationRunId &&
    generationRun?.delegationTaskStepId === input.delegationTaskStepId &&
    generationRun?.status === "PROCESSING" &&
    step?.id === input.delegationTaskStepId &&
    step.capability &&
    ["READY", "QUEUED", "RUNNING"].includes(step.status) &&
    input.requestedCapabilities.includes(step.capability.toLowerCase()) &&
    input.requestedCapabilities.every((capability) => allowedCapabilities.has(capability)) &&
    ["READY", "QUEUED", "RUNNING"].includes(task.status)
  );
}
