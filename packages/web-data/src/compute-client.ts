import type {
  CreateComputeSessionResponse,
  ExecuteToolResponse,
  ResolveApprovalResponse,
  ToolExecutionRequest,
} from "@delegate/compute-protocol";

export class ComputeBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ComputeBrokerError";
  }
}

const publicBrokerErrors: Record<string, { statusCode: number; message: string }> = {
  approval_request_not_found: {
    statusCode: 404,
    message: "Approval request not found.",
  },
  approval_request_domain_mismatch: {
    statusCode: 409,
    message: "Approval request does not belong to this capability.",
  },
  approval_request_already_resolved: {
    statusCode: 409,
    message: "Approval is no longer pending.",
  },
  approval_request_expired: {
    statusCode: 409,
    message: "Approval request has expired.",
  },
  approval_request_execution_missing: {
    statusCode: 409,
    message: "The approval execution is no longer available.",
  },
  approval_request_execution_not_blocked: {
    statusCode: 409,
    message: "The approval execution state changed. Refresh and retry.",
  },
  approval_request_payload_changed: {
    statusCode: 409,
    message: "The approval request changed. Refresh and retry.",
  },
  invalid_json: {
    statusCode: 400,
    message: "The compute broker received invalid JSON.",
  },
  invalid_request: {
    statusCode: 400,
    message: "The compute broker rejected the request.",
  },
};

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
  const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : "";
    const classified = publicBrokerErrors[code];
    if (!classified) {
      throw new ComputeBrokerError(
        "compute_broker_upstream_error",
        502,
        "The compute service is temporarily unavailable.",
      );
    }
    throw new ComputeBrokerError(
      code,
      classified.statusCode,
      classified.message,
    );
  }
  return payload as T;
}
