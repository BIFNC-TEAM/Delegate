const PUBLIC_COMPUTE_CAPABILITIES = new Set([
  "exec",
  "read",
  "write",
  "process",
  "browser",
  "mcp",
] as const);
const COMPUTE_AGENT_CAPABILITIES = new Set(["exec", "read", "write", "process", "mcp"]);
const BROWSER_AGENT_CAPABILITIES = new Set(["browser"]);

export type PublicComputeCapability =
  | "exec"
  | "read"
  | "write"
  | "process"
  | "browser"
  | "mcp";

export type PublicComputeSubagentId = "compute-agent" | "browser-agent";

export type PublicComputeSessionRequest = {
  generationRunId: string;
  subagentId: PublicComputeSubagentId;
  requestedCapabilities: PublicComputeCapability[];
  reason: string;
  requestedBaseImage?: string;
};

export type CreateWebAudienceComputeSessionInput = PublicComputeSessionRequest & {
  representativeId: string;
  contactId: string;
  conversationId: string;
};

const computeBrokerBaseUrl = (
  process.env.COMPUTE_BROKER_URL?.trim() || "http://localhost:4010"
).replace(/\/$/, "");

export function normalizePublicComputeSessionRequest(
  payload: unknown,
): PublicComputeSessionRequest {
  const body = (payload ?? {}) as Record<string, unknown>;
  const generationRunId =
    typeof body.generationRunId === "string"
      ? body.generationRunId.trim()
      : "";
  const subagentId = normalizeSubagentId(body.subagentId);
  const requestedCapabilities = normalizeCapabilities(body.requestedCapabilities);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const requestedBaseImage =
    typeof body.requestedBaseImage === "string" && body.requestedBaseImage.trim()
      ? body.requestedBaseImage.trim()
      : undefined;

  if (!requestedCapabilities.length) {
    throw new Error("requestedCapabilities is required.");
  }
  if (!generationRunId) {
    throw new Error("generationRunId is required.");
  }
  if (!reason) {
    throw new Error("reason is required.");
  }
  assertSubagentCapabilities(subagentId, requestedCapabilities);

  return {
    generationRunId,
    subagentId,
    requestedCapabilities,
    reason,
    ...(requestedBaseImage ? { requestedBaseImage } : {}),
  };
}

export async function createWebAudienceComputeSession(
  input: CreateWebAudienceComputeSessionInput,
): Promise<unknown> {
  const internalToken = process.env.COMPUTE_BROKER_INTERNAL_TOKEN?.trim();
  if (!internalToken) {
    throw new Error("COMPUTE_BROKER_INTERNAL_TOKEN is not configured.");
  }

  const response = await fetch(`${computeBrokerBaseUrl}/internal/compute/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      generationRunId: input.generationRunId,
      subagentId: input.subagentId,
      requestedBy: "audience",
      requestedCapabilities: input.requestedCapabilities,
      reason: input.reason,
      ...(input.requestedBaseImage ? { requestedBaseImage: input.requestedBaseImage } : {}),
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Compute broker request failed.");
  }

  return payload;
}

function normalizeSubagentId(value: unknown): PublicComputeSubagentId {
  return value === "compute-agent" || value === "browser-agent" ? value : "browser-agent";
}

function normalizeCapabilities(value: unknown): PublicComputeCapability[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const capabilities: PublicComputeCapability[] = [];

  for (const item of values) {
    if (typeof item !== "string" || !PUBLIC_COMPUTE_CAPABILITIES.has(item as PublicComputeCapability)) {
      continue;
    }
    capabilities.push(item as PublicComputeCapability);
  }

  return [...new Set(capabilities)];
}

function assertSubagentCapabilities(
  subagentId: PublicComputeSubagentId,
  capabilities: PublicComputeCapability[],
) {
  const allowed = subagentId === "browser-agent" ? BROWSER_AGENT_CAPABILITIES : COMPUTE_AGENT_CAPABILITIES;
  for (const capability of capabilities) {
    if (!allowed.has(capability)) {
      throw new Error(`Subagent ${subagentId} cannot request capability ${capability}.`);
    }
  }
}
