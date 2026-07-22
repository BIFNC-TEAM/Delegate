import type {
  CreateComputeSessionResponse,
  ExecuteToolResponse,
  ResolveApprovalResponse,
  ToolExecutionRequest,
} from "@delegate/compute-protocol";

export class ComputeBrokerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ComputeBrokerError";
  }
}

export async function createAudienceComputeSession(input: {
  representativeId: string;
  contactId: string;
  conversationId: string;
  generationRunId?: string;
  delegationTaskId?: string;
  delegationTaskStepId?: string;
  subagentId: "compute-agent" | "browser-agent";
  requestedCapabilities: ToolExecutionRequest["capability"][];
  reason: string;
  requestedBaseImage?: string;
}) {
  return callComputeBroker<CreateComputeSessionResponse>("/internal/compute/sessions", {
    method: "POST",
    body: JSON.stringify({
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      ...(input.generationRunId ? { generationRunId: input.generationRunId } : {}),
      ...(input.delegationTaskId ? { delegationTaskId: input.delegationTaskId } : {}),
      ...(input.delegationTaskStepId ? { delegationTaskStepId: input.delegationTaskStepId } : {}),
      subagentId: input.subagentId,
      requestedBy: "audience",
      requestedCapabilities: input.requestedCapabilities,
      reason: input.reason,
      ...(input.requestedBaseImage ? { requestedBaseImage: input.requestedBaseImage } : {}),
    }),
  });
}

export async function executeAudienceTool(sessionId: string, request: ToolExecutionRequest) {
  return callComputeBroker<ExecuteToolResponse>(
    `/internal/compute/sessions/${sessionId}/executions`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export async function resolveComputeApproval(
  approvalId: string,
  input: { resolution: "approved" | "rejected"; resolvedBy?: string; decisionNote?: string },
) {
  return callComputeBroker<ResolveApprovalResponse>(
    `/internal/compute/approvals/${approvalId}/resolve`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function callComputeBroker<T>(pathname: string, init: RequestInit): Promise<T> {
  const baseUrl = (process.env.COMPUTE_BROKER_URL?.trim() || "http://localhost:4010").replace(
    /\/$/,
    "",
  );
  const internalToken = process.env.COMPUTE_BROKER_INTERNAL_TOKEN?.trim();
  if (!internalToken) throw new Error("COMPUTE_BROKER_INTERNAL_TOKEN is not configured.");

  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${internalToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ComputeBrokerError(
      payload.error || "Compute broker request failed.",
      response.status,
    );
  }
  return payload as T;
}
