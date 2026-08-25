export type DelegationTaskResourcePolicyContext = {
  maxDurationMinutes?: number;
  maxEstimatedTokens?: number | null;
  allowedCapabilities: string[];
  allowedMcpBindingIds?: string[];
  networkMode?: string;
  filesystemMode?: string;
  requireApprovalForExternalSideEffects?: boolean;
};

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
    resourcePolicy: DelegationTaskResourcePolicyContext | null;
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

export function resolveDelegationTaskSessionDurationMinutes(input: {
  representativeMaxSessionMinutes: number;
  resourcePolicy: DelegationTaskResourcePolicyContext | null | undefined;
}) {
  const representativeMinutes = Math.max(
    0,
    input.representativeMaxSessionMinutes,
  );
  const taskMinutes = input.resourcePolicy?.maxDurationMinutes;
  return typeof taskMinutes === "number"
    ? Math.min(representativeMinutes, Math.max(0, taskMinutes))
    : representativeMinutes;
}

export function resolveEffectiveDelegationNetworkMode(
  representativeMode: "no_network" | "allowlist" | "full",
  taskMode: string | null | undefined,
): "no_network" | "allowlist" | "full" {
  const normalizedTaskMode = normalizeNetworkMode(taskMode);
  if (!normalizedTaskMode) return representativeMode;
  const rank = { full: 0, allowlist: 1, no_network: 2 } as const;
  return rank[representativeMode] >= rank[normalizedTaskMode]
    ? representativeMode
    : normalizedTaskMode;
}

export function resolveEffectiveDelegationFilesystemMode(
  representativeMode:
    | "workspace_only"
    | "read_only_workspace"
    | "ephemeral_full",
  taskMode: string | null | undefined,
): "workspace_only" | "read_only_workspace" | "ephemeral_full" {
  const normalizedTaskMode = normalizeFilesystemMode(taskMode);
  if (!normalizedTaskMode) return representativeMode;
  const rank = {
    ephemeral_full: 0,
    workspace_only: 1,
    read_only_workspace: 2,
  } as const;
  return rank[representativeMode] >= rank[normalizedTaskMode]
    ? representativeMode
    : normalizedTaskMode;
}

function normalizeNetworkMode(
  value: string | null | undefined,
): "no_network" | "allowlist" | "full" | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "no_network"
    || normalized === "allowlist"
    || normalized === "full"
    ? normalized
    : null;
}

function normalizeFilesystemMode(
  value: string | null | undefined,
): "workspace_only" | "read_only_workspace" | "ephemeral_full" | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "workspace_only"
    || normalized === "read_only_workspace"
    || normalized === "ephemeral_full"
    ? normalized
    : null;
}
